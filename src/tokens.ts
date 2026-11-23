import type { ChatMessage } from "./llm";

// Rough token estimate for context-size feedback (F8). Latin text averages
// ~4 characters per token; Cyrillic scripts are less compressible, ~2-3
// characters per token. Good enough for a UI hint, not for billing.

const LATIN_CHARS_PER_TOKEN = 4;
const CYRILLIC_CHARS_PER_TOKEN = 2.5;

// Providers report the real prompt size in `usage.prompt_tokens`. The heuristic
// above underestimates JSON/uuid-heavy text, so a factor learned from real
// usage keeps the budget honest on small context windows. It starts at 1 and
// is corrected gradually, so a single odd response cannot swing it.
const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 4;

let calibration = 1;

export function resetTokenCalibration(): void {
  calibration = 1;
}

export function getTokenCalibration(): number {
  return calibration;
}

// Feeds a real prompt-token count back into the estimator. `estimated` must be
// the value the estimator returned for the same prompt (calibration included).
export function calibrateTokenEstimate(
  estimated: number,
  actual: number
): void {
  if (estimated <= 0 || actual <= 0) return;
  const ratio = actual / estimated;
  if (!Number.isFinite(ratio)) return;
  const next = calibration * Math.sqrt(ratio);
  calibration = Math.min(MAX_CALIBRATION, Math.max(MIN_CALIBRATION, next));
}

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
  return Math.ceil(tokens * calibration);
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
