import { beforeEach, describe, expect, it, vi } from "vitest";

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
  executeSlashCommand,
  getCurrentSessionPage,
  isSessionPageFocused,
  persistSessionModel,
  refreshAnswerBlockRender,
  syncCurrentSession,
} from "../src/chat";
import { chatCompletion } from "../src/llm";

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
