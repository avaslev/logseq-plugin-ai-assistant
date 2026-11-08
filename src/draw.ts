// Excalidraw drawings: create a draws/<name>.excalidraw file with AI-generated
// elements and embed it into the current page as a page-ref. Logseq renders
// any [[...]] page-ref ending in .excalidraw as an inline editable canvas.
// File creation goes through the host-scope internal save-excalidraw! (same
// function Logseq's own /Draw command uses); there is no public API for it.

const DEFAULT_VIEW_BACKGROUND = "#FFFFFF";

export interface DrawShapeInput {
  type?: unknown;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  x2?: unknown;
  y2?: unknown;
  width?: unknown;
  height?: unknown;
  color?: unknown;
  background?: unknown;
}

export interface DrawElement extends Record<string, unknown> {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ShapeSpec {
  type: DrawElement["type"];
  text: string;
  x: number;
  y: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  color: string;
  background: string;
}

const SHAPE_TYPES = new Set(["rectangle", "ellipse", "text", "arrow"]);

function clampNumber(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampCoord(value: unknown, fallback: number): number {
  const n = clampNumber(value, fallback);
  return Math.min(Math.max(n, -10000), 10000);
}

function colorString(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(v) || /^rgba?\(/.test(v) ? v : fallback;
}

export function normalizeShapes(input: unknown): {
  shapes: ShapeSpec[];
  errors: string[];
} {
  const errors: string[] = [];
  let rows: unknown[] = [];
  if (Array.isArray(input)) rows = input;
  else if (typeof input === "string") {
    try {
      const parsed: unknown = JSON.parse(input);
      if (Array.isArray(parsed)) rows = parsed;
      else errors.push("shapes must be an array");
    } catch {
      errors.push("shapes is not valid JSON");
    }
  } else if (input != null) {
    errors.push("shapes must be an array");
  }
  const shapes: ShapeSpec[] = [];
  rows.forEach((row, i) => {
    const label = `shapes[${i}]`;
    if (typeof row !== "object" || row === null) {
      errors.push(`${label}: not an object`);
      return;
    }
    const raw = row as DrawShapeInput;
    let type =
      typeof raw.type === "string" && SHAPE_TYPES.has(raw.type.trim())
        ? (raw.type.trim() as ShapeSpec["type"])
        : null;
    const text = typeof raw.text === "string" ? raw.text : "";
    if (!type) {
      if (text) type = "text";
      else {
        errors.push(`${label}: unknown type`);
        return;
      }
    }
    if (type === "text" && !text.trim()) {
      errors.push(`${label}: text shape without text`);
      return;
    }
    const fontSize = 20;
    const lines = text ? text.split("\n") : [];
    const lineWidth = lines.length
      ? Math.max(...lines.map((l) => l.length)) * fontSize * 0.6
      : 0;
    const lineHeight = lines.length * fontSize * 1.25;
    const width = clampCoord(
      raw.width,
      type === "text" ? Math.max(20, lineWidth) : 160
    );
    const height = clampCoord(
      raw.height,
      type === "text" ? Math.max(20, lineHeight) : type === "ellipse" ? 90 : 80
    );
    shapes.push({
      type,
      text,
      x: clampCoord(raw.x, 100),
      y: clampCoord(raw.y, 100),
      x2: clampCoord(raw.x2, clampCoord(raw.x, 100) + width),
      y2: clampCoord(raw.y2, clampCoord(raw.y, 100) + height),
      width: Math.min(Math.max(width, 2), 20000),
      height: Math.min(Math.max(height, 2), 20000),
      color: colorString(raw.color, "#1e1e1e"),
      background: colorString(raw.background, "transparent"),
    });
  });
  return { shapes, errors };
}

function baseElement(
  id: string,
  type: string,
  shape: ShapeSpec,
  seed: number
): DrawElement {
  return {
    id,
    type,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    angle: 0,
    strokeColor: shape.color,
    backgroundColor: type === "text" ? "transparent" : shape.background,
    fillStyle: "hachure",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    roundness: type === "rectangle" ? { type: 3 } : null,
    seed,
    version: 1,
    versionNonce: seed + 1,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

// Pure: build an excalidraw v2 document JSON from shape specs.
export function buildExcalidrawJson(shapes: ShapeSpec[]): string {
  const elements = shapes.map((shape, i) => {
    const id = `ai-el-${i + 1}`;
    const seed = 100000 + i * 7919;
    if (shape.type === "text") {
      return {
        ...baseElement(id, "text", shape, seed),
        text: shape.text,
        fontSize: 20,
        fontFamily: 1,
        textAlign: "left",
        verticalAlign: "top",
        containerId: null,
        originalText: shape.text,
        lineHeight: 1.25,
        baseline: 18,
      };
    }
    if (shape.type === "arrow") {
      return {
        ...baseElement(id, "arrow", shape, seed),
        width: shape.x2 - shape.x,
        height: shape.y2 - shape.y,
        points: [
          [0, 0],
          [shape.x2 - shape.x, shape.y2 - shape.y],
        ],
        lastCommittedPoint: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        startBinding: null,
        endBinding: null,
      };
    }
    return baseElement(id, shape.type, shape, seed);
  });
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "logseq-plugin-ai-assistant",
    elements,
    appState: {
      viewBackgroundColor: DEFAULT_VIEW_BACKGROUND,
      gridSize: null,
    },
    files: {},
  });
}

// Same default content frontend.handler.draw/default-content uses.
function defaultJson(): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://logseq.com",
    elements: [],
    appState: { viewBackgroundColor: "#FFF", gridSize: null },
  });
}

