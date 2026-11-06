import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logseqMock = vi.hoisted(() => ({
  Editor: {
    upsertBlockProperty: vi.fn(),
    getPageBlocksTree: vi.fn(),
    getCurrentPage: vi.fn(),
    exitEditingMode: vi.fn(),
    deletePage: vi.fn(),
    appendBlockInPage: vi.fn(),
    removeBlock: vi.fn(),
    updateBlock: vi.fn(),
    getPage: vi.fn(),
    getAllPages: vi.fn(),
    getBlock: vi.fn(),
  },
  UI: {
    showMsg: vi.fn(),
    clearRightSidebarBlocks: vi.fn(),
  },
  App: {
    clearRightSidebarBlocks: vi.fn(),
  },
  settings: {},
}));

vi.mock("@logseq/libs", () => {
  (globalThis as { logseq?: unknown }).logseq = logseqMock;
  return { default: logseqMock, logseq: logseqMock };
});

vi.mock("../src/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm")>();
  return { ...actual, chatCompletion: vi.fn() };
});

import {
  cancelGeneration,
  classifyStop,
  clearFailedSend,
  executeSlashCommand,
  getCurrentSessionPage,
  getSendState,
  getSentMessages,
  isSessionPageFocused,
  persistSessionModel,
  refreshAnswerBlockRender,
  sendMessage,
  syncCurrentSession,
} from "../src/chat";
import { chatCompletion, LlmError } from "../src/llm";
import { onConfirmRequest, resolveConfirm } from "../src/confirm";
import { resetSkillsCache } from "../src/skills";

const chatCompletionMock = vi.mocked(chatCompletion);

const metaBlock = (content: string, uuid = "meta-uuid") => ({
  uuid,
  content,
  children: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  logseqMock.Editor.getPageBlocksTree.mockResolvedValue([]);
  logseqMock.Editor.getCurrentPage.mockResolvedValue(null);
});

describe("persistSessionModel", () => {
  it("updates the model property of the session meta block", async () => {
    await persistSessionModel("page", "new-model", [
      metaBlock("AI Session\nmodel:: old-model\nstarted:: 2026-01-01"),
    ]);
    expect(logseqMock.Editor.upsertBlockProperty).toHaveBeenCalledWith(
      "meta-uuid",
      "model",
      "new-model"
    );
  });

  it("does nothing when the stored model is already current", async () => {
    await persistSessionModel("page", "same-model", [
      metaBlock("AI Session\nmodel:: same-model\nstarted:: 2026-01-01"),
    ]);
    expect(logseqMock.Editor.upsertBlockProperty).not.toHaveBeenCalled();
  });

  it("does nothing when there is no meta block", async () => {
    await persistSessionModel("page", "new-model", [
      { uuid: "u1", content: "hello", children: [] },
    ]);
    expect(logseqMock.Editor.upsertBlockProperty).not.toHaveBeenCalled();
  });

  it("reads the block tree when it is not provided", async () => {
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      metaBlock("model:: old-model\nstarted:: 2026-01-01"),
    ]);
    await persistSessionModel("page", "new-model");
    expect(logseqMock.Editor.getPageBlocksTree).toHaveBeenCalledWith("page");
    expect(logseqMock.Editor.upsertBlockProperty).toHaveBeenCalledWith(
      "meta-uuid",
      "model",
      "new-model"
    );
  });
});

