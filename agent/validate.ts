import { spawn } from "node:child_process";
import path from "node:path";
import { ROOT } from "./config.ts";
import { getBrowser } from "./analyze.ts";

export function run(cmd: string, args: string[], cwd: string, timeoutMs = 180_000): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", FORCE_COLOR: "0" } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(err) });
    });
  });
}

/** Parses `tsc --pretty false` output into errors grouped by project-relative file. */
export function parseTscOutput(output: string): Map<string, string[]> {
  const byFile = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line.trim());
    if (!m) continue;
    const file = m[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const list = byFile.get(file) ?? [];
    list.push(`line ${m[2]}, col ${m[3]}: ${m[4]} ${m[5]}`);
    byFile.set(file, list);
  }
  return byFile;
}

export async function typecheck(siteDir: string): Promise<Map<string, string[]>> {
  const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const { code, output } = await run(process.execPath, [tsc, "--noEmit", "--pretty", "false", "-p", "tsconfig.json"], siteDir);
  const errors = parseTscOutput(output);
  if (code !== 0 && errors.size === 0) errors.set("(project)", [output.trim().slice(0, 2000) || "tsc failed"]);
  return errors;
}

export async function nextBuild(siteDir: string): Promise<{ ok: boolean; output: string }> {
  const next = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const { code, output } = await run(process.execPath, [next, "build"], siteDir, 600_000);
  return { ok: code === 0, output: output.slice(-4000) };
}

export interface RuntimeReport {
  ok: boolean;
  status: number;
  errors: string[];
  /** Component names mentioned in the errors, used to route repairs to the right file. */
  components: string[];
}

/** Loads the running preview in Chromium and collects server errors, uncaught exceptions and React errors. */
export async function runtimeCheck(url: string, componentNames: string[]): Promise<RuntimeReport> {
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`Uncaught: ${e.message}\n${(e.stack ?? "").split("\n").slice(0, 6).join("\n")}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const t = msg.text();
    if (/favicon|Failed to load resource|fonts\.g|net::ERR|Download the React DevTools/i.test(t)) return;
    errors.push(`Console error: ${t.slice(0, 800)}`);
  });
  let status = 0;
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 180_000 });
    status = res?.status() ?? 0;
    if (status >= 500) {
      const html = await page.content();
      const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      errors.unshift(`Server render failed (HTTP ${status}): ${text.slice(0, 1500)}`);
    }
    await page.waitForTimeout(1500);
  } catch (err) {
    errors.push(`Could not load preview: ${(err as Error).message.split("\n")[0]}`);
  } finally {
    await context.close().catch(() => {});
  }
  const blocking = errors.filter((e) => !/Warning: |hydrat/i.test(e) || /Uncaught|Server render/.test(e));
  const joined = errors.join("\n");
  const components = componentNames.filter((n) => new RegExp(`\\b${n}\\b|components/${n}\\.tsx`).test(joined));
  return { ok: status > 0 && status < 400 && blocking.length === 0, status, errors, components };
}
