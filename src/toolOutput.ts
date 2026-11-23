// Tool results are fed back into the same tiny context window as the prompt.
// Keeping every uuid, property and long block verbatim quickly crowds out the
// actual question, so trim repetitive JSON before handing it to the model.

export const MAX_TOOL_OUTPUT_CHARS = 6000;

interface Limits {
  text: number;
  items: number;
  keys: number;
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… [truncated ${text.length - limit} chars]`;
}

function compact(value: unknown, depth: number, limits: Limits): unknown {
  if (depth > 8) return "[nested data omitted]";
  if (typeof value === "string") return truncateText(value, limits.text);
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, limits.items)
      .map((item) => compact(item, depth + 1, limits));
    if (value.length > limits.items) {
      kept.push(`… ${value.length - limits.items} more items`);
    }
    return kept;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [index, [key, item]] of entries.entries()) {
      if (index >= limits.keys) {
        result.__more = `${entries.length - limits.keys} more fields`;
        break;
      }
      result[key] = compact(item, depth + 1, limits);
    }
    return result;
  }
  return value;
}

export function compactToolOutput(raw: string): string {
  if (!raw) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return truncateText(raw, MAX_TOOL_OUTPUT_CHARS);
  }

  // Shrink the parts, not the serialized string: cutting JSON mid-token would
  // leave the model with an unparseable tool result.
  const limits: Limits = { text: 1000, items: 30, keys: 40 };
  let text = JSON.stringify(compact(parsed, 0, limits));
  while (
    text.length > MAX_TOOL_OUTPUT_CHARS &&
    (limits.text > 80 || limits.items > 2 || limits.keys > 5)
  ) {
    limits.text = Math.max(80, Math.floor(limits.text / 2));
    limits.items = Math.max(2, Math.floor(limits.items / 2));
    limits.keys = Math.max(5, Math.floor(limits.keys / 2));
    text = JSON.stringify(compact(parsed, 0, limits));
  }
  return text;
}
