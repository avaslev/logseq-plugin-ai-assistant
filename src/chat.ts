import "@logseq/libs";
import {
  chatCompletion,
  runToolLoop,
  stripThinkTags,
  LlmError,
  type ChatMessage,
  type ChatResult,
  type ToolCall,
} from "./llm";
import {
  THINKING_TEXT,
  buildSystemPrompt,
  historyFromTree,
  sanitizeSessionSlug,
  toSingleBlockContent,
  type HistoryNode,
} from "./format";import { executeLogseqTool, getLogseqToolSpecs } from "./logseqTools";
import {
  callMcpTool,
  getMcpToolSpecs,
  mcpToolRoute,
  parseMcpServers,
} from "./mcp";
import { getSettings } from "./settings";

export const SESSION_NAMESPACE = "ai_assistant";

export const BAR_HEIGHT = 48;
export const SIDEBAR_DEFAULT_WIDTH = 360;

const MAX_HISTORY_BLOCKS_FALLBACK = 30;
const MAX_HISTORY_BLOCK_LENGTH = 500;
const THINKING_UPDATE_INTERVAL_MS = 1000;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatDateCompact(date: Date): string {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(
    date.getDate()
  )}`;
}

function formatTimeCompact(date: Date): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(
    date.getSeconds()
  )}`;
}