describe("isSessionPageFocused", () => {
  beforeEach(() => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue(null);
    delete (globalThis as { window?: unknown }).window;
  });

  function fakeWindow(focusInSidebar: boolean): void {
    (globalThis as { window?: unknown }).window = {
      parent: {
        document: {
          activeElement: focusInSidebar ? {} : null,
          getElementById: (id: string) =>
            id === "right-sidebar" && focusInSidebar
              ? { contains: () => true }
              : null,
        },
      },
      focus: () => {},
    };
  }

  it("is true when the open page is an assistant session page", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      name: "ai_assistant/20261105_120000_note",
      uuid: "page-uuid",
      id: 1,
    });
    await expect(isSessionPageFocused()).resolves.toBe(true);
  });

  it("is false when the user is editing another page in the main editor", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      name: "projects",
      uuid: "page-uuid",
      id: 2,
    });
    await expect(isSessionPageFocused()).resolves.toBe(false);
  });

  it("is true when the focus sits inside the right sidebar session", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      name: "projects",
      uuid: "page-uuid",
      id: 2,
    });
    fakeWindow(true);
    await expect(isSessionPageFocused()).resolves.toBe(true);
  });

  it("is false when the focus is not in the right sidebar", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      name: "projects",
      uuid: "page-uuid",
      id: 2,
    });
    fakeWindow(false);
    await expect(isSessionPageFocused()).resolves.toBe(false);
  });

  it("resolves the page name when the cursor is inside a block", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      uuid: "block-uuid",
      page: { name: "ai_assistant/20261105_120000_note" },
    });
    await expect(isSessionPageFocused()).resolves.toBe(true);
  });

  it("is true when no page is open", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue(null);
    await expect(isSessionPageFocused()).resolves.toBe(true);
  });

  it("falls back to sidebar detection when the editor lookup fails", async () => {
    logseqMock.Editor.getCurrentPage.mockRejectedValue(new Error("blocked"));
    await expect(isSessionPageFocused()).resolves.toBe(false);
    fakeWindow(true);
    await expect(isSessionPageFocused()).resolves.toBe(true);
  });
});

describe("refreshAnswerBlockRender", () => {
  beforeEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("exits editing mode when the session page is focused", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      name: "ai_assistant/20261104_x",
    });
    await refreshAnswerBlockRender();
    expect(logseqMock.Editor.exitEditingMode).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the user is on another page", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({ name: "notes" });
    await refreshAnswerBlockRender();
    expect(logseqMock.Editor.exitEditingMode).not.toHaveBeenCalled();
  });

  it("swallows failures of the exit call", async () => {
    logseqMock.Editor.getCurrentPage.mockResolvedValue({
      name: "ai_assistant/20261104_x",
    });
    logseqMock.Editor.exitEditingMode.mockRejectedValue(
      new Error("not supported")
    );
    await expect(refreshAnswerBlockRender()).resolves.toBeUndefined();
  });
});

describe("executeSlashCommand", () => {
  beforeEach(() => {
    syncCurrentSession(null);
  });

  it("rejects unknown commands", async () => {
    await expect(executeSlashCommand("frobnicate", "m")).rejects.toThrow(
      "Unknown command"
    );
  });

  it("reports when there is no session to remove", async () => {
    await executeSlashCommand("remove", "m");
    expect(logseqMock.Editor.deletePage).not.toHaveBeenCalled();
    const texts = logseqMock.UI.showMsg.mock.calls.map((call) => call[0]);
    expect(texts.some((text) => String(text).includes("No active session"))).toBe(
      true
    );
  });

  it("removes the session immediately and clears the sidebar", async () => {
    syncCurrentSession("ai_assistant/20261105_test");
    logseqMock.Editor.getPage.mockResolvedValue(null);
    await executeSlashCommand("remove", "m");
    expect(logseqMock.Editor.deletePage).toHaveBeenCalledWith(
      "ai_assistant/20261105_test"
    );
    expect(getCurrentSessionPage()).toBeNull();
    expect(logseqMock.App.clearRightSidebarBlocks).toHaveBeenCalledWith({
      close: false,
    });
    syncCurrentSession(null);
  });

  it("still resets the session when the deleted page lingers in cache", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    syncCurrentSession("ai_assistant/20261105_stuck");
    logseqMock.Editor.getPage.mockResolvedValue({
      name: "ai_assistant/20261105_stuck",
    });
    await executeSlashCommand("remove", "m");
    expect(logseqMock.Editor.deletePage).toHaveBeenCalledTimes(1);
    expect(logseqMock.App.clearRightSidebarBlocks).toHaveBeenCalledWith({
      close: false,
    });
    expect(getCurrentSessionPage()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    syncCurrentSession(null);
  });

  it("reports when there is no session to compress", async () => {
    await executeSlashCommand("compress", "m");
    expect(logseqMock.Editor.appendBlockInPage).not.toHaveBeenCalled();
    const texts = logseqMock.UI.showMsg.mock.calls.map((call) => call[0]);
    expect(texts.some((text) => String(text).includes("No active session"))).toBe(
      true
    );
  });

  it("compresses the session and refreshes the block render", async () => {
    syncCurrentSession("ai_assistant/20261105_comp");
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      {
        uuid: "meta",
        content: "AI Session\nmodel:: m\nstarted:: t",
        children: [],
      },
      { uuid: "u1", content: "вопрос пользователя", children: [] },
      { uuid: "a1", content: "✦ ответ ассистента", children: [] },
    ]);
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "status" });
    chatCompletionMock.mockResolvedValue({
      content: "compressed summary",
      reasoning: "",
      toolCalls: [],
    });

    await executeSlashCommand("compress", "model-x");

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    expect(logseqMock.Editor.removeBlock).toHaveBeenCalledWith("u1");
    expect(logseqMock.Editor.removeBlock).toHaveBeenCalledWith("a1");
    expect(logseqMock.Editor.removeBlock).toHaveBeenCalledWith("status");
    const appended = logseqMock.Editor.appendBlockInPage.mock.calls.map(
      (call) => call[1]
    );
    expect(appended.some((content) => String(content).startsWith("✦"))).toBe(
      true
    );
    expect(logseqMock.Editor.exitEditingMode).toHaveBeenCalled();
    syncCurrentSession(null);
  });

  it("keeps the history and marks the status block when compression fails", async () => {
    syncCurrentSession("ai_assistant/20261105_fail");
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { uuid: "u1", content: "вопрос", children: [] },
    ]);
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "status" });
    chatCompletionMock.mockRejectedValue(new Error("api down"));

    await executeSlashCommand("compress", "model-x");

    expect(logseqMock.Editor.removeBlock).not.toHaveBeenCalled();
    expect(logseqMock.Editor.updateBlock).toHaveBeenCalledWith(
      "status",
      "⚠️ api down"
    );
    syncCurrentSession(null);
  });
});

