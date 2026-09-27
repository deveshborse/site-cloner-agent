import type { DesignTokens, SectionSpec, SpecNode } from "./types.ts";

const TOKEN_KEYS = ["primary", "background", "foreground", "muted", "surface", "border"] as const;

/** Replaces colours that equal a design token with the token name so the model reuses theme classes. */
export function tokenName(color: string, tokens: DesignTokens): string {
  const c = color.toLowerCase();
  for (const k of TOKEN_KEYS) if (tokens[k].toLowerCase() === c) return k;
  return color;
}

function fmtStyle(style: SpecNode["style"], tokens: DesignTokens): string {
  if (!style) return "";
  const parts: string[] = [];
  const s = style as Record<string, string | number>;
  if (s.display === "flex") parts.push(`flex${s.flexDirection === "column" ? " col" : " row"}${s.flexWrap ? " wrap" : ""}`);
  if (s.display === "grid") parts.push(`grid cols:${s.gridCols}`);
  if (s.display && s.display !== "flex" && s.display !== "grid") parts.push(String(s.display));
  if (s.justifyContent) parts.push(`justify:${s.justifyContent}`);
  if (s.alignItems) parts.push(`align:${s.alignItems}`);
  if (s.gap) parts.push(`gap:${s.gap}`);
  if (s.padding) parts.push(`pad:${s.padding}`);
  if (s.margin) parts.push(`margin:${s.margin}`);
  if (s.maxWidth) parts.push(`maxW:${s.maxWidth}${s.center ? " centered" : ""}`);
  else if (s.center) parts.push("centered");
  if (s.position === "absolute" && s.abs) {
    const [t, l, w, h] = String(s.abs).split(" ");
    parts.push(`absolute top:${t} left:${l} ${w}x${h}`);
  } else if (s.position === "relative") parts.push("relative");
  if (s.bg) parts.push(`bg:${tokenName(String(s.bg), tokens)}`);
  if (s.bgGradient) parts.push(`bg:${s.bgGradient}`);
  if (s.bgImage) parts.push(`bgImage:${s.bgImage}${s.bgSize ? " " + s.bgSize : ""}`);
  if (s.border) parts.push(`border:${String(s.border).replace(/#[0-9a-f]{6}/i, (m) => tokenName(m, tokens))}`);
  if (s.radius) parts.push(`radius:${s.radius}`);
  if (s.shadow) parts.push("shadow");
  if (s.position === "sticky" || s.position === "fixed") parts.push(String(s.position));
  if (s.opacity) parts.push(`opacity:${s.opacity}`);
  if (s.fontSize) parts.push(`${s.fontSize}px ${s.fontWeight ?? 400}`);
  if (s.color) parts.push(`color:${tokenName(String(s.color), tokens)}`);
  if (s.font) parts.push(`font:${s.font}`);
  if (s.lineHeight) parts.push(`lh:${s.lineHeight}`);
  if (s.letterSpacing) parts.push(`ls:${s.letterSpacing}`);
  if (s.textAlign) parts.push(String(s.textAlign));
  if (s.textTransform) parts.push(String(s.textTransform));
  if (s.italic) parts.push("italic");
  if (s.underline) parts.push("underline");
  if (s.objectFit) parts.push(`fit:${s.objectFit}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}

/** Compact, indented text form of a section tree: much cheaper in tokens than JSON or raw HTML. */
export function toOutline(node: SpecNode, tokens: DesignTokens, depth = 0, lines: string[] = []): string[] {
  const pad = "  ".repeat(depth);
  if (node.tag === "#text") {
    if (node.text?.trim()) lines.push(`${pad}"${node.text.trim()}"`);
    return lines;
  }
  if (node.tag === "br") {
    lines.push(`${pad}<br>`);
    return lines;
  }
  const size = node.w && node.h ? ` ${node.w}x${node.h}` : "";
  if (node.tag === "img") {
    const alt = node.attrs?.alt ? ` alt="${node.attrs.alt}"` : "";
    lines.push(`${pad}img ${node.asset ?? "(missing image: use a neutral placeholder block)"}${size}${alt}${fmtStyle(node.style, tokens)}`);
    return lines;
  }
  const attrs = Object.entries(node.attrs ?? {})
    .map(([k, v]) => ` ${k}="${v}"`)
    .join("");
  const text = node.text ? ` "${node.text}"` : "";
  lines.push(`${pad}${node.tag}${text}${attrs}${size}${fmtStyle(node.style, tokens)}`);
  for (const c of node.children ?? []) toOutline(c, tokens, depth + 1, lines);
  return lines;
}

export function responsiveNotes(section: SectionSpec): string {
  const r = section.responsive;
  if (!r) return "Stack content vertically on mobile.";
  const notes: string[] = [];
  if (r.desktopCols > 1) notes.push(`On desktop the main row/grid shows ${r.desktopCols} columns; at 390px wide it shows ${r.mobileCols}.`);
  if (section.kind === "navbar") {
    if (r.menuButtonMobile || r.navLinksMobile < r.navLinksDesktop / 2) notes.push("On mobile the nav links are hidden behind a menu (hamburger) button; implement a toggle.");
    else notes.push("On mobile the nav links stay visible.");
  }
  if (section.mobileRect) notes.push(`Section height: ${section.rect.h}px on desktop, ${section.mobileRect.h}px on mobile.`);
  return notes.join(" ") || "Stack content vertically on mobile.";
}

export function tokensForPrompt(t: DesignTokens): string {
  return [
    `primary ${t.primary} (classes: bg-primary text-primary border-primary)`,
    `background ${t.background} (bg-background)`,
    `foreground ${t.foreground} (text-foreground)`,
    `muted ${t.muted} (text-muted)`,
    `surface ${t.surface} (bg-surface)`,
    `border ${t.border} (border-border)`,
    `heading font "${t.headingFont}" (font-heading), body font "${t.bodyFont}" (font-body)`,
    `radius ${t.radius} (rounded-theme)`,
    `content container width ${t.containerWidth}px`,
  ].join("\n");
}
