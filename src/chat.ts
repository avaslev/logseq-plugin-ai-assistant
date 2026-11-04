import "@logseq/libs";

export const SESSION_NAMESPACE = "ai_assistant";

export const BAR_HEIGHT = 48;
export const SIDEBAR_DEFAULT_WIDTH = 360;

export const MODEL_NAME = "mock-gpt-4";
const THINKING_DELAY_MS = 3000;
const THINKING_TEXT = "🤔 Thinking…";
const MAX_SLUG_LENGTH = 40;

let currentSessionPage: string | null = null;

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

function sanitizeSessionSlug(text: string): string {
  return text
    .replace(/[^0-9A-Za-zА-Яа-яЁё\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SLUG_LENGTH)
    .trim();
}

export async function createSessionFromMessage(
  content: string
): Promise<string> {
  const slug =
    sanitizeSessionSlug(content) || formatTimeCompact(new Date());
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
    `AI Session\nmodel:: ${MODEL_NAME}\nstarted:: ${formatTimestamp(
      new Date()
    )}`
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

export async function sendMessage(content: string): Promise<void> {
  let page = currentSessionPage;
  if (!page) {
    page = await createSessionFromMessage(content);
    await openCurrentSessionInSidebar();
  }

  await logseq.Editor.appendBlockInPage(page, content);
  scrollChatIntoView();

  const thinkingBlock = await logseq.Editor.appendBlockInPage(
    page,
    THINKING_TEXT
  );
  scrollChatIntoView();

  await new Promise((resolve) => setTimeout(resolve, THINKING_DELAY_MS));

  const reply = await getAIReply(content);
  if (thinkingBlock) {
    await logseq.Editor.updateBlock(thinkingBlock.uuid, reply);
  } else {
    await logseq.Editor.appendBlockInPage(page, reply);
  }
  scrollChatIntoView();
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

export async function getAIReply(userMessage: string): Promise<string> {
  return `Template reply to: "${userMessage}"`;
}
