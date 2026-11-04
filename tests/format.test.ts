import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  historyFromTree,
  sanitizeSessionSlug,
  toSingleBlockContent,
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

describe("toSingleBlockContent", () => {
  it("joins all lines into one block content with real line breaks", () => {
    expect(toSingleBlockContent("Intro:\n- Alice\n- Bob")).toBe(
      "Intro:\n• Alice\n• Bob"
    );
  });

  it("strips the leading bullet marker from the first line", () => {
    expect(toSingleBlockContent("• Hello there\nsecond line")).toBe(
      "Hello there\nsecond line"
    );
    expect(toSingleBlockContent("- Answer here")).toBe("Answer here");
  });

  it("trims lines and drops empty ones", () => {
    expect(toSingleBlockContent("  a  \n\n\n  b \n")).toBe("a\nb");
  });

  it("returns single trimmed line for single-line reply", () => {
    expect(toSingleBlockContent("  just text  ")).toBe("just text");
  });

  it("returns empty string for empty reply", () => {
    expect(toSingleBlockContent("\n\n")).toBe("");
  });

  it("drops think tag fragment lines", () => {
    expect(
      toSingleBlockContent("/think\n</think>\n37 × 43 = 1591.")
    ).toBe("37 × 43 = 1591.");
  });

  it("converts markdown bullets to plain bullet chars and strips headings", () => {
    expect(
      toSingleBlockContent("# Cities\n- Berlin\n- Paris")
    ).toBe("Cities\n• Berlin\n• Paris");
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
      { content: "💭 Думаю…" },
      { content: "  " },
      { content: "answer" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("skips error and cancel placeholders", () => {
    const result = historyFromTree([
      { content: "meta" },
      { content: "q1" },
      { content: "⚠️ LLM request failed: model runner stopped" },
      { content: "q2" },
      { content: "⏹ Cancelled" },
      { content: "q3" },
      { content: "(empty reply)" },
      { content: "q4" },
      { content: "final answer" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "q1" },
      { role: "user", content: "q2" },
      { role: "user", content: "q3" },
      { role: "user", content: "q4" },
      { role: "assistant", content: "final answer" },
    ]);
  });
});

describe("buildSystemPrompt", () => {
  it("describes the single-block answer format", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("SINGLE Logseq block");
    expect(prompt).toContain("line breaks inside that same block");
    expect(prompt).toContain("((block-uuid))");
    expect(prompt).toContain("[[Page Name]]");
    expect(prompt).toContain("search_graph");
    expect(prompt).toContain("Never output the literal characters backslash+n");
  });
});
