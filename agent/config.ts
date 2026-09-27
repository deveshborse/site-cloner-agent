import "dotenv/config";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const GENERATED_DIR = path.join(ROOT, "generated");
export const CACHE_DIR = path.join(ROOT, ".cache");

const env = process.env;
const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === "" ? d : v === "true" || v === "1");

export const config = {
  port: num(env.PORT, 4000),
  llm: {
    /** Any OpenAI-compatible Chat Completions endpoint (Groq, OpenAI, Anthropic, Gemini, OpenRouter, Ollama...). */
    baseUrl: (env.LLM_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
    apiKey: env.LLM_API_KEY ?? "",
    /** Main model: writes and repairs components. Should support image input when LLM_VISION=true. */
    mainModel: env.LLM_MODEL_MAIN ?? "qwen/qwen3.8-27b",
    /** Fast, cheap model: plans modifications. */
    fastModel: env.LLM_MODEL_FAST ?? "openai/gpt-oss-20b",
    vision: bool(env.LLM_VISION, true),
    concurrency: num(env.LLM_CONCURRENCY, 2),
    maxTokens: num(env.LLM_MAX_TOKENS, 6000),
    /** USD per 1M tokens for the main model, used only for the cost estimate shown in the studio (0 = show tokens only). */
    priceInPerM: num(env.LLM_PRICE_IN, 0),
    priceOutPerM: num(env.LLM_PRICE_OUT, 0),
    /** Extra provider-specific request fields as JSON, e.g. {"reasoning_effort":"none"}. Empty = sensible defaults. */
    extraMain: env.LLM_EXTRA_MAIN ?? "",
    extraFast: env.LLM_EXTRA_FAST ?? "",
    cache: bool(env.LLM_CACHE, true),
    timeoutMs: num(env.LLM_TIMEOUT_MS, 120_000),
  },
  maxRepairAttempts: num(env.MAX_REPAIR_ATTEMPTS, 2),
  refinePasses: num(env.REFINE_PASSES, 1),
  refineThreshold: num(env.REFINE_THRESHOLD, 0.8),
  refineMaxSections: num(env.REFINE_MAX_SECTIONS, 3),
  runNextBuild: bool(env.VALIDATE_NEXT_BUILD, false),
  previewPortStart: num(env.PREVIEW_PORT_START, 4100),
  /** Proxy generated-site previews through the main server at /preview/:slug instead of exposing raw ports.
   *  Needed on hosts (Render, Railway, Fly...) that only route a single public port. */
  previewProxy: bool(env.PREVIEW_PROXY, false),
  maxSections: num(env.MAX_SECTIONS, 18),
  maxAssets: num(env.MAX_ASSETS, 80),
};

/** The agent runs fully offline (deterministic generator only) when no key is set or LLM_PROVIDER=none. */
export function llmEnabled(): boolean {
  return Boolean(config.llm.apiKey) && env.LLM_PROVIDER !== "none";
}
