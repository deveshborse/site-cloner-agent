import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { config, GENERATED_DIR, ROOT } from "./config.ts";

interface PreviewServer {
  proc: ChildProcess;
  port: number;
  url: string;
  publicUrl: string;
  ready: Promise<void>;
  logs: string[];
}

const servers = new Map<string, PreviewServer>();

/** When true, previews are only reachable through the main server's /preview/:slug proxy
 *  (needed on hosts like Render that expose a single public port). */
const PROXY_MODE = config.previewProxy;

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, "127.0.0.1");
  });
}

async function freePort(): Promise<number> {
  const used = new Set([...servers.values()].map((s) => s.port));
  for (let p = config.previewPortStart; p < config.previewPortStart + 200; p++) {
    if (!used.has(p) && (await portFree(p))) return p;
  }
  throw new Error("No free port for the preview server");
}

async function waitForHttp(url: string, timeoutMs: number, proc: ChildProcess, logs: string[]) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Preview server exited: ${logs.slice(-15).join("")}`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      await res.arrayBuffer();
      return; // any HTTP answer (even 500) means the server is up; errors are handled by the runtime check
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("Preview server did not start in time");
}

/** Starts (or reuses) a `next dev` server for a generated site and resolves once the page has compiled. */
export async function ensurePreview(slug: string, log: (m: string) => void = () => {}): Promise<string> {
  const existing = servers.get(slug);
  if (existing && existing.proc.exitCode === null) {
    await existing.ready;
    return existing.url;
  }
  const port = await freePort();
  const siteDir = path.join(GENERATED_DIR, slug);
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const basePath = PROXY_MODE ? `/preview/${slug}` : "";
  log(`Starting preview server on port ${port}`);
  const proc = spawn(process.execPath, [nextBin, "dev", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: siteDir,
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      BROWSER: "none",
      PORT: String(port),
      ...(basePath ? { PREVIEW_BASE_PATH: basePath } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const keep = (d: Buffer) => {
    logs.push(d.toString());
    if (logs.length > 200) logs.shift();
  };
  proc.stdout?.on("data", keep);
  proc.stderr?.on("data", keep);
  const url = `http://127.0.0.1:${port}${basePath}`;
  const publicUrl = PROXY_MODE ? basePath : url;
  const server: PreviewServer = { proc, port, url, publicUrl, logs, ready: waitForHttp(url, 240_000, proc, logs) };
  servers.set(slug, server);
  proc.on("exit", () => {
    if (servers.get(slug) === server) servers.delete(slug);
  });
  try {
    await server.ready;
  } catch (err) {
    stopPreview(slug);
    throw err;
  }
  return url;
}

export function previewLogs(slug: string): string {
  return servers.get(slug)?.logs.join("") ?? "";
}

export function previewUrl(slug: string): string | null {
  return servers.get(slug)?.publicUrl ?? null;
}

/** Internal port for a running preview server, used by the /preview proxy. */
export function previewPort(slug: string): number | null {
  const s = servers.get(slug);
  return s && s.proc.exitCode === null ? s.port : null;
}

export function stopPreview(slug: string) {
  const s = servers.get(slug);
  if (!s) return;
  servers.delete(slug);
  killTree(s.proc);
}

export function stopAllPreviews() {
  for (const slug of [...servers.keys()]) stopPreview(slug);
}

function killTree(proc: ChildProcess) {
  if (proc.pid === undefined || proc.exitCode !== null) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  else proc.kill("SIGTERM");
}
