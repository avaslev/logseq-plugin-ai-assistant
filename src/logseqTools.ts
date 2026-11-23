import "@logseq/libs";
import { withTimeout } from "./http";
import { toSingleBlockContent } from "./format";
import {
  OUTLINE_MAX_BLOCKS,
  parseOutline,
  type OutlineNode,
} from "./outline";
import { confirmActionWithSignal } from "./confirm";
import { buildSkillPrompt, findSkill, listSkills } from "./skills";
import { createDrawing } from "./draw";

// Tool results are injected into the model context; the cap keeps a single
// read from flooding it. Large enough for a full page section with answers.
const MAX_TOOL_OUTPUT = 12000;
// Long strings are shortened stepwise before the output is cut, so tool
// results stay valid JSON and list items are not silently dropped.
const TRUNCATE_STRING_CAPS = [2000, 500, 150];
const PAGE_BLOCKS_LIMIT = 200;
const MAX_SEARCH_RESULTS = 15;
const SEARCH_CACHE_TTL_MS = 15_000;
const SEARCH_CACHE_MAX = 20;
const QUERY_TIMEOUT_MS = 5_000;
const SESSION_PAGE_PREFIX = "ai_assistant/";

// Blocks keep their text in :block/content on file graphs and :block/title on DB graphs.
const BLOCK_CONTENT_ATTRS = [":block/content", ":block/title"];

interface SearchResult {
  pages: string[];
  blocks: Array<{
    uuid: string;
    content: string;
    page: string;
    marker: string;
  }>;
}

interface BlockEntityMatch {
  uuid: string;
  content: string;
  marker: string;
  pageHint?: unknown;
}

// Task markers arrive as strings, arrays or Sets depending on the graph type
// and how the SDK serialized them.
function normalizeMarker(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? ""))
      .filter(Boolean)
      .join(", ");
  }
  if (
    value &&
    typeof value === "object" &&
    typeof (value as { size?: unknown }).size === "number"
  ) {
    return Array.from(value as Set<unknown>)
      .map(String)
      .join(", ");
  }
  return "";
}

const searchCache = new Map<
  string,
  { at: number; result: SearchResult }
>();

async function datalog(query: string, ...inputs: unknown[]): Promise<unknown> {
  return logseq.DB.datascriptQuery(query, ...inputs);
}

function readSearchCache(query: string): SearchResult | null {
  const entry = searchCache.get(query);
  if (!entry) return null;
  if (Date.now() - entry.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(query);
    return null;
  }
  return entry.result;
}

function writeSearchCache(query: string, result: SearchResult): void {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    const oldest = searchCache.keys().next().value;
    if (oldest !== undefined) searchCache.delete(oldest);
  }
  searchCache.set(query, { at: Date.now(), result });
}

export function filterPageNames(rows: unknown, query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(rows)) return [];
  const names = rows.map((row) =>
    Array.isArray(row) ? String(row[0]) : String(row)
  );
  return names.filter((name) => name.toLowerCase().includes(q)).slice(0, 10);
}

function blockDatalogQuery(attr: string): string {
  return `[:find ?uuid ?content ?name :in $ ?needle :where [?b :block/uuid ?uuid] [?b ${attr} ?content] [?b :block/page ?p] [?p :block/name ?name] [(clojure.string/includes? (clojure.string/lower-case ?content) (clojure.string/lower-case ?needle))]]`;
}

export function filterBlocks(
  rows: unknown,
  query: string
): SearchResult["blocks"] {
  const q = query.trim().toLowerCase();
  if (!q && !Array.isArray(rows)) return [];
  return (Array.isArray(rows) ? rows : [])
    .filter(
      (row) =>
        Array.isArray(row) && typeof row[0] === "string" && row[0].length > 0
    )
    .map((row) => ({
      uuid: String(row[0]),
      content: String(row[1] ?? ""),
      page: String(row[2] ?? ""),
      marker: normalizeMarker(row[3]),
    }))
    .filter((block) => !q || block.content.toLowerCase().includes(q))
    .slice(0, MAX_SEARCH_RESULTS);
}

export function filterBlockEntities(
  rows: unknown,
  query: string
): BlockEntityMatch[] {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(rows)) return [];
  const out: BlockEntityMatch[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const entity = row as Record<string, unknown>;
    const uuid = String(entity.uuid ?? "");
    if (!uuid) continue;
    const content = String(entity.content ?? entity.title ?? "");
    if (!content.toLowerCase().includes(q)) continue;
    out.push({
      uuid,
      content,
      marker: normalizeMarker(entity.marker),
      pageHint: entity.page,
    });
  }
  return out.slice(0, MAX_SEARCH_RESULTS);
}

async function resolveBlockPages(
  matches: BlockEntityMatch[]
): Promise<SearchResult["blocks"]> {
  const out: SearchResult["blocks"] = [];
  for (const { uuid, content, marker, pageHint } of matches) {
    let page = "";
    try {
      const hint =
        pageHint && typeof pageHint === "object"
          ? (pageHint as { id?: unknown }).id
          : pageHint;
      let pageId = typeof hint === "number" || typeof hint === "string" ? hint : null;
      if (pageId === null) {
        const block = (await logseq.Editor.getBlock(uuid)) as {
          page?: { id?: unknown };
        } | null;
        pageId =
          block?.page && typeof block.page.id === "number"
            ? block.page.id
            : null;
      }
      if (pageId !== null) {
        const pageEntity = await logseq.Editor.getPage(pageId);
        page = String((pageEntity as { name?: unknown } | null)?.name ?? "");
      }
    } catch {
      // page name is best-effort; the uuid is enough for ((uuid)) references
    }
    out.push({ uuid, content, page, marker });
  }
  return out;
}

interface BlockNode {
  uuid?: unknown;
  content?: unknown;
  children?: unknown;
}

function blockChildren(node: BlockNode): BlockNode[] {
  return Array.isArray(node.children) ? (node.children as BlockNode[]) : [];
}

