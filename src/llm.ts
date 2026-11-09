import {
  fetchWithTimeout,
  readResponseJson,
  TimeoutError,
  withTimeout,
} from "./http";

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  // "stop", "length", "tool_calls", etc. as reported by the provider.
  finishReason?: string | null;
}

export class LlmError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export function pickModel(
  requested: string | null,
  available: string[],
  fallback: string
): string {
  if (requested && available.includes(requested)) return requested;
  if (fallback && available.includes(fallback)) return fallback;
  return available[0] || requested || fallback;
}

const NON_CHAT_MODEL =
  /(embed|rerank|cross-encoder|moderation|whisper|tts|text-to-speech|speech|dall-e|stable-diffusion|imagen|flux)/i;

export function filterChatModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    if (!model || NON_CHAT_MODEL.test(model) || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }
  return result;
}

const MODELS_TIMEOUT_MS = 15_000;
const LLM_CONNECT_TIMEOUT_MS = 30_000;
const LLM_IDLE_TIMEOUT_MS = 120_000;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function authHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function extractErrorMessage(status: number, text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const apiMessage =
      typeof parsed.error === "object"
        ? parsed.error?.message
        : typeof parsed.error === "string"
          ? parsed.error
          : parsed.message;
    if (typeof apiMessage === "string" && apiMessage.length > 0) {
      return apiMessage;
    }
  } catch {
    return `HTTP ${status} ${text.slice(0, 200)}`;
  }
  return `HTTP ${status} ${text.slice(0, 200)}`;
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      joinUrl(baseUrl, "models"),
      { headers: authHeaders(apiKey), signal },
      { signal, timeoutMs: MODELS_TIMEOUT_MS }
    );
  } catch (err) {
    if (err instanceof TimeoutError) throw new LlmError(0, err.message);
    throw err;
  }
  if (!res.ok) {
    throw new LlmError(res.status, `Failed to list models: HTTP ${res.status}`);
  }
  const data = await readResponseJson<{ data?: Array<{ id?: unknown }> }>(
    res,
    MODELS_TIMEOUT_MS
  );
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item) => item.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function stripThinkTags(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, "");
  const openIdx = out.indexOf("<think>");
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out.trim();
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function partialTagPrefixLength(text: string): number {
  const max = Math.min(THINK_OPEN.length - 1, text.length);
  for (let len = max; len > 0; len--) {
    if (THINK_OPEN.startsWith(text.slice(-len))) return len;
  }
  return 0;
}

export function createStreamAccumulator(
  onDelta: (text: string) => void,
  onReasoning?: (text: string) => void
) {
  let content = "";
  let reasoning = "";
  let inThink = false;
  let pending = "";
  let finishReason: string | null = null;
  const toolCalls = new Map<number, ToolCall>();

  const emitVisible = (text: string): void => {
    if (!text) return;
    content += text;
    onDelta(content);
  };

  const step = (): boolean => {
    if (inThink) {
      const closeIdx = pending.indexOf(THINK_CLOSE);
      if (closeIdx !== -1) {
        const chunk = pending.slice(0, closeIdx);
        pending = pending.slice(closeIdx + THINK_CLOSE.length);
        inThink = false;
        if (chunk) {
          reasoning += chunk;
          onReasoning?.(reasoning);
        }
        return true;
      }
      const hold = THINK_CLOSE.length - 1;
      if (pending.length > hold) {
        const chunk = pending.slice(0, pending.length - hold);
        pending = pending.slice(pending.length - hold);
        reasoning += chunk;
        onReasoning?.(reasoning);
      }
      return false;
    }
    const openIdx = pending.indexOf(THINK_OPEN);
    if (openIdx !== -1) {
      emitVisible(pending.slice(0, openIdx));
      pending = pending.slice(openIdx + THINK_OPEN.length);
      inThink = true;
      return true;
    }
    const hold = partialTagPrefixLength(pending);
    const safe = hold > 0 ? pending.slice(0, pending.length - hold) : pending;
    pending = hold > 0 ? pending.slice(pending.length - hold) : "";
    emitVisible(safe);
    return false;
  };

  return {
    processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: unknown;
            reasoning?: unknown;
            reasoning_content?: unknown;
            tool_calls?: unknown;
          };
          finish_reason?: unknown;
        }>;
        done_reason?: unknown;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const choice = chunk.choices?.[0];
      if (typeof choice?.finish_reason === "string" && choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
      if (typeof chunk.done_reason === "string" && chunk.done_reason) {
        finishReason = chunk.done_reason;
      }
      const delta = choice?.delta ?? {};
      const reasoningDelta =
        typeof delta.reasoning_content === "string"
          ? delta.reasoning_content
          : typeof delta.reasoning === "string"
            ? delta.reasoning
            : "";
      if (reasoningDelta.length > 0) {
        reasoning += reasoningDelta;
        onReasoning?.(reasoning);
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        pending += delta.content;
        let progressed = step();
        while (progressed) progressed = step();
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const part of delta.tool_calls as Array<{
          index?: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          const index = typeof part.index === "number" ? part.index : 0;
          const acc = toolCalls.get(index) ?? {
            id: "",
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          if (typeof part.id === "string" && part.id) acc.id = part.id;
          if (typeof part.function?.name === "string")
            acc.function.name += part.function.name;
          if (typeof part.function?.arguments === "string")
            acc.function.arguments += part.function.arguments;
          toolCalls.set(index, acc);
        }
      }
    },
    result(): ChatResult {
      if (pending) {
        if (inThink) {
          reasoning += pending;
          onReasoning?.(reasoning);
        } else {
          emitVisible(pending);
        }
        pending = "";
      }
      return {
        content: content.trim(),
        reasoning: reasoning.trim(),
        toolCalls: [...toolCalls.values()].filter(
          (call) => call.function.name.length > 0
        ),
        finishReason,
      };
    },
  };
}

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onDelta?: (accumulated: string) => void;
  onReasoning?: (accumulated: string) => void;
}

