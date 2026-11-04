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

export function createStreamAccumulator(onDelta: (text: string) => void) {
  let content = "";
  const toolCalls = new Map<number, ToolCall>();

  return {
    processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) return;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      let chunk: {
        choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>;
      };
      try {
        chunk = JSON.parse(payload);
      } catch {
        return;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onDelta(content);
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
      return {
        content,
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
    throw new LlmError(
      res.status,
      `LLM request failed: HTTP ${res.status} ${text.slice(0, 200)}`
    );
  }
  if (!res.body) throw new LlmError(0, "LLM response has no body");

  const acc = createStreamAccumulator(opts.onDelta ?? (() => {}));
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
  toolCalls: ToolCall[];
  iterations: number;
}

export async function runToolLoop(
  opts: ToolLoopOptions
): Promise<ToolLoopResult> {
  const messages = [...opts.messages];
  const maxIterations = opts.maxIterations ?? 5;
  let result: ChatResult = { content: "", toolCalls: [] };
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
    toolCalls: result.toolCalls,
    iterations,
  };
}
