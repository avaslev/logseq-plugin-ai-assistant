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
  markAssistantContent,
  sanitizeSessionSlug,
  toSingleBlockContent,
  type HistoryNode,
} from "./format";
import {
  executeLogseqTool,
  getLogseqToolSpecs,
  getWriteToolSpecs,
} from "./logseqTools";
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

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isSessionMetaContent(content: string): boolean {
  return (
    /^\s*AI Session\s*(?:\n|$)/i.test(content) ||
    (/(^|\n)\s*model::/.test(content) &&
      /(^|\n)\s*started::/.test(content))
  );
}

function findSessionMetaBlock(
  tree: HistoryNode[]
): { uuid: string; content: string } | null {
  for (const node of tree ?? []) {
    const content = String(node.content ?? "").trim();
    if (!content || !isSessionMetaContent(content)) continue;
    const uuid = String(node.uuid ?? "");
    if (uuid) return { uuid, content };
  }
  return null;
}

export async function persistSessionModel(
  page: string,
  model: string,
  tree?: HistoryNode[]
): Promise<void> {
  const nodes =
    tree ??
    ((await logseq.Editor.getPageBlocksTree(
      page
    )) as unknown as HistoryNode[]) ??
    [];
  const meta = findSessionMetaBlock(nodes);
  if (!meta) return;
  const stored = /(^|\n)\s*model::\s*(.*)/.exec(meta.content)?.[2]?.trim();
  if (stored === model) return;
  await logseq.Editor.upsertBlockProperty(meta.uuid, "model", model);
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

async function routeTool(
  call: ToolCall,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const route = mcpToolRoute(call.function.name);
  if (!route) {
    const result = await executeLogseqTool(
      call.function.name,
      call.function.arguments
    );
    signal?.throwIfAborted();
    return result;
  }
  const server = parseMcpServers(getSettings().mcpServers).find(
    (item) => item.name === route.server
  );
  if (!server) return `Unknown MCP server: ${route.server}`;
  return callMcpTool(server, route.tool, call.function.arguments, { signal });
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

export async function isSessionPageFocused(): Promise<boolean> {
  let mainPageName = "";
  try {
    const entity = await logseq.Editor.getCurrentPage();
    if (entity) {
      const entityRecord = entity as {
        name?: string;
        page?: { name?: string };
      };
      mainPageName = entityRecord.page?.name ?? entityRecord.name ?? "";
    }
  } catch {
    return isParentFocusInsideRightSidebar();
  }
  if (
    mainPageName &&
    !mainPageName.toLowerCase().startsWith(`${SESSION_NAMESPACE}/`)
  ) {
    return isParentFocusInsideRightSidebar();
  }
  return true;
}

function isParentFocusInsideRightSidebar(): boolean {
  try {
    const doc = window.parent.document;
    const active = doc.activeElement;
    const sidebar = doc.getElementById("right-sidebar");
    return Boolean(
      active && sidebar && (active === sidebar || sidebar.contains(active))
    );
  } catch {
    return false;
  }
}

// While an editing session is active in the main editor, a programmatically
// updated block can stay rendered as raw text until the next focus change.
// Exiting edit mode after the final write makes the answer render immediately.
export async function refreshAnswerBlockRender(): Promise<void> {
  try {
    if (!(await isSessionPageFocused())) return;
    await logseq.Editor.exitEditingMode();
  } catch {
    // best-effort; older Logseq builds may not expose the API
  }
}

export function cleanupAssistantUi(): void {
  try {
    window.parent.document.body.classList.remove("ai-assistant-bar-shown");
  } catch {
    console.warn("[ai-assistant] unable to clear parent UI flag");
  }
  try {
    const frame = window.frameElement as HTMLIFrameElement | null;
    if (frame) {
      frame.style.transition = "";
      frame.style.transform = "";
    }
  } catch {
    console.warn("[ai-assistant] unable to reset frame styles");
  }
}

export async function sendMessage(
  content: string,
  model: string
): Promise<void> {
  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const signal = controller.signal;
  let thinkingBlock: { uuid: string } | null = null;
  let blockMissing = false;

  try {
    let page = currentSessionPage;
    if (!page) {
      page = await createSessionFromMessage(content, model);
      signal.throwIfAborted();
      await openCurrentSessionInSidebar();
      signal.throwIfAborted();
    }

    await logseq.Editor.appendBlockInPage(page, content);
    scrollChatIntoView();

    thinkingBlock = await logseq.Editor.appendBlockInPage(page, THINKING_TEXT);
    scrollChatIntoView();

    const settings = getSettings();
    let tree: HistoryNode[] = [];
    try {
      tree =
        ((await logseq.Editor.getPageBlocksTree(
          page
        )) as unknown as HistoryNode[]) ?? [];
    } catch {
      tree = [];
    }
    const history = historyFromTree(
      tree,
      settings.historyBlocks || MAX_HISTORY_BLOCKS_FALLBACK
    );
    try {
      await persistSessionModel(page, model, tree);
    } catch (err) {
      console.warn("[ai-assistant] failed to persist session model:", err);
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: buildSystemPrompt(new Date(), settings.enableWriteTools),
      },
      ...history,
    ];
    const tools = settings.enableTools
      ? [
          ...getLogseqToolSpecs(),
          ...(settings.enableWriteTools ? getWriteToolSpecs() : []),
          ...(await getMcpToolSpecs(
            parseMcpServers(settings.mcpServers),
            { signal }
          )),
        ]
      : [];

    let lastUpdate = 0;
    let contentAccum = "";
    const updateAnswerBlock = (): void => {
      if (!thinkingBlock || blockMissing) return;
      const now = Date.now();
      if (now - lastUpdate < THINKING_UPDATE_INTERVAL_MS) return;
      lastUpdate = now;
      const normalized = toSingleBlockContent(contentAccum);
      if (!normalized) return;
      void logseq.Editor.updateBlock(thinkingBlock.uuid, normalized).catch(
        () => {
          blockMissing = true;
          console.warn(
            "[ai-assistant] answer block was removed; the reply will be written as a new block"
          );
        }
      );
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
            : !(err instanceof Error && err.name === "AbortError") &&
              !signal.aborted;
        if (!transient || signal.aborted) throw err;
        await abortableDelay(1500, signal);
        return await attempt();
      }
    };

    const loop = await runToolLoop({
      messages,
      tools,
      send: sendWithRetry,
      execTool: routeTool,
      signal,
    });

    const replyText = markAssistantContent(
      toSingleBlockContent(stripThinkTags(loop.content)) ||
        loop.reasoning.trim()
    );
    if (!replyText) {
      if (thinkingBlock && !blockMissing) {
        try {
          await logseq.Editor.updateBlock(thinkingBlock.uuid, "(empty reply)");
        } catch {
          // answer block disappeared; nothing meaningful to write
        }
      }
      await refreshAnswerBlockRender();
      return;
    }

    let wrote = false;
    if (thinkingBlock && !blockMissing) {
      try {
        const existing = await logseq.Editor.getBlock(thinkingBlock.uuid);
        if (existing) {
          await logseq.Editor.updateBlock(thinkingBlock.uuid, replyText);
          wrote = true;
        }
      } catch {
        wrote = false;
      }
    }
    if (!wrote) {
      console.warn(
        "[ai-assistant] answer block is unavailable; writing the reply as a new block"
      );
      await logseq.Editor.appendBlockInPage(page, replyText);
    }
    scrollChatIntoView();
    await refreshAnswerBlockRender();
  } catch (err) {
    const aborted = signal.aborted;
    const message = err instanceof Error ? err.message : String(err);
    if (thinkingBlock && !blockMissing) {
      try {
        await logseq.Editor.updateBlock(
          thinkingBlock.uuid,
          aborted ? "⏹ Cancelled" : `⚠️ ${message}`
        );
      } catch {
        // answer block disappeared; skip the status mark
      }
    }
    await refreshAnswerBlockRender();
    if (!aborted) {
      void logseq.UI.showMsg(`AI assistant: ${message}`, "error");
    }
  } finally {
    if (abortController === controller) abortController = null;
  }
}
