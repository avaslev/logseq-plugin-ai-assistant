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
  buildSystemPrompt,
  historyFromTree,
  markAssistantContent,
  sanitizeSessionSlug,
  sentMessagesFromTree,
  stripAssistantMarker,
  toSingleBlockContent,
  trimHistoryToBudget,
  type HistoryNode,
} from "./format";
import {
  ASSISTANT_INFO_PREFIX,
  CANCELLED_TEXT,
  COMPRESSING_TEXT,
  EMPTY_REPLY_TEXT,
  ERROR_PREFIX,
  THINKING_TEXT,
  TOOL_REPLY_TEXT,
} from "./strings";
import { confirmAction, onConfirmRequest } from "./confirm";
import { estimateMessagesTokens, estimateTokens } from "./tokens";
import {
  buildSkillsCatalog,
  buildSkillPrompt,
  createSkillPage,
  listSkills,
  readSystemPromptOverride,
  type Skill,
} from "./skills";
import {
  executeLogseqTool,
  getLogseqToolSpecs,
  getSkillToolSpecs,
  getWriteToolSpecs,
} from "./logseqTools";
import { executeWebTool, getWebToolSpecs, isWebTool } from "./webTools";
import {
  computeHistoryBudget,
  computeMaxToolRounds,
  computeResponseTokenBudget,
  detectContextWindow,
} from "./modelInfo";
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
const TOOL_ARG_PREVIEW_FIELDS = [
  "query",
  "url",
  "status",
  "page",
  "title",
  "uuid",
  "name",
  "outline",
  "content",
];
const TOOL_ARG_PREVIEW_LIMIT = 60;

function previewText(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > TOOL_ARG_PREVIEW_LIMIT
    ? `${flat.slice(0, TOOL_ARG_PREVIEW_LIMIT - 1)}…`
    : flat;
}

export function describeToolCall(call: ToolCall): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.function.arguments || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "";
    }
    args = parsed as Record<string, unknown>;
  } catch {
    return "";
  }
  for (const field of TOOL_ARG_PREVIEW_FIELDS) {
    const value = args[field];
    if (typeof value === "string" && value.trim()) {
      return previewText(value);
    }
  }
  const json = JSON.stringify(args);
  return json && json !== "{}" ? previewText(json) : "";
}

function formatChars(length: number): string {
  return length < 1000 ? String(length) : `${(length / 1000).toFixed(1)}k`;
}

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

// --- send state & token usage (F8, F15) --------------------------------------

export type SendPhase = "idle" | "running" | "failed";

export interface StopInfo {
  kind: "cancelled" | "network" | "rate-limit" | "server" | "error";
  retryable: boolean;
  text: string;
}

export interface Continuation {
  page: string;
  blockUuid: string;
  model: string;
}

export interface SendState {
  phase: SendPhase;
  usage: { contextTokens: number; outputTokens: number } | null;
  failed: StopInfo | null;
  failedMessage: string | null;
  // Set when the provider stopped at the output token limit, so the UI can
  // offer to continue the same reply (F25).
  continuation: Continuation | null;
}

let sendState: SendState = {
  phase: "idle",
  usage: null,
  failed: null,
  failedMessage: null,
  continuation: null,
};
const sendStateListeners = new Set<(state: SendState) => void>();

export function getSendState(): SendState {
  return sendState;
}

export function onSendState(cb: (state: SendState) => void): () => void {
  sendStateListeners.add(cb);
  return () => sendStateListeners.delete(cb);
}

function setSendState(patch: Partial<SendState>): void {
  sendState = { ...sendState, ...patch };
  sendStateListeners.forEach((cb) => cb(sendState));
}

export function clearFailedSend(): void {
  setSendState({
    phase: "idle",
    failed: null,
    failedMessage: null,
    continuation: null,
  });
}

