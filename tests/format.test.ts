import { describe, expect, it } from "vitest";
import {
  ASSISTANT_MARKER,
  buildSystemPrompt,
  historyFromTree,
  markAssistantContent,
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

  it("preserves nested list indentation", () => {
    expect(toSingleBlockContent("- Parent\n  - Child\n    - Grandchild")).toBe(
      "Parent\n  • Child\n    • Grandchild"
    );
  });

  it("keeps fenced code blocks intact", () => {
    const reply = [
      "Example:",
      "",
      "```yaml",
      "- name: foo",
      "  value: 1",
      "",
      "# comment",
      "```",
      "Done",
    ].join("\n");
    expect(toSingleBlockContent(reply)).toBe(
      [
        "Example:",
        "```yaml",
        "- name: foo",
        "  value: 1",
        "",
        "# comment",
        "```",
        "Done",
      ].join("\n")
    );
  });

  it("does not treat think fragments inside code as service lines", () => {
    const reply = ["```", "</think>", "/think", "```"].join("\n");
    expect(toSingleBlockContent(reply)).toBe(reply);
  });

  it("supports tilde fences", () => {
    const reply = ["~~~sh", "- not a bullet", "~~~"].join("\n");
    expect(toSingleBlockContent(reply)).toBe(reply);
  });
});

describe("markAssistantContent", () => {
  it("prefixes replies with the assistant marker", () => {
    expect(markAssistantContent("hello")).toBe(`${ASSISTANT_MARKER}hello`);
    expect(markAssistantContent("")).toBe("");
  });

  it("does not duplicate the marker", () => {
    expect(markAssistantContent(`${ASSISTANT_MARKER}hello`)).toBe(
      `${ASSISTANT_MARKER}hello`
    );
  });
});

describe("historyFromTree", () => {
  const tree = [
    { content: "AI Session" },
    { content: "hello" },
    {
      content: `${ASSISTANT_MARKER}greetings`,
      children: [{ content: "- extra detail" }],
    },
    { content: "how are you" },
    { content: `${ASSISTANT_MARKER}fine` },
  ];

  it("skips meta block and detects roles by the assistant marker", () => {
    const result = historyFromTree(tree);
    expect(result).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "greetings\n- extra detail" },
      { role: "user", content: "how are you" },
      { role: "assistant", content: "fine" },
    ]);
  });

  it("treats unmarked blocks as user messages", () => {
    const result = historyFromTree([
      { content: "AI Session\nmodel:: m\nstarted:: now" },
      { content: "q" },
      { content: "legacy answer" },
    ]);
    expect(result).toEqual([
      { role: "user", content: "q" },
      { role: "user", content: "legacy answer" },
    ]);
  });

  it("keeps roles stable when a block is removed", () => {
    const result = historyFromTree([
      { content: "AI Session\nmodel:: m\nstarted:: now" },
      { content: "q1" },
      { content: `${ASSISTANT_MARKER}a1` },
      { content: `${ASSISTANT_MARKER}a2` },
      { content: "q3" },
      { content: `${ASSISTANT_MARKER}a3` },
    ]);
    expect(result).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  it("does not drop the first message when the meta block is missing", () => {
    const result = historyFromTree([
      { content: "first question" },
      { content: `${ASSISTANT_MARKER}first answer` },
    ]);
    expect(result).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
    ]);
  });

  it("limits history to the last N messages", () => {
    const longTree = Array.from({ length: 51 }, (_, i) => ({
      content: i % 2 === 1 ? `${ASSISTANT_MARKER}msg ${i}` : `msg ${i}`,
    }));
    const result = historyFromTree(longTree, 10);
    expect(result).toHaveLength(10);
    expect(result[0].content).toBe("msg 41");
    expect(result[9].content).toBe("msg 50");
  });

  it("skips empty and thinking placeholders", () => {
    const result = historyFromTree([
      { content: "AI Session\nmodel:: m\nstarted:: now" },
      { content: "q" },
      { content: "💭 Думаю…" },
      { content: "  " },
      { content: `${ASSISTANT_MARKER}answer` },
    ]);
    expect(result).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("skips error and cancel placeholders", () => {
    const result = historyFromTree([
      { content: "AI Session\nmodel:: m\nstarted:: now" },
      { content: "q1" },
      { content: "⚠️ LLM request failed: model runner stopped" },
      { content: "q2" },
      { content: "⏹ Cancelled" },
      { content: "q3" },
      { content: "(empty reply)" },
      { content: "q4" },
      { content: `${ASSISTANT_MARKER}final answer` },
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
