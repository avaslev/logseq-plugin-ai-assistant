import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@logseq/libs", () => ({ logseq: {} }));

import {
  executeLogseqTool,
  filterBlocks,
  filterPageNames,
  getLogseqToolSpecs,
  getWriteToolSpecs,
  journalDayNumber,
  journalRowsToBlocks,
  normalizeQueryRows,
  queryBlocks,
  searchGraph,
  searchJournal,
  searchTasks,
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
      marker: "",
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
      "search_tasks",
      "get_page",
      "get_page_blocks",
      "get_block",
      "get_current_page",
      "get_selected_blocks",
      "query_blocks",
      "search_journal",
      "get_recent_pages",
    ]);
  });

  it("requires arguments for search and lookups", () => {
    for (const spec of specs) {
      if (spec.function.name === "get_current_page") continue;
      if (spec.function.name === "get_selected_blocks") continue;
      if (spec.function.name === "search_tasks") continue;
      if (spec.function.name === "search_journal") continue;
      if (spec.function.name === "get_recent_pages") continue;
      expect(
        (spec.function.parameters.required as string[]).length
      ).toBeGreaterThan(0);
    }
  });
});

describe("searchGraph", () => {
  it("uses the built-in DSL query for blocks and getAllPages for pages", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {
        getAllPages: vi.fn().mockResolvedValue([{ name: "AI Assistant" }]),
        getPage: vi.fn().mockResolvedValue({ name: "AI Assistant" }),
      },
      DB: { q, datascriptQuery },
    };
    q.mockResolvedValue([
      { uuid: "u1", content: "AI assistant notes", page: 7 },
    ]);

    const first = await searchGraph("assistant");
    expect(first).toEqual({
      pages: ["AI Assistant"],
      blocks: [
        {
          uuid: "u1",
          content: "AI assistant notes",
          page: "AI Assistant",
          marker: "",
        },
      ],
    });
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toBe('"assistant"');
    expect(datascriptQuery).not.toHaveBeenCalled();

    const second = await searchGraph("assistant");
    expect(second).toEqual(first);
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("escapes quotes in the DSL literal", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([]) },
      DB: { q, datascriptQuery: vi.fn().mockResolvedValue([]) },
    };
    q.mockResolvedValue([]);
    await searchGraph('he said "hi"');
    expect(
      q.mock.calls.some((call) =>
        String(call[0]).includes('"he said \\"hi\\""')
      )
    ).toBe(true);
  });

  it("resolves page names via getBlock when the DSL row has no page hint", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {
        getAllPages: vi.fn().mockResolvedValue([]),
        getBlock: vi.fn().mockResolvedValue({ page: { id: 9 } }),
        getPage: vi.fn().mockResolvedValue({ name: "Named page" }),
      },
      DB: { q, datascriptQuery: vi.fn().mockResolvedValue([]) },
    };
    q.mockResolvedValue([{ uuid: "u6", title: "Db graph hit" }]);

    const result = await searchGraph("db graph");
    expect(result).toEqual({
      pages: [],
      blocks: [
        { uuid: "u6", content: "Db graph hit", page: "Named page", marker: "" },
      ],
    });
    expect(q.mock.calls[0][0]).toBe('"db graph"');
  });

  it("falls back to datascriptQuery when the DSL query fails", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([]) },
      DB: { q, datascriptQuery },
    };
    q.mockRejectedValue(new Error("DSL unsupported"));
    datascriptQuery.mockResolvedValue([["u3", "Probe block", "Probe page"]]);

    const result = await searchGraph("probe");
    expect(result).toEqual({
      pages: [],
      blocks: [
        { uuid: "u3", content: "Probe block", page: "Probe page", marker: "" },
      ],
    });
    expect(datascriptQuery).toHaveBeenCalledTimes(1);
    expect(datascriptQuery.mock.calls[0][0]).toContain(":block/content");
    expect(datascriptQuery.mock.calls[0][1]).toBe("probe");
  });

  it("tries the title attribute for DB graphs", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([]) },
      DB: { q, datascriptQuery },
    };
    q.mockResolvedValue([]);
    datascriptQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([["u4", "Db title hit", "DbPage"]]);

    const result = await searchGraph("db title");
    expect(result).toEqual({
      pages: [],
      blocks: [
        { uuid: "u4", content: "Db title hit", page: "DbPage", marker: "" },
      ],
    });
    expect(datascriptQuery).toHaveBeenCalledTimes(2);
    expect(datascriptQuery.mock.calls[1][0]).toContain(":block/title");
  });

  it("refines an empty multi-word query with the longest keyword", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([{ name: "Проекты" }]) },
      DB: { q, datascriptQuery: vi.fn().mockResolvedValue([]) },
    };
    q.mockResolvedValue([]);

    const result = await searchGraph("какие есть проекты");
    expect(result).toEqual({ pages: ["Проекты"], blocks: [] });

    const second = await searchGraph("какие есть проекты");
    expect(second).toEqual(result);
    expect(q).toHaveBeenCalledTimes(2);
  });

  it("falls back to a datalog page scan when getAllPages is unavailable", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {},
      DB: { q, datascriptQuery },
    };
    q.mockResolvedValue([]);
    datascriptQuery
      .mockResolvedValueOnce([["Scanword page"]])
      .mockResolvedValue([]);

    const result = await searchGraph("scanword");
    expect(result).toEqual({
      pages: ["Scanword page"],
      blocks: [],
    });
    expect(datascriptQuery.mock.calls[0][0]).toContain(":block/name");
  });

  it("falls back to a full block scan when the filtered queries fail", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([{ name: "Probeword page" }]) },
      DB: { q, datascriptQuery },
    };
    q.mockRejectedValue(new Error("DSL unsupported"));
    datascriptQuery
      .mockRejectedValueOnce(new Error("clojure.string unavailable"))
      .mockRejectedValueOnce(new Error("clojure.string unavailable"))
      .mockResolvedValueOnce([["u5", "Probeword block", "Probeword page"]]);

    const result = await searchGraph("probeword");
    expect(result).toEqual({
      pages: ["Probeword page"],
      blocks: [
        {
          uuid: "u5",
          content: "Probeword block",
          page: "Probeword page",
          marker: "",
        },
      ],
    });
    expect(datascriptQuery).toHaveBeenCalledTimes(3);
    expect(datascriptQuery.mock.calls[2][0]).not.toContain("includes?");
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

