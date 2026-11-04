import type { ToolSpec } from "./llm";

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export function parseMcpServers(json: string): McpServerConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter(
      (item): item is McpServerConfig =>
        !!item &&
        typeof item === "object" &&
        typeof (item as McpServerConfig).name === "string" &&
        typeof (item as McpServerConfig).url === "string"
    )
    .map((item) => ({
      name: item.name,
      url: item.url,
      headers: item.headers ?? undefined,
    }));
}

const CLIENT_INFO = { name: "logseq-ai-graph-assistant", version: "0.1.0" };

let rpcId = 0;
const sessionIds = new Map<string, string>();
const initialized = new Set<string>();

async function rpc(
  server: McpServerConfig,
  method: string,
  params?: unknown
): Promise<{ result?: unknown; error?: { message?: string } }> {
  rpcId += 1;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...(server.headers ?? {}),
  };
  const sessionId = sessionIds.get(server.name);
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(server.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId, method, params }),
  });

  if (res.status === 404 && sessionId) {
    sessionIds.delete(server.name);
    throw new Error("MCP session expired");
  }
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);

  const newSession = res.headers.get("mcp-session-id");
  if (newSession) sessionIds.set(server.name, newSession);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLine =
      text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .pop() ?? "";
    return JSON.parse(dataLine.replace(/^data:\s*/, ""));
  }
  return await res.json();
}

async function ensureInit(server: McpServerConfig): Promise<void> {
  if (initialized.has(server.name)) return;
  const res = await rpc(server, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  if (res?.error) {
    throw new Error(`MCP initialize failed: ${res.error.message ?? "unknown"}`);
  }
  initialized.add(server.name);
  try {
    await rpc(server, "notifications/initialized");
  } catch {
    return;
  }
}

export async function listMcpTools(server: McpServerConfig): Promise<ToolSpec[]> {
  await ensureInit(server);
  const res = await rpc(server, "tools/list", {});
  if (res?.error) {
    throw new Error(`MCP tools/list failed: ${res.error.message ?? "unknown"}`);
  }
  const tools =
    (res?.result as { tools?: Array<Record<string, unknown>> } | undefined)
      ?.tools ?? [];
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: `mcp__${server.name}__${String(tool.name)}`,
      description: String(tool.description ?? ""),
      parameters:
        (tool.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
    },
  }));
}

export function mcpToolRoute(
  toolName: string
): { server: string; tool: string } | null {
  const match = toolName.match(/^mcp__(.+?)__(.+)$/);
  return match ? { server: match[1], tool: match[2] } : null;
}

export async function callMcpTool(
  server: McpServerConfig,
  tool: string,
  argsJson: string
): Promise<string> {
  await ensureInit(server);
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return "Invalid tool arguments JSON";
  }
  const res = await rpc(server, "tools/call", { name: tool, arguments: args });
  if (res?.error) {
    return `Tool error: ${res.error.message ?? "unknown"}`;
  }
  const result = res?.result as
    | { content?: Array<{ text?: unknown }>; isError?: boolean }
    | undefined;
  const parts = Array.isArray(result?.content) ? result!.content : [];
  const text = parts
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
  if (result?.isError) return `Tool error: ${text}`;
  return text || "(empty result)";
}

let specsCache: { key: string; specs: ToolSpec[] } | null = null;

export async function getMcpToolSpecs(
  servers: McpServerConfig[]
): Promise<ToolSpec[]> {
  const key = servers.map((s) => `${s.name}|${s.url}`).join(",");
  if (specsCache && specsCache.key === key) return specsCache.specs;
  const specs: ToolSpec[] = [];
  for (const server of servers) {
    try {
      specs.push(...(await listMcpTools(server)));
    } catch (err) {
      console.warn(
        `[ai-assistant] MCP server "${server.name}" unavailable:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  specsCache = { key, specs };
  return specs;
}

export function resetMcpState(): void {
  sessionIds.clear();
  initialized.clear();
  specsCache = null;
}
