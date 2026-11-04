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
  if (available.includes(fallback)) return fallback;
  return available[0] ?? fallback ?? requested ?? "";
}

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
  const res = await fetch(joinUrl(baseUrl, "models"), {
    headers: authHeaders(apiKey),
    signal,
  });
  if (!res.ok) {
    throw new LlmError(res.status, `Failed to list models: HTTP ${res.status}`);
  }
  const data = await res.json();
  const items = Array.isArray(data?.data) ? data.data : [];
  return items
    .map((item: { id?: unknown }) => item.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);
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
        }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
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
  signal?: AbortSignal;
  onDelta?: (accumulated: string) => void;
  onReasoning?: (accumulated: string) => void;
}

export async function chatCompletion(
  opts: ChatCompletionOptions
): Promise<ChatResult> {
  const res = await fetch(joinUrl(opts.baseUrl, "chat/completions"), {
    method: "POST",
    headers: authHeaders(opts.apiKey),
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      tools: opts.tools && opts.tools.length > 0 ? opts.tools : undefined,
      stream: true,
    }),
    signal: opts.signal,
  });
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
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
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

export interface ToolLoopOptions {
  messages: ChatMessage[];
  tools: ToolSpec[];
  send: (messages: ChatMessage[]) => Promise<ChatResult>;
  execTool: (call: ToolCall) => Promise<string>;
  maxIterations?: number;
}

export interface ToolLoopResult {
  messages: ChatMessage[];
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  iterations: number;
}

export async function runToolLoop(
  opts: ToolLoopOptions
): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const maxIterations = opts.maxIterations ?? 5;
  let result: ChatResult = { content: "", reasoning: "", toolCalls: [] };
  let iterations = 0;

  while (iterations < maxIterations) {
    result = await opts.send(messages);
    iterations += 1;
    if (result.toolCalls.length === 0) break;

    messages.push({
      role: "assistant",
      content: result.content || null,
      tool_calls: result.toolCalls,
    });
    for (const call of result.toolCalls) {
      let output: string;
      try {
        output = await opts.execTool(call);
      } catch (err) {
        output = `Tool error: ${err instanceof Error ? err.message : String(err)}`;
      }
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
  };
}