function flattenBlocks(
  tree: BlockNode[],
  limit = 40
): Array<{
  uuid: string;
  content: string;
  children: number;
  depth: number;
  parentUuid: string | null;
}> {
  const out: Array<{
    uuid: string;
    content: string;
    children: number;
    depth: number;
    parentUuid: string | null;
  }> = [];
  const walk = (
    nodes: BlockNode[],
    depth: number,
    parentUuid: string | null
  ): void => {
    for (const node of nodes ?? []) {
      if (out.length >= limit) return;
      const uuid = String(node.uuid ?? "");
      out.push({
        uuid,
        content: String(node.content ?? ""),
        children: blockChildren(node).length,
        depth,
        parentUuid,
      });
      walk(blockChildren(node), depth + 1, uuid);
    }
  };
  walk(tree, 0, null);
  return out;
}

function countBlocks(tree: BlockNode[]): number {
  let n = 0;
  const walk = (nodes: BlockNode[]): void => {
    for (const node of nodes ?? []) {
      n++;
      walk(blockChildren(node));
    }
  };
  walk(tree);
  return n;
}

// Safety ceiling for a single page walk; real output is bounded by the
// offset/limit window and the final truncate() cap.
const MAX_PAGE_BLOCKS = 500;

// Page read result with an explicit marker when the block list was capped,
// so the model knows it saw only part of the page.
function pageReadResult(
  tree: BlockNode[],
  limit: number,
  offset = 0
): Record<string, unknown> {
  const total = countBlocks(tree);
  const all = flattenBlocks(tree, MAX_PAGE_BLOCKS);
  const blocks = all.slice(offset, offset + limit);
  const result: Record<string, unknown> = { blocks };
  if (total > blocks.length + offset) result.totalBlocks = total;
  return result;
}

// Keep the output valid JSON even when it exceeds the cap: first shorten long
// strings (progressively tighter), and only cut raw JSON as a last resort.
function shrinkStrings(value: unknown, cap: number): unknown {
  if (typeof value === "string") {
    return value.length <= cap ? value : `${value.slice(0, cap)}…`;
  }
  if (Array.isArray(value)) return value.map((item) => shrinkStrings(item, cap));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shrinkStrings(item, cap);
    }
    return out;
  }
  return value;
}

function truncate(data: unknown): string {
  const json = JSON.stringify(data);
  if (json.length <= MAX_TOOL_OUTPUT) return json;
  for (const cap of TRUNCATE_STRING_CAPS) {
    const shrunk = JSON.stringify(shrinkStrings(data, cap));
    if (shrunk.length <= MAX_TOOL_OUTPUT) return shrunk;
  }
  return JSON.stringify(
    shrinkStrings(data, TRUNCATE_STRING_CAPS[TRUNCATE_STRING_CAPS.length - 1])
  ).slice(0, MAX_TOOL_OUTPUT);
}

async function fetchAllPageNames(): Promise<{
  names: string[];
  source: string;
}> {
  try {
    const pages = await logseq.Editor.getAllPages();
    if (Array.isArray(pages)) {
      return {
        names: pages.map((page) =>
          String((page as { name?: unknown }).name ?? "")
        ),
        source: "getAllPages",
      };
    }
  } catch (err) {
    console.warn(
      "[ai-assistant] getAllPages failed:",
      err instanceof Error ? err.message : err
    );
  }
  try {
    const rows = await datalog("[:find ?name :where [?p :block/name ?name]]");
    if (Array.isArray(rows)) {
      return {
        names: rows.map((row) =>
          Array.isArray(row) ? String(row[0]) : String(row)
        ),
        source: "datalog",
      };
    }
  } catch (err) {
    console.warn(
      "[ai-assistant] page scan failed:",
      err instanceof Error ? err.message : err
    );
  }
  return { names: [], source: "none" };
}

