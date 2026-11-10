import "@logseq/libs";
import { withTimeout } from "./http";
import { toSingleBlockContent } from "./format";
import {
  OUTLINE_MAX_BLOCKS,
  parseOutline,
  type OutlineNode,
} from "./outline";
import type { ToolSpec } from "./llm";
import { confirmActionWithSignal } from "./confirm";
import { buildSkillPrompt, findSkill, listSkills } from "./skills";
import { createDrawing } from "./draw";

const MAX_TOOL_OUTPUT = 4000;
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

function flattenBlocks(tree: BlockNode[], limit = 40): Array<{
  uuid: string;
  content: string;
  children: number;
}> {
  const out: Array<{ uuid: string; content: string; children: number }> = [];
  const walk = (nodes: BlockNode[]): void => {
    for (const node of nodes ?? []) {
      if (out.length >= limit) return;
      out.push({
        uuid: String(node.uuid ?? ""),
        content: String(node.content ?? ""),
        children: blockChildren(node).length,
      });
      walk(blockChildren(node));
    }
  };
  walk(tree);
  return out;
}

function truncate(data: unknown): string {
  return JSON.stringify(data).slice(0, MAX_TOOL_OUTPUT);
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

async function getPageTool(pageName: string): Promise<unknown> {
  const page = await logseq.Editor.getPage(pageName);
  if (!page) return { error: `Page "${pageName}" not found` };
  return {
    name: page.name,
    uuid: page.uuid,
    id: page.id,
    updatedAt: page.updatedAt ?? null,
  };
}

async function getPageBlocksTool(pageName: string): Promise<unknown> {
  const page = await logseq.Editor.getPage(pageName);
  if (!page) return { error: `Page "${pageName}" not found` };
  const tree = await logseq.Editor.getPageBlocksTree(page.uuid);
  return { page: page.name, blocks: flattenBlocks(tree) };
}

async function getBlockTool(uuid: string): Promise<unknown> {
  const block = await logseq.Editor.getBlock(uuid, {
    includeChildren: true,
  });
  if (!block) return { error: `Block "${uuid}" not found` };
  return flattenBlocks([block as BlockNode])[0] ?? { error: "Empty block" };
}

async function getCurrentPageTool(): Promise<unknown> {
  const entity = await logseq.Editor.getCurrentPage();
  if (!entity) return { error: "No current page" };
  const asPage = entity as { name?: string; uuid?: string };
  const result: Record<string, unknown> = {
    name: asPage.name ?? null,
    uuid: asPage.uuid ?? null,
  };
  if (asPage.uuid) {
    try {
      const tree = await logseq.Editor.getPageBlocksTree(asPage.uuid);
      result.blocks = flattenBlocks(tree, 20);
    } catch {
      return result;
    }
  }
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

// Re-reads a block right after a write so tool results reflect the graph
// state instead of the model's intention. Returns null when the block is
// missing, which callers turn into an explicit error.
async function readBlockAfterWrite(
  uuid: string | null
): Promise<{ content: string } | null> {
  if (!uuid) return null;
  try {
    const block = await logseq.Editor.getBlock(uuid);
    if (!block) return null;
    const content = String((block as { content?: unknown }).content ?? "");
    return {
      content:
        content.length > WRITE_CONTENT_PREVIEW_LENGTH
          ? `${content.slice(0, WRITE_CONTENT_PREVIEW_LENGTH)}…`
          : content,
    };
  } catch {
    return null;
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
  if (afterUuid) {
    const err = await ensureBlockOnCurrentPage(afterUuid, page);
    if (err) return { error: err };
    const block = await logseq.Editor.insertBlock(afterUuid, normalized, {
      sibling: true,
    });
    const uuid = block?.uuid ? String(block.uuid) : null;
    const written = await readBlockAfterWrite(uuid);
    if (!written) return failed;
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
  const written = await readBlockAfterWrite(uuid);
  if (!written) return failed;
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
  const written = await readBlockAfterWrite(uuid);
  if (!written) {
    return {
      error:
        "insert failed: Logseq did not create the block. The change was NOT made",
    };
  }
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
  const written = await readBlockAfterWrite(uuid);
  if (!written) {
    return {
      error:
        "update failed: the block disappeared after writing. The change was NOT applied",
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
  return { ok: true, page: page.name, blocks: result.blocks };
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
  const written = await readBlockAfterWrite(uuid);
  if (!written) {
    return {
      error:
        "property update failed: the block disappeared. The change was NOT applied",
    };
  }
  return { ok: true, uuid, key, page: page.name, content: written.content };
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

export function getLogseqToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "search_graph",
        description:
          "Search the user's Logseq knowledge graph. Returns matching page names and block contents with their uuids (uuid can be referenced as ((uuid)) in the answer). Use 1-3 short keywords per search, not full sentences; if nothing is found, try different keywords. Task statuses (TODO/DOING/NOW) are markers, not text — use search_tasks for those.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Case-insensitive substring to search in page names and block contents",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_tasks",
        description:
          "List task blocks by their status marker (TODO, DOING, NOW, LATER, WAITING, DONE). The status is a marker attached to the block, not text inside it — search_graph cannot find tasks by status alone. Returns uuid, status, content and page.",
        parameters: {
          type: "object",
          properties: {
            status: {
              type: "string",
              description:
                'Optional comma-separated statuses to keep, e.g. "TODO, NOW". Default: TODO, DOING, NOW, LATER, WAITING',
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_page",
        description: "Get page metadata (name, uuid) by page name.",
        parameters: {
          type: "object",
          properties: {
            page: { type: "string", description: "Page name" },
          },
          required: ["page"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_page_blocks",
        description:
          "Read the content of a page: list of blocks (uuid, content, children count) in document order.",
        parameters: {
          type: "object",
          properties: {
            page: { type: "string", description: "Page name" },
          },
          required: ["page"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_block",
        description:
          "Read a single block with its children by block uuid. Use it to get full context for ((uuid)) references.",
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
          },
          required: ["uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_current_page",
        description:
          "Get the page the user currently has open in the main editor, with its first blocks.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "get_selected_blocks",
        description:
          "Get the blocks the user currently has selected in the editor. Use it when the user refers to \"this\" or \"the selected\" content.",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function",
      function: {
        name: "query_blocks",
        description:
          "Run a structured read-only query against the graph. lang=\"dsl\" (default) uses Logseq's built-in query syntax — the same as {{query}} in the UI — e.g. `(and (task TODO) [[project-x]])` or `(property status active)`. lang=\"datalog\" runs a raw Datascript query over :block/* and :block/page attributes. Prefer dsl unless you need advanced joins.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "Query text: a DSL expression or a Datalog vector like [:find ?b :where ...]",
            },
            lang: {
              type: "string",
              enum: ["dsl", "datalog"],
              description: "Query language, default: dsl",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search_journal",
        description:
          "Read blocks from the user's daily journal pages for the last N days (default 7, max 90). Returns uuid, content, page name and the journal day number.",
        parameters: {
          type: "object",
          properties: {
            days: {
              type: "number",
              description: "How many last days to include, default: 7",
            },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_recent_pages",
        description:
          "List recently updated page names (newest first) with their update timestamps. Use it to orient in what the user has been working on lately.",
        parameters: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Max page names to return, default: 10",
            },
          },
        },
      },
    },
  ];
}

const WRITE_TOOL_PAGE_NOTE =
  "Write tools only affect the page the user currently has open in the main editor.";

export function getWriteToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "create_page",
        description:
          'Create a new page in the graph. Set requested=true ONLY when the user explicitly asked for a page to be created in their current request. When YOU propose the page yourself, pass requested=false — the user will confirm it in the UI; if they decline, do not retry, continue without the page. An existing page with the same name is reused instead of duplicated. Use outline (not first_block) when the user asked for a structured page with real child blocks.',
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Name of the new page" },
            first_block: {
              type: "string",
              description:
                "Optional content of a SINGLE flat first block on the new page. # headings are stripped, markdown lists become • bullets, code fences are preserved. Do not combine with outline.",
            },
            outline: {
              type: "string",
              description:
                "Optional structured initial page as an indented list, e.g. '- Section\\n  - item\\n    - detail'. Top-level items and one child level become real blocks; deeper items are flattened to • lines. Do not combine with first_block. Use only when the user asked for a structured page/outline.",
            },
            requested: {
              type: "boolean",
              description:
                "true when the user explicitly asked for this page in the current request; false when you propose it yourself (then the user confirms)",
            },
          },
          required: ["title", "requested"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "insert_block",
        description: `Append one flat block to the end of the currently open page, or insert it right after a given block uuid. Markdown lists are flattened to • inside the block. For real child blocks use insert_outline. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Single block content (Markdown). Lists become • bullets and headings are stripped. One block per call; use insert_outline for hierarchy.",
            },
            after_uuid: {
              type: "string",
              description:
                "Optional block uuid: insert the new block right after this block instead of appending to the page end",
            },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "insert_outline",
        description: `Insert a structured outline as real nested blocks on the currently open page. Use only when the user asked for a structured page/outline; for a simple list use insert_block. Indent with 2 spaces or a tab. Top-level items and one child level become blocks; deeper items are flattened to • lines. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            outline: {
              type: "string",
              description:
                "Outline with one item per line, e.g. '- Section\\n  - item\\n    - detail'. Supports -, *, +, 1. and 1) markers.",
            },
            after_uuid: {
              type: "string",
              description:
                "Optional block uuid: insert the outline after this block as siblings",
            },
            parent_uuid: {
              type: "string",
              description:
                "Optional block uuid: insert the outline as children of this block. Do not combine with after_uuid.",
            },
          },
          required: ["outline"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "prepend_block",
        description: `Insert one flat block at the top of the currently open page. Markdown lists are flattened to • inside the block. For real child blocks use insert_outline. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Single block content (Markdown). Lists become • bullets and headings are stripped.",
            },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_block",
        description: `Replace the content of one block on the currently open page. Markdown lists are flattened to • inside the block; this does not create child blocks. Get the uuid from get_page_blocks or search_graph first. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
            content: {
              type: "string",
              description:
                "New single-block content (Markdown); lists become • bullets and headings are stripped. Replaces the old content entirely.",
            },
          },
          required: ["uuid", "content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "remove_block",
        description: `Remove a block (and its children) from the currently open page. Only use when the user clearly asked to delete it. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
          },
          required: ["uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "move_block",
        description: `Move a block to another position within the currently open page: before/after a target block or as its child. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid to move" },
            target_uuid: {
              type: "string",
              description: "Target block uuid",
            },
            before: {
              type: "boolean",
              description: "Place the block before the target (default: after)",
            },
            as_child: {
              type: "boolean",
              description: "Place the block as the last child of the target",
            },
          },
          required: ["uuid", "target_uuid"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "upsert_block_property",
        description: `Set or replace a property (key:: value) on a block of the currently open page. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
            key: { type: "string", description: "Property key" },
            value: { type: "string", description: "Property value" },
          },
          required: ["uuid", "key", "value"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "create_drawing",
        description:
          'Create an Excalidraw drawing and embed it into the currently open page as [[draws/<name>.excalidraw]] — an inline editable canvas appears right in the block. Use for quick sketches, flowcharts, mind maps the user asked to draw. Canvas origin is top-left, y grows down, units are px. Plan a readable layout: spread shapes out, add text labels. Pass shapes: [] for an empty canvas.',
        parameters: {
          type: "object",
          properties: {
            shapes: {
              type: "array",
              description:
                "Shapes to draw. Each shape: {type: rectangle|ellipse|text|arrow, x, y, text?, width?, height?, color?, background?}. text shapes need text (may contain \\n). arrows go from (x,y) to (x2,y2) and need x2,y2. Defaults: rectangle 160x80 at (100,100), ellipse 160x90, color #1e1e1e, background transparent.",
              items: {
                type: "object",
                properties: {
                  type: {
                    type: "string",
                    description: "rectangle | ellipse | text | arrow",
                  },
                  text: { type: "string", description: "Text content (text shapes)" },
                  x: { type: "number", description: "Left coordinate, px" },
                  y: { type: "number", description: "Top coordinate, px" },
                  x2: { type: "number", description: "Arrow end x, px" },
                  y2: { type: "number", description: "Arrow end y, px" },
                  width: { type: "number", description: "Width, px" },
                  height: { type: "number", description: "Height, px" },
                  color: {
                    type: "string",
                    description: "Stroke color, e.g. #e03131",
                  },
                  background: {
                    type: "string",
                    description: "Fill color, e.g. #ffd43b or transparent",
                  },
                },
              },
            },
          },
          required: ["shapes"],
        },
      },
    },
  ];
}

function stringify(data: unknown): string {
  return truncate(data);
}

// Skills are advertised in the system prompt as a catalog; this tool loads
// the full instructions of one skill on the model's request.
export function getSkillToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "use_skill",
        description:
          "Load the full instructions of a skill from the Available skills catalog. Call it before answering when the request clearly matches one of the listed skills; do not call it for unrelated requests.",
        parameters: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Skill name from the catalog",
            },
          },
          required: ["name"],
        },
      },
    },
  ];
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
        return stringify(await getPageTool(String(args.page ?? "")));
      case "get_page_blocks":
        return stringify(await getPageBlocksTool(String(args.page ?? "")));
      case "get_block":
        return stringify(await getBlockTool(String(args.uuid ?? "")));
      case "get_current_page":
        return stringify(await getCurrentPageTool());
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
