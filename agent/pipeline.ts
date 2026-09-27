import fs from "node:fs/promises";
import path from "node:path";
import { analyzeSite } from "./analyze.ts";
import { cropToDataUrl, scoreClone } from "./compare.ts";
import { config, GENERATED_DIR } from "./config.ts";
import { fallbackComponent } from "./fallback.ts";
import { generateSection, lintCode, readComponent, refineComponent, repairComponent, writeComponent } from "./generate.ts";
import type { Reporter } from "./jobs.ts";
import { LlmClient } from "./llm.ts";
import { ensurePreview } from "./preview.ts";
import { scaffoldProject, writeManifestFiles } from "./scaffold.ts";
import type { ManifestSection, SectionSpec, SiteManifest, SiteSpec } from "./types.ts";
import { nextBuild, runtimeCheck, typecheck } from "./validate.ts";

export function normalizeUrl(input: string): string {
  let u = input.trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  const parsed = new URL(u);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("Only http(s) URLs are supported");
  return parsed.href;
}

export function slugFor(url: string): string {
  const host = new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  return `${host}-${Date.now().toString(36).slice(-6)}`;
}

export const siteDirFor = (slug: string) => path.join(GENERATED_DIR, slug);

export async function loadSpec(siteDir: string): Promise<SiteSpec> {
  return JSON.parse(await fs.readFile(path.join(siteDir, ".clone", "spec.json"), "utf8")) as SiteSpec;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface RepairOptions {
  /** Files allowed to be changed by the repair loop (default: every section file). */
  only?: Set<string>;
  /** Replace components that cannot be repaired with the deterministic version (clone flow) instead of failing (edit flow). */
  fallbackOnFail: boolean;
}

/**
 * Validation + self-repair loop: type-check the project, send each failing component back to the model with the
 * compiler errors, and repeat. Components that still fail are replaced by the deterministic generator (which always
 * compiles), so a clone never ends in a broken build.
 */
export async function compileAndRepair(
  siteDir: string,
  manifest: SiteManifest,
  spec: SiteSpec,
  llm: LlmClient,
  rep: Reporter,
  opts: RepairOptions
): Promise<{ ok: boolean; remaining: Map<string, string[]> }> {
  const specById = new Map(spec.sections.map((s) => [s.id, s]));
  let errors = new Map<string, string[]>();
  for (let attempt = 0; attempt <= config.maxRepairAttempts; attempt++) {
    errors = await typecheck(siteDir);
    for (const sec of manifest.sections) {
      if (opts.only && !opts.only.has(sec.file)) continue;
      const code = await readComponent(siteDir, sec.name).catch(() => "");
      const lint = lintCode(code);
      if (lint.length) errors.set(sec.file, [...(errors.get(sec.file) ?? []), ...lint]);
    }
    if (errors.size === 0) {
      rep.info(attempt === 0 ? "Type check passed" : `Type check passed after ${attempt} repair round(s)`);
      return { ok: true, remaining: errors };
    }
    rep.warn(`Type check: errors in ${[...errors.keys()].join(", ")}`);
    if (attempt === config.maxRepairAttempts) break;

    await Promise.all(
      [...errors.entries()].map(async ([file, list]) => {
        const sec = manifest.sections.find((s) => s.file === file);
        if (!sec) {
          if (file.startsWith("app/")) await writeManifestFiles(siteDir, manifest);
          return;
        }
        if (opts.only && !opts.only.has(file)) return;
        const original = specById.get(sec.id);
        if (llm.enabled && sec.source !== "fallback") {
          try {
            const code = await readComponent(siteDir, sec.name);
            await writeComponent(siteDir, sec.name, await repairComponent(sec.name, code, list, llm));
            rep.info(`Repaired ${sec.name} with the model (attempt ${attempt + 1})`);
            return;
          } catch (err) {
            rep.warn(`Repair call failed for ${sec.name}: ${(err as Error).message}`);
          }
        }
        if (opts.fallbackOnFail && original) {
          await writeComponent(siteDir, sec.name, fallbackComponent(original, manifest.tokens));
          sec.source = "fallback";
          rep.warn(`Replaced ${sec.name} with the deterministic version`);
        }
      })
    );
  }

  if (opts.fallbackOnFail) {
    for (const file of errors.keys()) {
      const sec = manifest.sections.find((s) => s.file === file);
      const original = sec && specById.get(sec.id);
      if (sec && original) {
        await writeComponent(siteDir, sec.name, fallbackComponent(original, manifest.tokens));
        sec.source = "fallback";
        rep.warn(`${sec.name} still failed after repairs; using the deterministic version`);
      }
    }
    errors = await typecheck(siteDir);
  }
  return { ok: errors.size === 0, remaining: errors };
}

/** Loads the running preview, and routes runtime errors back to the component that caused them. */
export async function runtimeRepair(url: string, siteDir: string, manifest: SiteManifest, spec: SiteSpec, llm: LlmClient, rep: Reporter, fallbackOnFail: boolean): Promise<boolean> {
  const specById = new Map(spec.sections.map((s) => [s.id, s]));
  for (let attempt = 0; attempt <= config.maxRepairAttempts; attempt++) {
    const report = await runtimeCheck(url, manifest.sections.map((s) => s.name));
    if (report.ok) {
      rep.info(`Runtime check passed (HTTP ${report.status}, no page errors)`);
      return true;
    }
    rep.warn(`Runtime check: ${report.errors[0]?.split("\n")[0].slice(0, 300) ?? `HTTP ${report.status}`}`);
    if (attempt === config.maxRepairAttempts) break;
    const targets = manifest.sections.filter((s) => report.components.includes(s.name));
    if (!targets.length) {
      rep.warn("Could not attribute the runtime error to a specific component");
      break;
    }
    for (const sec of targets) {
      const original = specById.get(sec.id);
      const code = await readComponent(siteDir, sec.name);
      if (llm.enabled && sec.source !== "fallback") {
        try {
          await writeComponent(siteDir, sec.name, await repairComponent(sec.name, code, report.errors.slice(0, 6), llm));
          rep.info(`Repaired runtime error in ${sec.name}`);
          continue;
        } catch (err) {
          rep.warn(`Repair call failed for ${sec.name}: ${(err as Error).message}`);
        }
      }
      if (fallbackOnFail && original) {
        await writeComponent(siteDir, sec.name, fallbackComponent(original, manifest.tokens));
        sec.source = "fallback";
        rep.warn(`Replaced ${sec.name} with the deterministic version`);
      }
    }
    await compileAndRepair(siteDir, manifest, spec, llm, rep, { fallbackOnFail, only: new Set(targets.map((t) => t.file)) });
    await sleep(2500); // let the dev server hot-reload
  }
  return false;
}

async function score(siteDir: string, url: string, manifest: SiteManifest, spec: SiteSpec, rep: Reporter) {
  const result = await scoreClone(siteDir, url, spec.sections);
  for (const s of result.sections) {
    const m = manifest.sections.find((x) => x.id === s.id);
    if (m) m.score = Math.round(s.score * 1000) / 1000;
  }
  manifest.similarity = Math.round(result.overall * 1000) / 1000;
  rep.event({ type: "score", data: { overall: manifest.similarity, sections: manifest.sections.map((s) => ({ id: s.id, name: s.name, score: s.score })) } });
  return result;
}

/**
 * Visual refinement: for the worst-scoring sections, show the model the original and the current rendering side by
 * side and ask it to fix the differences. A change is kept only if it compiles and the score improves.
 */
async function refine(siteDir: string, url: string, manifest: SiteManifest, spec: SiteSpec, llm: LlmClient, rep: Reporter, scores: Awaited<ReturnType<typeof scoreClone>>) {
  const cloneDir = path.join(siteDir, ".clone");
  const candidates = scores.sections
    .filter((s) => s.score < config.refineThreshold && s.cloneRect)
    .sort((a, b) => a.score - b.score)
    .slice(0, config.refineMaxSections);
  if (!candidates.length) {
    rep.info(`All sections are above the ${config.refineThreshold} similarity threshold; no refinement needed`);
    return scores;
  }
  const before = new Map<string, { code: string; score: number }>();
  await Promise.all(
    candidates.map(async (c) => {
      const sec = manifest.sections.find((s) => s.id === c.id)!;
      const spc = spec.sections.find((s) => s.id === c.id)!;
      const code = await readComponent(siteDir, sec.name);
      const orig = await cropToDataUrl(path.join(cloneDir, "original-desktop.png"), spc.rect.y, spc.rect.h);
      const cur = await cropToDataUrl(path.join(cloneDir, "clone-desktop.png"), c.cloneRect!.y, c.cloneRect!.h);
      if (!orig || !cur) return;
      try {
        const improved = await refineComponent(sec.name, code, orig, cur, manifest.tokens, llm);
        before.set(sec.id, { code, score: c.score });
        await writeComponent(siteDir, sec.name, improved);
        if (sec.source === "fallback") sec.source = "llm";
        rep.info(`Refined ${sec.name} (similarity was ${(c.score * 100).toFixed(0)}%)`);
      } catch (err) {
        rep.warn(`Refinement failed for ${sec.name}: ${(err as Error).message}`);
      }
    })
  );
  if (!before.size) return scores;
  const touched = new Set(manifest.sections.filter((s) => before.has(s.id)).map((s) => s.file));
  const compiled = await compileAndRepair(siteDir, manifest, spec, llm, rep, { only: touched, fallbackOnFail: false });
  for (const file of compiled.remaining.keys()) {
    const sec = manifest.sections.find((s) => s.file === file);
    const prev = sec && before.get(sec.id);
    if (sec && prev) {
      await writeComponent(siteDir, sec.name, prev.code);
      before.delete(sec.id);
      rep.warn(`Reverted refinement of ${sec.name} (did not compile)`);
    }
  }
  await sleep(2500);
  const after = await score(siteDir, url, manifest, spec, rep);
  let reverted = false;
  for (const [id, prev] of before) {
    const now = after.sections.find((s) => s.id === id)?.score ?? 0;
    const sec = manifest.sections.find((s) => s.id === id)!;
    if (now < prev.score) {
      await writeComponent(siteDir, sec.name, prev.code);
      reverted = true;
      rep.info(`Kept the previous ${sec.name}: refinement scored lower (${(now * 100).toFixed(0)}% vs ${(prev.score * 100).toFixed(0)}%)`);
    } else rep.info(`${sec.name}: similarity ${(prev.score * 100).toFixed(0)}% -> ${(now * 100).toFixed(0)}%`);
  }
  if (reverted) {
    await sleep(2500);
    return score(siteDir, url, manifest, spec, rep);
  }
  return after;
}

/** The full URL -> Analysis -> Generation -> Validation -> Preview -> Scoring -> Refinement pipeline. */
export async function cloneWebsite(rawUrl: string, rep: Reporter, slugOverride?: string): Promise<SiteManifest> {
  const url = normalizeUrl(rawUrl);
  const slug = slugOverride ?? slugFor(url);
  const siteDir = siteDirFor(slug);
  const llm = new LlmClient((m) => rep.info(m));
  await fs.mkdir(siteDir, { recursive: true });

  rep.stage("analyze", `Analyzing ${url}`);
  const spec = await analyzeSite(url, siteDir, rep.info);
  await fs.writeFile(path.join(siteDir, ".clone", "spec.json"), JSON.stringify(spec, null, 2), "utf8");
  rep.info(`Found ${spec.sections.length} sections, ${spec.assetCount} assets; fonts: ${spec.fonts.join(", ") || "system"}`);
  rep.event({
    type: "analysis",
    data: {
      slug,
      title: spec.title,
      tokens: spec.tokens,
      fonts: spec.fonts,
      assetCount: spec.assetCount,
      pageHeight: spec.pageHeight,
      sections: spec.sections.map((s) => ({ id: s.id, name: s.name, kind: s.kind, heading: s.heading, height: s.rect.h, responsive: s.responsive })),
    },
  });

  const now = new Date().toISOString();
  const manifest: SiteManifest = {
    slug,
    sourceUrl: url,
    title: spec.title,
    description: spec.description,
    lang: spec.lang,
    createdAt: now,
    updatedAt: now,
    tokens: spec.tokens,
    fonts: spec.fonts,
    sections: spec.sections.map<ManifestSection>((s: SectionSpec) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      file: `components/${s.name}.tsx`,
      summary: `${s.kind}: ${s.heading ?? ""}`.slice(0, 140),
      sticky: s.sticky,
      source: "fallback",
    })),
    llm: { enabled: llm.enabled, mainModel: llm.enabled ? config.llm.mainModel : undefined, fastModel: llm.enabled ? config.llm.fastModel : undefined },
    usage: llm.usage,
    history: [],
  };
  await scaffoldProject(siteDir, manifest);

  rep.stage("generate", llm.enabled ? `Generating ${spec.sections.length} components with ${config.llm.mainModel}` : "Generating components (offline deterministic mode)");
  const screenshot = path.join(siteDir, ".clone", "original-desktop.png");
  await Promise.all(
    spec.sections.map(async (s) => {
      const result = await generateSection(s, spec, screenshot, llm, rep.info);
      await writeComponent(siteDir, s.name, result.code);
      const m = manifest.sections.find((x) => x.id === s.id)!;
      m.source = result.source;
      rep.event({ type: "section", data: { id: s.id, name: s.name, kind: s.kind, source: result.source } });
      rep.info(`${s.name}: generated (${result.source === "llm" ? "AI" : "deterministic"})`);
    })
  );
  await writeManifestFiles(siteDir, manifest);

  rep.stage("validate", "Type-checking and repairing generated code");
  await compileAndRepair(siteDir, manifest, spec, llm, rep, { fallbackOnFail: true });
  await writeManifestFiles(siteDir, manifest);

  rep.stage("preview", "Starting local preview (next dev)");
  const previewUrl = await ensurePreview(slug, rep.info);
  rep.event({ type: "preview", url: previewUrl });
  rep.info(`Preview running at ${previewUrl}`);
  await runtimeRepair(previewUrl, siteDir, manifest, spec, llm, rep, true);

  rep.stage("compare", "Scoring visual similarity against the original");
  let scores = await score(siteDir, previewUrl, manifest, spec, rep);
  rep.info(`Overall visual similarity: ${(scores.overall * 100).toFixed(1)}%`);

  if (llm.enabled && config.llm.vision && config.refinePasses > 0) {
    for (let pass = 1; pass <= config.refinePasses; pass++) {
      rep.stage("refine", `Visual refinement pass ${pass}`);
      scores = await refine(siteDir, previewUrl, manifest, spec, llm, rep, scores);
    }
    rep.info(`Similarity after refinement: ${(scores.overall * 100).toFixed(1)}%`);
  }

  if (config.runNextBuild) {
    rep.stage("build", "Running next build");
    const build = await nextBuild(siteDir);
    if (build.ok) rep.info("next build succeeded");
    else rep.warn(`next build failed:\n${build.output.slice(-1200)}`);
  }

  manifest.usage = { ...llm.usage, costUsd: Math.round(llm.usage.costUsd * 10000) / 10000 };
  await writeManifestFiles(siteDir, manifest);
  rep.event({ type: "usage", data: manifest.usage });
  rep.event({ type: "done", data: { slug, previewUrl, similarity: manifest.similarity, usage: manifest.usage } });
  return manifest;
}
