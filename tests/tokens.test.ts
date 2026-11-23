import { afterEach, describe, expect, it } from "vitest";
import {
  calibrateTokenEstimate,
  estimateMessagesTokens,
  estimateTokens,
  formatTokenCount,
  getTokenCalibration,
  resetTokenCalibration,
} from "../src/tokens";

describe("estimateTokens", () => {
  it("returns 0 for empty text", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates latin text at ~4 chars per token", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });

  it("estimates cyrillic text at ~2.5 chars per token", () => {
    expect(estimateTokens("б".repeat(25))).toBe(10);
  });

  it("handles mixed scripts", () => {
    const tokens = estimateTokens("a".repeat(20) + "б".repeat(10));
    expect(tokens).toBe(Math.ceil(20 / 4 + 10 / 2.5));
  });
});

describe("estimateMessagesTokens", () => {
  it("adds per-message framing", () => {
    const single = estimateMessagesTokens([{ role: "user", content: "" }]);
    expect(single).toBe(4);
    const pair = estimateMessagesTokens([
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ]);
    expect(pair).toBe(8);
  });

  it("counts message content and tool calls", () => {
    const tokens = estimateMessagesTokens([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "1",
            type: "function",
            function: { name: "search_graph", arguments: '{"query":"x"}' },
          },
        ],
      },
    ]);
    expect(tokens).toBeGreaterThan(4);
  });

  it("tolerates null content", () => {
    expect(
      estimateMessagesTokens([{ role: "assistant", content: null }])
    ).toBe(4);
  });
});

describe("token calibration", () => {
  afterEach(() => {
    resetTokenCalibration();
  });

  it("starts at 1 and raises the estimate when usage is larger", () => {
    expect(getTokenCalibration()).toBe(1);
    const before = estimateTokens("a".repeat(40));
    calibrateTokenEstimate(before, before * 2);
    expect(getTokenCalibration()).toBeGreaterThan(1);
    expect(estimateTokens("a".repeat(40))).toBeGreaterThan(before);
  });

  it("ignores zero or negative values", () => {
    calibrateTokenEstimate(0, 100);
    calibrateTokenEstimate(100, 0);
    expect(getTokenCalibration()).toBe(1);
  });

  it("never swings beyond sane bounds", () => {
    for (let i = 0; i < 50; i += 1) calibrateTokenEstimate(1, 1000);
    expect(getTokenCalibration()).toBeLessThanOrEqual(4);
    for (let i = 0; i < 50; i += 1) calibrateTokenEstimate(1000, 1);
    expect(getTokenCalibration()).toBeGreaterThanOrEqual(0.5);
  });
});

describe("formatTokenCount", () => {
  it("formats small numbers as-is", () => {
    expect(formatTokenCount(42)).toBe("42");
  });

  it("formats thousands with one decimal", () => {
    expect(formatTokenCount(1234)).toBe("1.2k");
  });

  it("formats large numbers without decimals", () => {
    expect(formatTokenCount(123_456)).toBe("123k");
  });
});
