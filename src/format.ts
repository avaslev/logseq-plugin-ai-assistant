import type { ChatMessage } from "./llm";

export const THINKING_TEXT = "💭 Думаю…";
export const MAX_SLUG_LENGTH = 40;

export interface HistoryNode {
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

export function toSingleBlockContent(reply: string): string {
  const lines = reply
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !THINK_FRAGMENT_LINE.test(line))
    .map((line) => {
      if (/^[-*+]\s+/.test(line)) return line.replace(/^[-*+]\s+/, "• ");
      if (/^#{1,6}\s+/.test(line)) return line.replace(/^#{1,6}\s+/, "");
      return line;
    });
  if (lines.length === 0) return "";
  lines[0] = lines[0].replace(/^[•*-]\s+/, "").trim();
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

export function historyFromTree(tree: HistoryNode[], max = 30): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 1; i < tree.length; i++) {
    const node = tree[i];
    const content = String(node.content ?? "")
      .trim()
      .slice(0, HISTORY_NODE_MAX_LENGTH);
    if (!content || isServiceBlock(content)) continue;
    const role = i % 2 === 1 ? "user" : "assistant";
    const childTexts = (Array.isArray(node.children)
      ? (node.children as HistoryNode[])
      : []
    )
      .map((child) =>
        String(child.content ?? "")
          .trim()
          .slice(0, HISTORY_NODE_MAX_LENGTH)
      )
      .filter((text) => text.length > 0);
    const full = childTexts.length
      ? [content, ...childTexts].join("\n")
      : content;
    messages.push({ role, content: full });
  }
  return messages.slice(-max);
}

export function buildSystemPrompt(date = new Date()): string {
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
    "- Keep answers concise.",
    "- Answer directly: do not restate the user's question at the start of your answer.",
    "- Never output thinking tags like <think>, </think> or /think — they are handled automatically.",
    "",
    `Today's date: ${date.toISOString().slice(0, 10)}.`,
  ].join("\n");
}
