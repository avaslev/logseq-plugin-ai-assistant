import type { ChatMessage } from "./llm";

// Rough token estimate for context-size feedback (F8). Latin text averages
// ~4 characters per token; Cyrillic scripts are less compressible, ~2-3
// characters per token. Good enough for a UI hint, not for billing.

const LATIN_CHARS_PER_TOKEN = 4;
const CYRILLIC_CHARS_PER_TOKEN = 2.5;

function isCyrillic(ch: string): boolean {
  return /[А-Яа-яЁё]/.test(ch);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cyrillic = 0;
  let other = 0;
  for (const ch of text) {
    if (isCyrillic(ch)) cyrillic++;
    else other++;
  }
  const tokens =
    other / LATIN_CHARS_PER_TOKEN + cyrillic / CYRILLIC_CHARS_PER_TOKEN;
  return Math.ceil(tokens);
}

function messageContent(message: ChatMessage): string {
  return typeof message.content === "string" ? message.content : "";
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const message of messages ?? []) {
    total += estimateTokens(messageContent(message)) + 4; // per-message framing
    if (Array.isArray(message.tool_calls)) {
      total += estimateTokens(
        message.tool_calls
          .map((call) => call.function.name + call.function.arguments)
          .join("\n")
      );
    }
  }
  return total;
}

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}