describe("classifyStop (F15)", () => {
  it("marks aborts as cancelled", () => {
    const stop = classifyStop(new Error("anything"), true);
    expect(stop.kind).toBe("cancelled");
    expect(stop.retryable).toBe(false);
    expect(stop.text).toContain("⏹");
  });

  it("classifies network failures (status 0)", () => {
    const stop = classifyStop(new LlmError(0, "timed out"), false);
    expect(stop.kind).toBe("network");
    expect(stop.retryable).toBe(true);
    expect(stop.text).toContain("timed out");
  });

  it("classifies rate limits (status 429)", () => {
    const stop = classifyStop(new LlmError(429, "slow down"), false);
    expect(stop.kind).toBe("rate-limit");
    expect(stop.retryable).toBe(true);
  });

  it("classifies server errors (status 5xx)", () => {
    const stop = classifyStop(new LlmError(502, "bad gateway"), false);
    expect(stop.kind).toBe("server");
    expect(stop.text).toContain("502");
  });

  it("falls back to a generic error", () => {
    const stop = classifyStop(new Error("boom"), false);
    expect(stop.kind).toBe("error");
    expect(stop.retryable).toBe(false);
    expect(stop.text).toContain("boom");
  });
});

describe("send state and retry (F15)", () => {
  beforeEach(() => {
    clearFailedSend();
    syncCurrentSession("ai_assistant/20261106_fail");
  });

  afterEach(() => {
    clearFailedSend();
    syncCurrentSession(null);
  });

  function enableSendFlow(): void {
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      {
        uuid: "meta",
        content: "AI Session\nmodel:: m\nstarted:: t",
        children: [],
      },
    ]);
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "thinking" });
    logseqMock.Editor.updateBlock.mockResolvedValue(undefined);
  }

  it("exposes the failure and the original message for retry", async () => {
    enableSendFlow();
    chatCompletionMock.mockRejectedValue(new LlmError(429, "slow down"));

    await sendMessage("повтори это", "m");

    const state = getSendState();
    expect(state.phase).toBe("failed");
    expect(state.failed?.kind).toBe("rate-limit");
    expect(state.failedMessage).toBe("повтори это");
    expect(logseqMock.UI.showMsg).toHaveBeenCalled();
  });

  it("resets to idle after clearFailedSend", () => {
    clearFailedSend();
    const state = getSendState();
    expect(state.phase).toBe("idle");
    expect(state.failed).toBeNull();
    expect(state.failedMessage).toBeNull();
  });

  it("marks a cancelled send as idle without a failure", async () => {
    enableSendFlow();
    const abortError = new DOMException("Aborted", "AbortError");
    chatCompletionMock.mockImplementation(async () => {
      cancelGeneration();
      throw abortError;
    });

    await sendMessage("stop me", "m");

    const state = getSendState();
    expect(state.phase).toBe("idle");
    expect(state.failedMessage).toBeNull();
    expect(logseqMock.Editor.updateBlock).toHaveBeenCalledWith(
      "thinking",
      expect.stringContaining("⏹")
    );
  });

  it("reports estimated token usage after a successful send", async () => {
    enableSendFlow();
    chatCompletionMock.mockResolvedValue({
      content: "Ответ ассистента",
      reasoning: "",
      toolCalls: [],
    });

    await sendMessage("вопрос", "m");

    const state = getSendState();
    expect(state.phase).toBe("idle");
    expect(state.usage).not.toBeNull();
    expect(state.usage!.contextTokens).toBeGreaterThan(0);
    expect(state.usage!.outputTokens).toBeGreaterThan(0);
  });
});

