import fs from "node:fs/promises";
import { ServerResponse } from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import httpProxy from "http-proxy";
import { closeBrowser } from "./analyze.ts";
import { config, GENERATED_DIR, llmEnabled, ROOT } from "./config.ts";
import { createJob, getJob, reporter } from "./jobs.ts";
import { modifySite, undoLast } from "./modify.ts";
import { cloneWebsite, normalizeUrl, siteDirFor, slugFor } from "./pipeline.ts";
import { ensurePreview, previewLogs, previewPort, previewUrl, stopAllPreviews } from "./preview.ts";
import { readManifest } from "./scaffold.ts";

const app = express();

const SLUG = /^[a-z0-9-]+$/;
const validSlug = (s: unknown): s is string => typeof s === "string" && SLUG.test(s);
const fail = (res: Response, status: number, message: string) => res.status(status).json({ error: message });

// Proxies /preview/:slug/* to that site's locally-spawned `next dev` server. Registered before
// express.json()/static so request bodies and upgrade (websocket/HMR) traffic pass through untouched.
let previewProxy: ReturnType<typeof httpProxy.createProxyServer> | undefined;
const previewSlug = (url: string | undefined): string | null => {
  const m = url?.match(/^\/preview\/([a-z0-9-]+)(\/.*)?$/);
  return m && validSlug(m[1]) ? m[1] : null;
};
if (config.previewProxy) {
  previewProxy = httpProxy.createProxyServer({ ws: true });
  previewProxy.on("error", (err, _req, res) => {
    if (res instanceof ServerResponse && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  app.use(async (req, res, next) => {
    const slug = previewSlug(req.url);
    if (!slug) return next();
    try {
      await ensurePreview(slug);
    } catch (err) {
      return fail(res, 502, (err as Error).message);
    }
    const port = previewPort(slug);
    if (!port) return fail(res, 502, "preview not running");
    previewProxy!.web(req, res, { target: `http://127.0.0.1:${port}` });
  });
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "studio")));

// Serve screenshots produced by the agent (original vs clone).
app.get("/shots/:slug/:file", (req, res) => {
  const { slug, file } = req.params;
  if (!validSlug(slug) || !/^(original|clone)-(desktop|mobile)\.png$/.test(file)) return fail(res, 400, "bad request");
  res.sendFile(path.join(GENERATED_DIR, slug, ".clone", file), { dotfiles: "allow", headers: { "Cache-Control": "no-store" } }, (err) => {
    if (err && !res.headersSent) fail(res, 404, "not found");
  });
});

app.get("/api/status", (_req, res) => {
  res.json({
    llm: llmEnabled(),
    mainModel: llmEnabled() ? config.llm.mainModel : null,
    fastModel: llmEnabled() ? config.llm.fastModel : null,
    vision: config.llm.vision,
    baseUrl: llmEnabled() ? new URL(config.llm.baseUrl).host : null,
  });
});

app.post("/api/clone", (req, res) => {
  let url: string;
  try {
    url = normalizeUrl(String(req.body?.url ?? ""));
  } catch {
    return fail(res, 400, "Please enter a valid http(s) URL");
  }
  const slug = slugFor(url);
  const job = createJob("clone", slug);
  const rep = reporter(job);
  cloneWebsite(url, rep, slug).catch((err: Error) => rep.event({ type: "failed", message: err.message }));
  res.json({ jobId: job.id, slug });
});

app.post("/api/sites/:slug/modify", (req, res) => {
  const { slug } = req.params;
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!validSlug(slug)) return fail(res, 400, "bad slug");
  if (!prompt) return fail(res, 400, "Please describe the change");
  const job = createJob("modify", slug);
  const rep = reporter(job);
  modifySite(slug, prompt, rep).catch((err: Error) => rep.event({ type: "failed", message: err.message }));
  res.json({ jobId: job.id, slug });
});