function formatTimestamp(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(
    date.getDate()
  )} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(
    date.getSeconds()
  )}`;
}

let currentSessionPage: string | null = null;
let abortController: AbortController | null = null;

export function getCurrentSessionPage(): string | null {
  return currentSessionPage;
}

export function syncCurrentSession(pageName: string | null): void {
  currentSessionPage = pageName;
}

export function detectOpenSessionPage(): string | null {
  try {
    const sidebar = window.parent.document.getElementById("right-sidebar");
    if (!sidebar) return null;
    let found: string | null = null;
    sidebar.querySelectorAll("*").forEach((el) => {
      if (found || el.childElementCount > 0) return;
      const text = (el.textContent ?? "").trim();
      if (text.startsWith(`${SESSION_NAMESPACE}/`)) found = text;
    });
    return found;
  } catch {
    return null;
  }
}

export async function createSessionFromMessage(
  content: string,
  model: string
): Promise<string> {
  const slug = sanitizeSessionSlug(content) || formatTimeCompact(new Date());
  const base = `${SESSION_NAMESPACE}/${formatDateCompact(new Date())}_${slug}`;
  let name = base;
  let counter = 2;
  while (await logseq.Editor.getPage(name)) {
    name = `${base} (${counter++})`;
  }

  await logseq.Editor.createPage(
    name,
    {},
    { redirect: false, createFirstBlock: false }
  );
  currentSessionPage = name;

  await logseq.Editor.appendBlockInPage(
    name,
    `AI Session\nmodel:: ${model}\nstarted:: ${formatTimestamp(new Date())}`
  );

  return name;
}

export async function openCurrentSessionInSidebar(): Promise<void> {
  if (!currentSessionPage) return;
  const page = await logseq.Editor.getPage(currentSessionPage);
  if (page) logseq.Editor.openInRightSidebar(page.uuid);
}

export async function openSessionsPage(): Promise<void> {
  let page = await logseq.Editor.getPage(SESSION_NAMESPACE);
  if (!page) {
    page = await logseq.Editor.createPage(
      SESSION_NAMESPACE,
      {},
      { redirect: false, createFirstBlock: false }
    );
  }
  if (page) {
    logseq.App.pushState("page", { name: page.name });
  }
}

export async function getSessionModel(
  pageName: string
): Promise<string | null> {
  try {
    const tree = await logseq.Editor.getPageBlocksTree(pageName);
    const first = tree?.[0];
    if (!first?.uuid) return null;
    const props = (await logseq.Editor.getBlockProperties(
      first.uuid
    )) as Record<string, unknown> | null;
    const model = props?.model;
    return typeof model === "string" && model.length > 0 ? model : null;
  } catch {
    return null;
  }
}

async function buildSessionHistory(page: string): Promise<ChatMessage[]> {
  try {
    const max = getSettings().historyBlocks || MAX_HISTORY_BLOCKS_FALLBACK;
    const tree = (await logseq.Editor.getPageBlocksTree(
      page
    )) as unknown as HistoryNode[];
    return historyFromTree(tree ?? [], max);
  } catch {
    return [];
  }
}

export function applyFallbackGeometry(): void {
  logseq.setMainUIInlineStyle({
    position: "fixed",
    zIndex: 9,
    left: `${Math.max(window.innerWidth - SIDEBAR_DEFAULT_WIDTH, 0)}px`,
    width: `${SIDEBAR_DEFAULT_WIDTH}px`,
    top: `${window.innerHeight - BAR_HEIGHT}px`,
    height: `${BAR_HEIGHT}px`,
  });
}

export function applyFormGeometry(
  left: number,
  width: number,
  height: number,
  parentHeight: number
): void {
  logseq.setMainUIInlineStyle({
    position: "fixed",
    zIndex: 9,
    left: `${left}px`,
    width: `${width}px`,
    top: `${Math.max(parentHeight - height, 0)}px`,
    height: `${height}px`,
  });
}

async function routeTool(call: ToolCall): Promise<string> {
  const route = mcpToolRoute(call.function.name);
  if (!route) {
    return executeLogseqTool(call.function.name, call.function.arguments);
  }
  const server = parseMcpServers(getSettings().mcpServers).find(
    (item) => item.name === route.server
  );
  if (!server) return `Unknown MCP server: ${route.server}`;
  return callMcpTool(server, route.tool, call.function.arguments);
}

function scrollChatIntoView(): void {
  try {
    const scroller = window.parent.document.querySelector(
      ".sidebar-item-list"
    );
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  } catch {
    return;
  }
}

export function cancelGeneration(): void {
  abortController?.abort();
}

export async function sendMessage(
  content: string,
  model: string
): Promise<void> {
  let page = currentSessionPage;
  if (!page) {
    page = await createSessionFromMessage(content, model);
    await openCurrentSessionInSidebar();
  }

  abortController?.abort();
  abortController = new AbortController();
  const signal = abortController.signal;

  await logseq.Editor.appendBlockInPage(page, content);
  scrollChatIntoView();

  const thinkingBlock = await logseq.Editor.appendBlockInPage(
    page,
    THINKING_TEXT
  );
  scrollChatIntoView();

  const settings = getSettings();
  const history = await buildSessionHistory(page);
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
  ];
  const tools = settings.enableTools
    ? [
        ...getLogseqToolSpecs(),
        ...(await getMcpToolSpecs(parseMcpServers(settings.mcpServers))),
      ]
    : [];

  let lastUpdate = 0;
  let contentAccum = "";
  const updateAnswerBlock = (): void => {
    if (!thinkingBlock) return;
    const now = Date.now();
    if (now - lastUpdate < THINKING_UPDATE_INTERVAL_MS) return;
    lastUpdate = now;
    const normalized = toSingleBlockContent(contentAccum);
    if (!normalized) return;
    void logseq.Editor.updateBlock(thinkingBlock.uuid, normalized);
  };

  const sendWithRetry = async (msgs: ChatMessage[]): Promise<ChatResult> => {
    const attempt = (): Promise<ChatResult> =>
      chatCompletion({
        baseUrl: settings.apiBaseUrl,
        apiKey: settings.apiKey,
        model,
        messages: msgs,
        tools,
        signal,
        onDelta: (text) => {
          contentAccum = text;
          updateAnswerBlock();
        },
      });
    try {
      return await attempt();
    } catch (err) {
      const transient =
        err instanceof LlmError
          ? err.status === 0 || err.status >= 500
          : !(err instanceof Error && err.name === "AbortError") && !signal.aborted;
      if (!transient || signal.aborted) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return await attempt();
    }
  };

  try {
    const loop = await runToolLoop({
      messages,
      tools,
      send: sendWithRetry,
      execTool: routeTool,
    });

    const replyText =
      toSingleBlockContent(stripThinkTags(loop.content)) ||
      loop.reasoning.trim();
    if (!replyText) {
      if (thinkingBlock) {
        await logseq.Editor.updateBlock(thinkingBlock.uuid, "(empty reply)");
      }
      return;
    }

    if (thinkingBlock) {
      await logseq.Editor.updateBlock(thinkingBlock.uuid, replyText);
    }
    scrollChatIntoView();
  } catch (err) {
    const aborted = signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    if (thinkingBlock) {
      await logseq.Editor.updateBlock(
        thinkingBlock.uuid,
        aborted ? "⏹ Cancelled" : `⚠️ ${message}`
      );
    }
    if (!aborted) {
      void logseq.UI.showMsg(`AI assistant: ${message}`, "error");
    }
  } finally {
    if (abortController?.signal === signal) abortController = null;
  }
}
