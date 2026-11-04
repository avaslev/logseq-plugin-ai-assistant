import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@logseq/libs", () => ({ logseq: {} }));

import {
  executeLogseqTool,
  filterBlocks,
  filterPageNames,
  getLogseqToolSpecs,
} from "../src/logseqTools";

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