app.post("/api/sites/:slug/undo", async (req, res) => {
  if (!validSlug(req.params.slug)) return fail(res, 400, "bad slug");
  try {
    const m = await undoLast(req.params.slug);
    res.json({ ok: true, manifest: m });
  } catch (err) {
    fail(res, 400, (err as Error).message);
  }
});

// Server-Sent Events: replays everything that already happened, then streams new events.
app.get("/api/jobs/:id/events", (req: Request, res: Response) => {
  const job = getJob(String(req.params.id));
  if (!job) return fail(res, 404, "job not found");
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  job.events.forEach(send);
  if (job.status !== "running") return res.end();
  const listener = (e: { type: string }) => {
    send(e);
    if (e.type === "done" || e.type === "failed") res.end();
  };
  job.listeners.add(listener);
  req.on("close", () => job.listeners.delete(listener));
});

app.get("/api/sites", async (_req, res) => {
  await fs.mkdir(GENERATED_DIR, { recursive: true });
  const dirs = await fs.readdir(GENERATED_DIR, { withFileTypes: true });
  const sites = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try {
      const m = await readManifest(path.join(GENERATED_DIR, d.name));
      sites.push({ slug: m.slug, title: m.title, sourceUrl: m.sourceUrl, similarity: m.similarity, updatedAt: m.updatedAt, sections: m.sections.length });
    } catch {
      /* incomplete run */
    }
  }
  sites.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json(sites);
});

app.get("/api/sites/:slug", async (req, res) => {
  if (!validSlug(req.params.slug)) return fail(res, 400, "bad slug");
  try {
    res.json({ manifest: await readManifest(siteDirFor(req.params.slug)), previewUrl: previewUrl(req.params.slug) });
  } catch {
    fail(res, 404, "site not found");
  }
});

app.post("/api/sites/:slug/preview", async (req, res) => {
  if (!validSlug(req.params.slug)) return fail(res, 400, "bad slug");
  try {
    res.json({ url: await ensurePreview(req.params.slug) });
  } catch (err) {
    fail(res, 500, `${(err as Error).message}\n${previewLogs(req.params.slug).slice(-2000)}`);
  }
});

// Read-only code viewer for the generated project.
app.get("/api/sites/:slug/files", async (req, res) => {
  if (!validSlug(req.params.slug)) return fail(res, 400, "bad slug");
  const dir = siteDirFor(req.params.slug);
  const list: string[] = [];
  for (const sub of ["app", "components"]) {
    const entries = await fs.readdir(path.join(dir, sub)).catch(() => [] as string[]);
    for (const e of entries) if (/\.(tsx|ts|css)$/.test(e)) list.push(`${sub}/${e}`);
  }
  res.json(list);
});

app.get("/api/sites/:slug/file", async (req, res) => {
  const rel = String(req.query.path ?? "");
  if (!validSlug(req.params.slug) || !/^(app|components)\/[A-Za-z0-9_.-]+\.(tsx|ts|css)$/.test(rel)) return fail(res, 400, "bad path");
  try {
    res.type("text/plain").send(await fs.readFile(path.join(siteDirFor(req.params.slug), rel), "utf8"));
  } catch {
    fail(res, 404, "not found");
  }
});

const server = app.listen(config.port, () => {
  console.log(`Site Cloner Agent studio: http://localhost:${config.port}`);
  console.log(llmEnabled() ? `AI: ${config.llm.mainModel} (plans with ${config.llm.fastModel}) via ${new URL(config.llm.baseUrl).host}` : "AI: off (no LLM_API_KEY) - running in offline deterministic mode");
});

// Forwards Next.js HMR/websocket upgrades for proxied previews (see previewProxy above).
server.on("upgrade", (req, socket, head) => {
  const slug = previewSlug(req.url);
  const port = slug ? previewPort(slug) : null;
  if (!previewProxy || !port) return socket.destroy();
  previewProxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
});

const shutdown = async () => {
  stopAllPreviews();
  await closeBrowser();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
