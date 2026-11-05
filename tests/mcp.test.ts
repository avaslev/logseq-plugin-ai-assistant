import { createServer, type Server } from "node:http";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  callMcpTool,
  getMcpToolSpecs,
  listMcpTools,
  mcpToolRoute,
  parseMcpServers,
  resetMcpState,
} from "../src/mcp";

let server: Server;
let port: number;
const rpcLog: Array<{ method: string }> = [];

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = JSON.parse(raw);
        rpcLog.push({ method: body.method });
        const reply = (result: unknown) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("mcp-session-id", "session-1");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        };
        switch (body.method) {
          case "initialize":
            reply({
              protocolVersion: "2025-03-26",
              capabilities: {},
              serverInfo: { name: "test-mcp", version: "1.0" },
            });
            return;
          case "tools/list":
            reply({
              tools: [
                {
                  name: "weather",
                  description: "Get weather",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            });
            return;
          case "tools/call":
            if (
              (body.params as { arguments?: { city?: string } } | undefined)
                ?.arguments?.city === "stall"
            ) {
              return;
            }
            reply({
              content: [{ type: "text", text: "sunny, +20" }],
              isError: false,
            });
            return;
          default:
            reply({});
        }
      });
    });
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

const serverConfig = () => ({
  name: "test-mcp",
  url: `http://127.0.0.1:${port}/mcp`,
});

beforeEach(async () => {
  if (!server) await startServer();
  resetMcpState();
  rpcLog.length = 0;
});

afterAll(() => {
  server?.close();
  server?.closeAllConnections?.();
});

describe("parseMcpServers", () => {
  it("parses valid config", () => {
    const servers = parseMcpServers(
      '[{"name":"a","url":"http://x/mcp","headers":{"Authorization":"Bearer t"}}]'
    );
    expect(servers).toEqual([
      { name: "a", url: "http://x/mcp", headers: { Authorization: "Bearer t" } },
    ]);
  });

  it("returns empty array on invalid JSON or wrong shape", () => {
    expect(parseMcpServers("not json")).toEqual([]);
    expect(parseMcpServers('{"a":1}')).toEqual([]);
    expect(parseMcpServers('[{"url":"no-name"}]')).toEqual([]);
    expect(parseMcpServers("[]")).toEqual([]);
  });
});

describe("mcpToolRoute", () => {
  it("splits mcp tool names", () => {
    expect(mcpToolRoute("mcp__srv__tool")).toEqual({
      server: "srv",
      tool: "tool",
    });
    expect(mcpToolRoute("search_graph")).toBeNull();
  });
});

describe("MCP client over HTTP", () => {
  it("initializes then lists tools", async () => {
    const tools = await listMcpTools(serverConfig());
    expect(rpcLog.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(tools).toEqual([
      {
        type: "function",
        function: {
          name: "mcp__test-mcp__weather",
          description: "Get weather",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });

  it("calls a tool and joins text content", async () => {
    const result = await callMcpTool(
      serverConfig(),
      "weather",
      '{"city":"Berlin"}'
    );
    expect(result).toBe("sunny, +20");
  });

  it("reuses initialization across calls", async () => {
    await listMcpTools(serverConfig());
    const countAfterFirst = rpcLog.length;
    await callMcpTool(serverConfig(), "weather", "{}");
    expect(rpcLog.slice(countAfterFirst).map((r) => r.method)).toEqual([
      "tools/call",
    ]);
  });

  it("caches tool specs by server key", async () => {
    const servers = [serverConfig()];
    const first = await getMcpToolSpecs(servers);
    const countAfterFirst = rpcLog.length;
    const second = await getMcpToolSpecs(servers);
    expect(second).toEqual(first);
    expect(rpcLog.length).toBe(countAfterFirst);
  });

  it("resetMcpState clears cached specs and sessions", async () => {
    await getMcpToolSpecs([serverConfig()]);
    resetMcpState();
    rpcLog.length = 0;
    await getMcpToolSpecs([serverConfig()]);
    expect(rpcLog.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });

  it("times out when a tool call stalls", async () => {
    await expect(
      callMcpTool(serverConfig(), "weather", '{"city":"stall"}', {
        timeoutMs: 50,
      })
    ).rejects.toThrow(/timed out/i);
  });

  it("aborts requests and does not cache the aborted result", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      getMcpToolSpecs([serverConfig()], { signal: controller.signal })
    ).rejects.toBeDefined();

    rpcLog.length = 0;
    const specs = await getMcpToolSpecs([serverConfig()]);
    expect(specs).toHaveLength(1);
    expect(rpcLog.map((r) => r.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
  });
});