export async function chatCompletion(
  opts: ChatCompletionOptions
): Promise<ChatResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      joinUrl(opts.baseUrl, "chat/completions"),
      {
        method: "POST",
        headers: authHeaders(opts.apiKey),
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
          max_tokens:
            opts.maxTokens && opts.maxTokens > 0
              ? Math.floor(opts.maxTokens)
              : undefined,
          stream: true,
        }),
        signal: opts.signal,
      },
      {
        signal: opts.signal,
        timeoutMs: opts.timeoutMs ?? LLM_CONNECT_TIMEOUT_MS,
      }
    );
  } catch (err) {
    if (err instanceof TimeoutError) throw new LlmError(0, err.message);
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LlmError(res.status, `LLM request failed: ${extractErrorMessage(res.status, text)}`);
  }
  if (!res.body) throw new LlmError(0, "LLM response has no body");

  const acc = createStreamAccumulator(
    opts.onDelta ?? (() => {}),
    opts.onReasoning
  );
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const idleTimeoutMs = opts.idleTimeoutMs ?? LLM_IDLE_TIMEOUT_MS;
  let buffer = "";
  for (;;) {
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await withTimeout(
        reader.read(),
        idleTimeoutMs,
        "LLM stream timed out"
      );
    } catch (err) {
      await reader.cancel().catch(() => {});
      if (err instanceof TimeoutError) throw new LlmError(0, err.message);
      throw err;
    }
    const { done, value } = read;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      acc.processLine(line);
    }
  }
  if (buffer.trim()) acc.processLine(buffer);
  return acc.result();
}

export type ToolLoopEvent =
  | { type: "request"; iteration: number; maxIterations: number }
  | { type: "tool-start"; call: ToolCall }
  | { type: "tool-end"; call: ToolCall; ok: boolean; outputLength: number };

export interface ToolLoopOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  send: (messages: ChatMessage[]) => Promise<ChatResult>;
  execTool: (call: ToolCall, signal?: AbortSignal) => Promise<string>;
  maxIterations?: number;
  signal?: AbortSignal;
  onEvent?: (event: ToolLoopEvent) => void;
}

export interface ToolLoopResult {
  messages: ChatMessage[];
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  iterations: number;
  finishReason?: string | null;
}

export async function runToolLoop(
  opts: ToolLoopOptions
): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const maxIterations = opts.maxIterations ?? 5;
  let result: ChatResult = { content: "", reasoning: "", toolCalls: [] };
  let iterations = 0;

  while (iterations < maxIterations) {
    opts.signal?.throwIfAborted();
    opts.onEvent?.({
      type: "request",
      iteration: iterations + 1,
      maxIterations,
    });
    result = await opts.send(messages);
    iterations += 1;
    if (result.toolCalls.length === 0) break;

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      opts.signal?.throwIfAborted();
      opts.onEvent?.({ type: "tool-start", call });
      let output: string;
      try {
        output = await opts.execTool(call, opts.signal);
      } catch (err) {
        opts.signal?.throwIfAborted();
        output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
      opts.signal?.throwIfAborted();
      opts.onEvent?.({
        type: "tool-end",
        call,
        ok: !output.startsWith("Tool error:"),
        outputLength: output.length,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: output.slice(0, 8000),
      });
    }
  }

  return {
    messages,
    content: result.content,
    reasoning: result.reasoning,
    toolCalls: result.toolCalls,
    iterations,
    finishReason: result.finishReason ?? null,
  };
}
