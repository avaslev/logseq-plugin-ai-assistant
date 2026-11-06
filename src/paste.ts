// Large text paste collapsing (F23). A paste above the threshold goes into
// a text attachment; the input keeps a short placeholder token. At send
// time placeholders are expanded back to the full text.

export const LARGE_PASTE_THRESHOLD = 300;

const PLACEHOLDER_RE = /\[text ([a-z0-9-]+), (\d[\d _]*) chars\]/gi;

export function isLargePaste(text: string): boolean {
  return text.length >= LARGE_PASTE_THRESHOLD;
}

export function makeTextPlaceholder(id: string, length: number): string {
  return `[text ${id}, ${length.toLocaleString("en-US").replace(/,/g, " ")} chars]`;
}

export interface TextAttachment {
  id: string;
  content: string;
}

export interface Expansion {
  content: string;
  // Attachment ids whose placeholder is no longer present in the text.
  orphanIds: string[];
}

// Replaces placeholder tokens with attachment contents. Attachments whose
// token was removed from the input are reported as orphans (the UI drops
// them). Unknown tokens are left as-is.
export function expandTextPlaceholders(
  text: string,
  attachments: TextAttachment[]
): Expansion {
  const byId = new Map(attachments.map((a) => [a.id, a.content]));
  const used = new Set<string>();
  const content = text.replace(PLACEHOLDER_RE, (token, id: string) => {
    const found = byId.get(id);
    if (found === undefined) return token;
    used.add(id);
    return found;
  });
  const orphanIds = attachments
    .map((a) => a.id)
    .filter((id) => !used.has(id));
  return { content, orphanIds };
}

let nextAttachmentSeq = 0;

export function nextAttachmentId(): string {
  nextAttachmentSeq += 1;
  return `t${Date.now().toString(36)}${nextAttachmentSeq}`;
}

// Removes the placeholder token for a dropped attachment from the input.
export function removeTextPlaceholder(text: string, id: string): string {
  const re = new RegExp(`\\[text ${id}, [\\d _]+ chars\\]`, "g");
  return text.replace(re, "");
}
