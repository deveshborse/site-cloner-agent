import fs from "node:fs/promises";
import path from "node:path";
import { normalizeColor } from "./colors.ts";
import { config } from "./config.ts";
import { lintCode, readComponent, sanitizeCode, writeComponent } from "./generate.ts";
import type { Reporter } from "./jobs.ts";
import { extractCode, extractJson, LlmClient } from "./llm.ts";
import { tokensForPrompt } from "./outline.ts";
import { compileAndRepair, loadSpec, runtimeRepair, siteDirFor } from "./pipeline.ts";
import { ensurePreview } from "./preview.ts";
import { EDIT_SYSTEM, NEW_SECTION_SYSTEM, PLAN_SYSTEM } from "./prompts.ts";
import { readManifest, writeManifestFiles } from "./scaffold.ts";
import type { DesignTokens, ManifestSection, SiteManifest } from "./types.ts";

export interface EditPlan {
  summary: string;
  theme: Partial<DesignTokens>;
  remove: string[];
  sticky: { section: string; sticky: boolean }[];
  edit: { section: string; instruction: string }[];
  add: { name: string; kind: string; after: string | null; instruction: string }[];
  order: string[];
}

const emptyPlan = (summary: string): EditPlan => ({ summary, theme: {}, remove: [], sticky: [], edit: [], add: [], order: [] });

function findSections(text: string, sections: ManifestSection[]): ManifestSection[] {
  const t = text.toLowerCase();
  const aliases: Record<string, string[]> = {
    navbar: ["navbar", "nav", "navigation", "header", "menu", "top bar"],
    hero: ["hero", "banner", "header section", "intro"],
    footer: ["footer"],
    pricing: ["pricing", "plans", "prices"],
    testimonials: ["testimonial", "reviews"],
    faq: ["faq", "questions"],
    features: ["features", "feature"],
    logos: ["logos", "logo", "clients", "partners"],
    cta: ["cta", "call to action"],
    newsletter: ["newsletter", "subscribe"],
    contact: ["contact", "form"],
    stats: ["stats", "numbers", "metrics"],
  };
  return sections.filter((s) => (aliases[s.kind] ?? [s.kind]).some((a) => t.includes(a)) || t.includes(s.name.toLowerCase()));
}

/** Offline planner: handles the common deterministic edits without any model call. */
export function ruleBasedPlan(prompt: string, manifest: SiteManifest): EditPlan | null {
  const p = prompt.trim().toLowerCase().replace(/[.!]+$/, "");
  const plan = emptyPlan(prompt);

  const colour = /(?:(primary|brand|main|accent|theme|button|background|text)\s+)?colou?r(?:\s+\w+)?\s+(?:to|into|as)\s+(.+)$/.exec(p) ?? /^make (?:it|the (?:site|website|page)) (.+)$/.exec(p);
  if (colour) {
    const target = colour.length === 3 ? colour[2] : colour[1];
    const hex = normalizeColor(target.replace(/^the\s+/, "").replace(/\s+colou?r$/, "")) ?? normalizeColor(target.split(/\s+/).pop() ?? "");
    if (hex) {
      const which = colour.length === 3 ? colour[1] : undefined;
      if (which === "background") plan.theme.background = hex;
      else if (which === "text") plan.theme.foreground = hex;
      else plan.theme.primary = hex;
      plan.summary = `Set the ${which === "background" ? "background" : which === "text" ? "text" : "primary"} colour to ${hex}`;
      return plan;
    }
  }
  const font = /(?:heading |body )?font(?: family)? (?:to|into) (.+)$/.exec(p);
  if (font) {
    const name = font[1].replace(/\b\w/g, (c) => c.toUpperCase());
    if (!p.includes("body")) plan.theme.headingFont = name;
    if (!p.includes("heading")) plan.theme.bodyFont = name;
    plan.summary = `Change font to ${name}`;
    return plan;
  }
  if (/\b(sticky|fixed)\b/.test(p) && /\b(nav|navbar|navigation|header|menu)\b/.test(p)) {
    const nav = manifest.sections.find((s) => s.kind === "navbar") ?? manifest.sections[0];
    plan.sticky.push({ section: nav.id, sticky: !/\b(not|non|unstick|remove)\b/.test(p) });
    plan.summary = `Make ${nav.name} ${plan.sticky[0].sticky ? "sticky" : "not sticky"}`;
    return plan;
  }
  const remove = /^(?:remove|delete|hide|drop|get rid of)\s+(?:the\s+)?(.+?)(?:\s+sections?)?$/.exec(p);
  if (remove) {
    const targets = findSections(remove[1], manifest.sections);
    if (targets.length) {
      plan.remove = targets.map((t) => t.id);
      plan.summary = `Remove ${targets.map((t) => t.name).join(", ")}`;
      return plan;
    }
  }
  return null;
}

