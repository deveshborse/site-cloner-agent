import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.ts";
import { fallbackComponent } from "./fallback.ts";
import { extractCode, type ContentPart, type LlmClient } from "./llm.ts";
import { responsiveNotes, toOutline, tokensForPrompt } from "./outline.ts";
import { GENERATE_SYSTEM, REFINE_SYSTEM, REPAIR_SYSTEM } from "./prompts.ts";
import type { DesignTokens, SectionSpec, SiteSpec } from "./types.ts";

const MAX_OUTLINE_LINES = 260;

/** Crops a region from a screenshot and returns a small JPEG data URL (small images keep vision token costs down). */
export async function cropDataUrl(screenshot: string, rect: { y: number; h: number }, width = 1440): Promise<string | null> {
  try {
    const img = sharp(screenshot);
    const meta = await img.metadata();
    const H = meta.height ?? 0;
    const W = meta.width ?? width;
    const top = Math.max(0, Math.min(rect.y, H - 1));
    const height = Math.max(1, Math.min(rect.h, 1800, H - top));
    if (height < 8) return null;
    const buf = await sharp(screenshot)
      .extract({ left: 0, top, width: W, height })
      .resize({ width: Math.min(1024, W), height: 1400, fit: "inside" })
      .jpeg({ quality: 70 })
      .toBuffer();
    return `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Deterministic fixes applied to every model output before compiling. Cheap to run, and they remove the most
 * common failure modes without spending tokens on a repair call.
 */
export function sanitizeCode(code: string, name: string): string {
  let out = code.replace(/\r\n/g, "\n");
  if (/from\s+["']next\/image["']/.test(out)) {
    out = out.replace(/import\s+\w+\s+from\s+["']next\/image["'];?\n?/g, "").replace(/<Image(\s|>)/g, "<img$1").replace(/<\/Image>/g, "");
  }
  if (/from\s+["']next\/link["']/.test(out)) {
    out = out.replace(/import\s+\w+\s+from\s+["']next\/link["'];?\n?/g, "").replace(/<Link(\s|>)/g, "<a$1").replace(/<\/Link>/g, "</a>");
  }
  out = out.replace(/^\s*["']use client["'];?\s*\n/m, "");
  const needsClient = /\buse(State|Effect|Ref|Reducer|Memo|Callback|LayoutEffect|Transition)\b/.test(out) || /\son[A-Z][a-zA-Z]*=\{/.test(out);
  if (!/export\s+default/.test(out)) {
    const fn = new RegExp(`(function|const)\\s+${name}\\b`).test(out) ? name : null;
    if (fn) out += `\nexport default ${fn};\n`;
  }
  return (needsClient ? '"use client";\n\n' : "") + out.trimStart();
}

/** Static checks that tsc would not catch, reported as errors so the repair loop can fix them. */
export function lintCode(code: string): string[] {
  const errors: string[] = [];
  for (const m of code.matchAll(/from\s+["']([^"']+)["']/g)) {
    const mod = m[1];
    if (!["react", "lucide-react"].includes(mod) && !mod.startsWith("@/components/")) errors.push(`Import from "${mod}" is not allowed; only "react" and "lucide-react" are installed.`);
  }
  if (!/export\s+default/.test(code)) errors.push("The file has no default export.");
  if (/src=["']https?:\/\/(?!.*\/assets\/)/.test(code) && /placeholder|unsplash|picsum|via\.placeholder/.test(code)) errors.push("Do not use external placeholder image URLs; use the provided /assets paths or a neutral placeholder block.");
  return errors;
}

export interface GenerateResult {
  code: string;
  source: "llm" | "fallback";
  note?: string;
}

export async function generateSection(
  section: SectionSpec,
  spec: SiteSpec,
  screenshot: string,
  llm: LlmClient,
  log: (m: string) => void
): Promise<GenerateResult> {
  if (!llm.enabled) return { code: fallbackComponent(section, spec.tokens), source: "fallback" };

  let outline = toOutline(section.node, spec.tokens);
  const truncated = section.truncated || outline.length > MAX_OUTLINE_LINES;
  if (outline.length > MAX_OUTLINE_LINES) outline = outline.slice(0, MAX_OUTLINE_LINES);

  const text = [
    `Component name: ${section.name}`,
    `Section type: ${section.kind}`,
    `Original size on a 1440px-wide desktop: ${section.rect.w}x${section.rect.h}px. Section background: ${section.background}.`,
    section.align === "full"
      ? "The section spans the full page width (backgrounds go edge to edge; constrain the inner content with a centered container)."
      : `The section's box is ${section.rect.w}px wide and ${section.align === "center" ? "centered" : `left-aligned at x=${section.rect.x}px`} in the 1440px viewport; reproduce that width and placement on the root element.`,
    section.gapBefore > 0 ? `There is ${section.gapBefore}px of empty space above this section: add it as top margin on the root element.` : "",
    section.sticky ? "The original section stays fixed at the top while scrolling: make its root element `sticky top-0 z-50`." : "",
    `Responsive behaviour: ${responsiveNotes(section)}`,
    "",
    "Theme tokens:",
    tokensForPrompt(spec.tokens),
    "",
    `Structure${truncated ? " (truncated: continue the visible pattern for the remaining items, guided by the screenshot)" : ""}:`,
    outline.join("\n"),
  ]
    .filter((l) => l !== "")
    .join("\n");

  const content: ContentPart[] = [{ type: "text", text }];
  if (config.llm.vision) {
    const img = await cropDataUrl(screenshot, section.rect);
    if (img) content.push({ type: "text", text: "Screenshot of the original section:" }, { type: "image_url", image_url: { url: img } });
  }

  try {
    const reply = await llm.chat({
      label: `generate ${section.name}`,
      messages: [
        { role: "system", content: GENERATE_SYSTEM },
        { role: "user", content },
      ],
    });
    return { code: sanitizeCode(extractCode(reply), section.name), source: "llm" };
  } catch (err) {
    log(`AI generation failed for ${section.name} (${(err as Error).message}); using the deterministic generator`);
    return { code: fallbackComponent(section, spec.tokens), source: "fallback", note: (err as Error).message };
  }
}

