import type { ChatMessage } from "./llm";
import { estimateMessagesTokens } from "./tokens";
import {
  CANCELLED_TEXT,
  COMPRESSING_TEXT,
  EMPTY_REPLY_TEXT,
  ERROR_PREFIX,
  THINKING_TEXT,
  TOOL_REPLY_TEXT,
} from "./strings";

// Re-exported for backwards compatibility with existing imports.
export { THINKING_TEXT };
export const MAX_SLUG_LENGTH = 40;

export interface HistoryNode {
  uuid?: unknown;
  content?: unknown;
  children?: unknown;
}

export function sanitizeSessionSlug(text: string): string {
  return text
    .replace(/[^0-9A-Za-zА-Яа-яЁё\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SLUG_LENGTH)
    .trim();
}

const THINK_FRAGMENT_LINE = /^\s*(<\/?think>?|\/think)\s*$/i;
const FENCE_START = /^\s*(`{3,}|~{3,})/;
const FENCE_END = /^\s*(`{3,}|~{3,})\s*$/;

export const ASSISTANT_MARKER = "✦ ";

// Markdown constructs that are only recognized at the start of a line:
// code fences, tables, headings, quotes and lists. Prefixing them with
// "✦ " inline would break their rendering.
const BLOCK_START_PATTERN =
  /^\s*(?:`{3,}|~{3,}|\||#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/;

export function isAssistantContent(text: string): boolean {
  return /^\s*✦(?:\s|$)/.test(text);
}

export function markAssistantContent(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (isAssistantContent(trimmed)) return trimmed;
  if (BLOCK_START_PATTERN.test(trimmed)) return `✦\n\n${trimmed}`;
  return `${ASSISTANT_MARKER}${trimmed}`;
}

export function stripAssistantMarker(text: string): string {
  return text.replace(/^\s*✦(?:\s+|$)/, "");
}

export function toSingleBlockContent(reply: string): string {
  const lines: string[] = [];
  let fence: { char: string; length: number } | null = null;

  for (const raw of reply.split("\n")) {
    if (fence) {
      lines.push(raw);
      const end = raw.match(FENCE_END);
      if (
        end &&
        end[1][0] === fence.char &&
        end[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    const start = raw.match(FENCE_START);
    if (start) {
      fence = { char: start[1][0], length: start[1].length };
      lines.push(raw.trimEnd());
      continue;
    }

    const line = raw.trim();
    if (!line || THINK_FRAGMENT_LINE.test(line)) continue;

    const list = line.match(/^(?:\d{1,3}[.)]|[-*+])\s+(.*)$/);
    if (list) {
      const indent = raw.slice(0, raw.length - raw.trimStart().length);
      lines.push(`${indent}• ${list[1]}`);
      continue;
    }

    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      lines.push(heading[1]);
      continue;
    }

    lines.push(line);
  }

  if (lines.length === 0) return "";
  lines[0] = lines[0].replace(/^\s*[•*-]\s+/, "").trim();
  if (!lines[0]) lines.shift();
  return lines.join("\n");
}


const SERVICE_BLOCK_PREFIXES = [ERROR_PREFIX, "⏹", "💭", "🔧", "↩️", "⏳"];
const SERVICE_BLOCK_TEXTS = [
  THINKING_TEXT,
  EMPTY_REPLY_TEXT,
  TOOL_REPLY_TEXT,
  CANCELLED_TEXT,
  COMPRESSING_TEXT,
];

function isServiceBlock(content: string): boolean {
  if (SERVICE_BLOCK_TEXTS.includes(content)) return true;
  return SERVICE_BLOCK_PREFIXES.some((prefix) =>
    content.startsWith(prefix)
  );
}

function isSessionMeta(content: string): boolean {
  if (/^\s*AI Session\s*(?:\n|$)/i.test(content)) return true;
  return /(^|\n)\s*model::/.test(content) &&
    /(^|\n)\s*started::/.test(content);
}

export function historyFromTree(tree: HistoryNode[], max = 30): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const node of tree ?? []) {
    const raw = String(node.content ?? "").trim();
    if (!raw || isServiceBlock(raw) || isSessionMeta(raw)) continue;
    const assistant = isAssistantContent(raw);
    const content = stripAssistantMarker(raw).trim();
    if (!content) continue;
    const childTexts = (Array.isArray(node.children)
      ? (node.children as HistoryNode[])
      : []
    )
      .map((child) => stripAssistantMarker(String(child.content ?? "").trim()))
      .filter((text) => text.length > 0);
    const full = childTexts.length
      ? [content, ...childTexts].join("\n")
      : content;
    messages.push({ role: assistant ? "assistant" : "user", content: full });
  }
  return messages.slice(-max);
}

// Drops the oldest messages until the token estimate fits the budget. The
// latest message is always kept so the current request is never lost.
export function trimHistoryToBudget(
  messages: ChatMessage[],
  budgetTokens: number
): ChatMessage[] {
  if (budgetTokens <= 0 || messages.length <= 1) return messages;
  let start = 0;
  while (
    start < messages.length - 1 &&
    estimateMessagesTokens(messages.slice(start)) > budgetTokens
  ) {
    start += 1;
  }
  return start === 0 ? messages : messages.slice(start);
}

// Emergency shrink after the provider rejects a prompt as too long. Tool
// call/result pairs are dropped as a unit: keeping one side of the pair makes
// the next request invalid. Plain user/assistant text is halved, always
// keeping the newest message (the current request or the wrap-up prompt).
export function shrinkMessagesForOverflow(
  messages: ChatMessage[]
): ChatMessage[] {
  const system = messages[0]?.role === "system" ? messages[0] : null;
  const rest = system ? messages.slice(1) : messages;
  const plain = rest.filter(
    (message) => message.role !== "tool" && !message.tool_calls?.length
  );
  if (plain.length < 2) return messages;
  const drop = Math.max(1, Math.floor(plain.length / 2));
  const kept = plain.slice(drop);
  if (kept.length === 0) return messages;
  return system ? [system, ...kept] : kept;
}

// Full-length (untruncated) user messages of a session, oldest first.
// Used by the input history navigation (F22).
export function sentMessagesFromTree(tree: HistoryNode[]): string[] {
  const out: string[] = [];
  for (const node of tree ?? []) {
    const raw = String(node.content ?? "").trim();
    if (!raw || isServiceBlock(raw) || isSessionMeta(raw)) continue;
    if (isAssistantContent(raw)) continue;
    if (out[out.length - 1] !== raw) out.push(raw);
  }
  return out;
}