describe("searchTasks", () => {
  it("uses the built-in (task ...) DSL query and normalizes markers", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {
        getPage: vi
          .fn()
          .mockImplementation(async (id: number) => ({
            name: id === 3 ? "Journal" : "Reading",
          })),
      },
      DB: { q, datascriptQuery },
    };
    q.mockResolvedValue([
      { uuid: "t1", content: "NOW сделать проект", marker: "now", page: 3 },
      { uuid: "t2", content: "LATER прочитать", marker: ["later"], page: 4 },
    ]);

    const result = await searchTasks();
    expect(q).toHaveBeenCalledTimes(1);
    expect(q.mock.calls[0][0]).toBe("(task todo doing now later waiting)");
    expect(result).toEqual([
      {
        uuid: "t1",
        content: "NOW сделать проект",
        page: "Journal",
        marker: "now",
      },
      {
        uuid: "t2",
        content: "LATER прочитать",
        marker: "later",
        page: "Reading",
      },
    ]);
    expect(datascriptQuery).not.toHaveBeenCalled();
  });

  it("passes the status filter into the DSL query", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getPage: vi.fn().mockResolvedValue({ name: "Journal" }) },
      DB: { q, datascriptQuery: vi.fn() },
    };
    q.mockResolvedValue([
      { uuid: "t3", content: "NOW срочно", marker: "now", page: 1 },
    ]);

    const result = await searchTasks("NOW, doing");
    expect(q.mock.calls[0][0]).toBe("(task now doing)");
    expect(result).toEqual([
      { uuid: "t3", content: "NOW срочно", page: "Journal", marker: "now" },
    ]);
  });

  it("falls back to a datalog marker scan when the DSL query fails", async () => {
    const q = vi.fn();
    const datascriptQuery = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([]) },
      DB: { q, datascriptQuery },
    };
    q.mockRejectedValue(new Error("DSL unsupported"));
    datascriptQuery.mockResolvedValue([
      ["t4", "TODO buy milk", "Notes", "todo"],
      ["t5", "LATER thing", "Notes", "later"],
    ]);

    const result = await searchTasks("todo");
    expect(result).toEqual([
      { uuid: "t4", content: "TODO buy milk", page: "Notes", marker: "todo" },
    ]);
    expect(datascriptQuery).toHaveBeenCalledTimes(1);
    expect(datascriptQuery.mock.calls[0][0]).toContain(":block/marker");
  });
});

