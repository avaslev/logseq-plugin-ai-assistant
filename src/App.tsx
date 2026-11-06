import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelGeneration,
  sendMessage,
  executeSlashCommand,
  getSessionModel,
  applyFallbackGeometry,
  applyFormGeometry,
  BAR_HEIGHT,
  SESSION_NAMESPACE,
  SIDEBAR_DEFAULT_WIDTH,
  detectOpenSessionPage,
  getSentMessages,
  getSendState,
  clearFailedSend,
  onSendState,
  syncCurrentSession,
  isSessionPageFocused,
  type SendPhase,
  type SendState,
} from "./chat";
import { matchSlashCommand, skillToCommand, type SlashCommand } from "./commands";
import { pickModel } from "./llm";
import {
  caretOnFirstLine,
  caretOnLastLine,
  historyDown,
  historyUp,
  shouldSubmitOnEnter,
} from "./input";
import {
  expandTextPlaceholders,
  isLargePaste,
  makeTextPlaceholder,
  nextAttachmentId,
  removeTextPlaceholder,
  type TextAttachment,
} from "./paste";
import { formatTokenCount } from "./tokens";
import { findSkill, listSkills, type Skill } from "./skills";
import {
  getPendingConfirm,
  onConfirmRequest,
  resolveConfirm,
  type ConfirmRequest,
} from "./confirm";
import {
  CONFIRM_CANCEL_LABEL,
  CONFIRM_CONFIRM_LABEL,
} from "./strings";
import {
  getAvailableModels,
  getDefaultModel,
  onAvailableModels,
  onDefaultModelChanged,
} from "./settings";

type SidebarRect = { left: number; width: number };

const MAX_TEXTAREA_HEIGHT = 200;
const SLIDE_MS = 250;

const THEME_VARS = [
  "--ls-primary-background-color",
  "--ls-secondary-background-color",
  "--ls-primary-text-color",
  "--ls-secondary-text-color",
  "--ls-primary-accent-color",
  "--ls-primary-accent-text-color",
  "--ls-error-color",
  "--ls-border-color",
  "--ls-secondary-border-color",
];

function isDarkRgb(r: number, g: number, b: number): boolean {
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

function isDarkColor(color: string): boolean {
  const rgbMatch = color.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
  if (rgbMatch) {
    return isDarkRgb(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]));
  }
  const hex = color.replace(/^#/, "");
  if (hex.length === 3 || hex.length === 6) {
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex.slice(0, 6);
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    if ([r, g, b].some((v) => Number.isNaN(v))) return false;
    return isDarkRgb(r, g, b);
  }
  return false;
}

function syncThemeVars(doc: Document) {
  const rootStyles = getComputedStyle(doc.documentElement);
  const bodyStyles = doc.body ? getComputedStyle(doc.body) : null;
  const root = document.documentElement;
  let primaryBackground = "";
  for (const name of THEME_VARS) {
    const value =
      rootStyles.getPropertyValue(name).trim() ||
      bodyStyles?.getPropertyValue(name).trim() ||
      "";
    if (!value) continue;
    if (name === "--ls-primary-background-color") primaryBackground = value;
    root.style.setProperty(name, value);
  }
  const dark =
    doc.documentElement.getAttribute("data-theme") === "dark" ||
    isDarkColor(primaryBackground);
  root.style.colorScheme = dark ? "dark" : "light";
}

type Geometry = { left: number; width: number; parentHeight: number };

