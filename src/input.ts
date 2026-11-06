export interface EnterKeyInfo {
  key: string;
  shiftKey: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

export function shouldSubmitOnEnter(event: EnterKeyInfo): boolean {
  if (event.isComposing || event.keyCode === 229) return false;
  return event.key === "Enter" && !event.shiftKey;
}

// Input history navigation (F22): ArrowUp/ArrowDown walk through previously
// sent messages, like a terminal. Position `null` is the "new message" slot
// holding the unsent draft; leaving the history restores it.

export interface HistoryNav {
  entries: string[];
  index: number | null;
  draft: string;
}

export interface HistoryNavResult {
  text: string;
  index: number | null;
}

export function historyUp(nav: HistoryNav): HistoryNavResult | null {
  const { entries, index } = nav;
  if (entries.length === 0) return null;
  if (index === null) {
    return { text: entries[entries.length - 1], index: entries.length - 1 };
  }
  if (index <= 0) return null;
  return { text: entries[index - 1], index: index - 1 };
}

export function historyDown(nav: HistoryNav): HistoryNavResult | null {
  const { entries, index } = nav;
  if (index === null) return null;
  if (index >= entries.length - 1) {
    return { text: nav.draft, index: null };
  }
  return { text: entries[index + 1], index: index + 1 };
}

// ArrowUp should only hijack the caret when it cannot move the caret up,
// i.e. the caret is on the first line (and vice versa for ArrowDown).
export function caretOnFirstLine(text: string, caret: number): boolean {
  return text.slice(0, caret).indexOf("\n") === -1;
}

export function caretOnLastLine(text: string, caret: number): boolean {
  return text.slice(caret).indexOf("\n") === -1;
}
