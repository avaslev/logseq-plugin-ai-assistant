import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@logseq/libs", () => ({ logseq: {} }));

import {
  executeLogseqTool,
  filterBlocks,
  filterPageNames,
  getLogseqToolSpecs,
  getWriteToolSpecs,
  searchGraph,
} from "../src/logseqTools";

function mockLogseqEditor(editor: Record<string, unknown>): void {
  (globalThis as { logseq?: unknown }).logseq = {
    DB: { q: () => Promise.resolve([]) },
    Editor: editor,
  };
}

describe("filterPageNames", () => {
  const rows = [["journals"], ["AI Assistant/20261104_x"], ["projects"]];

  it("filters page names by substring, case-insensitive", () => {
    expect(filterPageNames(rows, "assistant")).toEqual([
      "AI Assistant/20261104_x",
    ]);
    expect(filterPageNames(rows, "JOURNALS")).toEqual(["journals"]);
  });

  it("returns empty for blank query or malformed rows", () => {
    expect(filterPageNames(rows, "  ")).toEqual([]);
    expect(filterPageNames(null, "x")).toEqual([]);
    expect(filterPageNames("oops", "x")).toEqual([]);
  });
});

describe("filterBlocks", () => {
  const rows = [
    ["uuid-1", "Logseq is a tool", "journals"],
    ["uuid-2", "Meeting notes about logseq plugins", "projects"],
    ["uuid-3", "unrelated", "journals"],
  ];

  it("filters block contents by substring", () => {
    const result = filterBlocks(rows, "LOGSEQ");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      uuid: "uuid-1",
      content: "Logseq is a tool",
      page: "journals",
    });
  });

  it("drops malformed rows and limits results", () => {
    expect(filterBlocks([[null, "x"]], "x")).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => [
      `uuid-${i}`,
      "logseq",
      "p",
    ]);
    expect(filterBlocks(many, "logseq")).toHaveLength(15);
  });
});

describe("tool specs", () => {
  const specs = getLogseqToolSpecs();
  const names = specs.map((s) => s.function.name);

  it("declares the read-only graph tools", () => {
    expect(names).toEqual([
      "search_graph",
      "get_page",
      "get_page_blocks",
      "get_block",
      "get_current_page",
    ]);
  });

  it("requires arguments for search and lookups", () => {
    for (const spec of specs) {
      if (spec.function.name === "get_current_page") continue;
      expect(
        (spec.function.parameters.required as string[]).length
      ).toBeGreaterThan(0);
    }
  });
});

describe("searchGraph", () => {
  it("uses filtered Datalog queries and caches repeated searches", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = { DB: { q } };
    q.mockResolvedValueOnce([["AI Assistant"]])
      .mockResolvedValueOnce([["u1", "AI assistant notes", "AI Assistant"]]);

    const first = await searchGraph("assistant");
    expect(first).toEqual({
      pages: ["AI Assistant"],
      blocks: [
        { uuid: "u1", content: "AI assistant notes", page: "AI Assistant" },
      ],
    });
    expect(q).toHaveBeenCalledTimes(2);
    expect(q.mock.calls[0][0]).toContain("clojure.string/includes?");
    expect(q.mock.calls[0][0]).toContain('"assistant"');

    const second = await searchGraph("assistant");
    expect(second).toEqual(first);
    expect(q).toHaveBeenCalledTimes(2);
  });

  it("escapes quotes in the embedded search literal", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = { DB: { q } };
    q.mockResolvedValue([]);
    await searchGraph('he said "hi"');
    expect(q.mock.calls[0][0]).toContain('"he said \\"hi\\""');
  });

  it("falls back to a full scan when the filtered query fails", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = { DB: { q } };
    q.mockRejectedValueOnce(new Error("clojure.string/lower-case unavailable"))
      .mockResolvedValueOnce([["Fallback page"]])
      .mockResolvedValueOnce([["u2", "Fallback block", "Fallback page"]]);

    const result = await searchGraph("fallback");
    expect(result).toEqual({
      pages: ["Fallback page"],
      blocks: [
        { uuid: "u2", content: "Fallback block", page: "Fallback page" },
      ],
    });
    expect(q).toHaveBeenCalledTimes(3);
  });
});

describe("executeLogseqTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports invalid JSON arguments", async () => {
    const result = await executeLogseqTool("search_graph", "{broken");
    expect(result).toBe("Invalid JSON arguments");
  });

  it("reports unknown tools", async () => {
    const result = await executeLogseqTool("write_everything", "{}");
    expect(result).toBe("Unknown tool: write_everything");
  });

  it("wraps tool errors as strings", async () => {
    const result = await executeLogseqTool("get_block", "{bad json}");
    expect(result).toBe("Invalid JSON arguments");
  });
});

describe("getWriteToolSpecs", () => {
  const specs = getWriteToolSpecs();
  const names = specs.map((s) => s.function.name);

  it("declares the write tools for the open page", () => {
    expect(names).toEqual([
      "insert_block",
      "prepend_block",
      "update_block",
      "remove_block",
      "move_block",
      "upsert_block_property",
    ]);
  });

  it("requires arguments for every write tool", () => {
    for (const spec of specs) {
      expect(
        (spec.function.parameters.required as string[]).length
      ).toBeGreaterThan(0);
    }
  });
});