function useAssistantSidebar(
  onGeometry: (g: Geometry) => void,
  onSession: (page: string | null) => void
): SidebarRect | null {
  const [rect, setRect] = useState<SidebarRect | null>(null);
  const onGeometryRef = useRef(onGeometry);
  onGeometryRef.current = onGeometry;
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;

  useEffect(() => {
    let measureCount = 0;
    let wasShown = false;
    let lastGeometry: (SidebarRect & { parentHeight: number }) | null = null;
    let hideTimer: number | undefined;

    const frame = (): HTMLIFrameElement | null =>
      (window.frameElement as HTMLIFrameElement | null) ?? null;

    const slideIn = () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      try {
        const el = frame();
        if (el) {
          el.style.transition = `transform ${SLIDE_MS}ms ease`;
          el.style.transform = "";
        }
      } catch {
        return;
      }
    };

    const slideOut = () => {
      try {
        const el = frame();
        if (el) {
          el.style.transition = `transform ${SLIDE_MS}ms ease`;
          el.style.transform = "translateX(100%)";
        }
      } catch {
        return;
      }
    };

    const setParentFlag = (shown: boolean) => {
      try {
        window.parent.document.body.classList.toggle(
          "ai-assistant-bar-shown",
          shown
        );
      } catch {
        return;
      }
    };

    const hide = (reason: string) => {
      if (measureCount < 5) console.log("[ai-assistant] hide:", reason);
      if (wasShown) {
        wasShown = false;
        setRect(null);
        setParentFlag(false);
        slideOut();
        hideTimer = window.setTimeout(() => {
          hideTimer = undefined;
          if (!wasShown && window.logseq.isMainUIVisible) {
            window.logseq.hideMainUI();
          }
        }, SLIDE_MS);
      }
    };

    const showFallback = (reason: string) => {
      const next = {
        left: Math.max(window.innerWidth - SIDEBAR_DEFAULT_WIDTH, 0),
        width: SIDEBAR_DEFAULT_WIDTH,
      };
      if (measureCount < 5)
        console.log("[ai-assistant] fallback:", reason, next);
      wasShown = true;
      setRect(next);
      setParentFlag(true);
      applyFallbackGeometry();
      if (!window.logseq.isMainUIVisible) window.logseq.showMainUI();
    };

    const measure = () => {
      measureCount++;

      let doc: Document;
      try {
        doc = window.parent.document;
      } catch (err) {
        console.warn("[ai-assistant] parent.document blocked:", err);
        if (wasShown) showFallback("parent blocked");
        return;
      }

      syncThemeVars(doc);

      const sidebar = doc.getElementById("right-sidebar");
      if (!sidebar) {
        console.warn("[ai-assistant] #right-sidebar NOT FOUND");
        hide("sidebar not found");
        return;
      }

      if (measureCount < 5) {
        console.log("[ai-assistant] sidebar state:", {
          className: sidebar.className,
          open: sidebar.classList.contains("open"),
          rect: sidebar.getBoundingClientRect(),
        });
      }

      if (!sidebar.classList.contains("open")) {
        hide("sidebar closed");
        return;
      }

      const openSession = detectOpenSessionPage();
      syncCurrentSession(openSession);
      onSessionRef.current(openSession);

      const { left, width } = sidebar.getBoundingClientRect();
      if (width <= 0) {
        hide("sidebar width 0");
        return;
      }

      const next = { left, width };
      const parentHeight = doc.documentElement.clientHeight;

      const geometryChanged =
        !lastGeometry ||
        lastGeometry.left !== next.left ||
        lastGeometry.width !== next.width ||
        lastGeometry.parentHeight !== parentHeight;

      if (geometryChanged) {
        lastGeometry = { ...next, parentHeight };
        applyFormGeometry(next.left, next.width, BAR_HEIGHT, parentHeight);
        onGeometryRef.current({ ...next, parentHeight });
      }

      if (!wasShown) {
        wasShown = true;
        setRect(next);
        setParentFlag(true);
        slideIn();
        if (!window.logseq.isMainUIVisible) window.logseq.showMainUI();
      }
    };

    measure();
    const interval = setInterval(measure, 500);
    window.addEventListener("resize", measure);

    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", measure);
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      setParentFlag(false);
      try {
        const el = frame();
        if (el) {
          el.style.transition = "";
          el.style.transform = "";
        }
      } catch {
        return;
      }
    };
  }, []);

  return rect;
}

function focusFormField(field: HTMLTextAreaElement | null): void {
  try {
    (window.frameElement as HTMLElement | null)?.focus();
  } catch {
    window.focus();
  }
  field?.focus();
}

