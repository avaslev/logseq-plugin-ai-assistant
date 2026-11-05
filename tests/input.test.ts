import { describe, expect, it } from "vitest";
import { shouldSubmitOnEnter } from "../src/input";

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
