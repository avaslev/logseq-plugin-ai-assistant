import { describe, expect, it } from "vitest";

import {
  buildExcalidrawJson,
  makeDrawingName,
  normalizeShapes,
} from "../src/draw";

describe("normalizeShapes", () => {
  it("applies defaults for a rectangle", () => {
    const { shapes, errors } = normalizeShapes([{ type: "rectangle" }]);
    expect(errors).toEqual([]);
    expect(shapes).toHaveLength(1);
    expect(shapes[0]).toMatchObject({
      type: "rectangle",
      x: 100,
      y: 100,
      width: 160,
      height: 80,
      color: "#1e1e1e",
      background: "transparent",
    });
  });

  it("infers text type from text field", () => {
    const { shapes, errors } = normalizeShapes([{ text: "hello" }]);
    expect(errors).toEqual([]);
    expect(shapes[0].type).toBe("text");
  });

  it("accepts a JSON string", () => {
    const { shapes, errors } = normalizeShapes(
      '[{"type":"ellipse","x":10,"y":20}]'
    );
    expect(errors).toEqual([]);
    expect(shapes[0]).toMatchObject({ type: "ellipse", x: 10, y: 20 });
  });

  it("clamps non-finite numbers to defaults", () => {
    const { shapes, errors } = normalizeShapes([
      { type: "rectangle", x: "abc", y: Number.NaN, width: -5, height: 99999 },
    ]);
    expect(errors).toEqual([]);
    expect(shapes[0].x).toBe(100);
    expect(shapes[0].y).toBe(100);
    expect(shapes[0].width).toBe(2);
    expect(shapes[0].height).toBe(10000);
  });

  it("keeps valid colors and rejects others", () => {
    const { shapes } = normalizeShapes([
      { type: "rectangle", color: "#e03131", background: "rgba(1,2,3,0.5)" },
      { type: "rectangle", color: "red", background: "not a color" },
    ]);
    expect(shapes[0].color).toBe("#e03131");
    expect(shapes[0].background).toBe("rgba(1,2,3,0.5)");
    expect(shapes[1].color).toBe("#1e1e1e");
    expect(shapes[1].background).toBe("transparent");
  });

  it("collects errors for unknown types and empty text", () => {
    const { shapes, errors } = normalizeShapes([
      { type: "star" },
      { type: "text" },
      "garbage",
      null,
    ]);
    expect(shapes).toHaveLength(0);
    expect(errors).toHaveLength(4);
  });

  it("reports malformed input", () => {
    expect(normalizeShapes("nope").errors).toEqual([
      "shapes is not valid JSON",
    ]);
    expect(normalizeShapes(42).errors).toEqual(["shapes must be an array"]);
    expect(normalizeShapes({"a":1}).errors).toEqual(["shapes must be an array"]);
    expect(normalizeShapes(undefined).shapes).toEqual([]);
  });

  it("estimates text size from content", () => {
    const { shapes } = normalizeShapes([{ type: "text", text: "ab" }]);
    expect(shapes[0].width).toBe(20 * 2 * 0.6);
    expect(shapes[0].height).toBe(20 * 1.25);
  });

  it("defaults arrow endpoints to x+width / y+height", () => {
    const { shapes } = normalizeShapes([
      { type: "arrow", x: 10, y: 10, x2: 200, y2: 300 },
      { type: "arrow", x: 10, y: 10 },
    ]);
    expect(shapes[0].x2).toBe(200);
    expect(shapes[0].y2).toBe(300);
    expect(shapes[1].x2).toBe(10 + 160);
    expect(shapes[1].y2).toBe(10 + 80);
  });
});

describe("buildExcalidrawJson", () => {
  it("builds a valid v2 document", () => {
    const { shapes } = normalizeShapes([
      { type: "rectangle" },
      { type: "text", text: "hi" },
    ]);
    const doc = JSON.parse(buildExcalidrawJson(shapes)) as {
      type: string;
      version: number;
      elements: Array<Record<string, unknown>>;
    };
    expect(doc.type).toBe("excalidraw");
    expect(doc.version).toBe(2);
    expect(doc.elements).toHaveLength(2);
  });

  it("emits arrow points relative to origin", () => {
    const { shapes } = normalizeShapes([
      { type: "arrow", x: 100, y: 100, x2: 300, y2: 400 },
    ]);
    const doc = JSON.parse(buildExcalidrawJson(shapes)) as {
      elements: Array<{ points: number[][]; width: number; height: number }>;
    };
    expect(doc.elements[0].points).toEqual([
      [0, 0],
      [200, 300],
    ]);
    expect(doc.elements[0].width).toBe(200);
    expect(doc.elements[0].height).toBe(300);
  });

  it("gives every element a unique id and seed", () => {
    const { shapes } = normalizeShapes([
      { type: "rectangle" },
      { type: "ellipse" },
      { type: "text", text: "x" },
    ]);
    const doc = JSON.parse(buildExcalidrawJson(shapes)) as {
      elements: Array<{ id: string; seed: number }>;
    };
    const ids = new Set(doc.elements.map((e) => e.id));
    const seeds = new Set(doc.elements.map((e) => e.seed));
    expect(ids.size).toBe(3);
    expect(seeds.size).toBe(3);
  });
});

describe("makeDrawingName", () => {
  it("formats a timestamp name", () => {
    expect(makeDrawingName(new Date(2026, 10, 8, 23, 4, 5))).toBe(
      "2026-11-08-23-04-05"
    );
  });
});
