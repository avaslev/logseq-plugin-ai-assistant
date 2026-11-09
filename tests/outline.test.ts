import { describe, expect, it } from "vitest";
import { parseOutline } from "../src/outline";

describe("parseOutline", () => {
  it("parses top-level items and their children", () => {
    const parsed = parseOutline("- Section A\n  - item 1\n  - item 2\n- Section B");
    expect(parsed.nodes).toEqual([
      {
        content: "Section A",
        children: [
          { content: "item 1", children: [] },
          { content: "item 2", children: [] },
        ],
      },
      { content: "Section B", children: [] },
    ]);
    expect(parsed.blockCount).toBe(4);
  });

  it("flattens items deeper than the block depth into • lines", () => {
    const parsed = parseOutline(
      "- A\n  - B\n    - C\n      - D\n  - E"
    );
    expect(parsed.nodes).toEqual([
      {
        content: "A",
        children: [
          { content: "B\n• C\n  • D", children: [] },
          { content: "E", children: [] },
        ],
      },
    ]);
    expect(parsed.blockCount).toBe(3);
  });

  it("collapses a single-child chain into one block", () => {
    const parsed = parseOutline("- A\n  - B");
    expect(parsed.nodes).toEqual([
      { content: "A\n• B", children: [] },
    ]);
    expect(parsed.blockCount).toBe(1);
  });

  it("supports numbered markers and tabs", () => {
    const parsed = parseOutline("1. A\n\t1) B\n\t\t2) C");
    expect(parsed.nodes).toEqual([
      { content: "A\n• B\n  • C", children: [] },
    ]);
  });

  it("does not parse list markers inside fenced code blocks", () => {
    const parsed = parseOutline(
      "- Section\n```\n- not a bullet\n```\n- Next"
    );
    expect(parsed.nodes).toEqual([
      {
        content: "Section\n```\n- not a bullet\n```",
        children: [],
      },
      { content: "Next", children: [] },
    ]);
    expect(parsed.blockCount).toBe(2);
  });

  it("treats plain text without list markers as one block", () => {
    const parsed = parseOutline("Intro line\nsecond line");
    expect(parsed.nodes).toEqual([
      { content: "Intro line\nsecond line", children: [] },
    ]);
  });

  it("returns no nodes for empty text", () => {
    expect(parseOutline(" \n\n ")).toEqual({ nodes: [], blockCount: 0 });
  });

  it("counts blocks for the tool limit", () => {
    const outline = Array.from({ length: 101 }, (_, i) => `- item ${i}`).join(
      "\n"
    );
    expect(parseOutline(outline).blockCount).toBe(101);
  });
});