function App() {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [sessionPage, setSessionPage] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>(getAvailableModels());
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    getDefaultModel()
  );

  // F17: pending confirmation request
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    () => getPendingConfirm()
  );
  // F15/F8: send phase, failure and token usage
  const [sendPhase, setSendPhase] = useState<SendPhase>(() =>
    getSendState().phase
  );
  const [failedMessage, setFailedMessage] = useState<string | null>(
    () => getSendState().failedMessage
  );
  const [usage, setUsage] = useState<SendState["usage"]>(() =>
    getSendState().usage
  );
  // F18: skills as dynamic slash commands
  const [skills, setSkills] = useState<SlashCommand[]>([]);
  // F22: sent-message history navigation
  const [historyEntries, setHistoryEntries] = useState<string[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const savedDraftRef = useRef<string>("");
  // F23: collapsed large text pastes
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);

  useEffect(() => onAvailableModels(setModels), []);

  useEffect(
    () =>
      onConfirmRequest((request) => {
        setConfirmRequest(request);
        if (request) fieldRef.current?.blur();
      }),
    []
  );

  useEffect(
    () =>
      onSendState((state) => {
        setSendPhase(state.phase);
        setUsage(state.usage);
        setFailedMessage(state.failedMessage);
      }),
    []
  );

  const loadSkills = useCallback(async (force = false) => {
    try {
      // Cached by default (3s TTL in skills.ts) so typing "/" is cheap;
      // pass force=true to bypass the cache.
      const list = await listSkills(force);
      setSkills(list.map(skillToCommand));
    } catch {
      // skill listing is best-effort
    }
  }, []);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills, sessionPage]);

  const loadHistory = useCallback(async (page: string | null) => {
    if (!page) {
      setHistoryEntries([]);
      historyIndexRef.current = null;
      return;
    }
    const entries = await getSentMessages(page);
    setHistoryEntries(entries);
    historyIndexRef.current = null;
  }, []);

  useEffect(() => {
    void loadHistory(sessionPage);
  }, [loadHistory, sessionPage]);

  const sessionPageRef = useRef<string | null>(null);
  sessionPageRef.current = sessionPage;

  useEffect(
    () =>
      onDefaultModelChanged((model) => {
        if (!sessionPageRef.current) setSelectedModel(model);
      }),
    []
  );

  const lastSyncedSessionRef = useRef<string | null>(null);

  const handleSessionChange = useCallback((page: string | null) => {
    setSessionPage(page);
    if (page === lastSyncedSessionRef.current) return;
    lastSyncedSessionRef.current = page;
    if (!page) return;
    void getSessionModel(page).then((model) => {
      setSelectedModel(
        pickModel(model, getAvailableModels(), getDefaultModel())
      );
    });
  }, []);

  const rect = useAssistantSidebar(
    (g) => {
      geometryRef.current = g;
    },
    handleSessionChange
  );

  const autoResize = useCallback(() => {
    const field = fieldRef.current;
    const form = formRef.current;
    const geometry = geometryRef.current;
    if (!field || !form || !geometry) return;

    field.style.height = "auto";
    const height = Math.min(field.scrollHeight, MAX_TEXTAREA_HEIGHT);
    field.style.height = `${height}px`;
    field.style.overflowY =
      field.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";

    applyFormGeometry(
      geometry.left,
      geometry.width,
      Math.max(BAR_HEIGHT, form.scrollHeight),
      geometry.parentHeight
    );
  }, []);

  useEffect(() => {
    if (!rect) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(autoResize);
    });
    const timer = window.setTimeout(autoResize, 350);
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      clearTimeout(timer);
    };
  }, [rect, autoResize]);

  // Re-measure the form height whenever the confirm card or attachment
  // chips appear/disappear.
  useEffect(() => {
    autoResize();
  }, [confirmRequest, textAttachments, autoResize]);

  // Escape cancels the pending confirmation (F17).
  useEffect(() => {
    if (!confirmRequest) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        resolveConfirm(false);
        focusFormField(fieldRef.current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmRequest]);

  const shown = rect !== null;
  const prevShownRef = useRef(false);

  // Refresh the skill list whenever the panel becomes visible: the pages
  // may have been edited in the main editor since the last load.
  useEffect(() => {
    if (shown) void loadSkills(true);
  }, [shown, loadSkills]);

  useEffect(() => {
    if (!shown || pending) {
      prevShownRef.current = shown;
      return;
    }
    const firstAppearance = !prevShownRef.current;
    prevShownRef.current = shown;
    if (firstAppearance) {
      focusFormField(fieldRef.current);
      return;
    }
    let cancelled = false;
    void isSessionPageFocused().then((sessionOpen) => {
      if (!cancelled && sessionOpen) focusFormField(fieldRef.current);
    });
    return () => {
      cancelled = true;
    };
  }, [shown, pending]);

  if (!rect) return null;

  const model = selectedModel || getDefaultModel();

  const resetHistoryNav = (): void => {
    historyIndexRef.current = null;
    savedDraftRef.current = "";
  };

  const appendHistoryEntry = (text: string): void => {
    setHistoryEntries((prev) =>
      prev[prev.length - 1] === text ? prev : [...prev, text]
    );
    resetHistoryNav();
  };

  const runCommand = async (name: string): Promise<void> => {
    setPending(true);
    setDraft("");
    try {
      await executeSlashCommand(name, model);
      if (name === "skill") void loadSkills();
    } catch (err) {
      void logseq.UI.showMsg(
        `AI assistant: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    } finally {
      setPending(false);
      autoResize();
    }
  };

  const runMessage = async (
    text: string,
    historyText = text,
    skill: Skill | null = null
  ): Promise<void> => {
    setPending(true);
    setDraft("");
    setTextAttachments([]);
    resetHistoryNav();
    try {
      await sendMessage(text, model, { skill });
      appendHistoryEntry(historyText);
    } catch (err) {
      void logseq.UI.showMsg(
        `AI assistant: ${err instanceof Error ? err.message : String(err)}`,
        "error"
      );
    } finally {
      setPending(false);
      autoResize();
    }
  };

  const handleSend = async () => {
    const raw = draft;
    const text = raw.trim();
    if (!text || pending || confirmRequest) return;

    // F23: expand collapsed large-text placeholders before anything else.
    const expansion = expandTextPlaceholders(raw, textAttachments);
    if (expansion.orphanIds.length > 0) {
      setTextAttachments((prev) =>
        prev.filter((a) => !expansion.orphanIds.includes(a.id))
      );
    }
    const fullText = expansion.content.trim();
    if (!fullText) return;

    const cmd = matchSlashCommand(fullText, skills);
    if (cmd) {
      if (!cmd.exact) {
        setDraft(`/${cmd.name}`);
        autoResize();
        return;
      }
      if (cmd.extra) {
        // Skill invocation (F18): the rest of the line is the user request.
        const rest = fullText.slice(1 + cmd.name.length).trim();
        if (!rest) {
          void logseq.UI.showMsg(
            `AI assistant: type a request after /${cmd.name}`,
            "warning"
          );
          return;
        }
        try {
          const skill = await findSkill(cmd.name);
          if (!skill) {
            void logseq.UI.showMsg(
              `AI assistant: skill "${cmd.name}" not found`,
              "error"
            );
            return;
          }
          await runMessage(rest, fullText, skill);
        } catch (err) {
          void logseq.UI.showMsg(
            `AI assistant: ${err instanceof Error ? err.message : String(err)}`,
            "error"
          );
        }
        return;
      }
      await runCommand(cmd.name);
      return;
    }

    await runMessage(fullText);
  };

  // F15: retry the last failed message as-is.
  const handleRetry = async () => {
    const text = failedMessage;
    if (!text || pending) return;
    clearFailedSend();
    await runMessage(text);
  };

  const canSend = !pending && !!draft.trim();
  const slash = matchSlashCommand(draft, skills);

  const sendButtonStyle = pending
    ? {
        backgroundColor: "var(--ls-primary-accent-color, #6366f1)",
        color: "var(--ls-primary-accent-text-color, #ffffff)",
      }
    : canSend
      ? {
          backgroundColor: "var(--ls-primary-accent-color, #6366f1)",
          color: "var(--ls-primary-accent-text-color, #ffffff)",
        }
      : {
          backgroundColor: "var(--ls-secondary-background-color, transparent)",
          color: "var(--ls-secondary-text-color, #9ca3af)",
        };

  const handleButtonClick = () => {
    if (pending) {
      cancelGeneration();
      return;
    }
    void handleSend();
  };

  // F23: collapse a large pasted text into a placeholder token.
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData("text/plain");
    if (!text || !isLargePaste(text)) return;
    event.preventDefault();
    const id = nextAttachmentId();
    const placeholder = makeTextPlaceholder(id, text.length);
    setTextAttachments((prev) => [...prev, { id, content: text }]);
    const field = event.currentTarget;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const next =
      field.value.slice(0, start) + placeholder + field.value.slice(end);
    setDraft(next);
    const caret = start + placeholder.length;
    requestAnimationFrame(() => {
      fieldRef.current?.setSelectionRange(caret, caret);
    });
    autoResize();
  };

  // F23: removing a chip drops the attachment and its placeholder token.
  const removeAttachment = (id: string) => {
    setTextAttachments((prev) => prev.filter((a) => a.id !== id));
    setDraft((prev) => removeTextPlaceholder(prev, id));
    autoResize();
  };

  // F22: arrow-key history navigation helpers.
  const navigateHistory = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    direction: "up" | "down"
  ) => {
    const field = event.currentTarget;
    const caret = field.selectionStart ?? 0;
    if (direction === "up" && !caretOnFirstLine(field.value, caret)) return;
    if (direction === "down" && !caretOnLastLine(field.value, caret)) return;
    const result =
      direction === "up"
        ? historyUp({
            entries: historyEntries,
            index: historyIndexRef.current,
            draft: field.value,
          })
        : historyDown({
            entries: historyEntries,
            index: historyIndexRef.current,
            draft: historyIndexRef.current === null ? field.value : savedDraftRef.current,
          });
    if (!result) return;
    event.preventDefault();
    if (direction === "up" && historyIndexRef.current === null) {
      savedDraftRef.current = field.value;
    }
    historyIndexRef.current = result.index;
    setDraft(result.text);
    const caretPos = direction === "up" ? 0 : result.text.length;
    requestAnimationFrame(() => {
      fieldRef.current?.setSelectionRange(caretPos, caretPos);
    });
    autoResize();
  };

  return (
    <form
      ref={formRef}
      className="pointer-events-auto flex w-full flex-col gap-1 overflow-hidden border-t p-1.5"
      style={{
        backgroundColor: "var(--ls-secondary-background-color, transparent)",
        borderTopColor: "var(--ls-border-color, #52525b)",
        color: "var(--ls-primary-text-color, #e5e7eb)",
      }}
      onSubmit={(e) => {
        e.preventDefault();
        handleSend();
      }}
    >
      {confirmRequest ? (
        <div
          className="ai-assistant-box flex flex-col gap-1.5 rounded-md border p-2"
          style={{
            backgroundColor: "var(--ls-primary-background-color, transparent)",
            borderColor: confirmRequest.danger
              ? "var(--ls-error-color, #ef4444)"
              : "var(--ls-secondary-border-color, #6b7280)",
          }}
        >
          <div className="text-sm font-medium">{confirmRequest.title}</div>
          {confirmRequest.description ? (
            <div
              className="break-words text-xs"
              style={{ color: "var(--ls-secondary-text-color, #9ca3af)" }}
            >
              {confirmRequest.description}
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              className="rounded border px-2 py-1 text-xs hover:opacity-90"
              style={{
                borderColor: "var(--ls-secondary-border-color, #6b7280)",
                color: "var(--ls-primary-text-color, #e5e7eb)",
              }}
              onClick={() => {
                resolveConfirm(false);
                focusFormField(fieldRef.current);
              }}
            >
              {confirmRequest.cancelLabel ?? CONFIRM_CANCEL_LABEL}
            </button>
            <button
              type="button"
              autoFocus
              className="rounded px-2 py-1 text-xs text-white hover:opacity-90"
              style={{
                backgroundColor: "var(--ls-error-color, #ef4444)",
                color: "#ffffff",
              }}
              onClick={() => {
                resolveConfirm(true);
                focusFormField(fieldRef.current);
              }}
            >
              {confirmRequest.confirmLabel ?? CONFIRM_CONFIRM_LABEL}
            </button>
          </div>
        </div>
      ) : (
        <>
          {textAttachments.length > 0 ? (
            <div className="flex flex-wrap gap-1 px-0.5">
              {textAttachments.map((attachment) => (
                <span
                  key={attachment.id}
                  className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]"
                  style={{
                    borderColor: "var(--ls-secondary-border-color, #6b7280)",
                    color: "var(--ls-secondary-text-color, #9ca3af)",
                  }}
                >
                  {`inserted text, ${attachment.content.length.toLocaleString("en-US").replace(/,/g, " ")} chars`}
                  <button
                    type="button"
                    className="hover:opacity-80"
                    title="Remove inserted text"
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div
            className="ai-assistant-box flex items-end gap-1 rounded-md border p-1"
            style={{
              backgroundColor: "var(--ls-primary-background-color, transparent)",
              borderColor: "var(--ls-secondary-border-color, #6b7280)",
            }}
          >
            <div className="relative min-w-0 flex-1">
              <textarea
                ref={fieldRef}
                rows={1}
                value={draft}
                placeholder="Type a message…"
                className="max-h-[200px] w-full resize-none bg-transparent px-1 py-0.5 text-sm outline-none"
                style={{
                  color: "var(--ls-primary-text-color, currentColor)",
                }}
                onChange={(e) => {
                  setDraft(e.target.value);
                  // Refresh the skill list while typing a slash command
                  // (cached, so this is cheap on every keystroke).
                  if (e.target.value.startsWith("/")) void loadSkills();
                  autoResize();
                }}
                onScroll={(e) => {
                  if (ghostRef.current) {
                    ghostRef.current.scrollTop = e.currentTarget.scrollTop;
                  }
                }}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === "Tab" && slash && !slash.exact) {
                    e.preventDefault();
                    setDraft(`/${slash.name}`);
                    autoResize();
                    return;
                  }
                  if (e.key === "ArrowUp" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    navigateHistory(e, "up");
                    if (e.defaultPrevented) return;
                  }
                  if (e.key === "ArrowDown" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    navigateHistory(e, "down");
                    if (e.defaultPrevented) return;
                  }
                  if (
                    shouldSubmitOnEnter({
                      key: e.key,
                      shiftKey: e.shiftKey,
                      isComposing: e.nativeEvent.isComposing,
                      keyCode: e.nativeEvent.keyCode,
                    })
                  ) {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
              />
              {slash && !slash.exact && slash.complete ? (
                <div
                  ref={ghostRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap px-1 py-0.5 text-sm"
                  style={{
                    color: "var(--ls-secondary-text-color, #9ca3af)",
                    opacity: 0.75,
                  }}
                >
                  <span className="invisible">{draft}</span>
                  <span>{slash.complete}</span>
                </div>
              ) : null}
            </div>
            {sendPhase === "failed" && failedMessage && !pending ? (
              <button
                type="button"
                onClick={() => void handleRetry()}
                className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:opacity-90"
                style={{
                  backgroundColor: "var(--ls-secondary-background-color, transparent)",
                  color: "var(--ls-error-color, #ef4444)",
                }}
                title="Retry last message"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              disabled={!pending && !canSend}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleButtonClick}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full hover:opacity-90 disabled:opacity-50"
              style={sendButtonStyle}
              title={pending ? "Stop generation" : "Send (Enter)"}
            >
              {pending ? (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <rect x="6" y="6" width="12" height="12" rx="1.5" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m5 12 7-7 7 7" />
                  <path d="M12 19V5" />
                </svg>
              )}
            </button>
          </div>
        </>
      )}
      <div
        className="flex items-center justify-between gap-2 px-1"
        style={{ color: "var(--ls-secondary-text-color, #9ca3af)" }}
      >
        <span className="truncate text-[10px]">
          {sessionPage ?? `${SESSION_NAMESPACE}/…`}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {usage ? (
            <span className="text-[10px]" title="Estimated tokens">
              ≈{formatTokenCount(usage.contextTokens)} ctx ·{" "}
              {formatTokenCount(usage.outputTokens)} out
            </span>
          ) : null}
          <select
            className="ai-assistant-model-select max-w-[160px] bg-transparent text-[10px] outline-none"
            style={{ color: "var(--ls-secondary-text-color, #9ca3af)" }}
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            title="Model for this session"
          >
            {(models.length > 0
              ? models
              : selectedModel
                ? [selectedModel]
                : ["—"]
            ).map((modelName) => (
              <option key={modelName} value={modelName}>
                {modelName}
              </option>
            ))}
          </select>
        </span>
      </div>
    </form>
  );
}

export default App;