export function classifyStop(err: unknown, aborted: boolean): StopInfo {
  if (aborted) {
    return { kind: "cancelled", retryable: false, text: CANCELLED_TEXT };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (err instanceof LlmError) {
    if (err.status === 0) {
      return {
        kind: "network",
        retryable: true,
        text: `${ERROR_PREFIX} No connection to the LLM server: ${message}`,
      };
    }
    if (err.status === 429) {
      return {
        kind: "rate-limit",
        retryable: true,
        text: `${ERROR_PREFIX} Rate limited by the provider: ${message}`,
      };
    }
    if (err.status >= 500) {
      return {
        kind: "server",
        retryable: true,
        text: `${ERROR_PREFIX} Server error (HTTP ${err.status}): ${message}`,
      };
    }
  }
  return { kind: "error", retryable: false, text: `${ERROR_PREFIX} ${message}` };
}

export function getSentMessages(pageName: string): Promise<string[]> {
  return (async () => {
    try {
      const tree =
        ((await logseq.Editor.getPageBlocksTree(
          pageName
        )) as unknown as HistoryNode[]) ?? [];
      return sentMessagesFromTree(tree);
    } catch {
      return [];
    }
  })();
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

function assistantInfo(text: string): void {
  void logseq.UI.showMsg(`${ASSISTANT_INFO_PREFIX} ${text}`);
}

const COMPRESS_SYSTEM_PROMPT = [
  "You compress a chat session into a compact summary that will replace the session history.",
  "Keep key facts, decisions, open questions, names and any page/block references.",
  "Drop duplication, small talk and superseded details.",
  "Start the summary with a one-line heading \"Summary of the previous dialogue:\" translated into the language of the conversation.",
  "Reply with the summary only — no preamble.",
].join(" ");

async function removeSession(): Promise<void> {
  const pageName = currentSessionPage;
  if (!pageName) {
    assistantInfo("No active session to remove");
    return;
  }

  const confirmed = await confirmAction({
    title: "Delete this session?",
    description: `Page "${pageName}" and all its messages will be deleted permanently. This action can not be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    danger: true,
  });
  if (!confirmed) {
    console.info("[ai-assistant] /remove cancelled by user");
    return;
  }

  console.info(`[ai-assistant] /remove: deleting page ${pageName}`);
  try {
    await logseq.Editor.deletePage(pageName);
  } catch (err) {
    console.warn("[ai-assistant] /remove: deletePage failed:", err);
    assistantInfo(
      `Failed to remove the session: ${err instanceof Error ? err.message : String(err)}`
    );
    return;
  }

  // Some Logseq builds keep the deleted page in the entity cache for a while,
  // so a lookup right after deletion is informational only.
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    if (await logseq.Editor.getPage(pageName)) {
      console.warn(
        `[ai-assistant] /remove: page ${pageName} is still visible after deletePage (stale cache or refused deletion)`
      );
    }
  } catch {
    // lookup failed — assume the page is gone
  }

  if (currentSessionPage === pageName) currentSessionPage = null;
  try {
    // Drop the stale session page from the right sidebar; the assistant
    // panel itself is re-shown by the visibility loop right after.
    logseq.App.clearRightSidebarBlocks({ close: false });
  } catch {
    // sidebar cleanup is cosmetic
  }
  assistantInfo(`Session removed: ${pageName}`);
}

async function compressSession(model: string): Promise<void> {
  const pageName = currentSessionPage;
  if (!pageName) {
    assistantInfo("No active session to compress");
    return;
  }

  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const signal = controller.signal;

  let statusUuid: string | null = null;
  try {
    const status = await logseq.Editor.appendBlockInPage(
      pageName,
      COMPRESSING_TEXT
    );
    statusUuid = status ? String((status as { uuid?: unknown }).uuid ?? "") : null;

    const tree =
      ((await logseq.Editor.getPageBlocksTree(
        pageName
      )) as unknown as HistoryNode[]) ?? [];
    const history = historyFromTree(tree, 1_000_000);
    if (history.length === 0) {
      if (statusUuid) await logseq.Editor.removeBlock(statusUuid);
      assistantInfo("Nothing to compress: the session has no messages");
      return;
    }

    const settings = getSettings();
    const result = await chatCompletion({
      baseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model,
      messages: [
        { role: "system", content: COMPRESS_SYSTEM_PROMPT },
        ...history,
        {
          role: "user",
          content:
            "Compress the conversation above into the summary. Reply with the summary only.",
        },
      ],
      signal,
    });
    signal.throwIfAborted();

    const summary = toSingleBlockContent(stripThinkTags(result.content));
    if (!summary) throw new Error("Empty summary");

    const metaUuid = findSessionMetaBlock(tree)?.uuid ?? null;
    let removed = 0;
    for (const node of tree) {
      const uuid = String(node.uuid ?? "");
      if (!uuid || uuid === metaUuid || uuid === statusUuid) continue;
      try {
        await logseq.Editor.removeBlock(uuid);
        removed++;
      } catch {
        // already gone; keep going
      }
    }
    if (statusUuid) {
      try {
        await logseq.Editor.removeBlock(statusUuid);
      } catch {
        // already gone
      }
    }

    await logseq.Editor.appendBlockInPage(
      pageName,
      markAssistantContent(summary)
    );
    await refreshAnswerBlockRender();
    assistantInfo(`Session compressed: ${removed} blocks → 1 summary block`);
  } catch (err) {
    const aborted = signal.aborted;
    const stop = classifyStop(err, aborted);
    if (statusUuid) {
      try {
        await logseq.Editor.updateBlock(statusUuid, stop.text);
      } catch {
        // status block disappeared; skip the mark
      }
    }
    await refreshAnswerBlockRender();
    if (!aborted) {
      assistantInfo(`Compression failed: ${stop.text}`);
    }
  } finally {
    if (abortController === controller) abortController = null;
  }
}

export async function executeSlashCommand(
  name: string,
  model: string
): Promise<void> {
  if (name === "compress") return compressSession(model);
  if (name === "remove") return removeSession();
  if (name === "skill") return createSkillFlow();
  throw new Error(`Unknown command: /${name}`);
}

async function createSkillFlow(): Promise<void> {
  const { page } = await createSkillPage("");
  try {
    logseq.App.pushState("page", { name: page });
  } catch {
    // navigation is cosmetic; the page exists in the graph anyway
  }
  assistantInfo(`Skill page created: ${page}`);
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
    if (isWebTool(call.function.name)) {
      // Web tools (F21) are read-only and independent of the graph.
      return executeWebTool(
        call.function.name,
        call.function.arguments,
        signal
      );
    }
    const result = await executeLogseqTool(
      call.function.name,
      call.function.arguments,
      signal
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

export interface SendMessageOptions {
  skill?: Skill | null;
}

export async function sendMessage(
  content: string,
  model: string,
  options?: SendMessageOptions
): Promise<void> {
  abortController?.abort();
  const controller = new AbortController();
  abortController = controller;
  const signal = controller.signal;
  let thinkingBlock: { uuid: string } | null = null;
  let blockMissing = false;
  let unsubscribeConfirm: (() => void) | null = null;
  setSendState({
    phase: "running",
    failed: null,
    failedMessage: null,
    continuation: null,
  });

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

    const systemOverride = await readSystemPromptOverride();
    const basePrompt = systemOverride
      ? `${systemOverride}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.`
      : buildSystemPrompt(new Date(), settings.enableWriteTools);

    // Without an explicit /skill invocation, advertise the catalog and let
    // the model load a skill itself via the use_skill tool (needs tools on).
    const skill = options?.skill ?? null;
    const catalog =
      skill == null && settings.enableTools
        ? buildSkillsCatalog(await listSkills())
        : "";
    const systemPrompt = [
      basePrompt,
      catalog,
      skill ? buildSkillPrompt(skill) : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const tools = settings.enableTools
      ? [
          ...getLogseqToolSpecs(),
          ...getWebToolSpecs(),
          ...(settings.enableWriteTools ? getWriteToolSpecs() : []),
          ...(catalog ? getSkillToolSpecs() : []),
          ...(await getMcpToolSpecs(
            parseMcpServers(settings.mcpServers),
            { signal }
          )),
        ]
      : [];

    const contextWindow = await detectContextWindow(
      settings.apiBaseUrl,
      settings.apiKey,
      model,
      signal
    );
    const toolsTokens =
      tools.length > 0 ? estimateTokens(JSON.stringify(tools)) : 0;
    const historyBudget = computeHistoryBudget(
      contextWindow,
      estimateTokens(systemPrompt) + toolsTokens
    );
    const trimmedHistory = trimHistoryToBudget(history, historyBudget);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...trimmedHistory,
    ];
    setSendState({
      usage: {
        contextTokens: estimateMessagesTokens(messages),
        outputTokens: 0,
      },
    });
    const maxToolRounds = computeMaxToolRounds(
      contextWindow,
      estimateMessagesTokens(messages)
    );

    let lastUpdate = 0;
    let contentAccum = "";
    let lastToolStatus = "";
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

    const setStatus = (text: string): void => {
      if (!thinkingBlock || blockMissing) return;
      lastUpdate = 0;
      void logseq.Editor.updateBlock(thinkingBlock.uuid, text).catch(() => {
        blockMissing = true;
        console.warn(
          "[ai-assistant] answer block was removed; the reply will be written as a new block"
        );
      });
    };

    unsubscribeConfirm = onConfirmRequest((request) => {
      setStatus(
        request ? `⏳ Confirm: ${request.title}` : lastToolStatus || THINKING_TEXT
      );
    });

    const sendWithRetry = async (msgs: ChatMessage[]): Promise<ChatResult> => {
      const attempt = (): Promise<ChatResult> => {
        const promptTokens = estimateMessagesTokens(msgs) + toolsTokens;
        return chatCompletion({
          baseUrl: settings.apiBaseUrl,
          apiKey: settings.apiKey,
          model,
          messages: msgs,
          tools,
          maxTokens: computeResponseTokenBudget(contextWindow, promptTokens),
          signal,
          onDelta: (text) => {
            contentAccum = text;
            updateAnswerBlock();
          },
        });
      };
      try {
        return await attempt();
      } catch (err) {
        const transient =
          err instanceof LlmError
            ? err.status === 0 || err.status >= 500
            : !(err instanceof Error && err.name === "AbortError") &&
              !signal.aborted;
        if (!transient || signal.aborted) throw err;
        setStatus(
          err instanceof LlmError && err.status > 0
            ? `💭 Retrying (HTTP ${err.status})…`
            : "💭 Retrying (network)…"
        );
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
      maxIterations: maxToolRounds,
      onEvent: (event) => {
        if (event.type === "request") {
          contentAccum = "";
          setStatus(
            `💭 Request ${event.iteration} → ${model}`
          );
          return;
        }
        const name = event.call.function.name;
        if (event.type === "tool-start") {
          const summary = describeToolCall(event.call);
          lastToolStatus = `🔧 ${name}${summary ? `: ${summary}` : ""}`;
          setStatus(lastToolStatus);
          return;
        }
        setStatus(
          `↩️ ${name}: ${event.ok ? "ok" : "failed"} · ${formatChars(
            event.outputLength
          )}`
        );
      },
    });

    const answer =
      stripThinkTags(loop.content).trim() || loop.reasoning.trim();
    const replyText = markAssistantContent(toSingleBlockContent(answer));
    setSendState({
      phase: "idle",
      failed: null,
      failedMessage: null,
      continuation: null,
      usage: {
        contextTokens: estimateMessagesTokens(loop.messages),
        outputTokens: estimateTokens(loop.content),
      },
    });
    if (!replyText) {
      if (thinkingBlock && !blockMissing) {
        try {
          await logseq.Editor.updateBlock(
            thinkingBlock.uuid,
            loop.messages.some((message) => message.role === "tool")
              ? TOOL_REPLY_TEXT
              : EMPTY_REPLY_TEXT
          );
        } catch {
          // answer block disappeared; nothing meaningful to write
        }
      }
      await refreshAnswerBlockRender();
      return;
    }

    let wrote = false;
    let replyBlockUuid: string | null = null;
    if (thinkingBlock && !blockMissing) {
      try {
        const existing = await logseq.Editor.getBlock(thinkingBlock.uuid);
        if (existing) {
          await logseq.Editor.updateBlock(thinkingBlock.uuid, replyText);
          wrote = true;
          replyBlockUuid = thinkingBlock.uuid;
        }
      } catch {
        wrote = false;
      }
    }
    if (!wrote) {
      console.warn(
        "[ai-assistant] answer block is unavailable; writing the reply as a new block"
      );
      const appended = await logseq.Editor.appendBlockInPage(page, replyText);
      replyBlockUuid = appended?.uuid ?? null;
    }
    if (loop.finishReason === "length" && replyBlockUuid) {
      setSendState({
        continuation: { page, blockUuid: replyBlockUuid, model },
      });
    }
    scrollChatIntoView();
    await refreshAnswerBlockRender();
  } catch (err) {
    const aborted = signal.aborted;
    const stop = classifyStop(err, aborted);
    if (thinkingBlock && !blockMissing) {
      try {
        await logseq.Editor.updateBlock(thinkingBlock.uuid, stop.text);
      } catch {
        // answer block disappeared; skip the status mark
      }
    }
    await refreshAnswerBlockRender();
    if (!aborted) {
      setSendState({
        phase: "failed",
        failed: stop,
        failedMessage: content,
      });
      void logseq.UI.showMsg(
        `${ASSISTANT_INFO_PREFIX} ${stop.text}`,
        "error"
      );
    } else {
      setSendState({ phase: "idle" });
    }
  } finally {
    unsubscribeConfirm?.();
    if (abortController === controller) abortController = null;
  }
}

const CONTINUE_PROMPT =
  "Your previous reply was cut off by the output token limit. Continue exactly from where it stopped. Do not repeat text that is already written and do not add a preamble.";

// Appends the rest of a reply that the provider stopped at the output token
// limit (F25). Works on the same block so the answer stays a single message.
export async function continueGeneration(): Promise<void> {
  const continuation = getSendState().continuation;
  if (!continuation || abortController) return;
  const settings = getSettings();
  const controller = new AbortController();
  abortController = controller;
  const signal = controller.signal;
  setSendState({
    phase: "running",
    failed: null,
    failedMessage: null,
    continuation: null,
  });
  try {
    let tree: HistoryNode[] = [];
    try {
      tree =
        ((await logseq.Editor.getPageBlocksTree(
          continuation.page
        )) as unknown as HistoryNode[]) ?? [];
    } catch {
      tree = [];
    }
    const history = historyFromTree(
      tree,
      settings.historyBlocks || MAX_HISTORY_BLOCKS_FALLBACK
    );
    const systemOverride = await readSystemPromptOverride();
    const basePrompt = systemOverride
      ? `${systemOverride}\n\nToday's date: ${new Date().toISOString().slice(0, 10)}.`
      : buildSystemPrompt(new Date(), settings.enableWriteTools);
    const contextWindow = await detectContextWindow(
      settings.apiBaseUrl,
      settings.apiKey,
      continuation.model,
      signal
    );
    const trimmedHistory = trimHistoryToBudget(
      history,
      computeHistoryBudget(contextWindow, estimateTokens(basePrompt))
    );
    const messages: ChatMessage[] = [
      { role: "system", content: basePrompt },
      ...trimmedHistory,
      { role: "user", content: CONTINUE_PROMPT },
    ];
    const promptTokens = estimateMessagesTokens(messages);
    const result = await chatCompletion({
      baseUrl: settings.apiBaseUrl,
      apiKey: settings.apiKey,
      model: continuation.model,
      messages,
      maxTokens: computeResponseTokenBudget(contextWindow, promptTokens),
      signal,
    });
    signal.throwIfAborted();
    const extra = toSingleBlockContent(stripThinkTags(result.content)).trim();
    if (extra) {
      const block = await logseq.Editor.getBlock(continuation.blockUuid);
      if (block) {
        const existing = stripAssistantMarker(
          String(block.content ?? "")
        ).trim();
        const merged = markAssistantContent(
          toSingleBlockContent([existing, extra].filter(Boolean).join("\n"))
        );
        await logseq.Editor.updateBlock(continuation.blockUuid, merged);
      }
    }
    setSendState({
      phase: "idle",
      failed: null,
      failedMessage: null,
      continuation:
        result.finishReason === "length"
          ? {
              page: continuation.page,
              blockUuid: continuation.blockUuid,
              model: continuation.model,
            }
          : null,
      usage: {
        contextTokens: promptTokens,
        outputTokens: estimateTokens(result.content),
      },
    });
    await refreshAnswerBlockRender();
    scrollChatIntoView();
  } catch (err) {
    const aborted = signal.aborted;
    const stop = classifyStop(err, aborted);
    setSendState({
      phase: "idle",
      failed: null,
      failedMessage: null,
      continuation,
    });
    await refreshAnswerBlockRender();
    if (!aborted) {
      void logseq.UI.showMsg(`${ASSISTANT_INFO_PREFIX} ${stop.text}`, "error");
    }
  } finally {
    if (abortController === controller) abortController = null;
  }
}
