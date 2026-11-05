import "@logseq/libs";
import type { ToolSpec } from "./llm";

const MAX_TOOL_OUTPUT = 4000;
const MAX_SEARCH_RESULTS = 15;
const SEARCH_CACHE_TTL_MS = 15_000;
const SEARCH_CACHE_MAX = 20;

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

const SESSION_PAGE_PREFIX = "ai_assistant/";

interface CurrentPage {
  name: string;
  uuid: string;
  id: number;
}

async function resolveCurrentPage(): Promise<CurrentPage | string> {
  const entity = await logseq.Editor.getCurrentPage();
  if (!entity) return "No page is currently open in the main editor";
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
    return `Block "${uuid}" is not on the current page "${page.name}". Write tools only work on the page you currently have open`;
  }
  return null;
}

async function insertBlockTool(
  page: CurrentPage,
  content: string,
  afterUuid: string
): Promise<unknown> {
  if (!content) return { error: "content is required" };
  if (afterUuid) {
    const err = await ensureBlockOnCurrentPage(afterUuid, page);
    if (err) return { error: err };
    const block = await logseq.Editor.insertBlock(afterUuid, content, {
      sibling: true,
    });
    return { ok: true, uuid: block?.uuid ?? null, insertedAfter: afterUuid };
  }
  const block = await logseq.Editor.appendBlockInPage(page.uuid, content);
  return { ok: true, uuid: block?.uuid ?? null, page: page.name };
}

async function prependBlockTool(
  page: CurrentPage,
  content: string
): Promise<unknown> {
  if (!content) return { error: "content is required" };
  const block = await logseq.Editor.prependBlockInPage(page.uuid, content);
  return { ok: true, uuid: block?.uuid ?? null, page: page.name };
}

async function updateBlockTool(
  page: CurrentPage,
  uuid: string,
  content: string
): Promise<unknown> {
  const err = await ensureBlockOnCurrentPage(uuid, page);
  if (err) return { error: err };
  await logseq.Editor.updateBlock(uuid, content);
  return { ok: true, uuid };
}

async function removeBlockTool(
  page: CurrentPage,
  uuid: string
): Promise<unknown> {
  const err = await ensureBlockOnCurrentPage(uuid, page);
  if (err) return { error: err };
  await logseq.Editor.removeBlock(uuid);
  return { ok: true, removed: uuid };
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
  return { ok: true, moved: uuid, target: targetUuid };
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
  return { ok: true, uuid, key };
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
  ];
}

const WRITE_TOOL_PAGE_NOTE =
  "Write tools only affect the page the user currently has open in the main editor.";

export function getWriteToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "insert_block",
        description: `Append a new block to the end of the currently open page, or insert one right after a given block uuid. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description:
                "Block content (Markdown). One block per call; use multiple calls for multiple blocks",
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
        name: "prepend_block",
        description: `Insert a new block at the top of the currently open page. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "Block content (Markdown)" },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "update_block",
        description: `Replace the content of a block on the currently open page. Get the uuid from get_page_blocks or search_graph first. ${WRITE_TOOL_PAGE_NOTE}`,
        parameters: {
          type: "object",
          properties: {
            uuid: { type: "string", description: "Block uuid" },
            content: {
              type: "string",
              description: "New block content (Markdown), replaces the old content entirely",
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
  ];
}

function stringify(data: unknown): string {
  return truncate(data);
}

export async function executeLogseqTool(
  name: string,
  argsJson: string
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return "Invalid JSON arguments";
  }
  try {
    switch (name) {
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
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
