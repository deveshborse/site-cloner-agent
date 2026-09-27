import path from "node:path";
import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { getBrowser } from "./analyze.ts";
import type { SectionSpec } from "./types.ts";

export interface SectionScore {
  id: string;
  score: number;
  cloneRect: { y: number; h: number } | null;
}

/**
 * Perceptual similarity between two crops: both are resized to the same small, slightly blurred grid and compared
 * with pixelmatch, then combined with how closely the heights match. 1 = identical, 0 = unrelated.
 */
export async function similarity(original: Buffer, clone: Buffer, origHeight: number, cloneHeight: number): Promise<number> {
  const W = 320;
  const H = Math.max(16, Math.min(1024, Math.round((origHeight * W) / 1440)));
  const prep = (b: Buffer) => sharp(b).resize(W, H, { fit: "fill" }).blur(0.6).ensureAlpha().raw().toBuffer();
  const [a, c] = await Promise.all([prep(original), prep(clone)]);
  const diff = pixelmatch(a, c, undefined, W, H, { threshold: 0.1 });
  const pixelSim = 1 - diff / (W * H);
  const heightSim = Math.min(origHeight, cloneHeight) / Math.max(origHeight, cloneHeight, 1);
  return Math.max(0, Math.min(1, 0.75 * pixelSim + 0.25 * heightSim));
}

async function crop(file: string, y: number, h: number): Promise<Buffer | null> {
  const meta = await sharp(file).metadata();
  const H = meta.height ?? 0;
  const top = Math.max(0, Math.min(Math.round(y), H - 1));
  const height = Math.max(1, Math.min(Math.round(h), H - top));
  if (height < 4) return null;
  return sharp(file).extract({ left: 0, top, width: meta.width ?? 1440, height }).png().toBuffer();
}

/** Screenshots the running clone (desktop + mobile) and scores every section against the original screenshot. */
export async function scoreClone(siteDir: string, url: string, sections: Pick<SectionSpec, "id" | "rect">[]): Promise<{ overall: number; sections: SectionScore[] }> {
  const cloneDir = path.join(siteDir, ".clone");
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 180_000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" }).catch(() => {});
    await page.waitForTimeout(500);
    const rects = (await page.evaluate(() => {
      const out: Record<string, { y: number; h: number }> = {};
      document.querySelectorAll<HTMLElement>("[data-clone-section]").forEach((w) => {
        const kids = w.children.length ? [...w.children] : [w];
        let top = Infinity;
        let bottom = -Infinity;
        for (const k of kids) {
          const r = k.getBoundingClientRect();
          if (r.height < 1) continue;
          top = Math.min(top, r.top + window.scrollY);
          bottom = Math.max(bottom, r.bottom + window.scrollY);
        }
        if (Number.isFinite(top)) out[w.dataset.cloneSection!] = { y: top, h: bottom - top };
      });
      return out;
    })) as Record<string, { y: number; h: number }>;
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    const clonePng = path.join(cloneDir, "clone-desktop.png");
    await page.screenshot({ path: clonePng, fullPage: true, clip: { x: 0, y: 0, width: 1440, height: Math.min(fullHeight, 16000) } });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const mobileHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.screenshot({ path: path.join(cloneDir, "clone-mobile.png"), fullPage: true, clip: { x: 0, y: 0, width: 390, height: Math.min(mobileHeight, 16000) } });

    const origPng = path.join(cloneDir, "original-desktop.png");
    const scores: SectionScore[] = [];
    let weighted = 0;
    let weight = 0;
    for (const s of sections) {
      const cr = rects[s.id] ?? null;
      let score = 0;
      if (cr) {
        const [a, b] = await Promise.all([crop(origPng, s.rect.y, s.rect.h), crop(clonePng, cr.y, cr.h)]);
        if (a && b) score = await similarity(a, b, s.rect.h, cr.h);
      }
      scores.push({ id: s.id, score, cloneRect: cr });
      weighted += score * s.rect.h;
      weight += s.rect.h;
    }
    return { overall: weight ? weighted / weight : 0, sections: scores };
  } finally {
    await context.close().catch(() => {});
  }
}

export async function cropToDataUrl(file: string, y: number, h: number): Promise<string | null> {
  const buf = await crop(file, y, Math.min(h, 1800));
  if (!buf) return null;
  const jpg = await sharp(buf).resize({ width: 1024, height: 1400, fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
  return `data:image/jpeg;base64,${jpg.toString("base64")}`;
}
