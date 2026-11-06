import { describe, expect, it } from "vitest";
import {
  caretOnFirstLine,
  caretOnLastLine,
  historyDown,
  historyUp,
  shouldSubmitOnEnter,
} from "../src/input";

describe("shouldSubmitOnEnter", () => {
  it("submits on Enter", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("inserts a newline on Shift+Enter", () => {
    expect(shouldSubmitOnEnter({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("ignores other keys", () => {
    expect(shouldSubmitOnEnter({ key: "a", shiftKey: false })).toBe(false);
  });

  it("does not submit while an IME is composing", () => {
    expect(
      shouldSubmitOnEnter({ key: "Enter", shiftKey: false, isComposing: true })
    ).toBe(false);
    expect(
      shouldSubmitOnEnter({ key: "Enter", shiftKey: false, keyCode: 229 })
    ).toBe(false);
  });
});

describe("historyUp", () => {
  const entries = ["first", "second", "third"];

  it("enters the history from the newest entry", () => {
    expect(
      historyUp({ entries, index: null, draft: "draft text" })
    ).toEqual({ text: "third", index: 2 });
  });

  it("walks back through the entries", () => {
    expect(historyUp({ entries, index: 2, draft: "" })).toEqual({
      text: "second",
      index: 1,
    });
    expect(historyUp({ entries, index: 1, draft: "" })).toEqual({
      text: "first",
      index: 0,
    });
  });

  it("stops at the oldest entry", () => {
    expect(historyUp({ entries, index: 0, draft: "" })).toBeNull();
  });

  it("does nothing when the history is empty", () => {
    expect(historyUp({ entries: [], index: null, draft: "x" })).toBeNull();
  });
});

describe("historyDown", () => {
  const entries = ["first", "second", "third"];

  it("does nothing in the new-message slot", () => {
    expect(historyDown({ entries, index: null, draft: "x" })).toBeNull();
  });

  it("walks forward through the entries", () => {
    expect(historyDown({ entries, index: 0, draft: "" })).toEqual({
      text: "second",
      index: 1,
    });
  });

  it("restores the saved draft when leaving the history", () => {
    expect(
      historyDown({ entries, index: entries.length - 1, draft: "my draft" })
    ).toEqual({ text: "my draft", index: null });
  });
});

describe("caret line helpers", () => {
  it("detects the first line for ArrowUp hijacking", () => {
    expect(caretOnFirstLine("one\ntwo", 2)).toBe(true);
    expect(caretOnFirstLine("one\ntwo", 5)).toBe(false);
    expect(caretOnFirstLine("one\ntwo", 0)).toBe(true);
  });

  it("detects the last line for ArrowDown hijacking", () => {
    expect(caretOnLastLine("one\ntwo", 5)).toBe(true);
    expect(caretOnLastLine("one\ntwo", 2)).toBe(false);
    expect(caretOnLastLine("one\ntwo", 7)).toBe(true);
  });
});
