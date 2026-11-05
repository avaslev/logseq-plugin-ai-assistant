import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelGeneration,
  sendMessage,
  getSessionModel,
  applyFallbackGeometry,
  applyFormGeometry,
  BAR_HEIGHT,
  SESSION_NAMESPACE,
  SIDEBAR_DEFAULT_WIDTH,
  detectOpenSessionPage,
  syncCurrentSession,
  isSessionPageFocused,
} from "./chat";
import { pickModel } from "./llm";
import { shouldSubmitOnEnter } from "./input";
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
  const geometryRef = useRef<Geometry | null>(null);
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState("");
  const [sessionPage, setSessionPage] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>(getAvailableModels());
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    getDefaultModel()
  );

  useEffect(() => onAvailableModels(setModels), []);

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

  const shown = rect !== null;
  const prevShownRef = useRef(false);

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

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || pending) return;

    setPending(true);
    setDraft("");
    try {
      await sendMessage(text, selectedModel || getDefaultModel());
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

  const canSend = !pending && !!draft.trim();

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
      <div
        className="ai-assistant-box flex items-end gap-1 rounded-md border p-1"
        style={{
          backgroundColor: "var(--ls-primary-background-color, transparent)",
          borderColor: "var(--ls-secondary-border-color, #6b7280)",
        }}
      >
        <textarea
          ref={fieldRef}
          rows={1}
          value={draft}
          placeholder="Type a message…"
          className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-sm outline-none"
          style={{
            color: "var(--ls-primary-text-color, currentColor)",
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            autoResize();
          }}
          onKeyDown={(e) => {
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
      <div
        className="flex items-center justify-between gap-2 px-1"
        style={{ color: "var(--ls-secondary-text-color, #9ca3af)" }}
      >
        <span className="truncate text-[10px]">
          {sessionPage ?? `${SESSION_NAMESPACE}/…`}
        </span>
        <select
          className="ai-assistant-model-select max-w-[160px] shrink-0 bg-transparent text-[10px] outline-none"
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
          ).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </div>
    </form>
  );
}

export default App;
