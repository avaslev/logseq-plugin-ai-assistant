import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  historyFromTree,
  sanitizeSessionSlug,
  splitReplyIntoBlocks,
} from "../src/format";

describe("sanitizeSessionSlug", () => {
  it("keeps letters, digits, spaces, dashes and underscores", () => {
    expect(sanitizeSessionSlug("Fix login bug-2_test")).toBe(
      "Fix login bug-2_test"
    );
    expect(sanitizeSessionSlug("Заметки о проекте")).toBe("Заметки о проекте");
  });

  it("replaces special characters with spaces", () => {
    expect(sanitizeSessionSlug("a/b\\c:d*e?f")).toBe("a b c d e f");
    expect(sanitizeSessionSlug("при<>вет|мир")).toBe("при вет мир");
  });

  it("collapses whitespace and trims to 40 chars", () => {
    expect(sanitizeSessionSlug("   a    b   ")).toBe("a b");
    expect(sanitizeSessionSlug("x".repeat(60)).length).toBe(40);
  });
});

describe("splitReplyIntoBlocks", () => {
  it("splits by newline into parent blocks", () => {
    const blocks = splitReplyIntoBlocks("first\nsecond\nthird");
    expect(blocks.map((b) => b.content)).toEqual(["first", "second", "third"]);
    expect(blocks.every((b) => b.children.length === 0)).toBe(true);
  });

  it("indented lines become children of the previous block", () => {
    const blocks = splitReplyIntoBlocks("parent\n  child1\n  child2\nnext");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      content: "parent",
      children: ["child1", "child2"],
    });
    expect(blocks[1].content).toBe("next");
  });

  it("skips empty lines", () => {
    const blocks = splitReplyIntoBlocks("a\n\n\nb");
    expect(blocks.map((b) => b.content)).toEqual(["a", "b"]);
  });

  it("attaches bullet lists as children of the intro line", () => {
    const blocks = splitReplyIntoBlocks("Here are the names:\n- Alice\n- Bob");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("Here are the names:");
    expect(blocks[0].children).toEqual(["- Alice", "- Bob"]);
  });

  it("treats numbered items as bullets of the intro", () => {
    const blocks = splitReplyIntoBlocks("Steps:\n1. first\n2. second");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].children).toEqual(["1. first", "2. second"]);
  });

  it("makes a bullet list without intro sibling top-level blocks", () => {
    const blocks = splitReplyIntoBlocks("- Alice\n- Bob\n- Carol");
    expect(blocks.map((b) => b.content)).toEqual([
      "- Alice",
      "- Bob",
      "- Carol",
    ]);
    expect(blocks.every((b) => b.children.length === 0)).toBe(true);
  });

  it("merges description lines into the preceding bullet block", () => {
    const blocks = splitReplyIntoBlocks(
      "- Berlin\nCapital of Germany\n- Paris\nCapital of France"
    );
    expect(blocks.map((b) => b.content)).toEqual([
      "- Berlin Capital of Germany",
      "- Paris Capital of France",
    ]);
  });

  it("starts a new block for text after an empty line", () => {
    const blocks = splitReplyIntoBlocks(
      "Here are the names:\n- Alice\n- Bob\n\nConclusion here"
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].content).toBe("Here are the names:");
    expect(blocks[0].children).toEqual(["- Alice", "- Bob"]);
    expect(blocks[1].content).toBe("Conclusion here");
  });

  it("starts a new block for non-bullet lines after a list", () => {
    const blocks = splitReplyIntoBlocks("Intro:\n- a\n- b\nConclusion here");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].children).toEqual(["- a", "- b"]);
    expect(blocks[1].content).toBe("Conclusion here");
    expect(blocks[1].children).toEqual([]);
  });

  it("converts literal-\\n lists into one line with bullet separators", () => {
    const blocks = splitReplyIntoBlocks("Names:\\n- Alice\\n- Bob");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("Names: • Alice • Bob");
    expect(blocks[0].children).toEqual([]);
  });

  it("keeps compact bullet lists written with bullets on one line", () => {
    const blocks = splitReplyIntoBlocks("• Alice\\n• Bob\\n• Carol");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].content).toBe("• Alice • Bob • Carol");
    expect(blocks[0].children).toEqual([]);
  });

  it("returns empty array for empty reply", () => {
    expect(splitReplyIntoBlocks("")).toEqual([]);
    expect(splitReplyIntoBlocks("\n\n  \n")).toEqual([]);
  });
});

describe("historyFromTree", () => {
  const tree = [
    { content: "AI Session" },
    { content: "hello" },
    {
      content: "greetings",
      children: [{ content: "- extra detail" }],
    },
    { content: "how are you" },
    { content: "fine" },
  ];

  it("skips meta block and alternates user/assistant by position", () => {
    const result = historyFromTree(tree);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "greetings\n- extra detail" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "fine" },
    ]);
  });

  it("limits history to the last N messages", () => {
    const longTree = Array.from({ length: 51 }, (_, i) => ({
      content: `msg ${i}`,
    }));
    const result = historyFromTree(longTree, 10);
    expect(result).toHaveLength(10);
    expect(result[0].content).toBe("msg 41");
    expect(result[9].content).toBe("msg 50");
  });

  it("skips empty and thinking placeholders", () => {
    const result = historyFromTree([
      { content: "meta" },
      { content: "q" },
      { content: "🤔 Thinking…" },
      { content: "  " },
      { content: "answer" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "answer" },
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("contains Logseq block rules and reference rules", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("NEW block");
    expect(prompt).toContain("\\n");
    expect(prompt).toContain("((block-uuid))");
    expect(prompt).toContain("[[Page Name]]");
    expect(prompt).toContain("search_graph");
  });
});
