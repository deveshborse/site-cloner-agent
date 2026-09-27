import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { config, ROOT } from "./config.ts";
import { deriveTokens, isWebFont, type PageStats } from "./colors.ts";
import type { SectionSpec, SiteSpec, SpecNode } from "./types.ts";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };
const MAX_SHOT_HEIGHT = 16000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

interface RawSection {
  id: string;
  kind: string;
  rect: SectionSpec["rect"];
  fullBleed: boolean;
  sticky: boolean;
  background: string;
  heading: string;
  node: SpecNode;
  truncated: boolean;
  desktopCols: number;
  navLinksDesktop: number;
}
interface RawAsset {
  id: string;
  kind: "img" | "svg";
  url?: string;
  svg?: string;
}
interface RawExtract {
  title: string;
  description: string;
  lang: string;
  pageHeight: number;
  viewport: { w: number; h: number };
  sections: RawSection[];
  assets: RawAsset[];
  stats: PageStats;
  fonts: { body: string; heading: string };
  pageBg: string;
}
type RawMobile = Record<string, { rect: SectionSpec["rect"]; cols: number; navLinks: number; menuButton: boolean }>;

let sharedBrowser: Browser | null = null;
export async function getBrowser(): Promise<Browser> {
  if (!sharedBrowser || !sharedBrowser.isConnected()) sharedBrowser = await chromium.launch({ headless: true });
  return sharedBrowser;
}
export async function closeBrowser() {
  await sharedBrowser?.close().catch(() => {});
  sharedBrowser = null;
}

const script = async (name: string) => fs.readFile(path.join(ROOT, "agent", "browser", name), "utf8");

