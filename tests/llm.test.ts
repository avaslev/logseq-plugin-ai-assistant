import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chatCompletion,
  createStreamAccumulator,
  listModels,
  LlmError,
  pickModel,
  runToolLoop,
  type ChatMessage,
} from "../src/llm";

let server: Server;
let port: number;

type CompletionHandler = (
  body: Record<string, unknown>
) => { status: number; body: string };

let completionHandler: CompletionHandler;
const receivedBodies: Array<Record<string, unknown>> = [];

function sseEvent(json: unknown): string {
  return `data: ${JSON.stringify(json)}\n\n`;
}

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw ? JSON.parse(raw) : {};
        if (req.url === "/v1/models") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              data: [{ id: "model-a" }, { id: "model-b" }],
            })
          );
          return;
        }
        if (req.url === "/v1/chat/completions") {
          receivedBodies.push(body);
          const { status, body: out } = completionHandler(body);
          if (status !== 200) {
            res.statusCode = status;
            res.end(out);
            return;
          }
          res.setHeader("Content-Type", "text/event-stream");
          res.write(out);
          res.end();
          return;
        }
        res.statusCode = 404;
        res.end("not found");
      });
    });
    server.listen(0, () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
}

const baseUrl = () => `http://127.0.0.1:${port}/v1`;

beforeEach(async () => {
  receivedBodies.length = 0;
  if (!server) await startServer();
});

afterAll(() => {
  server?.close();
});

describe("createStreamAccumulator", () => {
  it("accumulates content deltas in order", () => {
    const deltas: string[] = [];
    const acc = createStreamAccumulator((text) => deltas.push(text));
    acc.processLine(sseEvent({ choices: [{ delta: { content: "Hel" } }] }));
    acc.processLine("");
    acc.processLine("data: [DONE]");
    acc.processLine(sseEvent({ choices: [{ delta: { content: "lo" } }] }));
    acc.processLine("data: not-json");
    const result = acc.result();
    expect(result.content).toBe("Hello");
    expect(deltas).toEqual(["Hel", "Hello"]);
    expect(result.toolCalls).toEqual([]);
  });

  it("merges split tool_calls by index", () => {
    const acc = createStreamAccumulator(() => {});
    acc.processLine(
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "search", arguments: '{"qu' },
                },
                {
                  index: 1,
                  id: "call_2",
                  function: { name: "get_page", arguments: "" },
                },
              ],
            },
          },
        ],
      })
    );
    acc.processLine(
      sseEvent({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: 'ery":"logseq"}' } },
                { index: 1, function: { arguments: '{"page":"x"}' } },
              ],
            },
          },
        ],
      })
    );
    const { toolCalls } = acc.result();
    expect(toolCalls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "search", arguments: '{"query":"logseq"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "get_page", arguments: '{"page":"x"}' },
      },
    ]);
  });
});

describe("pickModel", () => {
  it("prefers requested model when available", () => {
    expect(pickModel("b", ["a", "b"], "a")).toBe("b");
  });
  it("falls back to default when requested is unavailable", () => {
    expect(pickModel("gone", ["a", "b"], "b")).toBe("b");
  });
  it("uses first available when default is missing", () => {
    expect(pickModel(null, ["a", "b"], "zzz")).toBe("a");
  });
});

describe("listModels", () => {
  it("returns model ids from the API", async () => {
    const models = await listModels(baseUrl(), "");
    expect(models).toEqual(["model-a", "model-b"]);
  });
});

describe("chatCompletion streaming", () => {
  afterEach(() => {
    completionHandler = () => ({ status: 200, body: "" });
  });

  it("streams text deltas into onDelta and returns full content", async () => {
    completionHandler = () => ({
      status: 200,
      body:
        sseEvent({ choices: [{ delta: { content: "Hel" } }] }) +
        sseEvent({ choices: [{ delta: { content: "lo world" } }] }) +
        "data: [DONE]\n\n",
    });
    const deltas: string[] = [];
    const result = await chatCompletion({
      baseUrl: baseUrl(),
      apiKey: "",
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
      onDelta: (text) => deltas.push(text),
    });
    expect(result.content).toBe("Hello world");
    expect(deltas).toEqual(["Hel", "Hello world"]);
    expect(receivedBodies[0].stream).toBe(true);
    expect(receivedBodies[0].model).toBe("model-a");
  });

  it("sends tools only when non-empty", async () => {
    completionHandler = () => ({
      status: 200,
      body: sseEvent({ choices: [{ delta: { content: "ok" } }] }),
    });
    await chatCompletion({
      baseUrl: baseUrl(),
      apiKey: "",
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(receivedBodies[0].tools).toBeUndefined();
    await chatCompletion({
      baseUrl: baseUrl(),
      apiKey: "",
      model: "model-a",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "t",
            description: "",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });
    expect(Array.isArray(receivedBodies[1].tools)).toBe(true);
  });

  it("throws LlmError with status on HTTP error", async () => {
    completionHandler = () => ({ status: 401, body: "unauthorized" });
    await expect(
      chatCompletion({
        baseUrl: baseUrl(),
        apiKey: "bad",
        model: "model-a",
        messages: [{ role: "user", content: "hi" }],
      })
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("runToolLoop", () => {
  it("executes tools and feeds results back until final answer", async () => {
    completionHandler = (body) => {
      const messages = body.messages as ChatMessage[];
      const hasToolResult = messages.some((m) => m.role === "tool");
      if (hasToolResult) {
        return {
          status: 200,
          body:
            sseEvent({
              choices: [
                { delta: { content: "Found: logseq is great ((abc))" } },
              ],
            }) + "data: [DONE]\n\n",
        };
      }
      return {
        status: 200,
        body:
          sseEvent({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_x",
                      function: {
                        name: "search_graph",
                        arguments: '{"query":"logseq"}',
                      },
                    },
                  ],
                },
              },
            ],
          }) + "data: [DONE]\n\n",
      };
    };

    const executed: Array<{ name: string; args: string }> = [];
    const loop = await runToolLoop({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "find logseq" },
      ],
      tools: [],
      send: (messages) =>
        chatCompletion({
          baseUrl: baseUrl(),
          apiKey: "",
          model: "model-a",
          messages,
        }),
      execTool: async (call) => {
        executed.push({ name: call.function.name, args: call.function.arguments });
        return JSON.stringify({ blocks: [{ uuid: "abc", content: "logseq" }] });
      },
    });

    expect(executed).toEqual([
      { name: "search_graph", args: '{"query":"logseq"}' },
    ]);
    expect(loop.content).toBe("Found: logseq is great ((abc))");
    const assistantWithTools = loop.messages.find(
      (m) => m.role === "assistant" && m.tool_calls
    );
    expect(assistantWithTools).toBeDefined();
    const toolMessage = loop.messages.find((m) => m.role === "tool");
    expect(toolMessage?.tool_call_id).toBe("call_x");
    expect(toolMessage?.content).toContain("abc");
  });

  it("stops after maxIterations when the model keeps calling tools", async () => {
    const loopingCall = {
      id: "call_loop",
      type: "function" as const,
      function: { name: "t", arguments: "{}" },
    };
    let calls = 0;
    const loop = await runToolLoop({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      send: async () => {
        calls += 1;
        return { content: "", toolCalls: [{ ...loopingCall }] };
      },
      execTool: async () => "ok",
      maxIterations: 5,
    });
    expect(calls).toBe(5);
    expect(loop.iterations).toBe(5);
  });
});
