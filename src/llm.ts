import {
  fetchWithTimeout,
  readResponseJson,
  TimeoutError,
  withTimeout,
} from "./http";
import { repairToolCall } from "./toolArgs";
import { compactToolOutput } from "./toolOutput";

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
  // Real token counts when the provider reports them.
  usage?: TokenUsage | null;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export class LlmError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const CONTEXT_OVERFLOW_PATTERN =
  /context (?:length|window|size)|maximum context|max(?:imum)? (?:model )?(?:context|tokens)|too many tokens|prompt is too long|input (?:is )?too long|exceeds?[^.]*(?:context|token)|reduce[^.]*(?:tokens|length)/i;

// Providers signal an oversized prompt in different ways (400/413 with a text
// explanation). Recognising it lets the caller shrink the history and retry
// instead of failing the whole turn.
export function isContextOverflowError(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false;
  if (err.status === 413) return true;
  if (err.status !== 400) return false;
  return CONTEXT_OVERFLOW_PATTERN.test(err.message);
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

function readTokenCount(value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  return typeof num === "number" && Number.isFinite(num) && num > 0
    ? Math.floor(num)
    : 0;
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
  let usage: TokenUsage | null = null;
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
        usage?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      // OpenAI-compatible servers put counts in `usage`, Ollama's native
      // shape uses prompt_eval_count/eval_count on the same stream.
      if (chunk.usage && typeof chunk.usage === "object") {
        const raw = chunk.usage as Record<string, unknown>;
        const promptTokens = readTokenCount(
          raw.prompt_tokens ?? raw.input_tokens
        );
        const completionTokens = readTokenCount(
          raw.completion_tokens ?? raw.output_tokens
        );
        if (promptTokens > 0 || completionTokens > 0) {
          usage = { promptTokens, completionTokens };
        }
      }
      const promptEval = readTokenCount(chunk.prompt_eval_count);
      const evalCount = readTokenCount(chunk.eval_count);
      if (promptEval > 0 || evalCount > 0) {
        usage = { promptTokens: promptEval, completionTokens: evalCount };
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
        usage,
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
  const post = async (includeUsage: boolean): Promise<Response> => {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      max_tokens:
        opts.maxTokens && opts.maxTokens > 0
          ? Math.floor(opts.maxTokens)
          : undefined,
      stream: true,
    };
    // Ask for the real token counts. Servers that do not know the field are
    // retried without it below, so this never makes an otherwise working
    // server fail.
    if (includeUsage) body.stream_options = { include_usage: true };
    try {
      return await fetchWithTimeout(
        joinUrl(opts.baseUrl, "chat/completions"),
        {
          method: "POST",
          headers: authHeaders(opts.apiKey),
          body: JSON.stringify(body),
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
  };

  let res = await post(true);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (
      res.status === 400 &&
      /stream_options|unknown field|extra fields|unrecognized/i.test(text)
    ) {
      res = await post(false);
      if (!res.ok) {
        const retryText = await res.text().catch(() => "");
        throw new LlmError(
          res.status,
          `LLM request failed: ${extractErrorMessage(res.status, retryText)}`
        );
      }
    } else {
      throw new LlmError(
        res.status,
        `LLM request failed: ${extractErrorMessage(res.status, text)}`
      );
    }
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

export const TOOL_ROUNDS_EXHAUSTED_PROMPT =
  "The tool round budget is exhausted. Do not call any more tools. Briefly report what you actually changed or found so far and what remains unfinished.";

const TOOL_REPEAT_PROMPT =
  "You repeated the same tool call. Stop using tools now and answer briefly using the results you already have. If something remains unknown, say so.";
const REPEAT_CALL_LIMIT = 3;
const REPEAT_CYCLE_LENGTH = 4;

export type ToolLoopEvent =
  | {
      type: "request";
      iteration: number;
      maxIterations: number;
      wrapUp?: boolean;
    }
  | { type: "tool-start"; call: ToolCall }
  | { type: "tool-end"; call: ToolCall; ok: boolean; outputLength: number }
  | { type: "repeat"; signature: string };

export interface ToolLoopOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  send: (messages: ChatMessage[]) => Promise<ChatResult>;
  // Used for the wrap-up request when the round budget runs out mid-tool-run:
  // sent without tools so the model reports instead of calling more.
  sendFinal?: (messages: ChatMessage[]) => Promise<ChatResult>;
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
  roundsExhausted: boolean;
  repeated: boolean;
  finishReason?: string | null;
  usage?: TokenUsage | null;
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b)
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function callSignature(call: ToolCall): string {
  let args = call.function.arguments;
  try {
    args = stableValue(JSON.parse(args) as unknown);
  } catch {
    // Keep the raw string when the arguments are not JSON.
  }
  return `${call.function.name}:${args}`;
}

function noteRepeat(
  signature: string,
  counts: Map<string, number>,
  history: string[]
): boolean {
  counts.set(signature, (counts.get(signature) ?? 0) + 1);
  history.push(signature);
  if ((counts.get(signature) ?? 0) >= REPEAT_CALL_LIMIT) return true;
  if (history.length >= REPEAT_CYCLE_LENGTH) {
    const tail = history.slice(-REPEAT_CYCLE_LENGTH);
    if (tail[0] === tail[2] && tail[1] === tail[3] && tail[0] !== tail[1]) {
      return true;
    }
  }
  return false;
}

export async function runToolLoop(
  opts: ToolLoopOptions
): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const maxIterations = opts.maxIterations ?? 5;
  const callCounts = new Map<string, number>();
  const callHistory: string[] = [];
  let result: ChatResult = { content: "", reasoning: "", toolCalls: [] };
  let iterations = 0;
  let repeated = false;

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

    const calls = result.toolCalls.map((call) => repairToolCall(call, opts.tools));
    const executed: ToolCall[] = [];

    for (const { call, error } of calls) {
      opts.signal?.throwIfAborted();
      executed.push(call);
      opts.onEvent?.({ type: "tool-start", call });
      const signature = callSignature(call);
      let output: string;
      let ok = true;
      if (error) {
        // Bad arguments never reach the tool: tell the model what to fix.
        output = error;
        ok = false;
      } else if (noteRepeat(signature, callCounts, callHistory)) {
        repeated = true;
        output = `Repeated identical call: ${signature}. Stop calling tools and answer from the results you already have.`;
        ok = false;
        opts.onEvent?.({ type: "repeat", signature });
      } else {
        try {
          output = await opts.execTool(call, opts.signal);
        } catch (err) {
          opts.signal?.throwIfAborted();
          output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
          ok = false;
        }
      }
      opts.signal?.throwIfAborted();
      const toolText = compactToolOutput(output);
      opts.onEvent?.({
        type: "tool-end",
        call,
        ok,
        outputLength: toolText.length,
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: toolText,
      });
      if (repeated) break;
    }
    // Only the calls that actually got a tool result go into the transcript.
    // Skipped calls would leave dangling tool_calls without results.
    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: executed,
    });
    if (repeated) break;
  }

  // The loop exited with pending tool calls: either the round budget ran out
  // or the model got stuck repeating itself. Make one final request without
  // tools so it reports honestly instead of leaving the answer empty.
  let roundsExhausted = false;
  if (repeated || result.toolCalls.length > 0) {
    roundsExhausted = !repeated && result.toolCalls.length > 0;
    messages.push({
      role: "user",
      content: repeated ? TOOL_REPEAT_PROMPT : TOOL_ROUNDS_EXHAUSTED_PROMPT,
    });
    opts.onEvent?.({
      type: "request",
      iteration: iterations + 1,
      maxIterations,
      wrapUp: true,
    });
    const send = opts.sendFinal ?? opts.send;
    result = await send(messages);
    iterations += 1;
  }

  return {
    messages,
    content: result.content,
    reasoning: result.reasoning,
    toolCalls: result.toolCalls,
    iterations,
    roundsExhausted,
    repeated,
    finishReason: result.finishReason ?? null,
    usage: result.usage ?? null,
  };
}
