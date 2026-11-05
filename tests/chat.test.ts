import { beforeEach, describe, expect, it, vi } from "vitest";

const logseqMock = vi.hoisted(() => ({
  Editor: {
    upsertBlockProperty: vi.fn(),
    getPageBlocksTree: vi.fn(),
    getCurrentPage: vi.fn(),
  },
  settings: {},
}));

vi.mock("@logseq/libs", () => {
  (globalThis as { logseq?: unknown }).logseq = logseqMock;
  return { default: logseqMock, logseq: logseqMock };
});

import { isSessionPageFocused, persistSessionModel } from "../src/chat";

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
