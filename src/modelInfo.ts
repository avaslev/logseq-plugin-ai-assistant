// Best-effort context-window detection (F25). OpenAI-compatible APIs report
// the window only on some servers, so the probe walks the common shapes:
// /models metadata (OpenRouter, vLLM, LM Studio), LM Studio's native API,
// Ollama's /api/show and llama.cpp's /props. Results are cached; when every
// probe fails a conservative fallback keeps the agent working.

import { fetchWithTimeout, readResponseText } from "./http";

export const FALLBACK_CONTEXT_WINDOW = 32768;
export const MAX_TOOL_ROUNDS = 24;
export const ANSWER_RESERVE_TOKENS = 2048;
export const MIN_RESPONSE_TOKENS = 256;
export const MAX_RESPONSE_TOKENS = 8192;
const ROUND_COST_TOKENS = 2048;
const DETECT_TIMEOUT_MS = 2500;
const CACHE_TTL_MS = 10 * 60 * 1000;

const CONTEXT_FIELDS = [
  "context_length",
  "max_model_len",
  "max_context_length",
  "context_window",
];

interface CacheEntry {
  value: number | null;
  at: number;
}

const cache = new Map<string, CacheEntry>();

export function resetModelInfoCache(): void {
  cache.clear();
}

function readPositiveInt(value: unknown): number | null {
  const num =
    typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num) || num <= 0) {
    return null;
  }
  return Math.floor(num);
}

function readContextFields(item: Record<string, unknown>): number | null {
  for (const field of CONTEXT_FIELDS) {
    const value = readPositiveInt(item[field]);
    if (value) return value;
  }
  const provider = item.top_provider ?? item.topProvider;
  if (provider && typeof provider === "object") {
    const value = readPositiveInt(
      (provider as Record<string, unknown>).context_length
    );
    if (value) return value;
  }
  return null;
}

function payloadItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
}

function matchesModel(id: string, model: string): boolean {
  if (id === model) return true;
  return id.endsWith(`/${model}`) || model.endsWith(`/${id}`);
}

// Shared by /models and LM Studio's /api/v0/models: both return { data: [...] }.
export function findModelContext(
  payload: unknown,
  model: string
): number | null {
  const items = payloadItems(payload).filter(
    (item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item)
  );
  const named = items.filter(
    (item) => typeof item.id === "string" && matchesModel(item.id, model)
  );
  const candidates = named.length > 0 ? named : items;
  for (const item of candidates) {
    const value = readContextFields(item);
    if (value) return value;
  }
  return null;
}

export function findOllamaContext(payload: unknown): number | null {
  // An explicit num_ctx is the runtime window and wins over the model's
  // theoretical maximum, which can be much larger than what Ollama loads.
  const parameters = (payload as { parameters?: unknown } | null)?.parameters;
  if (typeof parameters === "string") {
    const match = parameters.match(/(?:^|\n)\s*num_ctx\s+(\d+)/);
    if (match) {
      const context = readPositiveInt(match[1]);
      if (context) return context;
    }
  }
  const info = (payload as { model_info?: unknown } | null)?.model_info;
  if (info && typeof info === "object") {
    for (const [key, value] of Object.entries(
      info as Record<string, unknown>
    )) {
      if (!key.endsWith(".context_length")) continue;
      const context = readPositiveInt(value);
      if (context) return context;
    }
  }
  return null;
}

export function findLlamaContext(payload: unknown): number | null {
  const settings = (
    payload as { default_generation_settings?: unknown } | null
  )?.default_generation_settings;
  if (settings && typeof settings === "object") {
    const context = readPositiveInt(
      (settings as Record<string, unknown>).n_ctx
    );
    if (context) return context;
  }
  return readPositiveInt((payload as { n_ctx?: unknown } | null)?.n_ctx);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function apiRoot(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function isLocalHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

async function fetchJson(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<unknown> {
  try {
    const res = await fetchWithTimeout(url, init, {
      signal,
      timeoutMs: DETECT_TIMEOUT_MS,
    });
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readResponseText(res, DETECT_TIMEOUT_MS);
    return JSON.parse(text) as unknown;
  } catch {
    signal?.throwIfAborted();
    return null;
  }
}

function baseHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function probe(
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<number | null> {
  const headers = baseHeaders(apiKey);
  const models = await fetchJson(
    joinUrl(baseUrl, "models"),
    { headers, signal },
    signal
  );
  const fromModels = findModelContext(models, model);
  if (fromModels) return fromModels;
  if (!isLocalHost(baseUrl)) return null;

  const root = apiRoot(baseUrl);

  const lmStudio = await fetchJson(
    `${root}/api/v0/models`,
    { headers, signal },
    signal
  );
  const fromLmStudio = findModelContext(lmStudio, model);
  if (fromLmStudio) return fromLmStudio;

  const ollama = await fetchJson(
    `${root}/api/show`,
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model }),
      signal,
    },
    signal
  );
  const fromOllama = findOllamaContext(ollama);
  if (fromOllama) return fromOllama;

  const props = await fetchJson(
    `${root}/props`,
    { headers, signal },
    signal
  );
  return findLlamaContext(props);
}

export async function detectContextWindow(
  baseUrl: string,
  apiKey: string,
  model: string,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted();
  const key = `${baseUrl}::${model}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value ?? FALLBACK_CONTEXT_WINDOW;
  }
  const value = await probe(baseUrl, apiKey, model, signal);
  cache.set(key, { value, at: Date.now() });
  return value ?? FALLBACK_CONTEXT_WINDOW;
}

// How many tool rounds fit between the prompt already built and the room
// reserved for the final answer. Each round adds a tool result (capped at
// 8000 chars) plus the assistant tool call back into the context.
export function computeMaxToolRounds(
  contextWindow: number,
  promptTokens: number
): number {
  const available = contextWindow - promptTokens - ANSWER_RESERVE_TOKENS;
  if (available < ROUND_COST_TOKENS) return 1;
  return Math.max(
    1,
    Math.min(MAX_TOOL_ROUNDS, Math.floor(available / ROUND_COST_TOKENS))
  );
}

// Room left for conversation history after the system prompt, tool schemas
// and the answer reserve.
export function computeHistoryBudget(
  contextWindow: number,
  overheadTokens: number
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return 0;
  return Math.max(0, contextWindow - overheadTokens - ANSWER_RESERVE_TOKENS);
}

// Output limit for one request: the rest of the window, clamped so the model
// neither starves the answer nor generates an absurdly long one.
export function computeResponseTokenBudget(
  contextWindow: number,
  promptTokens: number
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return MAX_RESPONSE_TOKENS;
  }
  const available = contextWindow - promptTokens - ANSWER_RESERVE_TOKENS;
  return Math.max(
    MIN_RESPONSE_TOKENS,
    Math.min(MAX_RESPONSE_TOKENS, Math.floor(available))
  );
}
