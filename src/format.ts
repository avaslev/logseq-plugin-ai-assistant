import type { ChatMessage } from "./llm";

export const THINKING_TEXT = "💭 Думаю…";
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

    const list = line.match(/^[-*+]\s+(.*)$/);
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


const HISTORY_NODE_MAX_LENGTH = 500;
const SERVICE_BLOCK_PREFIXES = ["⚠️", "⏹"];
const SERVICE_BLOCK_TEXTS = [THINKING_TEXT, "(empty reply)"];

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
    const content = stripAssistantMarker(raw)
      .trim()
      .slice(0, HISTORY_NODE_MAX_LENGTH);
    if (!content) continue;
    const childTexts = (Array.isArray(node.children)
      ? (node.children as HistoryNode[])
      : []
    )
      .map((child) => stripAssistantMarker(String(child.content ?? "").trim()))
      .filter((text) => text.length > 0)
      .map((text) => text.slice(0, HISTORY_NODE_MAX_LENGTH));
    const full = childTexts.length
      ? [content, ...childTexts].join("\n")
      : content;
    messages.push({ role: assistant ? "assistant" : "user", content: full });
  }
  return messages.slice(-max);
}

export function buildSystemPrompt(
  date = new Date(),
  enableWriteTools = false
): string {
  return [
    "You are an AI assistant working inside Logseq, a networked note-taking app.",
    "Your answers are written into the user's graph as Logseq blocks.",
    "",
    "Logseq block rules:",
    "- Your ENTIRE answer is written into a SINGLE Logseq block (bullet).",
    "- Newlines in your reply are rendered as line breaks inside that same block, so use them freely to structure the answer.",
    "- Use '- ' bullets and '1.' numbering inside the answer for lists; keep lists compact.",
    "- Never output the literal characters backslash+n ('\\n') anywhere in the reply.",
    "",
    "Markdown support:",
    "- Logseq blocks support Markdown: **bold**, *italic*, `code`, [links](url) and Markdown tables.",
    "- If the user asks for a table, output a Markdown table directly: a header row, a '|---|---|' separator row, then data rows. No introduction needed before it.",
    "",
    "Language rules:",
    "- Reply in the same language the user writes in.",
    "",
    "Graph reference rules:",
    "- When tools return blocks you may cite them with ((block-uuid)).",
    "- When tools return pages you may reference them as [[Page Name]].",
    "- Add references only when they are clearly relevant; every link adds noise.",
    "",
    "Behavior rules:",
    "- The user's graph is their knowledge base: use search_graph before asking the user for details.",
    "- Task statuses (TODO/DOING/NOW/LATER) are markers on blocks, not words in their text: use search_tasks to list tasks by status.",
    "- Keep answers concise.",
    "- Answer directly: do not restate the user's question at the start of your answer.",
    "- Never output thinking tags like <think>, </think> or /think — they are handled automatically.",
    ...(enableWriteTools
      ? [
          "",
          "Page editing rules:",
          "- Write tools (insert_block, prepend_block, update_block, remove_block, move_block, upsert_block_property) only affect the page the user currently has open.",
          "- Get block uuids from get_page_blocks, get_block or search_graph before editing; never guess uuids.",
          "- Each tool call writes ONE block; to add several blocks, make several insert_block calls.",
          "- Newlines inside the content parameter are line breaks within that same block, not new blocks.",
          "- For destructive actions (remove_block, move_block) describe what you are about to change and confirm with the user first if the request is ambiguous.",
          "- After editing, briefly report what changed; do not paste whole edited blocks back unless asked.",
        ]
      : []),
    "",
    `Today's date: ${date.toISOString().slice(0, 10)}.`,
  ].join("\n");
}