describe("write tools", () => {
  const currentPage = { name: "projects", uuid: "page-uuid", id: 42 };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("insert_block appends to the current page", async () => {
    const appendBlockInPage = vi.fn().mockResolvedValue({ uuid: "new-1" });
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(currentPage),
      appendBlockInPage,
    });
    const result = JSON.parse(
      await executeLogseqTool("insert_block", '{"content":"hello"}')
    );
    expect(result).toEqual({ ok: true, uuid: "new-1", page: "projects" });
    expect(appendBlockInPage).toHaveBeenCalledWith("page-uuid", "hello");
  });

  it("insert_block resolves the page when the cursor is on a block", async () => {
    const appendBlockInPage = vi.fn().mockResolvedValue({ uuid: "new-2" });
    mockLogseqEditor({
      getCurrentPage: vi
        .fn()
        .mockResolvedValue({
          uuid: "block-uuid",
          page: { name: "projects", uuid: "page-uuid", id: 42 },
        }),
      appendBlockInPage,
    });
    const result = JSON.parse(
      await executeLogseqTool("insert_block", '{"content":"x"}')
    );
    expect(result.ok).toBe(true);
    expect(appendBlockInPage).toHaveBeenCalledWith("page-uuid", "x");
  });

  it("insert_block inserts after a uuid on the current page", async () => {
    const insertBlock = vi.fn().mockResolvedValue({ uuid: "new-3" });
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(currentPage),
      getBlock: vi.fn().mockResolvedValue({ uuid: "u1", page: { id: 42 } }),
      insertBlock,
    });
    const result = JSON.parse(
      await executeLogseqTool(
        "insert_block",
        '{"content":"x","after_uuid":"u1"}'
      )
    );
    expect(result).toEqual({ ok: true, uuid: "new-3", insertedAfter: "u1" });
    expect(insertBlock).toHaveBeenCalledWith("u1", "x", { sibling: true });
  });

  it("update_block refuses blocks from another page", async () => {
    const updateBlock = vi.fn();
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(currentPage),
      getBlock: vi.fn().mockResolvedValue({ uuid: "u2", page: { id: 99 } }),
      updateBlock,
    });
    const result = JSON.parse(
      await executeLogseqTool(
        "update_block",
        '{"uuid":"u2","content":"x"}'
      )
    );
    expect(result.error).toContain("not on the current page");
    expect(updateBlock).not.toHaveBeenCalled();
  });

  it("remove_block refuses ai_assistant session pages", async () => {
    const removeBlock = vi.fn();
    mockLogseqEditor({
      getCurrentPage: vi
        .fn()
        .mockResolvedValue({
          name: "ai_assistant/20261105_120000_note",
          uuid: "page-uuid",
          id: 42,
        }),
      removeBlock,
    });
    const result = JSON.parse(
      await executeLogseqTool("remove_block", '{"uuid":"u1"}')
    );
    expect(result.error).toContain("session page");
    expect(removeBlock).not.toHaveBeenCalled();
  });

  it("update_block updates a block on the current page", async () => {
    const updateBlock = vi.fn().mockResolvedValue(undefined);
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(currentPage),
      getBlock: vi.fn().mockResolvedValue({ uuid: "u1", page: { id: 42 } }),
      updateBlock,
    });
    const result = JSON.parse(
      await executeLogseqTool(
        "update_block",
        '{"uuid":"u1","content":"new text"}'
      )
    );
    expect(result).toEqual({ ok: true, uuid: "u1" });
    expect(updateBlock).toHaveBeenCalledWith("u1", "new text");
  });

  it("move_block validates both source and target blocks", async () => {
    const moveBlock = vi.fn();
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(currentPage),
      getBlock: vi
        .fn()
        .mockResolvedValueOnce({ uuid: "u1", page: { id: 42 } })
        .mockResolvedValueOnce({ uuid: "u2", page: { id: 777 } }),
      moveBlock,
    });
    const result = JSON.parse(
      await executeLogseqTool(
        "move_block",
        '{"uuid":"u1","target_uuid":"u2","before":true}'
      )
    );
    expect(result.error).toContain("u2");
    expect(moveBlock).not.toHaveBeenCalled();
  });

  it("upsert_block_property sets a property on the current page", async () => {
    const upsertBlockProperty = vi.fn().mockResolvedValue(undefined);
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(currentPage),
      getBlock: vi.fn().mockResolvedValue({ uuid: "u1", page: { id: 42 } }),
      upsertBlockProperty,
    });
    const result = JSON.parse(
      await executeLogseqTool(
        "upsert_block_property",
        '{"uuid":"u1","key":"status","value":"done"}'
      )
    );
    expect(result).toEqual({ ok: true, uuid: "u1", key: "status" });
    expect(upsertBlockProperty).toHaveBeenCalledWith("u1", "status", "done");
  });

  it("reports when no page is open", async () => {
    mockLogseqEditor({
      getCurrentPage: vi.fn().mockResolvedValue(null),
    });
    const result = JSON.parse(
      await executeLogseqTool("insert_block", '{"content":"x"}')
    );
    expect(result.error).toContain("No page is currently open");
  });
});
