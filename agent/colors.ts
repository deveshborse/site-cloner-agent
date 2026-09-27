import type { DesignTokens } from "./types.ts";

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function saturation(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
}

export function colorDistance(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return 999;
  return Math.sqrt((x[0] - y[0]) ** 2 + (x[1] - y[1]) ** 2 + (x[2] - y[2]) ** 2);
}

export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 1;
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Nudges a colour lighter (amount > 0) or darker (amount < 0). */
export function shade(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const out = rgb.map((v) => Math.round(amount > 0 ? v + (255 - v) * amount : v * (1 + amount)));
  return "#" + out.map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join("");
}

export const NAMED_COLORS: Record<string, string> = {
  blue: "#2563eb", "light blue": "#38bdf8", "dark blue": "#1e3a8a", navy: "#1e3a8a", sky: "#0ea5e9",
  indigo: "#4f46e5", purple: "#7c3aed", violet: "#7c3aed", pink: "#db2777", magenta: "#c026d3",
  red: "#dc2626", orange: "#ea580c", amber: "#f59e0b", yellow: "#eab308", gold: "#ca8a04",
  green: "#16a34a", "dark green": "#166534", emerald: "#059669", lime: "#65a30d", teal: "#0d9488",
  cyan: "#0891b2", brown: "#92400e", black: "#111111", white: "#ffffff", gray: "#6b7280", grey: "#6b7280",
};

/** Accepts "#abc", "#aabbcc" or a colour name and returns a 7-character hex, or null. */
export function normalizeColor(input: string): string | null {
  const v = input.trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v];
  const short = /^#?([0-9a-f]{3})$/.exec(v);
  if (short) return "#" + short[1].split("").map((c) => c + c).join("");
  const full = /^#?([0-9a-f]{6})$/.exec(v);
  return full ? "#" + full[1] : null;
}

const SYSTEM_FONTS = new Set([
  "", "system-ui", "-apple-system", "blinkmacsystemfont", "segoe ui", "helvetica", "helvetica neue", "arial",
  "sans-serif", "serif", "monospace", "times new roman", "times", "georgia", "ui-sans-serif", "ui-serif",
  "ui-monospace", "verdana", "tahoma", "courier new", "cursive", "fantasy", "apple color emoji",
]);

export function isWebFont(name: string): boolean {
  return !SYSTEM_FONTS.has(name.trim().toLowerCase());
}

/** Maps self-hosted variants such as "Inter Variable" or "Geist VF" to the family name Google Fonts uses. */
export function googleFontFamily(name: string): string {
  return name.replace(/[-\s]*(variable|vf|var|web|display\s*vf)$/i, "").trim();
}

export interface PageStats {
  text: Record<string, number>;
  bg: Record<string, number>;
  button: Record<string, number>;
  link: Record<string, number>;
  border: Record<string, number>;
  radius: Record<string, number>;
  container: Record<string, number>;
}

const ranked = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([k]) => k && k !== "null")
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

/** Turns raw colour/size statistics from the page into a small set of named design tokens. */
export function deriveTokens(stats: PageStats, fonts: { body: string; heading: string }, pageBg: string): DesignTokens {
  const solid = (c: string) => /^#[0-9a-f]{6}$/i.test(c);
  const background = solid(pageBg) ? pageBg : ranked(stats.bg).find(solid) ?? "#ffffff";
  const texts = ranked(stats.text).filter(solid);
  const foreground = texts[0] ?? (luminance(background) > 0.4 ? "#111111" : "#f5f5f5");
  const muted = texts.find((c) => colorDistance(c, foreground) > 40 && colorDistance(c, background) > 60 && saturation(c) < 0.3) ?? shade(foreground, 0.35);

  const saturated = (c: string) => solid(c) && saturation(c) > 0.25 && colorDistance(c, background) > 60;
  const primary =
    ranked(stats.button).find(saturated) ??
    ranked(stats.link).find(saturated) ??
    ranked(stats.bg).find(saturated) ??
    texts.find(saturated) ??
    ranked(stats.button).find((c) => solid(c) && colorDistance(c, background) > 60) ??
    foreground;

  const surface = ranked(stats.bg).find((c) => solid(c) && colorDistance(c, background) > 6 && colorDistance(c, primary) > 30) ?? shade(background, luminance(background) > 0.5 ? -0.04 : 0.08);
  const border = ranked(stats.border).find(solid) ?? shade(background, luminance(background) > 0.5 ? -0.12 : 0.18);
  const radiusPx = Number(ranked(stats.radius)[0] ?? 8);
  const container = Number(ranked(stats.container)[0] ?? 1200);

  return {
    primary,
    background,
    foreground,
    muted,
    surface,
    border,
    headingFont: fonts.heading || fonts.body || "Inter",
    bodyFont: fonts.body || "Inter",
    radius: `${Math.min(Number.isFinite(radiusPx) ? radiusPx : 8, 9999)}px`,
    containerWidth: Math.min(Math.max(Number.isFinite(container) ? container : 1200, 960), 1600),
  };
}