describe("skill auto-selection (F24)", () => {
  const meta = {
    uuid: "meta",
    content: "AI Session\nmodel:: m\nstarted:: t",
    children: [],
  };
  const skillTree = [
    { content: "AI Skill\nname:: Alpha\ndescription:: does alpha things" },
    { content: "Do alpha things carefully" },
  ];

  beforeEach(() => {
    resetSkillsCache();
    syncCurrentSession("ai_assistant/20261106_skill");
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "thinking" });
    logseqMock.Editor.updateBlock.mockResolvedValue(undefined);
    logseqMock.Editor.getPage.mockImplementation(async (name: string) =>
      name === "ai_assistant/skills/alpha" ? { uuid: "skill-uuid" } : null
    );
    logseqMock.Editor.getPageBlocksTree.mockImplementation(
      async (ref: string) => (ref === "skill-uuid" ? skillTree : [meta])
    );
    logseqMock.Editor.getAllPages.mockResolvedValue([
      { name: "ai_assistant/skills/alpha" },
    ]);
    chatCompletionMock.mockResolvedValue({
      content: "Ответ",
      reasoning: "",
      toolCalls: [],
    });
  });

  afterEach(() => {
    syncCurrentSession(null);
    logseqMock.settings = {};
  });

  it("adds the catalog and the use_skill tool when tools are on", async () => {
    await sendMessage("help with alpha", "m");

    const call = chatCompletionMock.mock.calls.at(-1)![0];
    expect(call.messages[0].content).toContain("Available skills");
    expect(call.messages[0].content).toContain("Alpha — does alpha things");
    expect(call.tools?.some((t) => t.function.name === "use_skill")).toBe(
      true
    );
  });

  it("does not advertise skills when one is invoked explicitly", async () => {
    await sendMessage("request", "m", {
      skill: {
        name: "Alpha",
        description: "does alpha things",
        content: "Do alpha things carefully",
        page: "ai_assistant/skills/alpha",
      },
    });

    const call = chatCompletionMock.mock.calls.at(-1)![0];
    expect(call.messages[0].content).toContain("Skill: Alpha");
    expect(call.messages[0].content).not.toContain("Available skills");
    expect(call.tools?.some((t) => t.function.name === "use_skill")).toBe(
      false
    );
    expect(logseqMock.Editor.getAllPages).not.toHaveBeenCalled();
  });

  it("omits the catalog and the tool when tools are disabled", async () => {
    logseqMock.settings = { enableTools: false };

    await sendMessage("help with alpha", "m");

    const call = chatCompletionMock.mock.calls.at(-1)![0];
    expect(call.messages[0].content).not.toContain("Available skills");
    expect(call.tools ?? []).toHaveLength(0);
  });
});

