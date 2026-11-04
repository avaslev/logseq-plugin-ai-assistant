import "@logseq/libs";
import type { ToolSpec } from "./llm";

const MAX_TOOL_OUTPUT = 4000;
const MAX_SEARCH_RESULTS = 15;

interface SearchResult {
  pages: string[];
  blocks: Array<{ uuid: string; content: string; page: string }>;
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

async function searchGraph(query: string): Promise<unknown> {
  const q = query.trim();
  if (!q) return { pages: [], blocks: [] };

  let pages: string[] = [];
  try {
    const rows = await logseq.DB.q(
      "[:find ?name :where [?p :block/name ?name]]"
    );
    pages = filterPageNames(rows, q);
  } catch (err) {
    console.warn(
      "[ai-assistant] page search failed:",
      err instanceof Error ? err.message : err
    );
  }

  let blocks: SearchResult["blocks"] = [];
  try {
    const rows = await logseq.DB.q(
      "[:find ?uuid ?content ?name :where [?b :block/uuid ?uuid] [?b :block/content ?content] [?b :block/page ?p] [?p :block/name ?name]]"
    );
    blocks = filterBlocks(rows, q);
  } catch (err) {
    console.warn(
      "[ai-assistant] block search failed:",
      err instanceof Error ? err.message : err
    );
  }

  return { pages, blocks };
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
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