export function makeDrawingName(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `-${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`
  );
}

type HostApi = Record<string, (...args: unknown[]) => unknown>;

interface HostScope {
  $APP?: Record<string, unknown>;
  logseq?: {
    api?: HostApi;
  };
}

interface ProbePage {
  uuid: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHostScope(): HostScope | null {
  try {
    return logseq.Experiments.ensureHostScope() as HostScope;
  } catch {
    return null;
  }
}

export interface CreateDrawingResult {
  path: string;
  elements: number;
  pageCreated: boolean;
  insertedBlock: string | null;
  note?: string;
}

export async function createDrawing(
  shapesInput: unknown
): Promise<CreateDrawingResult> {
  const { shapes, errors } = normalizeShapes(shapesInput);
  if (errors.length && !shapes.length) {
    throw new Error(errors.join("; "));
  }
  if (!shapes.length) {
    throw new Error("shapes is empty");
  }
  const app = getHostScope()?.$APP;
  const save = app?.$frontend$handler$draw$save_excalidraw_BANG_$$ as
    | ((path: string, data: string) => Promise<unknown>)
    | undefined;
  if (typeof save !== "function") {
    throw new Error("host save_excalidraw! недоступен");
  }
  const name = `draws/ai-drawing-${makeDrawingName(new Date())}.excalidraw`;
  const existing = await logseq.Editor.getPage(name);
  if (existing) {
    throw new Error(`Страница ${name} уже существует`);
  }
  // save-excalidraw! creates draws/, writes the file and transacts the
  // page/file records — everything create_draw_with_default_content does.
  await save(name, defaultJson());
  await sleep(300);
  const page = (await logseq.Editor.getPage(name)) as ProbePage | null;
  if (!page) throw new Error("страница рисунка не создалась");
  await save(name, buildExcalidrawJson(shapes));
  await sleep(300);
  let insertedBlock: string | null = null;
  const notes: string[] = [];
  notes.push(...errors.map((e) => `warning: ${e}`));
  const current = (await logseq.Editor.getCurrentPage()) as ProbePage | null;
  if (current?.uuid) {
    const block = (await logseq.Editor.insertBlock(
      current.uuid,
      `[[${name}]]`
    )) as { uuid?: string } | null;
    insertedBlock = block?.uuid ?? null;
  } else {
    notes.push(`нет открытой страницы: вставьте [[${name}]] вручную`);
  }
  return {
    path: name,
    elements: shapes.length,
    pageCreated: true,
    insertedBlock,
    note: notes.length ? notes.join("; ") : undefined,
  };
}
