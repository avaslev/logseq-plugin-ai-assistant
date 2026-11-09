import { toSingleBlockContent } from "./format";

export interface OutlineNode {
  content: string;
  children: OutlineNode[];
}

export interface ParsedOutline {
  nodes: OutlineNode[];
  blockCount: number;
}

export interface OutlineOptions {
  maxDepth?: number;
  collapseSingleChild?: boolean;
}

export const OUTLINE_MAX_DEPTH = 2;
export const OUTLINE_MAX_BLOCKS = 100;

const LIST_LINE = /^(\s*)(?:\d{1,3}[.)]|[-*+])\s+(.*)$/;
const FENCE_START = /^\s*(`{3,}|~{3,})/;
const FENCE_END = /^\s*(`{3,}|~{3,})\s*$/;

function normalizeLine(raw: string): string {
  return raw.replace(/\t/g, "  ").trimEnd();
}

function countBlocks(nodes: OutlineNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countBlocks(node.children);
  }
  return count;
}

function containsFence(content: string): boolean {
  return /(^|\n)\s*(`{3,}|~{3,})/.test(content);
}

function renderFlattenedChildren(
  children: OutlineNode[],
  level: number
): string {
  const lines: string[] = [];
  const indent = "  ".repeat(level);
  for (const child of children) {
    const childLines = child.content.split("\n");
    if (childLines.length === 0) continue;
    if (containsFence(child.content)) {
      for (const line of childLines) {
        lines.push(`${indent}${line}`);
      }
    } else {
      lines.push(`${indent}• ${childLines[0]}`);
      for (const line of childLines.slice(1)) {
        lines.push(`${indent}  ${line}`);
      }
    }
    if (child.children.length > 0) {
      lines.push(renderFlattenedChildren(child.children, level + 1));
    }
  }
  return lines.join("\n");
}

function flattenDepth(
  nodes: OutlineNode[],
  depth: number,
  maxDepth: number
): void {
  for (const node of nodes) {
    if (depth >= maxDepth - 1 && node.children.length > 0) {
      const flattened = renderFlattenedChildren(node.children, 0);
      node.content = [node.content, flattened].filter(Boolean).join("\n");
      node.children = [];
      continue;
    }
    flattenDepth(node.children, depth + 1, maxDepth);
  }
}

function collapseSingleChildren(nodes: OutlineNode[]): void {
  for (const node of nodes) {
    collapseSingleChildren(node.children);
    if (
      node.children.length === 1 &&
      node.children[0].children.length === 0 &&
      !containsFence(node.children[0].content)
    ) {
      const child = node.children[0];
      const childLines = child.content.split("\n");
      const rendered = [
        `• ${childLines[0]}`,
        ...childLines.slice(1).map((line) => `  ${line}`),
      ].join("\n");
      node.content = node.content
        ? `${node.content}\n${rendered}`
        : rendered;
      node.children = [];
    }
  }
}

export function parseOutline(
  text: string,
  options: OutlineOptions = {}
): ParsedOutline {
  const maxDepth = Math.max(1, options.maxDepth ?? OUTLINE_MAX_DEPTH);
  const collapseSingleChild = options.collapseSingleChild ?? true;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const normalized = lines.map(normalizeLine);

  const listIndents: number[] = [];
  let scanFence: { char: string; length: number } | null = null;
  for (const line of normalized) {
    if (scanFence) {
      const end = line.match(FENCE_END);
      if (
        end &&
        end[1][0] === scanFence.char &&
        end[1].length >= scanFence.length
      ) {
        scanFence = null;
      }
      continue;
    }
    const start = line.match(FENCE_START);
    if (start) {
      scanFence = { char: start[1][0], length: start[1].length };
      continue;
    }
    const match = line.match(LIST_LINE);
    if (match) listIndents.push(match[1].length);
  }
  const baseIndent = listIndents.length > 0 ? Math.min(...listIndents) : 0;
  const hasList = listIndents.length > 0;

  if (!hasList) {
    const content = toSingleBlockContent(text);
    const nodes = content ? [{ content, children: [] }] : [];
    return { nodes, blockCount: countBlocks(nodes) };
  }

  const nodes: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  let fence: { char: string; length: number } | null = null;
  let current: OutlineNode | null = null;

  const appendLine = (line: string) => {
    if (!current) {
      const content = toSingleBlockContent(line);
      if (!content) return;
      current = { content, children: [] };
      nodes.push(current);
      stack[0] = current;
      return;
    }
    current.content = current.content ? `${current.content}\n${line}` : line;
  };

  for (const line of normalized) {
    if (fence) {
      appendLine(line);
      const end = line.match(FENCE_END);
      if (end && end[1][0] === fence.char && end[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const start = line.match(FENCE_START);
    if (start) {
      fence = { char: start[1][0], length: start[1].length };
      appendLine(line);
      continue;
    }

    const match = line.match(LIST_LINE);
    if (match) {
      const indent = match[1].length;
      const level = Math.max(
        0,
        Math.min(Math.floor((indent - baseIndent) / 2), stack.length)
      );
      const content = match[2].trim();
      const node: OutlineNode = { content, children: [] };
      if (level > 0) {
        const parent = stack[level - 1];
        parent.children.push(node);
      } else {
        nodes.push(node);
      }
      stack[level] = node;
      stack.length = level + 1;
      current = node;
      continue;
    }

    if (!line.trim()) {
      appendLine("");
      continue;
    }

    appendLine(line);
  }

  for (const node of nodes) {
    const clean = (item: OutlineNode) => {
      item.content = toSingleBlockContent(item.content);
      item.children.forEach(clean);
    };
    clean(node);
  }

  flattenDepth(nodes, 0, maxDepth);
  if (collapseSingleChild) collapseSingleChildren(nodes);

  const cleaned = nodes.filter((node) => node.content || node.children.length > 0);
  return { nodes: cleaned, blockCount: countBlocks(cleaned) };
}