async function fullScanBlocks(q: string): Promise<SearchResult["blocks"]> {
  for (const attr of BLOCK_CONTENT_ATTRS) {
    try {
      const rows = await datalog(
        `[:find ?uuid ?content ?name :where [?b :block/uuid ?uuid] [?b ${attr} ?content] [?b :block/page ?p] [?p :block/name ?name]]`
      );
      const found = filterBlocks(rows, q);
      if (found.length > 0) return found;
    } catch (err) {
      console.warn(
        `[ai-assistant] block scan (${attr}) failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return [];
}

async function searchBlocks(
  q: string
): Promise<{ blocks: SearchResult["blocks"]; via: string }> {
  let via = "dsl";
  // 1) Built-in query engine — the same DSL as {{query}} in the Logseq UI.
  //    A bare string literal runs the built-in full-text block-content rule,
  //    which is graph-type aware.
  try {
    const rows = await logseq.DB.q(JSON.stringify(q.toLowerCase()));
    if (Array.isArray(rows)) {
      const matches = filterBlockEntities(rows, q);
      if (matches.length > 0)
        return { blocks: await resolveBlockPages(matches), via };
    }
  } catch (err) {
    console.warn(
      "[ai-assistant] built-in block query failed:",
      err instanceof Error ? err.message : err
    );
  }

  // 2) Raw Datalog fallback with case-insensitive matching, content attr first.
  let variantError: unknown = null;
  via = "datalog";
  for (const attr of BLOCK_CONTENT_ATTRS) {
    try {
      const rows = await datalog(blockDatalogQuery(attr), q.toLowerCase());
      const found = filterBlocks(rows, q);
      if (found.length > 0) return { blocks: found, via };
    } catch (err) {
      variantError = err;
      console.warn(
        `[ai-assistant] block search (${attr}) failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  if (variantError) {
    via = "scan";
    return { blocks: await fullScanBlocks(q), via };
  }
  return { blocks: [], via };
}

async function runSearch(q: string): Promise<SearchResult> {
  const { names, source } = await fetchAllPageNames();
  const pages = filterPageNames(names, q);
  const { blocks, via } = await searchBlocks(q);
  console.info(
    `[ai-assistant] search_graph "${q}" (pages: ${source}, blocks: ${via}): ${pages.length} pages, ${blocks.length} blocks`
  );
  return { pages, blocks };
}

const DEFAULT_TASK_STATUSES = ["todo", "doing", "now", "later", "waiting"];

function taskDatalogQuery(attr: string): string {
  return `[:find ?uuid ?content ?name ?marker :where [?b :block/uuid ?uuid] [?b :block/marker ?marker] [?b ${attr} ?content] [?b :block/page ?p] [?p :block/name ?name]]`;
}

export async function searchTasks(
  statusFilter?: string
): Promise<SearchResult["blocks"]> {
  const wanted = (statusFilter ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const statuses = wanted.length > 0 ? wanted : DEFAULT_TASK_STATUSES;
  let via = "dsl";

  // 1) Built-in task rule — the same (task ...) filter as {{query (task TODO)}} in the UI.
  try {
    const rows = await logseq.DB.q(`(task ${statuses.join(" ")})`);
    if (Array.isArray(rows)) {
      const matches: BlockEntityMatch[] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const entity = row as Record<string, unknown>;
        const uuid = String(entity.uuid ?? "");
        if (!uuid) continue;
        matches.push({
          uuid,
          content: String(entity.content ?? entity.title ?? ""),
          marker: normalizeMarker(entity.marker),
          pageHint: entity.page,
        });
      }
      const blocks = await resolveBlockPages(matches.slice(0, MAX_SEARCH_RESULTS));
      console.info(
        `[ai-assistant] search_tasks [${statuses.join(",")}] (${via}): ${blocks.length} blocks`
      );
      return blocks;
    }
  } catch (err) {
    console.warn(
      "[ai-assistant] built-in task query failed:",
      err instanceof Error ? err.message : err
    );
  }

  // 2) Datalog fallback: blocks that carry a :block/marker value.
  via = "datalog";
  for (const attr of BLOCK_CONTENT_ATTRS) {
    try {
      const rows = await datalog(taskDatalogQuery(attr));
      const blocks = filterBlocks(rows, "").filter((block) => {
        const marker = block.marker.toLowerCase();
        return statuses.some((status) => marker.includes(status));
      });
      if (blocks.length > 0) {
        console.info(
          `[ai-assistant] search_tasks [${statuses.join(",")}] (${via}): ${blocks.length} blocks`
        );
        return blocks;
      }
    } catch (err) {
      console.warn(
        `[ai-assistant] task search (${attr}) failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  console.info(
    `[ai-assistant] search_tasks [${statuses.join(",")}] (${via}): 0 blocks`
  );
  return [];
}

// --- query_blocks (F9): structured read-only queries -------------------------

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export interface NormalizedQueryRows {
  // DSL results arrive as block entities; resolve them to full blocks.
  entities: BlockEntityMatch[];
  // Datalog results arrive as tuples; uuid-keyed ones become blocks,
  // everything else is returned as raw string rows.
  tuples: unknown[][];
}

export function normalizeQueryRows(rows: unknown): NormalizedQueryRows {
  const out: NormalizedQueryRows = { entities: [], tuples: [] };
  if (!Array.isArray(rows)) return out;
  const asEntities = rows.filter(
    (row) => row && typeof row === "object" && !Array.isArray(row)
  ) as Record<string, unknown>[];
  if (asEntities.length === rows.length) {
    for (const entity of asEntities) {
      const uuid = String(entity.uuid ?? "");
      if (!uuid) continue;
      out.entities.push({
        uuid,
        content: String(entity.content ?? entity.title ?? ""),
        marker: normalizeMarker(entity.marker),
        pageHint: entity.page,
      });
    }
    out.entities = out.entities.slice(0, MAX_SEARCH_RESULTS);
    return out;
  }
  for (const row of rows) {
    if (Array.isArray(row)) out.tuples.push(row);
    else out.tuples.push([row]);
  }
  return out;
}

function tuplesToBlocks(tuples: unknown[][]): SearchResult["blocks"] {
  return tuples
    .filter(
      (row) =>
        typeof row[0] === "string" &&
        isUuid(String(row[0]))
    )
    .map((row) => ({
      uuid: String(row[0]),
      content: String(row[1] ?? ""),
      page: String(row[2] ?? ""),
      marker: normalizeMarker(row[3]),
    }))
    .slice(0, MAX_SEARCH_RESULTS);
}

export async function queryBlocks(
  query: string,
  lang?: string
): Promise<unknown> {
  const q = query.trim();
  if (!q) return { error: "query is required" };
  const via = lang === "datalog" ? "datalog" : "dsl";
  try {
    const raw = await withTimeout(
      via === "dsl" ? logseq.DB.q(q) : datalog(q),
      QUERY_TIMEOUT_MS,
      "Query timed out"
    );
    const { entities, tuples } = normalizeQueryRows(raw);
    if (entities.length > 0) {
      const blocks = await resolveBlockPages(entities);
      return { via, blocks };
    }
    const blocks = tuplesToBlocks(tuples);
    if (blocks.length > 0) return { via, blocks };
    return {
      via,
      blocks: [],
      rows: tuples
        .slice(0, 10)
        .map((row) => row.map((cell) => String(cell ?? "").slice(0, 200))),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// --- search_journal (F10) ----------------------------------------------------

export function journalDayNumber(date: Date): number {
  return (
    date.getFullYear() * 10_000 + (date.getMonth() + 1) * 100 + date.getDate()
  );
}

function journalDayFrom(date: Date, days: number): number {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() - (days - 1));
  return journalDayNumber(shifted);
}

export function journalDateIso(day: number): string {
  const year = Math.floor(day / 10_000);
  const month = Math.floor((day % 10_000) / 100);
  const date = Math.floor(day % 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(date)}`;
}

const JOURNAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Accepts today (default), yesterday, tomorrow and YYYY-MM-DD in the
// graph-local time. Returns the Logseq journal-day number (YYYYMMDD).
export function parseJournalDate(input: string, now = new Date()): number | null {
  const value = input.trim().toLowerCase();
  const date = new Date(now);
  if (!value || value === "today") return journalDayNumber(date);
  if (value === "yesterday") {
    date.setDate(date.getDate() - 1);
    return journalDayNumber(date);
  }
  if (value === "tomorrow") {
    date.setDate(date.getDate() + 1);
    return journalDayNumber(date);
  }
  if (JOURNAL_DATE_PATTERN.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(year, month - 1, day);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() !== month - 1 ||
      parsed.getDate() !== day
    ) {
      return null;
    }
    return journalDayNumber(parsed);
  }
  return null;
}

export function journalRowsToBlocks(
  rows: unknown,
  days: number,
  now = new Date()
): Array<SearchResult["blocks"][number] & { day: number }> {
  const from = journalDayFrom(now, days);
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => Array.isArray(row) && isUuid(String(row[0] ?? "")))
    .map((row) => ({
      uuid: String(row[0]),
      content: String(row[1] ?? ""),
      page: String(row[2] ?? ""),
      marker: normalizeMarker(row[3]),
      day: Number(row[4] ?? 0),
    }))
    .filter((block) => block.day >= from)
    .sort((a, b) => b.day - a.day)
    .slice(0, MAX_SEARCH_RESULTS);
}

export async function searchJournal(days?: number): Promise<unknown> {
  const windowDays = Math.min(Math.max(Math.floor(days ?? 7) || 7, 1), 90);
  for (const attr of BLOCK_CONTENT_ATTRS) {
    try {
      const rows = await datalog(
        `[:find ?uuid ?content ?name ?day :where [?p :block/journal? true] [?p :block/journal-day ?day] [?b :block/page ?p] [?b :block/uuid ?uuid] [?b ${attr} ?content] [?p :block/name ?name]]`
      );
      const blocks = journalRowsToBlocks(rows, windowDays, new Date());
      if (blocks.length > 0) return { via: "datalog", days: windowDays, blocks };
    } catch (err) {
      console.warn(
        `[ai-assistant] journal search (${attr}) failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return { via: "datalog", days: windowDays, blocks: [] };
}

// --- get_recent_pages (F10) --------------------------------------------------

async function getRecentPagesTool(limit?: number): Promise<unknown> {
  const max = Math.min(Math.max(Math.floor(limit ?? 10) || 10, 1), 25);
  try {
    const rows = await datalog(
      "[:find ?name ?ts :where [?p :block/name ?name] [?p :block/updated-at ?ts]]"
    );
    const pages = (Array.isArray(rows) ? rows : [])
      .map((row) =>
        Array.isArray(row)
          ? { name: String(row[0] ?? ""), updatedAt: Number(row[1] ?? 0) }
          : { name: String(row ?? ""), updatedAt: 0 }
      )
      .filter(
        (page) =>
          page.name && !page.name.toLowerCase().startsWith(SESSION_PAGE_PREFIX)
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, max);
    if (pages.length > 0) return { via: "datalog", pages };
  } catch (err) {
    console.warn(
      "[ai-assistant] recent pages (datalog) failed:",
      err instanceof Error ? err.message : err
    );
  }
  try {
    const all = await logseq.Editor.getAllPages();
    if (Array.isArray(all)) {
      const pages = all
        .map((page) => {
          const entity = page as { name?: unknown; updatedAt?: unknown };
          return {
            name: String(entity.name ?? ""),
            updatedAt: Number(entity.updatedAt ?? 0),
          };
        })
        .filter(
          (page) =>
            page.name &&
            !page.name.toLowerCase().startsWith(SESSION_PAGE_PREFIX)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, max);
      return { via: "getAllPages", pages };
    }
  } catch (err) {
    console.warn(
      "[ai-assistant] recent pages (getAllPages) failed:",
      err instanceof Error ? err.message : err
    );
  }
  return { via: "none", pages: [] };
}

// --- get_selected_blocks (F10) ----------------------------------------------

async function getSelectedBlocksTool(): Promise<unknown> {
  let blocks: unknown;
  try {
    blocks = await logseq.Editor.getSelectedBlocks();
  } catch {
    return { blocks: [] };
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return { blocks: [] };
  return { blocks: flattenBlocks(blocks as BlockNode[], 20) };
}

function longestKeyword(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2)
    .sort((a, b) => b.length - a.length);
  return tokens[0] ?? null;
}

export async function searchGraph(query: string): Promise<unknown> {
  const q = query.trim();
  if (!q) return { pages: [], blocks: [] };

  const cached = readSearchCache(q);
  if (cached) return cached;

  const result = await runSearch(q);
  const found = result.pages.length > 0 || result.blocks.length > 0;
  if (!found && q.includes(" ")) {
    const keyword = longestKeyword(q);
    if (keyword && keyword.toLowerCase() !== q.toLowerCase()) {
      const refined = await runSearch(keyword);
      if (refined.pages.length > 0 || refined.blocks.length > 0) {
        writeSearchCache(q, refined);
        return refined;
      }
    }
  }

  writeSearchCache(q, result);
  return result;
}

// Merged read behind get_page (formerly get_page + get_page_blocks +
// get_current_page): metadata plus a window of blocks, for a named page or
// for the page the user currently has open when no name is given.
async function getPageTool(
  pageName: string,
  offset?: number,
  metaOnly?: boolean
): Promise<unknown> {
  let name: string | null = null;
  let uuid = "";
  let id: unknown = null;
  let updatedAt: unknown = null;
  if (pageName.trim()) {
    const page = (await logseq.Editor.getPage(pageName)) as {
      name?: unknown;
      uuid?: unknown;
      id?: unknown;
      updatedAt?: unknown;
    } | null;
    if (!page) return { error: `Page "${pageName}" not found` };
    name = String(page.name ?? pageName);
    uuid = String(page.uuid ?? "");
    id = page.id ?? null;
    updatedAt = page.updatedAt ?? null;
  } else {
    const entity = (await logseq.Editor.getCurrentPage()) as {
      name?: string;
      uuid?: string;
    } | null;
    if (!entity) return { error: "No current page" };
    name = entity.name ?? null;
    uuid = String(entity.uuid ?? "");
    if (!uuid) return { name, uuid: null };
  }
  if (metaOnly) return { name, uuid, id, updatedAt };
  try {
    const tree = await logseq.Editor.getPageBlocksTree(uuid);
    return {
      page: name,
      uuid,
      ...pageReadResult(
        tree as BlockNode[],
        PAGE_BLOCKS_LIMIT,
        Math.max(0, Math.floor(offset ?? 0))
      ),
    };
  } catch {
    return { name, uuid };
  }
}

async function getBlockTool(uuid: string, outline = false): Promise<unknown> {
  const block = await logseq.Editor.getBlock(uuid, {
    includeChildren: true,
  });
  if (!block) return { error: `Block "${uuid}" not found` };
  const root = block as BlockNode;
  if (outline) return subtreeResult(root);
  const flat = flattenBlocks([root], 100);
  const [top, ...childBlocks] = flat;
  if (!top) return { error: "Empty block" };
  return { ...top, childBlocks };
}

// Whole-section view of a block: everything nested under it rendered as an
// indented outline a model can parse directly. blockRefs maps each outline
// line (in the same order) to its block uuid.
function subtreeResult(root: BlockNode): unknown {
  if (!String(root.uuid ?? "")) return { error: "Empty block" };
  const lines: string[] = [];
  const blockRefs: Array<{ uuid: string; depth: number }> = [];
  let count = 0;
  let capped = false;
  const walk = (node: BlockNode, depth: number): void => {
    if (count >= MAX_PAGE_BLOCKS) {
      capped = true;
      return;
    }
    count++;
    lines.push("  ".repeat(depth) + "- " + String(node.content ?? ""));
    blockRefs.push({ uuid: String(node.uuid ?? ""), depth });
    for (const child of blockChildren(node)) walk(child, depth + 1);
  };
  walk(root, 0);
  const result: Record<string, unknown> = {
    uuid: String(root.uuid ?? ""),
    outline: lines.join("\n"),
    blockRefs,
  };
  if (capped) result.truncated = true;
  return result;
}

interface CurrentPage {
  name: string;
  uuid: string;
  id: number;
}

async function resolveCurrentPage(): Promise<CurrentPage | string> {
  const entity = await logseq.Editor.getCurrentPage();
  if (!entity)
    return "No page is currently open in the main editor. The change was NOT made. Ask the user to open the target page in the main editor, then retry";
  const entityRecord = entity as {
    name?: string;
    uuid?: string;
    id?: number;
    page?: { name?: string; uuid?: string; id?: number };
  };
  const pageRef = entityRecord.page;
  const name = pageRef?.name ?? entityRecord.name ?? "";
  const uuid = pageRef?.uuid ?? entityRecord.uuid ?? "";
  const id = pageRef?.id ?? entityRecord.id;
  if (!name || !uuid) return "Could not resolve the currently open page";
  if (name.toLowerCase().startsWith(SESSION_PAGE_PREFIX)) {
    return `"${name}" is an AI assistant session page: editing it with write tools is not allowed`;
  }
  return { name, uuid, id: id ?? 0 };
}

async function ensureBlockOnCurrentPage(
  uuid: string,
  page: CurrentPage
): Promise<string | null> {
  const block = await logseq.Editor.getBlock(uuid);
  if (!block) return `Block "${uuid}" not found`;
  const blockPageId = (block as { page?: { id?: number } }).page?.id;
  if (blockPageId !== page.id) {
    return `Block "${uuid}" is not on the current page "${page.name}". Write tools only work on the page you currently have open. The change was NOT made. Ask the user to open the target page in the main editor, then retry`;
  }
  return null;
}

const WRITE_CONTENT_PREVIEW_LENGTH = 200;

interface WrittenBlock {
  content: string;
  wrongPage: boolean;
}

// Re-reads a block right after a write so tool results reflect the graph
// state instead of the model's intention. Returns null when the block is
// missing; wrongPage flags a block that landed on a page other than the one
// the write targeted (stale or orphaned page target).
async function readBlockAfterWrite(
  uuid: string | null,
  expectedPageId?: number
): Promise<WrittenBlock | null> {
  if (!uuid) return null;
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return null;
    const content = String((block as { content?: unknown }).content ?? "");
    const blockPageId = (block as { page?: { id?: number } }).page?.id;
    const wrongPage =
      expectedPageId != null &&
      blockPageId != null &&
      blockPageId !== expectedPageId;
    return {
      content:
        content.length > WRITE_CONTENT_PREVIEW_LENGTH
          ? `${content.slice(0, WRITE_CONTENT_PREVIEW_LENGTH)}…`
          : content,
      wrongPage,
    };
  } catch {
    return null;
  }
}

// A successful write does not always re-render the open page: Logseq defers
// redraws of plugin-made changes until something pokes the editor. Scrolling
// to the new block shows the change immediately and flushes that render.
function scrollToBlock(pageName: string, uuid: string | null): void {
  if (!uuid) return;
  try {
    Promise.resolve(logseq.Editor.scrollToBlockInPage(pageName, uuid)).catch(
      () => {
        // rendering pokes are best-effort
      }
    );
  } catch {
    // rendering pokes are best-effort
  }
}

interface InsertedOutlineNode {
  uuid: string | null;
  content: string;
  children: InsertedOutlineNode[];
}

function parseOutlineForTool(
  outline: string
): { nodes?: OutlineNode[]; error?: string } {
  const parsed = parseOutline(outline);
  if (parsed.nodes.length === 0) return { error: "outline is required" };
  if (parsed.blockCount > OUTLINE_MAX_BLOCKS) {
    return {
      error: `outline creates ${parsed.blockCount} blocks; the limit is ${OUTLINE_MAX_BLOCKS}. Split it into smaller outlines.`,
    };
  }
  return { nodes: parsed.nodes };
}

interface OutlineInsertOutcome {
  blocks?: InsertedOutlineNode[];
  error?: string;
}

async function insertChildOutline(
  parentUuid: string,
  nodes: OutlineNode[]
): Promise<OutlineInsertOutcome> {
  const inserted: InsertedOutlineNode[] = [];
  let cursor: string | null = null;
  for (const node of nodes) {
    const block: { uuid?: unknown } | null = cursor
      ? await logseq.Editor.insertBlock(cursor, node.content, { sibling: true })
      : await logseq.Editor.insertBlock(parentUuid, node.content, {
          sibling: false,
        });
    const uuid: string | null = block?.uuid ? String(block.uuid) : null;
    if (!uuid) {
      return {
        error: `insert failed after ${inserted.length} of ${nodes.length} child blocks; the outline was only partially applied. The remaining items were NOT created`,
      };
    }
    cursor = uuid;
    const child = await insertChildOutline(uuid, node.children);
    if (child.error) return { error: child.error };
    inserted.push({
      uuid,
      content: node.content,
      children: child.blocks ?? [],
    });
  }
  return { blocks: inserted };
}

async function insertOutlineNodes(
  pageRef: string,
  nodes: OutlineNode[],
  options: { afterUuid?: string; parentUuid?: string } = {}
): Promise<OutlineInsertOutcome> {
  const inserted: InsertedOutlineNode[] = [];
  let cursor: string | null = null;
  for (const node of nodes) {
    let block: { uuid?: unknown } | null;
    if (options.parentUuid) {
      block = cursor
        ? await logseq.Editor.insertBlock(cursor, node.content, { sibling: true })
        : await logseq.Editor.insertBlock(options.parentUuid, node.content, {
            sibling: false,
          });
    } else if (options.afterUuid) {
      block = await logseq.Editor.insertBlock(
        cursor ?? options.afterUuid,
        node.content,
        { sibling: true }
      );
    } else {
      block = await logseq.Editor.appendBlockInPage(pageRef, node.content);
    }
    const uuid: string | null = block?.uuid ? String(block.uuid) : null;
    if (!uuid) {
      return {
        error: `insert failed after ${inserted.length} of ${nodes.length} top-level blocks; the outline was only partially applied. The remaining items were NOT created`,
      };
    }
    cursor = uuid;
    const child = await insertChildOutline(uuid, node.children);
    if (child.error) return { error: child.error };
    inserted.push({
      uuid,
      content: node.content,
      children: child.blocks ?? [],
    });
  }
  return { blocks: inserted };
}

async function insertBlockTool(
  page: CurrentPage,
  content: string,
  afterUuid: string
): Promise<unknown> {
  const normalized = toSingleBlockContent(content);
  if (!normalized) return { error: "content is required" };
  const failed = {
    error:
      "insert failed: Logseq did not create the block. The change was NOT made",
  };
  const landedWrong = {
    error:
      "insert failed: the block landed on a different page. The change was NOT made where expected",
  };
  if (afterUuid) {
    const err = await ensureBlockOnCurrentPage(afterUuid, page);
    if (err) return { error: err };
    const block = await logseq.Editor.insertBlock(afterUuid, normalized, {
      sibling: true,
    });
    const uuid = block?.uuid ? String(block.uuid) : null;
    const written = await readBlockAfterWrite(uuid, page.id);
    if (!written) return failed;
    if (written.wrongPage) return landedWrong;
    scrollToBlock(page.name, uuid);
    return {
      ok: true,
      uuid,
      insertedAfter: afterUuid,
      page: page.name,
      content: written.content,
    };
  }
  const block = await logseq.Editor.appendBlockInPage(page.uuid, normalized);
  const uuid = block?.uuid ? String(block.uuid) : null;
  const written = await readBlockAfterWrite(uuid, page.id);
  if (!written) return failed;
  if (written.wrongPage) return landedWrong;
  scrollToBlock(page.name, uuid);
  return { ok: true, uuid, page: page.name, content: written.content };
}

async function prependBlockTool(
  page: CurrentPage,
  content: string
): Promise<unknown> {
  const normalized = toSingleBlockContent(content);
  if (!normalized) return { error: "content is required" };
  const block = await logseq.Editor.prependBlockInPage(page.uuid, normalized);
  const uuid = block?.uuid ? String(block.uuid) : null;
  const written = await readBlockAfterWrite(uuid, page.id);
  if (!written) {
    return {
      error:
        "insert failed: Logseq did not create the block. The change was NOT made",
    };
  }
  if (written.wrongPage) {
    return {
      error:
        "insert failed: the block landed on a different page. The change was NOT made where expected",
    };
  }
  scrollToBlock(page.name, uuid);
  return { ok: true, uuid, page: page.name, content: written.content };
}

async function updateBlockTool(
  page: CurrentPage,
  uuid: string,
  content: string
): Promise<unknown> {
  const err = await ensureBlockOnCurrentPage(uuid, page);
  if (err) return { error: err };
  const normalized = toSingleBlockContent(content);
  if (!normalized) return { error: "content is required" };
  await logseq.Editor.updateBlock(uuid, normalized);
  const written = await readBlockAfterWrite(uuid, page.id);
  if (!written) {
    return {
      error:
        "update failed: the block disappeared after writing. The change was NOT applied",
    };
  }
  if (written.wrongPage) {
    return {
      error:
        "update failed: the block landed on a different page. The change was NOT applied",
    };
  }
  return { ok: true, uuid, page: page.name, content: written.content };
}

async function insertOutlineTool(
  page: CurrentPage,
  outline: string,
  afterUuid: string,
  parentUuid: string
): Promise<unknown> {
  if (afterUuid && parentUuid) {
    return { error: "Use either after_uuid or parent_uuid, not both" };
  }
  if (afterUuid) {
    const err = await ensureBlockOnCurrentPage(afterUuid, page);
    if (err) return { error: err };
  }
  if (parentUuid) {
    const err = await ensureBlockOnCurrentPage(parentUuid, page);
    if (err) return { error: err };
  }
  const parsed = parseOutlineForTool(outline);
  if (parsed.error) return { error: parsed.error };
  const result = await insertOutlineNodes(page.uuid, parsed.nodes ?? [], {
    afterUuid: afterUuid || undefined,
    parentUuid: parentUuid || undefined,
  });
  if (result.error) return { error: result.error };
  const blocks = result.blocks ?? [];
  scrollToBlock(page.name, blocks[0]?.uuid ?? null);
  return { ok: true, page: page.name, blocks };
}

async function removeBlockTool(
  page: CurrentPage,
  uuid: string
): Promise<unknown> {
  const err = await ensureBlockOnCurrentPage(uuid, page);
  if (err) return { error: err };
  await logseq.Editor.removeBlock(uuid);
  const leftover = await logseq.Editor.getBlock(uuid).catch(() => null);
  if (leftover) {
    return {
      error: "remove failed: the block still exists. The change was NOT made",
    };
  }
  return { ok: true, removed: uuid, page: page.name };
}

async function moveBlockTool(
  page: CurrentPage,
  uuid: string,
  targetUuid: string,
  before: boolean,
  asChild: boolean
): Promise<unknown> {
  const err = await ensureBlockOnCurrentPage(uuid, page);
  if (err) return { error: err };
  const targetErr = await ensureBlockOnCurrentPage(targetUuid, page);
  if (targetErr) return { error: targetErr };
  await logseq.Editor.moveBlock(uuid, targetUuid, {
    before,
    children: asChild,
  });
  const moved = await logseq.Editor.getBlock(uuid).catch(() => null);
  if (!moved) {
    return {
      error: "move failed: the block disappeared. The change was NOT applied",
    };
  }
  if (asChild) {
    const parentId = (moved as { parent?: { id?: number } }).parent?.id;
    const target = await logseq.Editor.getBlock(targetUuid).catch(() => null);
    const targetId = (target as { id?: number } | null)?.id;
    if (parentId != null && targetId != null && parentId !== targetId) {
      return {
        error:
          "move failed: the block did not become a child of the target. The change was NOT applied",
      };
    }
  }
  return { ok: true, moved: uuid, target: targetUuid, page: page.name };
}

async function upsertBlockPropertyTool(
  page: CurrentPage,
  uuid: string,
  key: string,
  value: string
): Promise<unknown> {
  const err = await ensureBlockOnCurrentPage(uuid, page);
  if (err) return { error: err };
  if (!key) return { error: "key is required" };
  await logseq.Editor.upsertBlockProperty(uuid, key, value);
  const written = await readBlockAfterWrite(uuid, page.id);
  if (!written) {
    return {
      error:
        "property update failed: the block disappeared. The change was NOT applied",
    };
  }
  if (written.wrongPage) {
    return {
      error:
        "property update failed: the block landed on a different page. The change was NOT applied",
    };
  }
  return { ok: true, uuid, key, page: page.name, content: written.content };
}

async function findJournalPage(
  day: number
): Promise<{ name: string; uuid: string } | null> {
  const rows = await datalog(
    `[:find ?name ?uuid :where [?p :block/journal? true] [?p :block/journal-day ?day] [(= ?day ${day})] [?p :block/name ?name] [?p :block/uuid ?uuid]]`
  );
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const name = String(row[0] ?? "");
    const uuid = String(row[1] ?? "");
    if (name && uuid) return { name, uuid };
  }
  return null;
}

// Journal notes are the one write that must not require the target page to be
// open: on the journals overview no page is active at all.
async function appendJournalTool(
  date: string,
  content: string
): Promise<unknown> {
  const day = parseJournalDate(date);
  if (day == null) {
    return {
      error:
        "invalid date: use today, yesterday, tomorrow or YYYY-MM-DD (e.g. 2026-11-10)",
    };
  }
  const normalized = toSingleBlockContent(content);
  if (!normalized) return { error: "content is required" };
  let page = await findJournalPage(day);
  if (!page) {
    try {
      await logseq.Editor.createPage(journalDateIso(day), {}, {
        redirect: false,
        createFirstBlock: false,
        journal: true,
      });
    } catch {
      // fall through to the re-check below
    }
    page = await findJournalPage(day);
  }
  if (!page) {
    return {
      error: `journal page for ${journalDateIso(day)} does not exist and could not be created. The change was NOT made. Ask the user to open that day's journal once, then retry`,
    };
  }
  const block = await logseq.Editor.appendBlockInPage(page.uuid, normalized);
  const uuid = block?.uuid ? String(block.uuid) : null;
  const written = await readBlockAfterWrite(uuid);
  if (!written) {
    return {
      error:
        "append failed: Logseq did not create the block. The change was NOT made",
    };
  }
  return { ok: true, page: page.name, uuid, content: written.content, day };
}

// --- create_page (user-requested or agent-proposed with consent) ------------

async function createPageTool(
  title: string,
  firstBlock: string,
  outline: string,
  requested: boolean,
  signal?: AbortSignal
): Promise<unknown> {
  const name = title.trim();
  if (!name) return { error: "title is required" };
  const lower = name.toLowerCase();
  if (lower === "ai_assistant" || lower.startsWith(SESSION_PAGE_PREFIX)) {
    return {
      error: `Pages under "${SESSION_PAGE_PREFIX}" are managed by the AI assistant (sessions, skills, system prompt) and cannot be created with create_page`,
    };
  }
  const hasOutline = outline.trim().length > 0;
  if (hasOutline && firstBlock.trim()) {
    return { error: "Provide either first_block or outline, not both" };
  }
  const parsedOutline = hasOutline ? parseOutlineForTool(outline) : null;
  if (parsedOutline?.error) return { error: parsedOutline.error };

  // Reuse an existing page instead of duplicating it.
  const existing = (await logseq.Editor.getPage(name)) as {
    name?: unknown;
    uuid?: unknown;
  } | null;
  if (existing) {
    return {
      ok: true,
      name: String(existing.name ?? name),
      uuid: existing.uuid ? String(existing.uuid) : null,
      existed: true,
    };
  }

  let confirmed = requested;
  if (!confirmed) {
    // The agent proposed this page itself: ask the user first.
    try {
      confirmed = await confirmActionWithSignal(
        {
          title: "Create page?",
          description: `The assistant wants to create a new page "${name}".`,
          confirmLabel: "Create",
          cancelLabel: "Cancel",
        },
        signal
      );
    } catch {
      return { error: "cancelled by the user" };
    }
  }
  if (!confirmed) {
    return {
      error: `User declined to create the page "${name}". Do not retry; continue without the page or ask the user what they prefer.`,
    };
  }

  const page = (await logseq.Editor.createPage(
    name,
    {},
    { redirect: false, createFirstBlock: false }
  )) as { uuid?: unknown } | null;
  let blocks: InsertedOutlineNode[] | undefined;
  let warning: string | undefined;
  if (parsedOutline?.nodes) {
    const outlineResult = await insertOutlineNodes(name, parsedOutline.nodes);
    if (outlineResult.error) {
      warning = outlineResult.error;
    } else {
      blocks = outlineResult.blocks;
    }
  } else {
    const normalizedBlock = toSingleBlockContent(firstBlock);
    if (normalizedBlock) {
      await logseq.Editor.appendBlockInPage(name, normalizedBlock);
    }
  }
  return {
    ok: true,
    name,
    uuid: page?.uuid ? String(page.uuid) : null,
    created: true,
    ...(blocks ? { blocks } : {}),
    ...(warning ? { warning } : {}),
  };
}

async function withCurrentPage(
  fn: (page: CurrentPage) => Promise<unknown>
): Promise<unknown> {
  const page = await resolveCurrentPage();
  if (typeof page === "string") return { error: page };
  return fn(page);
}

function stringify(data: unknown): string {
  return truncate(data);
}

// Returns the raw skill prompt (not JSON) so long instructions survive.
async function loadSkillTool(name: string): Promise<string> {
  const skill = await findSkill(name);
  if (!skill) {
    const available = (await listSkills())
      .map((item) => item.name)
      .join(", ");
    return `Unknown skill: ${name}.${
      available
        ? ` Available: ${available}`
        : " No skills are defined (pages under ai_assistant/skills/)"
    }`;
  }
  return buildSkillPrompt(skill);
}

export async function executeLogseqTool(
  name: string,
  argsJson: string,
  signal?: AbortSignal
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return "Invalid JSON arguments";
  }
  try {
    switch (name) {
      case "create_page":
        return stringify(
          await createPageTool(
            String(args.title ?? ""),
            String(args.first_block ?? ""),
            String(args.outline ?? ""),
            Boolean(args.requested),
            signal
          )
        );
      case "search_graph":
        return stringify(await searchGraph(String(args.query ?? "")));
      case "search_tasks":
        return stringify(
          await searchTasks(args.status == null ? undefined : String(args.status))
        );
      case "get_page":
      case "get_page_blocks":
      case "get_current_page":
        // Legacy names route into the merged get_page read; the aliases
        // always return blocks, only the merged spec exposes meta_only.
        return stringify(
          await getPageTool(
            String(args.page ?? ""),
            args.offset == null ? undefined : Number(args.offset),
            name === "get_page" ? Boolean(args.meta_only) : false
          )
        );
      case "get_block":
      case "get_block_subtree":
        return stringify(
          await getBlockTool(
            String(args.uuid ?? ""),
            name === "get_block_subtree" ? true : Boolean(args.outline)
          )
        );
      case "get_selected_blocks":
        return stringify(await getSelectedBlocksTool());
      case "query_blocks":
        return stringify(
          await queryBlocks(
            String(args.query ?? ""),
            args.lang == null ? undefined : String(args.lang)
          )
        );
      case "search_journal":
        return stringify(
          await searchJournal(args.days == null ? undefined : Number(args.days))
        );
      case "get_recent_pages":
        return stringify(
          await getRecentPagesTool(
            args.limit == null ? undefined : Number(args.limit)
          )
        );
      case "use_skill": {
        const skillName = String(args.name ?? "");
        console.info(`[ai-assistant] use_skill: ${skillName}`);
        return await loadSkillTool(skillName);
      }
      case "append_journal":
        return stringify(
          await appendJournalTool(
            String(args.date ?? ""),
            String(args.content ?? "")
          )
        );
      case "insert_block":
        return stringify(
          await withCurrentPage((page) =>
            insertBlockTool(
              page,
              String(args.content ?? ""),
              String(args.after_uuid ?? "")
            )
          )
        );
      case "insert_outline":
        return stringify(
          await withCurrentPage((page) =>
            insertOutlineTool(
              page,
              String(args.outline ?? ""),
              String(args.after_uuid ?? ""),
              String(args.parent_uuid ?? "")
            )
          )
        );
      case "prepend_block":
        return stringify(
          await withCurrentPage((page) =>
            prependBlockTool(page, String(args.content ?? ""))
          )
        );
      case "update_block":
        return stringify(
          await withCurrentPage((page) =>
            updateBlockTool(
              page,
              String(args.uuid ?? ""),
              String(args.content ?? "")
            )
          )
        );
      case "remove_block":
        return stringify(
          await withCurrentPage((page) =>
            removeBlockTool(page, String(args.uuid ?? ""))
          )
        );
      case "move_block":
        return stringify(
          await withCurrentPage((page) =>
            moveBlockTool(
              page,
              String(args.uuid ?? ""),
              String(args.target_uuid ?? ""),
              Boolean(args.before),
              Boolean(args.as_child)
            )
          )
        );
      case "upsert_block_property":
        return stringify(
          await withCurrentPage((page) =>
            upsertBlockPropertyTool(
              page,
              String(args.uuid ?? ""),
              String(args.key ?? ""),
              String(args.value ?? "")
            )
          )
        );
      case "create_drawing":
        return stringify(await createDrawing(args.shapes));
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