describe("queryBlocks (F9)", () => {
  const uuidA = "a7b40f24-1111-4222-8333-444455556666";

  it("rejects an empty query", async () => {
    const q = vi.fn();
    (globalThis as { logseq?: unknown }).logseq = { DB: { q } };
    const result = await queryBlocks("   ");
    expect(result).toEqual({ error: "query is required" });
    expect(q).not.toHaveBeenCalled();
  });

  it("normalizes DSL entity rows into blocks with page names", async () => {
    const q = vi.fn().mockResolvedValue([
      { uuid: uuidA, content: "rating:: 5", marker: "todo", page: 3 },
    ]);
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {
        getPage: vi.fn().mockResolvedValue({ name: "Books" }),
      },
      DB: { q },
    };
    const result = await queryBlocks("(property rating 5)");
    expect(result).toEqual({
      via: "dsl",
      blocks: [
        { uuid: uuidA, content: "rating:: 5", page: "Books", marker: "todo" },
      ],
    });
    expect(q).toHaveBeenCalledWith("(property rating 5)");
  });

  it("maps datalog tuples with uuids into blocks", async () => {
    const datascriptQuery = vi
      .fn()
      .mockResolvedValue([[uuidA, "block text", "SomePage", "todo"]]);
    (globalThis as { logseq?: unknown }).logseq = {
      DB: { q: vi.fn(), datascriptQuery },
    };
    const result = await queryBlocks(
      "[:find ?b :where [?b :block/uuid]]",
      "datalog"
    );
    expect(result).toEqual({
      via: "datalog",
      blocks: [
        { uuid: uuidA, content: "block text", page: "SomePage", marker: "todo" },
      ],
    });
  });

  it("returns raw rows for tuples without uuids", async () => {
    const datascriptQuery = vi
      .fn()
      .mockResolvedValue([["count", 42], ["name", "x", 1, 2, 3]]);
    (globalThis as { logseq?: unknown }).logseq = {
      DB: { q: vi.fn(), datascriptQuery },
    };
    const result = await queryBlocks("[:find ?x :where ...]", "datalog");
    expect(result).toEqual({
      via: "datalog",
      blocks: [],
      rows: [
        ["count", "42"],
        ["name", "x", "1", "2", "3"],
      ],
    });
  });

  it("reports query errors as strings", async () => {
    const q = vi.fn().mockRejectedValue(new Error("bad query"));
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn().mockResolvedValue([]) },
      DB: { q, datascriptQuery: vi.fn() },
    };
    const result = await queryBlocks("(broken");
    expect(result).toEqual({ error: "bad query" });
  });
});

describe("normalizeQueryRows", () => {
  const uuid = "a7b40f24-1111-4222-8333-444455556666";

  it("detects entity rows and slices to the limit", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      uuid: `${uuid.slice(0, -1)}${i % 10}`,
      content: `c${i}`,
    }));
    const { entities, tuples } = normalizeQueryRows(rows);
    expect(entities).toHaveLength(15);
    expect(tuples).toHaveLength(0);
  });

  it("wraps non-array rows into tuples", () => {
    const { tuples } = normalizeQueryRows(["a", 42, ["b", 1]]);
    expect(tuples).toEqual([["a"], [42], ["b", 1]]);
  });

  it("tolerates non-array input", () => {
    expect(normalizeQueryRows(null)).toEqual({ entities: [], tuples: [] });
  });
});

