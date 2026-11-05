import { beforeEach, describe, expect, it, vi } from "vitest";

const logseqMock = vi.hoisted(() => ({
  Editor: {
    upsertBlockProperty: vi.fn(),
    getPageBlocksTree: vi.fn(),
  },
  settings: {},
}));

vi.mock("@logseq/libs", () => {
  (globalThis as { logseq?: unknown }).logseq = logseqMock;
  return { default: logseqMock, logseq: logseqMock };
});

import { persistSessionModel } from "../src/chat";

const metaBlock = (content: string, uuid = "meta-uuid") => ({
  uuid,
  content,
  children: [],
});

beforeEach(() => {
  vi.clearAllMocks();
  logseqMock.Editor.getPageBlocksTree.mockResolvedValue([]);
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
