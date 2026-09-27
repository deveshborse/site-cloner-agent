import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { deriveTokens, googleFontFamily, normalizeColor } from "../agent/colors.ts";
import { fallbackComponent } from "../agent/fallback.ts";
import { lintCode, sanitizeCode } from "../agent/generate.ts";
import { extractCode, extractJson } from "../agent/llm.ts";
import { ruleBasedPlan } from "../agent/modify.ts";
import { toOutline } from "../agent/outline.ts";
import type { DesignTokens, SectionSpec, SiteManifest } from "../agent/types.ts";
import { parseTscOutput } from "../agent/validate.ts";

const tokens: DesignTokens = {
  primary: "#4f46e5",
  background: "#ffffff",
  foreground: "#111827",
  muted: "#6b7280",
  surface: "#f3f4f6",
  border: "#e5e7eb",
  headingFont: "Inter",
  bodyFont: "Inter",
  radius: "8px",
  containerWidth: 1200,
};

const section: SectionSpec = {
  id: "s1",
  kind: "hero",
  name: "Hero",
  rect: { x: 0, y: 72, w: 1440, h: 600 },
  fullBleed: true,
  gapBefore: 0,
  align: "full",
  sticky: false,
  background: "#ffffff",
  heading: "Build {faster}",
  truncated: false,
  node: {
    tag: "section",
    style: { padding: "96 24 96 24", bg: "#ffffff" },
    children: [
      { tag: "h1", text: 'Build {faster} with "quotes" & <tags>', style: { fontSize: 56, fontWeight: 700, color: "#111827" } },
      { tag: "p", children: [{ tag: "#text", text: "Text with a " }, { tag: "a", text: "link", attrs: { href: "#" } }, { tag: "div", text: "block inside p" }] },
      { tag: "a", attrs: { href: "#" }, style: { bg: "#4f46e5", color: "#ffffff", radius: 8, padding: "12 20 12 20" }, children: [{ tag: "a", text: "nested link" }] },
      { tag: "img", asset: "/assets/img-1.png", w: 600, h: 400, attrs: { alt: "Product" } },
      { tag: "img", w: 24, h: 24, attrs: { alt: "" } },
      { tag: "br" },
    ],
  },
};

test("normalizeColor handles names and hex forms", () => {
  assert.equal(normalizeColor("blue"), "#2563eb");
  assert.equal(normalizeColor("#ABC"), "#aabbcc");
  assert.equal(normalizeColor("12ab34"), "#12ab34");
  assert.equal(normalizeColor("not a colour"), null);
});

test("googleFontFamily strips self-hosted variant suffixes", () => {
  assert.equal(googleFontFamily("Inter Variable"), "Inter");
  assert.equal(googleFontFamily("Geist VF"), "Geist");
  assert.equal(googleFontFamily("Roboto"), "Roboto");
});

test("deriveTokens picks a saturated button colour as primary", () => {
  const t = deriveTokens(
    {
      text: { "#111827": 900, "#6b7280": 300 },
      bg: { "#ffffff": 5000, "#f9fafb": 800 },
      button: { "#4f46e5": 4, "#ffffff": 2 },
      link: { "#111827": 10 },
      border: { "#e5e7eb": 12 },
      radius: { "8": 4 },
      container: { "1200": 6 },
    },
    { body: "Inter", heading: "Inter" },
    "#ffffff"
  );
  assert.equal(t.primary, "#4f46e5");
  assert.equal(t.foreground, "#111827");
  assert.equal(t.muted, "#6b7280");
  assert.equal(t.surface, "#f9fafb");
  assert.equal(t.containerWidth, 1200);
});

test("extractCode and extractJson tolerate prose and fences", () => {
  assert.match(extractCode("Here you go:\n```tsx\nexport default function A() { return null; }\n```\nThanks"), /^export default function A/);
  assert.match(extractCode("export default function B() { return null; }"), /function B/);
  assert.throws(() => extractCode("I cannot help with that."));
  assert.deepEqual(extractJson<{ a: number }>('Sure!\n```json\n{"a": 1}\n```'), { a: 1 });
});

test("parseTscOutput groups errors by file", () => {
  const out = [
    "components/Hero.tsx(12,5): error TS2304: Cannot find name 'foo'.",
    "components/Hero.tsx(20,1): error TS1005: ';' expected.",
    "app/page.tsx(3,8): error TS2307: Cannot find module '@/components/X'.",
  ].join("\n");
  const map = parseTscOutput(out);
  assert.equal(map.get("components/Hero.tsx")?.length, 2);
  assert.equal(map.get("app/page.tsx")?.length, 1);
});

test("sanitizeCode converts next/image and next/link and adds use client when needed", () => {
  const code = sanitizeCode(
    `import Image from "next/image";\nimport Link from "next/link";\nimport { useState } from "react";\nexport default function Nav() { const [o, s] = useState(false); return <Link href="#"><Image src="/a.png" alt="" /></Link>; }`,
    "Nav"
  );
  assert.ok(code.startsWith('"use client";'));
  assert.ok(!code.includes("next/image") && !code.includes("next/link"));
  assert.ok(code.includes("<img") && code.includes("<a"));
  assert.deepEqual(lintCode(code), []);
  assert.equal(lintCode('import x from "framer-motion";\nexport default function A(){return null}').length, 1);
});

test("fallback generator emits syntactically valid TSX for tricky content", () => {
  const code = fallbackComponent(section, tokens);
  const out = ts.transpileModule(code, { compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2020 }, reportDiagnostics: true, fileName: "Hero.tsx" });
  assert.deepEqual(out.diagnostics?.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n")), []);
  assert.ok(code.includes("var(--color-primary)"), "token colours become CSS variables so theme edits apply");
  assert.ok(!/<a[^>]*>[\s\S]*<a /.test(code.split("nested link")[0].slice(-200)), "nested links are converted");
  assert.ok(code.includes("<br />"));
});

test("outline is compact and uses token names", () => {
  const lines = toOutline(section.node, tokens);
  assert.ok(lines.some((l) => l.includes("bg:primary")));
  assert.ok(lines.some((l) => l.includes("img /assets/img-1.png 600x400")));
  assert.ok(lines.some((l) => l.includes("missing image")));
});

test("rule-based planner handles the common edits without an LLM", () => {
  const manifest = {
    sections: [
      { id: "s0", name: "Navbar", kind: "navbar", file: "components/Navbar.tsx", summary: "", sticky: false, source: "fallback" },
      { id: "s1", name: "Hero", kind: "hero", file: "components/Hero.tsx", summary: "", sticky: false, source: "fallback" },
      { id: "s2", name: "Pricing", kind: "pricing", file: "components/Pricing.tsx", summary: "", sticky: false, source: "fallback" },
    ],
  } as unknown as SiteManifest;
  assert.equal(ruleBasedPlan("Change the primary color to blue.", manifest)?.theme.primary, "#2563eb");
  assert.deepEqual(ruleBasedPlan("Make the navbar sticky", manifest)?.sticky, [{ section: "s0", sticky: true }]);
  assert.deepEqual(ruleBasedPlan("Remove the pricing section", manifest)?.remove, ["s2"]);
  assert.equal(ruleBasedPlan("Add a testimonials section", manifest), null);
});
