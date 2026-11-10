import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FALLBACK_CONTEXT_WINDOW,
  MAX_RESPONSE_TOKENS,
  MAX_TOOL_ROUNDS,
  MIN_RESPONSE_TOKENS,
  computeHistoryBudget,
  computeMaxToolRounds,
  computeResponseTokenBudget,
  detectContextWindow,
  findLlamaContext,
  findModelContext,
  findOllamaContext,
  resetModelInfoCache,
} from "../src/modelInfo";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
    text: async () => JSON.stringify(body),
  };
}

function routeFetch(routes: Record<string, unknown>): void {
  fetchMock.mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url in routes) return routes[url];
    return jsonResponse({ error: "not found" }, 404);
  });
}

beforeEach(() => {
  resetModelInfoCache();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findModelContext", () => {
  it("reads context_length, max_model_len and max_context_length", () => {
    expect(
      findModelContext(
        { data: [{ id: "openrouter/model", context_length: 128000 }] },
        "openrouter/model"
      )
    ).toBe(128000);
    expect(
      findModelContext(
        { data: [{ id: "vllm-model", max_model_len: 32768 }] },
        "vllm-model"
      )
    ).toBe(32768);
    expect(
      findModelContext(
        { data: [{ id: "lmstudio-model", max_context_length: 8192 }] },
        "lmstudio-model"
      )
    ).toBe(8192);
  });

  it("reads OpenRouter's top_provider.context_length", () => {
    expect(
      findModelContext(
        {
          data: [
            {
              id: "vendor/model",
              top_provider: { context_length: 64000 },
            },
          ],
        },
        "vendor/model"
      )
    ).toBe(64000);
  });

  it("matches ids by suffix and falls back to the only item", () => {
    expect(
      findModelContext(
        { data: [{ id: "vendor/model:latest", context_length: 16000 }] },
        "model:latest"
      )
    ).toBe(16000);
    expect(
      findModelContext(
        { data: [{ id: "only", context_length: 4096 }] },
        "unknown"
      )
    ).toBe(4096);
  });

  it("returns null when nothing is reported", () => {
    expect(findModelContext({ data: [{ id: "m" }] }, "m")).toBeNull();
    expect(findModelContext(null, "m")).toBeNull();
    expect(findModelContext({}, "m")).toBeNull();
  });
});

describe("findOllamaContext", () => {
  it("reads the architecture context_length from model_info", () => {
    expect(
      findOllamaContext({
        model_info: { "llama.context_length": 131072, "llama.embedding": 4096 },
      })
    ).toBe(131072);
  });

  it("prefers an explicit num_ctx from parameters", () => {
    expect(
      findOllamaContext({
        model_info: { "llama.context_length": 131072 },
        parameters: 'stop "<|eot|>"\nnum_ctx 8192',
      })
    ).toBe(8192);
  });

  it("reads num_ctx when model_info lacks the window", () => {
    expect(
      findOllamaContext({ parameters: "num_ctx 8192\ntemperature 0.2" })
    ).toBe(8192);
    expect(findOllamaContext({ model_info: {} })).toBeNull();
    expect(findOllamaContext(null)).toBeNull();
  });
});

describe("findLlamaContext", () => {
  it("reads n_ctx from default_generation_settings", () => {
    expect(
      findLlamaContext({ default_generation_settings: { n_ctx: 4096 } })
    ).toBe(4096);
    expect(findLlamaContext({ n_ctx: 2048 })).toBe(2048);
    expect(findLlamaContext({})).toBeNull();
  });
});

describe("detectContextWindow", () => {
  it("uses OpenAI-compatible model metadata first", async () => {
    routeFetch({
      "https://api.example.com/v1/models": jsonResponse({
        data: [{ id: "model-a", context_length: 64000 }],
      }),
    });

    await expect(
      detectContextWindow("https://api.example.com/v1", "key", "model-a")
    ).resolves.toBe(64000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to LM Studio's native endpoint on a local host", async () => {
    routeFetch({
      "http://localhost:1234/v1/models": jsonResponse({
        data: [{ id: "local-model" }],
      }),
      "http://localhost:1234/api/v0/models": jsonResponse({
        data: [{ id: "local-model", max_context_length: 8192 }],
      }),
    });

    await expect(
      detectContextWindow("http://localhost:1234/v1", "", "local-model")
    ).resolves.toBe(8192);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to Ollama's /api/show on a local host", async () => {
    routeFetch({
      "http://localhost:11434/v1/models": jsonResponse({
        data: [{ id: "llama3" }],
      }),
      "http://localhost:11434/api/show": jsonResponse({
        model_info: { "llama.context_length": 131072 },
      }),
    });

    await expect(
      detectContextWindow("http://localhost:11434/v1", "", "llama3")
    ).resolves.toBe(131072);
  });

  it("falls back to llama.cpp's /props", async () => {
    routeFetch({
      "http://127.0.0.1:8080/v1/models": jsonResponse({
        data: [{ id: "gguf-model" }],
      }),
      "http://127.0.0.1:8080/props": jsonResponse({
        default_generation_settings: { n_ctx: 4096 },
      }),
    });

    await expect(
      detectContextWindow("http://127.0.0.1:8080/v1", "", "gguf-model")
    ).resolves.toBe(4096);
  });

  it("keeps the conservative fallback for remote APIs without metadata", async () => {
    routeFetch({
      "https://api.example.com/v1/models": jsonResponse({
        data: [{ id: "m" }],
      }),
    });

    await expect(
      detectContextWindow("https://api.example.com/v1", "", "m")
    ).resolves.toBe(FALLBACK_CONTEXT_WINDOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the result per base URL and model", async () => {
    routeFetch({
      "https://api.example.com/v1/models": jsonResponse({
        data: [{ id: "m", context_length: 16000 }],
      }),
    });

    await detectContextWindow("https://api.example.com/v1", "", "m");
    await detectContextWindow("https://api.example.com/v1", "", "m");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      detectContextWindow(
        "http://localhost:1234/v1",
        "",
        "m",
        controller.signal
      )
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("computeMaxToolRounds", () => {
  it("caps the rounds for a large context", () => {
    expect(MAX_TOOL_ROUNDS).toBe(24);
    expect(computeMaxToolRounds(32768, 2000)).toBe(14);
    expect(computeMaxToolRounds(200000, 1000)).toBe(MAX_TOOL_ROUNDS);
  });

  it("scales down for a small context", () => {
    expect(computeMaxToolRounds(8192, 1000)).toBe(2);
    expect(computeMaxToolRounds(4096, 1000)).toBe(1);
  });

  it("always allows the first request", () => {
    expect(computeMaxToolRounds(32768, 40000)).toBe(1);
  });
});

describe("context budgets", () => {
  it("reserves room for the answer when sizing history", () => {
    expect(computeHistoryBudget(32768, 4096)).toBe(32768 - 4096 - 2048);
  });

  it("never returns a negative history budget", () => {
    expect(computeHistoryBudget(4096, 8000)).toBe(0);
  });

  it("clamps the response budget to a sane range", () => {
    expect(computeResponseTokenBudget(32768, 1000)).toBe(8192);
    expect(computeResponseTokenBudget(8192, 7900)).toBe(MIN_RESPONSE_TOKENS);
    expect(computeResponseTokenBudget(0, 0)).toBe(MAX_RESPONSE_TOKENS);
  });

  it("returns the remaining window for mid-sized prompts", () => {
    expect(computeResponseTokenBudget(32768, 28000)).toBe(
      32768 - 28000 - 2048
    );
  });
});
