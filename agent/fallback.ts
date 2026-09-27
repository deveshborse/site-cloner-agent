import type { DesignTokens, SectionSpec, SpecNode } from "./types.ts";

/**
 * Deterministic generator: converts a captured section tree into a React component with inline styles.
 * Used in offline mode (no API key) and as the safety net when an AI-generated component cannot be repaired.
 * It always compiles, so the pipeline can always produce a working site.
 */

const ALLOWED = new Set([
  "div", "section", "header", "footer", "nav", "main", "article", "aside", "h1", "h2", "h3", "h4", "h5", "h6", "p",
  "span", "a", "button", "ul", "ol", "li", "strong", "em", "b", "i", "small", "blockquote", "figure", "figcaption",
  "label", "form", "table", "thead", "tbody", "tr", "td", "th", "dl", "dt", "dd", "details", "summary", "hr", "code",
  "pre", "sup", "sub", "time", "address", "mark", "s", "u",
]);
const PHRASING_PARENTS = new Set(["p", "a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "span", "label", "summary", "strong", "em", "b", "i", "small"]);
const BLOCKISH = new Set(["div", "section", "header", "footer", "nav", "main", "article", "aside", "ul", "ol", "li", "p", "h1", "h2", "h3", "h4", "h5", "h6", "figure", "form", "table", "blockquote", "dl", "details", "pre", "address", "hr"]);
const INTERACTIVE = new Set(["a", "button"]);

type Style = Record<string, string | number>;

function tokenVar(color: string, tokens: DesignTokens): string {
  const c = color.toLowerCase();
  for (const k of ["primary", "background", "foreground", "muted", "surface", "border"] as const) {
    if (tokens[k].toLowerCase() === c) return `var(--color-${k})`;
  }
  return color;
}

const padClamp = (v: number) => (v > 24 ? `min(${v}px, 5vw)` : `${v}px`);

function cssFrom(node: SpecNode, tokens: DesignTokens, ctx: { isRoot: boolean; parentFlexRow: boolean; sticky: boolean }): Style {
  const s = (node.style ?? {}) as Style;
  const out: Style = {};
  if (s.display === "flex") {
    out.display = "flex";
    out.flexDirection = String(s.flexDirection ?? "row");
    if (out.flexDirection === "row") out.flexWrap = "wrap";
    if (s.justifyContent) out.justifyContent = s.justifyContent;
    if (s.alignItems) out.alignItems = s.alignItems;
  } else if (s.display === "grid") {
    const cols = Number(s.gridCols ?? 1);
    const gap = Number(s.gap ?? 0);
    const colW = node.w && cols > 1 ? Math.max(160, Math.floor((node.w - gap * (cols - 1)) / cols) - 8) : 0;
    out.display = "grid";
    out.gridTemplateColumns = cols > 1 ? `repeat(auto-fit, minmax(min(100%, ${colW}px), 1fr))` : "1fr";
  } else if (s.display === "inline-block" || s.display === "inline") {
    out.display = "inline-block";
  }
  if (s.gap) out.gap = `${s.gap}px`;
  if (s.padding) {
    const [t, r, b, l] = String(s.padding).split(" ").map(Number);
    out.padding = `${t}px ${padClamp(r)} ${b}px ${padClamp(l)}`;
  }
  if (s.margin) {
    const [t, , b] = String(s.margin).split(" ").map(Number);
    if (t) out.marginTop = `${t}px`;
    if (b) out.marginBottom = `${b}px`;
  }
  if (s.maxWidth) {
    out.maxWidth = `${s.maxWidth}px`;
    out.width = "100%";
  }
  if (s.center) {
    out.marginLeft = "auto";
    out.marginRight = "auto";
  }
  if (s.position === "relative") out.position = "relative";
  if (s.position === "absolute" && s.abs) {
    const [top, left, w] = String(s.abs).split(" ").map(Number);
    out.position = "absolute";
    out.top = `${top}px`;
    out.left = `${left}px`;
    if (w) out.width = `${w}px`;
  }
  if (s.bg) out.backgroundColor = tokenVar(String(s.bg), tokens);
  if (s.bgGradient) out.backgroundImage = String(s.bgGradient);
  if (s.bgImage) {
    out.backgroundImage = `url(${s.bgImage})`;
    out.backgroundSize = String(s.bgSize ?? "cover");
    out.backgroundPosition = "center";
  }
  if (s.border) {
    const m = /^(top |bottom |left )?(\d+(?:\.\d+)?)px (\w+) (#[0-9a-f]{3,8})/i.exec(String(s.border));
    if (m) {
      const prop = m[1] ? `border${m[1].trim()[0].toUpperCase()}${m[1].trim().slice(1)}` : "border";
      out[prop] = `${m[2]}px ${m[3]} ${tokenVar(m[4], tokens)}`;
    }
  }
  if (s.radius) out.borderRadius = Number(s.radius) >= 9999 ? "9999px" : `${s.radius}px`;
  if (s.shadow) out.boxShadow = s.shadow === "yes" ? "0 8px 24px rgba(0,0,0,0.08)" : String(s.shadow);
  if (s.opacity) out.opacity = Number(s.opacity);
  if (ctx.isRoot && ctx.sticky) {
    out.position = "sticky";
    out.top = 0;
    out.zIndex = 50;
  }
  if (s.fontSize) {
    const size = Number(s.fontSize);
    out.fontSize = size > 30 ? `clamp(${Math.round(size * 0.62)}px, ${((size / 1440) * 100).toFixed(2)}vw, ${size}px)` : `${size}px`;
  }
  if (s.fontWeight) out.fontWeight = Number(s.fontWeight) || String(s.fontWeight);
  if (s.color) out.color = tokenVar(String(s.color), tokens);
  if (s.font) out.fontFamily = `"${s.font}", var(--font-body)`;
  if (s.lineHeight) out.lineHeight = Number(s.lineHeight);
  if (s.letterSpacing) out.letterSpacing = `${s.letterSpacing}px`;
  if (s.textAlign) out.textAlign = String(s.textAlign);
  if (s.textTransform) out.textTransform = String(s.textTransform);
  if (s.italic) out.fontStyle = "italic";
  if (s.underline) out.textDecoration = "underline";
  // Let columns inside a wrapping flex row share space instead of shrinking to their content.
  if (ctx.parentFlexRow && node.children?.length && (node.w ?? 0) > 140 && s.position !== "absolute") {
    out.flex = `1 1 ${Math.min(node.w ?? 240, 1200)}px`;
    out.minWidth = 0;
  }
  return out;
}

const jsxString = (v: string) => `{${JSON.stringify(v)}}`;

function render(node: SpecNode, tokens: DesignTokens, depth: number, ancestors: string[], ctx: { isRoot: boolean; parentFlexRow: boolean; sticky: boolean; rootExtra?: Style }): string {
  const pad = "  ".repeat(depth + 2);
  if (node.tag === "#text") return `${pad}${jsxString(node.text ?? "")}`;

  if (node.tag === "img") {
    const s = (node.style ?? {}) as Style;
    const w = node.w ?? 0;
    const h = node.h ?? 0;
    const small = w > 0 && w <= 72 && h <= 72;
    const style: Style = small
      ? { width: `${w}px`, height: `${h}px`, flexShrink: 0 }
      : { width: "100%", maxWidth: w ? `${w}px` : "100%", height: "auto", ...(h && w ? { aspectRatio: `${w} / ${h}` } : {}) };
    if (s.objectFit) style.objectFit = String(s.objectFit);
    if (s.radius) style.borderRadius = `${s.radius}px`;
    if (!node.asset) {
      return `${pad}<div aria-hidden="true" style={${JSON.stringify({ ...style, background: "var(--color-surface)", minHeight: small ? undefined : "40px" })}} />`;
    }
    const alt = node.attrs?.alt ?? "";
    return `${pad}<img src=${jsxString(node.asset)} alt=${jsxString(alt)} loading="lazy" style={${JSON.stringify(style)}} />`;
  }

  let tag = ALLOWED.has(node.tag) ? node.tag : "div";
  const insidePhrasing = ancestors.some((a) => PHRASING_PARENTS.has(a));
  const insideInteractive = ancestors.some((a) => INTERACTIVE.has(a));
  const css: Style = { ...(ctx.isRoot ? ctx.rootExtra ?? {} : {}), ...cssFrom(node, tokens, ctx) };
  if (insideInteractive && INTERACTIVE.has(tag)) tag = "span";
  if (insidePhrasing && BLOCKISH.has(tag)) {
    tag = "span";
    if (!css.display) css.display = "block";
  }
  if (ctx.isRoot && !["header", "footer", "nav", "section"].includes(tag)) tag = "section";

  if (tag === "input" || node.tag === "input") {
    const a = node.attrs ?? {};
    const attrs = [`type=${jsxString(a.type ?? "text")}`];
    if (a.placeholder) attrs.push(`placeholder=${jsxString(a.placeholder)}`);
    if (a.value) attrs.push(`defaultValue=${jsxString(a.value)}`);
    return `${pad}<input ${attrs.join(" ")} style={${JSON.stringify(cssFrom(node, tokens, { ...ctx, isRoot: false }))}} />`;
  }
  if (node.tag === "textarea") {
    return `${pad}<textarea placeholder=${jsxString(node.attrs?.placeholder ?? "")} style={${JSON.stringify(css)}} />`;
  }
  if (node.tag === "select") return `${pad}<select aria-label="Select" style={${JSON.stringify(css)}} />`;
  if (tag === "hr") return `${pad}<hr style={${JSON.stringify(css)}} />`;
  if (node.tag === "br") return `${pad}<br />`;

  const attrs: string[] = [];
  if (tag === "a") attrs.push(`href=${jsxString(node.attrs?.href ?? "#")}`);
  if (tag === "button") attrs.push(`type="button"`);
  if (node.attrs?.ariaLabel) attrs.push(`aria-label=${jsxString(node.attrs.ariaLabel)}`);
  if (Object.keys(css).length) attrs.push(`style={${JSON.stringify(css)}}`);
  const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;

  // Treat children as columns only when together they fill most of the row (e.g. text + image), not for nav link groups.
  const kidsWidth = (node.children ?? []).reduce((sum, c) => sum + (c.tag === "#text" ? 0 : c.w ?? 0), 0);
  const isFlexRow = css.display === "flex" && css.flexDirection === "row" && (node.w ?? 0) > 0 && kidsWidth / (node.w ?? 1) > 0.8;
  if (node.children?.some((c) => (c.style as Style | undefined)?.position === "absolute") && !css.position) css.position = "relative";
  const childAncestors = [...ancestors, tag];
  const children: string[] = [];
  if (node.text) children.push(`${pad}  ${jsxString(node.text)}`);
  for (const c of node.children ?? []) {
    children.push(render(c, tokens, depth + 1, childAncestors, { isRoot: false, parentFlexRow: isFlexRow, sticky: false }));
  }
  if (!children.length) return `${pad}${open.replace(/>$/, " />")}`;
  return `${pad}${open}\n${children.join("\n")}\n${pad}</${tag}>`;
}

/** Places a section the way the original page did: its width, horizontal alignment and the space above it. */
function placement(section: SectionSpec): Style {
  const out: Style = {};
  if (section.gapBefore > 0) out.marginTop = section.gapBefore > 32 ? `min(${section.gapBefore}px, 8vw)` : `${section.gapBefore}px`;
  if (section.align !== "full") {
    out.width = "100%";
    out.maxWidth = `${section.rect.w}px`;
    out.boxSizing = "border-box";
    if (section.align === "center") {
      out.marginLeft = "auto";
      out.marginRight = "auto";
    } else {
      out.marginLeft = `clamp(16px, ${((section.rect.x / 1440) * 100).toFixed(2)}vw, ${section.rect.x}px)`;
      out.paddingRight = "16px";
    }
  }
  return out;
}

export function fallbackComponent(section: SectionSpec, tokens: DesignTokens): string {
  const body = render(section.node, tokens, 0, [], { isRoot: true, parentFlexRow: false, sticky: section.sticky, rootExtra: placement(section) });
  return `// Generated deterministically from the captured layout of the "${section.kind}" section.
export default function ${section.name}() {
  return (
${body}
  );
}
`;
}