export async function repairComponent(name: string, code: string, errors: string[], llm: LlmClient): Promise<string> {
  const reply = await llm.chat({
    label: `repair ${name}`,
    messages: [
      { role: "system", content: REPAIR_SYSTEM },
      {
        role: "user",
        content: `Component name: ${name}\n\nErrors:\n${errors.slice(0, 20).join("\n")}\n\nCurrent file:\n\`\`\`tsx\n${code}\n\`\`\``,
      },
    ],
  });
  return sanitizeCode(extractCode(reply), name);
}

export async function refineComponent(name: string, code: string, original: string, current: string, tokens: DesignTokens, llm: LlmClient): Promise<string> {
  const reply = await llm.chat({
    label: `refine ${name}`,
    messages: [
      { role: "system", content: REFINE_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: `Component name: ${name}\nTheme tokens:\n${tokensForPrompt(tokens)}\n\nORIGINAL section:` },
          { type: "image_url", image_url: { url: original } },
          { type: "text", text: "CURRENT recreation:" },
          { type: "image_url", image_url: { url: current } },
          { type: "text", text: `Current code:\n\`\`\`tsx\n${code}\n\`\`\`` },
        ],
      },
    ],
  });
  return sanitizeCode(extractCode(reply), name);
}

export async function writeComponent(siteDir: string, name: string, code: string) {
  await fs.writeFile(path.join(siteDir, "components", `${name}.tsx`), code, "utf8");
}

export async function readComponent(siteDir: string, name: string) {
  return fs.readFile(path.join(siteDir, "components", `${name}.tsx`), "utf8");
}
