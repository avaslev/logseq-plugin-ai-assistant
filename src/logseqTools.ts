import "@logseq/libs";
import type { ToolSpec } from "./llm";

const MAX_TOOL_OUTPUT = 4000;
const MAX_SEARCH_RESULTS = 15;
const SEARCH_CACHE_TTL_MS = 15_000;
const SEARCH_CACHE_MAX = 20;

function pageSearchQuery(needle: string): string {
  return `[:find ?name :where [?p :block/name ?name] [(clojure.string/includes? (clojure.string/lower-case ?name) ${JSON.stringify(
    needle
  )})]]`;
}

function blockSearchQuery(needle: string): string {
  return `[:find ?uuid ?content ?name :where [?b :block/uuid ?uuid] [?b :block/content ?content] [?b :block/page ?p] [?p :block/name ?name] [(clojure.string/includes? (clojure.string/lower-case ?content) ${JSON.stringify(
    needle
  )})]]`;
}

interface SearchResult {
  pages: string[];
  blocks: Array<{ uuid: string; content: string; page: string }>;
}

const searchCache = new Map<
  string,
  { at: number; result: SearchResult }
>();

async function datalog(query: string): Promise<unknown> {
  return logseq.DB.q(query);
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

export function filterBlocks(
  rows: unknown,
  query: string
): SearchResult["blocks"] {
  const q = query.trim().toLowerCase();
  if (!q || !Array.isArray(rows)) return [];
  return rows
    .filter(
      (row) =>
        Array.isArray(row) && typeof row[0] === "string" && row[0].length > 0
    )
    .map((row) => ({
      uuid: String(row[0]),
      content: String(row[1] ?? ""),
      page: String(row[2] ?? ""),
    }))
    .filter((block) => block.content.toLowerCase().includes(q))
    .slice(0, MAX_SEARCH_RESULTS);
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

async function fullScanPages(q: string): Promise<string[]> {
  try {
    const rows = await datalog("[:find ?name :where [?p :block/name ?name]]");
    return filterPageNames(rows, q);
  } catch (err) {
    console.warn(
      "[ai-assistant] page search failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

async function fullScanBlocks(q: string): Promise<SearchResult["blocks"]> {
  try {
    const rows = await datalog(
      "[:find ?uuid ?content ?name :where [?b :block/uuid ?uuid] [?b :block/content ?content] [?b :block/page ?p] [?p :block/name ?name]]"
    );
    return filterBlocks(rows, q);
  } catch (err) {
    console.warn(
      "[ai-assistant] block search failed:",
      err instanceof Error ? err.message : err
    );
    return [];
  }
}

export async function searchGraph(query: string): Promise<unknown> {
  const q = query.trim();
  if (!q) return { pages: [], blocks: [] };

  const cached = readSearchCache(q);
  if (cached) return cached;

  let pages: string[] = [];
  let blocks: SearchResult["blocks"] = [];
  try {
    const needle = q.toLowerCase();
    pages = filterPageNames(
      await datalog(pageSearchQuery(needle)),
      q
    );
    blocks = filterBlocks(
      await datalog(blockSearchQuery(needle)),
      q
    );
  } catch (err) {
    console.warn(
      "[ai-assistant] filtered search failed, scanning the graph:",
      err instanceof Error ? err.message : err
    );
    pages = await fullScanPages(q);
    blocks = await fullScanBlocks(q);
  }

  const result = { pages, blocks };
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
          "Search the user's Logseq knowledge graph. Returns matching page names and block contents with their uuids (uuid can be referenced as ((uuid)) in the answer).",
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