describe("empty reply fallback (tool-aware)", () => {
  const meta = {
    uuid: "meta",
    content: "AI Session\nmodel:: m\nstarted:: t",
    children: [],
  };

  beforeEach(() => {
    syncCurrentSession("ai_assistant/20261106_empty");
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "thinking" });
    logseqMock.Editor.updateBlock.mockResolvedValue(undefined);
    logseqMock.Editor.getBlock.mockResolvedValue({ uuid: "thinking" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([meta]);
  });

  afterEach(() => {
    syncCurrentSession(null);
    logseqMock.settings = {};
  });

  it("writes a tool completion note when tools were used without text", async () => {
    chatCompletionMock
      .mockResolvedValueOnce({
        content: "",
        reasoning: "",
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: { name: "get_current_page", arguments: "{}" },
          },
        ],
      })
      .mockResolvedValueOnce({ content: "", reasoning: "", toolCalls: [] });

    await sendMessage("заполни страницу", "m");

    expect(logseqMock.Editor.updateBlock).toHaveBeenCalledWith(
      "thinking",
      expect.stringContaining("completed with tools")
    );
    expect(logseqMock.Editor.updateBlock).not.toHaveBeenCalledWith(
      "thinking",
      "(empty reply)"
    );
  });

  it("keeps (empty reply) when no tools were used", async () => {
    chatCompletionMock.mockResolvedValue({
      content: "",
      reasoning: "",
      toolCalls: [],
    });

    await sendMessage("молчаливый вопрос", "m");

    expect(logseqMock.Editor.updateBlock).toHaveBeenCalledWith(
      "thinking",
      "(empty reply)"
    );
  });
});

describe("web tools registration (F21)", () => {
  afterEach(() => {
    syncCurrentSession(null);
    logseqMock.settings = {};
  });

  it("exposes web_search and fetch_page when tools are enabled", async () => {
    syncCurrentSession("ai_assistant/20261106_web");
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      {
        uuid: "meta",
        content: "AI Session\nmodel:: m\nstarted:: t",
        children: [],
      },
    ]);
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "thinking" });
    logseqMock.Editor.updateBlock.mockResolvedValue(undefined);
    chatCompletionMock.mockResolvedValue({
      content: "Ответ",
      reasoning: "",
      toolCalls: [],
    });

    await sendMessage("что нового в logseq?", "m");

    const tools = chatCompletionMock.mock.calls.at(-1)![0].tools ?? [];
    expect(tools.some((t) => t.function.name === "web_search")).toBe(true);
    expect(tools.some((t) => t.function.name === "fetch_page")).toBe(true);
  });
});

describe("getSentMessages (F22)", () => {
  it("returns full-length user messages of the session", async () => {
    const long = "y".repeat(600);
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "AI Session\nmodel:: m\nstarted:: now" },
      { content: "first question" },
      { content: "✦ first answer" },
      { content: "💭 Thinking…" },
      { content: long },
    ]);
    await expect(getSentMessages("page")).resolves.toEqual([
      "first question",
      long,
    ]);
  });

  it("returns an empty list when the tree is unavailable", async () => {
    logseqMock.Editor.getPageBlocksTree.mockRejectedValue(new Error("gone"));
    await expect(getSentMessages("page")).resolves.toEqual([]);
  });
});

describe("/remove confirmation (F17)", () => {
  afterEach(() => {
    syncCurrentSession(null);
  });

  it("does not delete the session when the user cancels", async () => {
    const unsubscribe = onConfirmRequest(() => resolveConfirm(false));
    syncCurrentSession("ai_assistant/20261106_cancel");

    await executeSlashCommand("remove", "m");

    expect(logseqMock.Editor.deletePage).not.toHaveBeenCalled();
    expect(getCurrentSessionPage()).toBe("ai_assistant/20261106_cancel");
    unsubscribe();
    syncCurrentSession(null);
  });

  it("deletes the session after confirmation", async () => {
    const unsubscribe = onConfirmRequest(() => resolveConfirm(true));
    syncCurrentSession("ai_assistant/20261106_ok");
    logseqMock.Editor.getPage.mockResolvedValue(null);

    await executeSlashCommand("remove", "m");

    expect(logseqMock.Editor.deletePage).toHaveBeenCalledWith(
      "ai_assistant/20261106_ok"
    );
    expect(getCurrentSessionPage()).toBeNull();
    unsubscribe();
    syncCurrentSession(null);
  });
});