async function llmPlan(prompt: string, manifest: SiteManifest, llm: LlmClient): Promise<EditPlan> {
  const sections = manifest.sections.map((s) => `- ${s.id}: ${s.name} (${s.kind}) ${s.summary}${s.sticky ? " [sticky]" : ""}`).join("\n");
  const reply = await llm.chat({
    label: "plan edit",
    model: config.llm.fastModel,
    json: true,
    maxTokens: 900,
    temperature: 0,
    messages: [
      { role: "system", content: PLAN_SYSTEM },
      { role: "user", content: `Sections (in page order):\n${sections}\n\nTheme tokens:\n${tokensForPrompt(manifest.tokens)}\n\nInstruction: ${prompt}` },
    ],
  });
  const raw = extractJson<Partial<EditPlan>>(reply);
  const ids = new Set(manifest.sections.map((s) => s.id));
  const plan: EditPlan = {
    summary: String(raw.summary ?? prompt),
    theme: typeof raw.theme === "object" && raw.theme ? raw.theme : {},
    remove: (raw.remove ?? []).filter((id) => ids.has(id)),
    sticky: (raw.sticky ?? []).filter((s) => ids.has(s.section)),
    edit: (raw.edit ?? []).filter((e) => ids.has(e.section) && e.instruction),
    add: (raw.add ?? []).filter((a) => a.name && a.instruction),
    order: (raw.order ?? []).filter((id) => ids.has(id)),
  };
  for (const key of ["primary", "background", "foreground", "muted", "surface", "border"] as const) {
    const v = plan.theme[key];
    if (v !== undefined) {
      const hex = normalizeColor(String(v));
      if (hex) plan.theme[key] = hex;
      else delete plan.theme[key];
    }
  }
  return plan;
}

// ---------- snapshots (undo + rollback) ----------
async function snapshot(siteDir: string): Promise<string> {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(siteDir, ".clone", "history", id);
  await fs.mkdir(dir, { recursive: true });
  await fs.cp(path.join(siteDir, "components"), path.join(dir, "components"), { recursive: true });
  await fs.cp(path.join(siteDir, "app"), path.join(dir, "app"), { recursive: true });
  await fs.copyFile(path.join(siteDir, "clone.json"), path.join(dir, "clone.json"));
  return id;
}

async function restore(siteDir: string, id: string) {
  const dir = path.join(siteDir, ".clone", "history", id);
  await fs.rm(path.join(siteDir, "components"), { recursive: true, force: true });
  await fs.cp(path.join(dir, "components"), path.join(siteDir, "components"), { recursive: true });
  await fs.cp(path.join(dir, "app"), path.join(siteDir, "app"), { recursive: true, force: true });
  await fs.copyFile(path.join(dir, "clone.json"), path.join(siteDir, "clone.json"));
}

const uniqueName = (base: string, manifest: SiteManifest) => {
  const clean = (base.replace(/[^A-Za-z0-9]/g, "") || "Section").replace(/^[a-z]/, (c) => c.toUpperCase()).replace(/^\d/, "S$&");
  let name = clean;
  for (let i = 2; manifest.sections.some((s) => s.name === name); i++) name = `${clean}${i}`;
  return name;
};

