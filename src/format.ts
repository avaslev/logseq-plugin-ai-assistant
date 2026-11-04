import type { ChatMessage } from "./llm";

export const THINKING_TEXT = "🤔 Thinking…";
export const MAX_SLUG_LENGTH = 40;

export interface ReplyBlock {
  content: string;
  children: string[];
}

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

const BULLET_LINE = /^([-*•]|\d+[.)])\s+/;

export function splitReplyIntoBlocks(reply: string): ReplyBlock[] {
  const normalized = reply.replace(/\\n\s*([-*•]|\d+[.)])\s*/g, " • ");
  const blocks: ReplyBlock[] = [];
  let current: ReplyBlock | null = null;
  let lastWasBullet = false;
  let sectionBreak = true;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.replace(/\r$/, "").trim();
    if (!line) {
      sectionBreak = true;
      continue;
    }

    const indented = /^\s/.test(rawLine);
    const bullet = BULLET_LINE.test(line);

    if (sectionBreak) {
      current = { content: line, children: [] };
      blocks.push(current);
      lastWasBullet = bullet;
      sectionBreak = false;
      continue;
    }

    if (indented && current) {
      current.children.push(line);
      lastWasBullet = false;
      continue;
    }

    if (bullet) {
      if (current && !BULLET_LINE.test(current.content)) {
        current.children.push(line);
      } else {
        current = { content: line, children: [] };
        blocks.push(current);
        lastWasBullet = true;
      }
      continue;
    }

    if (current && lastWasBullet && BULLET_LINE.test(current.content)) {
      current.content = `${current.content} ${line}`;
      lastWasBullet = false;
      continue;
    }

    current = { content: line, children: [] };
    blocks.push(current);
    lastWasBullet = false;
  }

  return blocks;
}

const SESSION_HISTORY_LIMIT = 30;

export function historyFromTree(tree: HistoryNode[], max = 30): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 1; i < tree.length; i++) {
    const node = tree[i];
    const content = String(node.content ?? "").trim();
    if (!content || content === THINKING_TEXT) continue;
    const role = i % 2 === 1 ? "user" : "assistant";
    const childTexts = (Array.isArray(node.children)
      ? (node.children as HistoryNode[])
      : []
    )
      .map((child) => String(child.content ?? ""))
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
    "- Every newline in your reply starts a NEW block.",
    "- Every bullet list MUST start with a short intro line; the intro becomes the parent block and each bullet becomes its child block.",
    "- Elaborated list items go on their own lines starting with '- ' (they become child blocks of the intro).",
    "- Keep each list item on ONE line: write its full description in the same line, never split an item across multiple lines.",
    "- Compact enumeration of short items: write all items on ONE line separated by ' • ' (e.g. 'Names: Alice • Bob • Carol').",
    "- Never output the literal characters backslash+n ('\\n') anywhere in the reply.",
    "- When switching back to normal text after a list, leave an empty line before it.",
    "- Indent a line with two spaces to make it a child block of the previous line.",
    "",
    "Graph reference rules:",
    "- When tools return blocks you may cite them with ((block-uuid)).",
    "- When tools return pages you may reference them as [[Page Name]].",
    "- Add references only when they are clearly relevant; every link adds noise.",
    "",
    "Behavior rules:",
    "- The user's graph is their knowledge base: use search_graph before asking the user for details.",
    "- Keep answers concise.",
    "",
    `Today's date: ${date.toISOString().slice(0, 10)}.`,
  ].join("\n");
}
