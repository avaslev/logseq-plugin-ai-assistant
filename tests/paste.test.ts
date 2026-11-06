import { describe, expect, it } from "vitest";
import {
  expandTextPlaceholders,
  isLargePaste,
  LARGE_PASTE_THRESHOLD,
  makeTextPlaceholder,
  nextAttachmentId,
  removeTextPlaceholder,
} from "../src/paste";

describe("isLargePaste", () => {
  it("flags pastes above the threshold", () => {
    expect(isLargePaste("a".repeat(LARGE_PASTE_THRESHOLD))).toBe(true);
    expect(isLargePaste("a".repeat(LARGE_PASTE_THRESHOLD - 1))).toBe(false);
    expect(isLargePaste("short")).toBe(false);
  });
});

describe("makeTextPlaceholder + expandTextPlaceholders", () => {
  it("round-trips attachment content through the placeholder", () => {
    const id = nextAttachmentId();
    const placeholder = makeTextPlaceholder(id, 5200);
    expect(placeholder).toMatch(/^\[text t[a-z0-9]+, 5 200 chars\]$/);

    const input = `Check this: ${placeholder} please.`;
    const expansion = expandTextPlaceholders(input, [
      { id, content: "x".repeat(5200) },
    ]);
    expect(expansion.content).toBe(`Check this: ${"x".repeat(5200)} please.`);
    expect(expansion.orphanIds).toEqual([]);
  });

  it("reports attachments whose placeholder was removed", () => {
    const kept = "t1";
    const dropped = "t2";
    const expansion = expandTextPlaceholders(
      `[text ${kept}, 1 500 chars] plain`,
      [
        { id: kept, content: "kept text" },
        { id: dropped, content: "dropped text" },
      ]
    );
    expect(expansion.content).toBe("kept text plain");
    expect(expansion.orphanIds).toEqual([dropped]);
  });

  it("leaves unknown tokens untouched", () => {
    const token = "[text unknown, 10 chars]";
    const expansion = expandTextPlaceholders(token, []);
    expect(expansion.content).toBe(token);
    expect(expansion.orphanIds).toEqual([]);
  });

  it("expands multiple placeholders", () => {
    const a = makeTextPlaceholder("ta", 2);
    const b = makeTextPlaceholder("tb", 3);
    const expansion = expandTextPlaceholders(`${a} and ${b}`, [
      { id: "ta", content: "aa" },
      { id: "tb", content: "bbb" },
    ]);
    expect(expansion.content).toBe("aa and bbb");
  });
});

describe("removeTextPlaceholder", () => {
  it("removes only the token of the given id", () => {
    const input = `keep [text t1, 1 500 chars] drop [text t2, 2 000 chars]`;
    expect(removeTextPlaceholder(input, "t2")).toBe(
      "keep [text t1, 1 500 chars] drop "
    );
  });
});

describe("nextAttachmentId", () => {
  it("generates unique ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextAttachmentId()));
    expect(ids.size).toBe(50);
  });
});