/** Applies a natural-language instruction to a generated site. Any failure rolls the site back to its previous state. */
export async function modifySite(slug: string, prompt: string, rep: Reporter): Promise<SiteManifest> {
  const siteDir = siteDirFor(slug);
  const manifest = await readManifest(siteDir);
  const spec = await loadSpec(siteDir);
  const llm = new LlmClient((m) => rep.info(m));

  rep.stage("plan", `Planning: "${prompt}"`);
  // Cost-aware routing: simple, unambiguous edits are planned by rules (free); compound or section-specific requests
  // go to the fast model.
  let plan = ruleBasedPlan(prompt, manifest);
  const compound = /\b(and|then|also|but)\b/i.test(prompt);
  const sectionSpecificTheme = plan !== null && Object.keys(plan.theme).length > 0 && findSections(prompt, manifest.sections).length > 0;
  if (llm.enabled && (!plan || compound || sectionSpecificTheme)) {
    plan = await llmPlan(prompt, manifest, llm);
  } else if (plan) {
    rep.info("Planned without an AI call (rule-based)");
  }
  if (!plan) {
    throw new Error(
      llm.enabled
        ? "Could not understand the instruction"
        : "This instruction needs an AI model (set LLM_API_KEY). Offline mode supports colour, font, sticky navbar and remove-section edits."
    );
  }
  if (plan.edit.length === 0 && plan.add.length === 0 && plan.remove.length === 0 && plan.sticky.length === 0 && plan.order.length === 0 && Object.keys(plan.theme).length === 0) {
    throw new Error(`Nothing to change for this instruction. Sections on this page: ${manifest.sections.map((s) => `${s.name} (${s.kind})`).join(", ")}`);
  }
  rep.info(`Plan: ${plan.summary}`);
  rep.event({ type: "analysis", data: { plan } });

  const snap = await snapshot(siteDir);
  const touched = new Set<string>();
  try {
    rep.stage("apply", "Applying changes");
    if (Object.keys(plan.theme).length) {
      manifest.tokens = { ...manifest.tokens, ...plan.theme };
      for (const f of [plan.theme.headingFont, plan.theme.bodyFont]) if (f && !manifest.fonts.includes(f)) manifest.fonts.push(f);
      rep.info(`Theme tokens updated: ${Object.entries(plan.theme).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }
    for (const s of plan.sticky) {
      const sec = manifest.sections.find((x) => x.id === s.section)!;
      sec.sticky = s.sticky;
      rep.info(`${sec.name} is now ${s.sticky ? "sticky" : "not sticky"}`);
    }
    for (const id of plan.remove) {
      const sec = manifest.sections.find((x) => x.id === id);
      if (!sec) continue;
      manifest.sections = manifest.sections.filter((x) => x.id !== id);
      await fs.rm(path.join(siteDir, sec.file), { force: true });
      rep.info(`Removed ${sec.name}`);
    }
    if (plan.order.length) {
      const byId = new Map(manifest.sections.map((s) => [s.id, s]));
      const ordered = plan.order.map((id) => byId.get(id)!).filter(Boolean);
      manifest.sections = [...ordered, ...manifest.sections.filter((s) => !plan!.order.includes(s.id))];
      rep.info("Sections reordered");
    }

    if (plan.edit.length || plan.add.length) {
      if (!llm.enabled) throw new Error("Editing or adding sections needs an AI model (set LLM_API_KEY)");
      await Promise.all(
        plan.edit.map(async (e) => {
          const sec = manifest.sections.find((x) => x.id === e.section);
          if (!sec) return;
          const code = await readComponent(siteDir, sec.name);
          const reply = await llm.chat({
            label: `edit ${sec.name}`,
            messages: [
              { role: "system", content: EDIT_SYSTEM },
              { role: "user", content: `Component name: ${sec.name}\nTheme tokens:\n${tokensForPrompt(manifest.tokens)}\n\nInstruction: ${e.instruction}\n(Original user request: "${prompt}")\n\nCurrent file:\n\`\`\`tsx\n${code}\n\`\`\`` },
            ],
          });
          await writeComponent(siteDir, sec.name, sanitizeCode(extractCode(reply), sec.name));
          if (sec.source === "fallback") sec.source = "llm";
          touched.add(sec.file);
          rep.info(`Edited ${sec.name}: ${e.instruction}`);
        })
      );
      for (const a of plan.add) {
        const name = uniqueName(a.name, manifest);
        const idx = a.after === "start" ? 0 : a.after ? manifest.sections.findIndex((s) => s.id === a.after) + 1 : manifest.sections.length;
        const insertAt = idx <= 0 && a.after !== "start" ? manifest.sections.length : idx;
        const neighbour = manifest.sections[Math.max(0, insertAt - 1)];
        const neighbourCode = neighbour ? (await readComponent(siteDir, neighbour.name).catch(() => "")).slice(0, 6000) : "";
        const reply = await llm.chat({
          label: `add ${name}`,
          messages: [
            { role: "system", content: NEW_SECTION_SYSTEM },
            {
              role: "user",
              content: `Component name: ${name}\nSection type: ${a.kind}\nWhat it should contain: ${a.instruction}\n(Original user request: "${prompt}")\n\nTheme tokens:\n${tokensForPrompt(manifest.tokens)}\n\nSite: ${manifest.title}\nNeighbouring section for style reference (${neighbour?.name ?? "none"}):\n\`\`\`tsx\n${neighbourCode}\n\`\`\``,
            },
          ],
        });
        await writeComponent(siteDir, name, sanitizeCode(extractCode(reply), name));
        const id = `n${Date.now().toString(36)}`;
        manifest.sections.splice(insertAt, 0, { id, name, kind: a.kind, file: `components/${name}.tsx`, summary: `${a.kind}: ${a.instruction}`.slice(0, 140), sticky: false, source: "added" });
        touched.add(`components/${name}.tsx`);
        rep.info(`Added ${name} after ${neighbour?.name ?? "start"}`);
      }
    }

    await writeManifestFiles(siteDir, manifest);

    rep.stage("validate", "Validating the modified site");
    const compiled = await compileAndRepair(siteDir, manifest, spec, llm, rep, { only: touched, fallbackOnFail: false });
    if (!compiled.ok) {
      const lint = [...compiled.remaining.entries()].map(([f, e]) => `${f}: ${e[0]}`).join("; ");
      throw new Error(`Generated code still has errors after ${config.maxRepairAttempts} repair rounds (${lint})`);
    }
    for (const f of touched) {
      const name = path.basename(f, ".tsx");
      if (lintCode(await readComponent(siteDir, name)).length) throw new Error(`${name} failed static checks`);
    }
    const url = await ensurePreview(slug, rep.info);
    await new Promise((r) => setTimeout(r, 2500));
    const ok = await runtimeRepair(url, siteDir, manifest, spec, llm, rep, false);
    if (!ok) throw new Error("The modified page has runtime errors");

    manifest.history.push({ at: new Date().toISOString(), prompt, summary: plan.summary, snapshot: snap });
    manifest.usage = {
      calls: manifest.usage.calls + llm.usage.calls,
      cachedCalls: manifest.usage.cachedCalls + llm.usage.cachedCalls,
      promptTokens: manifest.usage.promptTokens + llm.usage.promptTokens,
      completionTokens: manifest.usage.completionTokens + llm.usage.completionTokens,
      costUsd: Math.round((manifest.usage.costUsd + llm.usage.costUsd) * 10000) / 10000,
    };
    await writeManifestFiles(siteDir, manifest);
    rep.event({ type: "usage", data: { thisEdit: llm.usage, total: manifest.usage } });
    rep.event({ type: "done", data: { slug, previewUrl: url, summary: plan.summary } });
    return manifest;
  } catch (err) {
    await restore(siteDir, snap);
    rep.warn("Rolled back to the previous version");
    throw err;
  }
}

export async function undoLast(slug: string): Promise<SiteManifest> {
  const siteDir = siteDirFor(slug);
  const manifest = await readManifest(siteDir);
  const last = manifest.history.at(-1);
  if (!last) throw new Error("Nothing to undo");
  await restore(siteDir, last.snapshot);
  return readManifest(siteDir);
}