async function settle(page: Page) {
  // Jump animations/transitions to their end state so fade-in content is captured.
  await page
    .addStyleTag({
      content: "*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important;scroll-behavior:auto!important;caret-color:transparent!important}",
    })
    .catch(() => {});
  // Scroll through the page to trigger lazy-loaded images and scroll-reveal effects.
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    for (let i = 0; i < 60; i++) {
      window.scrollBy(0, step);
      await new Promise((r) => setTimeout(r, 120));
      if (window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) break;
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
  await page.waitForTimeout(600);
}

/**
 * Stage 1 of the pipeline. Loads the URL in headless Chromium, captures desktop and mobile screenshots,
 * extracts sections + simplified DOM + styles, downloads assets, and derives design tokens.
 */
export async function analyzeSite(url: string, siteDir: string, log: (m: string) => void): Promise<SiteSpec> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1, userAgent: USER_AGENT, ignoreHTTPSErrors: true, locale: "en-US" });
  const page = await context.newPage();
  try {
    log(`Opening ${url}`);
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    } catch (err) {
      throw new Error(`Could not load ${url}: ${(err as Error).message.split("\n")[0]}`);
    }
    if (response && response.status() >= 400) log(`Warning: server answered HTTP ${response.status()}; continuing with what rendered`);
    await page.waitForLoadState("load", { timeout: 20_000 }).catch(() => log("Page 'load' event timed out; continuing"));
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    const bodyText = (await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "")).toLowerCase();
    if (/just a moment|verify you are human|checking your browser|access denied/.test(bodyText) && bodyText.length < 300) {
      throw new Error("The site served a bot-protection page instead of its content (Cloudflare or similar).");
    }
    await settle(page);

    log("Extracting layout, sections, styles and assets");
    const raw = (await page.evaluate(
      (await script("extract.js")).replace("__OPTS__", JSON.stringify({ maxSections: config.maxSections, maxAssets: config.maxAssets, nodeBudget: 170 }))
    )) as RawExtract;
    if (!raw.sections.length) throw new Error("No visible content found on the page.");

    const cloneDir = path.join(siteDir, ".clone");
    await fs.mkdir(cloneDir, { recursive: true });
    const shotHeight = Math.min(raw.pageHeight, MAX_SHOT_HEIGHT);
    await page.screenshot({ path: path.join(cloneDir, "original-desktop.png"), fullPage: true, clip: { x: 0, y: 0, width: DESKTOP.width, height: shotHeight } });

    log("Measuring responsive layout at 390px");
    await page.setViewportSize(MOBILE);
    await page.waitForTimeout(700);
    const mobile = (await page.evaluate(await script("mobile.js"))) as RawMobile;
    const mobileHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: path.join(cloneDir, "original-mobile.png"), fullPage: true, clip: { x: 0, y: 0, width: MOBILE.width, height: Math.min(mobileHeight, MAX_SHOT_HEIGHT) } });

    log(`Downloading ${raw.assets.length} assets`);
    const assetPaths = await downloadAssets(raw.assets, path.join(siteDir, "public", "assets"), context.request, log);

    const fonts = [...new Set([raw.fonts.heading, raw.fonts.body])].filter(isWebFont);
    const tokens = deriveTokens(raw.stats, raw.fonts, raw.pageBg);
    const names = new Map<string, number>();
    const vw = raw.viewport.w;
    const sections: SectionSpec[] = raw.sections.map((s, i) => {
      const m = mobile[s.id];
      const prev = raw.sections[i - 1];
      const gapBefore = Math.max(0, Math.round(s.rect.y - (prev ? prev.rect.y + prev.rect.h : 0)));
      const center = s.rect.x + s.rect.w / 2;
      const align: SectionSpec["align"] = s.fullBleed ? "full" : Math.abs(center - vw / 2) < 24 ? "center" : "left";
      return {
        gapBefore: s.sticky && i === 0 ? 0 : gapBefore,
        align,
        id: s.id,
        kind: s.kind,
        name: componentName(s.kind, i, names),
        rect: s.rect,
        mobileRect: m?.rect,
        fullBleed: s.fullBleed,
        sticky: s.sticky,
        background: s.background,
        heading: s.heading,
        node: resolveAssets(s.node, assetPaths),
        truncated: s.truncated,
        responsive: {
          desktopCols: s.desktopCols,
          mobileCols: m?.cols ?? 1,
          navLinksDesktop: s.navLinksDesktop,
          navLinksMobile: m?.navLinks ?? 0,
          menuButtonMobile: m?.menuButton ?? false,
          mobileHeight: m?.rect.h ?? 0,
        },
      };
    });

    return {
      url,
      finalUrl: page.url(),
      title: raw.title,
      description: raw.description,
      lang: raw.lang,
      viewport: raw.viewport,
      pageHeight: raw.pageHeight,
      tokens,
      fonts,
      sections,
      assetCount: assetPaths.size,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

const KIND_NAMES: Record<string, string> = {
  navbar: "Navbar", hero: "Hero", footer: "Footer", pricing: "Pricing", testimonials: "Testimonials", faq: "Faq",
  logos: "Logos", newsletter: "Newsletter", contact: "Contact", features: "Features", stats: "Stats", cta: "CallToAction",
  blog: "Blog", content: "Section",
};

export function componentName(kind: string, index: number, used: Map<string, number>): string {
  const base = KIND_NAMES[kind] ?? "Section";
  const count = (used.get(base) ?? 0) + 1;
  used.set(base, count);
  if (base === "Section") return `Section${index + 1}`;
  return count === 1 ? base : `${base}${count}`;
}

function resolveAssets(node: SpecNode, paths: Map<string, string>): SpecNode {
  const fix = (v: string | undefined) => (v && v.startsWith("@asset:") ? paths.get(v.slice(7)) : v);
  const out: SpecNode = { ...node };
  if (out.asset) {
    const p = fix(out.asset);
    if (p) out.asset = p;
    else delete out.asset;
  }
  if (out.style?.bgImage) {
    const p = fix(String(out.style.bgImage));
    out.style = { ...out.style };
    if (p) out.style.bgImage = p;
    else delete out.style.bgImage;
  }
  if (out.children) out.children = out.children.map((c) => resolveAssets(c, paths));
  return out;
}

const EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "image/svg+xml": "svg", "image/avif": "avif", "image/x-icon": "ico", "image/vnd.microsoft.icon": "ico",
};

async function downloadAssets(
  assets: RawAsset[],
  dir: string,
  request: import("playwright").APIRequestContext,
  log: (m: string) => void
): Promise<Map<string, string>> {
  await fs.mkdir(dir, { recursive: true });
  const result = new Map<string, string>();
  let failed = 0;
  const queue = [...assets];
  const worker = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      try {
        if (a.kind === "svg" && a.svg) {
          await fs.writeFile(path.join(dir, `${a.id}.svg`), a.svg, "utf8");
          result.set(a.id, `/assets/${a.id}.svg`);
          continue;
        }
        if (!a.url) continue;
        let body: Buffer;
        let type = "";
        if (a.url.startsWith("data:")) {
          const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(a.url);
          if (!m) continue;
          type = m[1];
          body = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]));
        } else {
          const res = await request.get(a.url, { timeout: 20_000 });
          if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
          type = (res.headers()["content-type"] ?? "").split(";")[0].trim();
          body = await res.body();
        }
        if (body.length > 6 * 1024 * 1024) throw new Error("too large");
        const ext = EXT[type] ?? (/\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.exec(a.url)?.[1]?.toLowerCase().replace("jpeg", "jpg") ?? "png");
        await fs.writeFile(path.join(dir, `${a.id}.${ext}`), body);
        result.set(a.id, `/assets/${a.id}.${ext}`);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (failed) log(`${failed} asset(s) could not be downloaded; placeholders will be used`);
  return result;
}
