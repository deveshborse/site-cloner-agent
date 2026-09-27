import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, config, llmEnabled } from "./config.ts";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ContentPart[] };

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  json?: boolean;
  maxTokens?: number;
  temperature?: number;
  /** Short label used in logs and the cost breakdown. */
  label: string;
}

export interface Usage {
  calls: number;
  cachedCalls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Minimal counting semaphore so several sections can generate in parallel without hitting rate limits. */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Provider-specific request fields. Reasoning models spend output tokens on hidden thinking, which can truncate a
 * generated component, so on Groq thinking is switched off for Qwen and kept low for GPT-OSS unless overridden.
 */
export function extraBodyFor(model: string): Record<string, unknown> {
  const override = model === config.llm.fastModel && model !== config.llm.mainModel ? config.llm.extraFast : config.llm.extraMain;
  if (override.trim()) {
    try {
      return JSON.parse(override) as Record<string, unknown>;
    } catch {
      throw new LlmError(`Invalid JSON in LLM_EXTRA_MAIN/LLM_EXTRA_FAST: ${override}`);
    }
  }
  if (!config.llm.baseUrl.includes("groq.com")) return {};
  if (/qwen/i.test(model)) return { reasoning_effort: "none" };
  if (/gpt-oss/i.test(model)) return { reasoning_effort: "low" };
  return {};
}

/**
 * OpenAI-compatible chat client with retries, rate-limit backoff, a disk cache and token/cost accounting.
 * One client is created per job so every job reports its own cost.
 */
export class LlmClient {
  readonly usage: Usage = { calls: 0, cachedCalls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  private static gate = new Semaphore(config.llm.concurrency);

  constructor(private readonly log: (msg: string) => void = () => {}) {}

  get enabled() {
    return llmEnabled();
  }

  async chat(req: ChatRequest): Promise<string> {
    if (!this.enabled) throw new LlmError("LLM is disabled (no LLM_API_KEY set)");
    const model = req.model ?? config.llm.mainModel;
    const body: Record<string, unknown> = {
      model,
      messages: req.messages,
      temperature: req.temperature ?? 0.2,
      max_tokens: req.maxTokens ?? config.llm.maxTokens,
    };
    if (req.json) body.response_format = { type: "json_object" };
    Object.assign(body, extraBodyFor(model));

    const key = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const cached = await this.readCache(key);
    if (cached !== null) {
      this.usage.cachedCalls++;
      this.log(`LLM ${req.label}: cache hit (no cost)`);
      return cached;
    }

    const text = await LlmClient.gate.run(() => this.send(body, req.label));
    await this.writeCache(key, text);
    return text;
  }

  private async send(body: Record<string, unknown>, label: string): Promise<string> {
    const maxAttempts = 5;
    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      let res: Response;
      try {
        res = await fetch(`${config.llm.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.llm.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(config.llm.timeoutMs),
        });
      } catch (err) {
        if (attempt >= maxAttempts) throw new LlmError(`Network error calling LLM: ${(err as Error).message}`);
        await this.backoff(attempt, undefined, label, "network error");
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxAttempts) throw new LlmError(`LLM returned ${res.status} after ${attempt} attempts`, res.status);
        await this.backoff(attempt, res.headers.get("retry-after"), label, `HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 500);
        throw new LlmError(`LLM returned ${res.status}: ${detail}`, res.status);
      }

      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      // Reasoning models may inline their chain of thought; it is never part of the answer.
      const text = (data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      const pIn = data.usage?.prompt_tokens ?? 0;
      const pOut = data.usage?.completion_tokens ?? 0;
      this.usage.calls++;
      this.usage.promptTokens += pIn;
      this.usage.completionTokens += pOut;
      this.usage.costUsd += (pIn * config.llm.priceInPerM + pOut * config.llm.priceOutPerM) / 1_000_000;
      this.log(`LLM ${label}: ${pIn} in / ${pOut} out tokens in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      if (!text.trim()) throw new LlmError("LLM returned an empty response");
      return text;
    }
  }

  private async backoff(attempt: number, retryAfter: string | null | undefined, label: string, why: string) {
    const fromHeader = retryAfter ? Number(retryAfter) * 1000 : NaN;
    const wait = Number.isFinite(fromHeader) ? Math.min(fromHeader, 60_000) : Math.min(2 ** attempt * 1000, 30_000) + Math.random() * 500;
    this.log(`LLM ${label}: ${why}, retrying in ${(wait / 1000).toFixed(1)}s`);
    await sleep(wait);
  }

  private async readCache(key: string): Promise<string | null> {
    if (!config.llm.cache) return null;
    try {
      return await fs.readFile(path.join(CACHE_DIR, "llm", `${key}.txt`), "utf8");
    } catch {
      return null;
    }
  }

  private async writeCache(key: string, text: string) {
    if (!config.llm.cache) return;
    await fs.mkdir(path.join(CACHE_DIR, "llm"), { recursive: true });
    await fs.writeFile(path.join(CACHE_DIR, "llm", `${key}.txt`), text, "utf8");
  }
}

/** Pulls the code out of a model reply: the first tsx/ts/jsx fenced block, or the whole reply if it already looks like code. */
export function extractCode(reply: string): string {
  const fence = /```(?:tsx|typescript|ts|jsx|javascript|js|react)?[^\n]*\n([\s\S]*?)```/i.exec(reply);
  if (fence) return fence[1].trim() + "\n";
  const trimmed = reply.trim();
  if (/^("use client"|'use client'|import |export )/.test(trimmed)) return trimmed + "\n";
  throw new LlmError("Model reply did not contain a code block");
}

/** Parses JSON from a model reply, tolerating code fences and surrounding prose. */
export function extractJson<T = unknown>(reply: string): T {
  const cleaned = reply.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new LlmError("Model reply did not contain JSON");
  return JSON.parse(cleaned.slice(start, end + 1)) as T;
}