describe("searchJournal (F10)", () => {
  const uuid = "a7b40f24-1111-4222-8333-444455556666";
  const today = journalDayNumber(new Date());

  it("keeps only blocks inside the day window, newest first", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);
    const blocks = journalRowsToBlocks(
      [
        [uuid, "today note", "Nov 6th, 2026", "", today],
        [uuid, "yesterday note", "Nov 5th, 2026", "", today - 1],
        [uuid, "old note", "old page", "", journalDayNumber(oldDate)],
      ],
      7
    );
    expect(blocks.map((block) => block.content)).toEqual([
      "today note",
      "yesterday note",
    ]);
    expect(blocks[0].day).toBe(today);
  });

  it("sorts days descending across the window", () => {
    const d1 = new Date();
    d1.setDate(d1.getDate() - 3);
    const d2 = new Date();
    d2.setDate(d2.getDate() - 1);
    const blocks = journalRowsToBlocks(
      [
        [uuid, "d1", "p", "", journalDayNumber(d1)],
        [uuid, "d2", "p", "", journalDayNumber(d2)],
      ],
      7
    );
    expect(blocks.map((block) => block.day)).toEqual([
      journalDayNumber(d2),
      journalDayNumber(d1),
    ]);
  });

  it("queries journal pages via datalog and returns matching blocks", async () => {
    const datascriptQuery = vi
      .fn()
      .mockImplementationOnce(() => Promise.resolve([]))
      .mockImplementationOnce(() =>
        Promise.resolve([[uuid, "journal entry", "Nov 6th, 2026", "", today]])
      );
    (globalThis as { logseq?: unknown }).logseq = {
      DB: { q: vi.fn(), datascriptQuery },
    };
    const result = (await searchJournal(7)) as {
      via: string;
      days: number;
      blocks: unknown[];
    };
    expect(result.via).toBe("datalog");
    expect(result.days).toBe(7);
    expect(result.blocks).toHaveLength(1);
    expect(datascriptQuery.mock.calls[0][0]).toContain(":block/journal?");
    expect(datascriptQuery.mock.calls[0][0]).toContain(":block/journal-day");
  });

  it("clamps the days window and returns an empty result on failures", async () => {
    const datascriptQuery = vi.fn().mockRejectedValue(new Error("no dsl"));
    (globalThis as { logseq?: unknown }).logseq = {
      DB: { q: vi.fn(), datascriptQuery },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = (await searchJournal(1000)) as { days: number; blocks: unknown[] };
    expect(result.days).toBe(90);
    expect(result.blocks).toEqual([]);
    warnSpy.mockRestore();
  });
});

describe("getRecentPages (F10)", () => {
  it("lists pages by updatedAt via datalog, excluding assistant pages", async () => {
    const datascriptQuery = vi.fn().mockResolvedValue([
      ["old-page", 100],
      ["fresh-page", 300],
      ["ai_assistant/20261105_test", 999],
      ["mid-page", 200],
    ]);
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages: vi.fn() },
      DB: { q: vi.fn(), datascriptQuery },
    };
    const result = (await executeLogseqTool("get_recent_pages", "{}")) as string;
    expect(JSON.parse(result)).toEqual({
      via: "datalog",
      pages: [
        { name: "fresh-page", updatedAt: 300 },
        { name: "mid-page", updatedAt: 200 },
        { name: "old-page", updatedAt: 100 },
      ],
    });
    expect(datascriptQuery.mock.calls[0][0]).toContain(":block/updated-at");
  });

  it("falls back to getAllPages when datalog fails", async () => {
    const datascriptQuery = vi.fn().mockRejectedValue(new Error("no attr"));
    const getAllPages = vi.fn().mockResolvedValue([
      { name: "alpha", updatedAt: 5 },
      { name: "beta", updatedAt: 50 },
    ]);
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getAllPages },
      DB: { q: vi.fn(), datascriptQuery },
    };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = JSON.parse(
      (await executeLogseqTool("get_recent_pages", '{"limit": 1}')) as string
    );
    expect(result).toEqual({
      via: "getAllPages",
      pages: [{ name: "beta", updatedAt: 50 }],
    });
    warnSpy.mockRestore();
  });
});

describe("get_selected_blocks (F10)", () => {
  it("returns the selected blocks", async () => {
    const getSelectedBlocks = vi.fn().mockResolvedValue([
      { uuid: "u1", content: "selected text" },
    ]);
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: { getSelectedBlocks },
    };
    const result = JSON.parse(
      (await executeLogseqTool("get_selected_blocks", "{}")) as string
    );
    expect(result).toEqual({
      blocks: [{ uuid: "u1", content: "selected text", children: 0 }],
    });
  });

  it("returns an empty list when nothing is selected or the API fails", async () => {
    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {
        getSelectedBlocks: vi.fn().mockResolvedValue(null),
      },
    };
    expect(JSON.parse(
      (await executeLogseqTool("get_selected_blocks", "{}")) as string
    )).toEqual({ blocks: [] });

    (globalThis as { logseq?: unknown }).logseq = {
      Editor: {
        getSelectedBlocks: vi.fn().mockRejectedValue(new Error("blocked")),
      },
    };
    expect(JSON.parse(
      (await executeLogseqTool("get_selected_blocks", "{}")) as string
    )).toEqual({ blocks: [] });
  });
});
