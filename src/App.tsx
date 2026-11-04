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
} from "./chat";
import { pickModel } from "./llm";
import {
  getAvailableModels,
  getDefaultModel,
  onAvailableModels,
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

function syncThemeVars(doc: Document) {
  const styles = getComputedStyle(doc.documentElement);
  const root = document.documentElement;
  for (const name of THEME_VARS) {
    const value = styles.getPropertyValue(name).trim();
    if (value) root.style.setProperty(name, value);
  }
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
    };
  }, []);

  return rect;
}

function App() {
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const geometryRef = useRef<Geometry | null>(null);
  const [pending, setPending] = useState(false);
  const [hasInput, setHasInput] = useState(false);
  const [sessionPage, setSessionPage] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>(getAvailableModels());
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    getDefaultModel()
  );

  useEffect(() => onAvailableModels(setModels), []);

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

  useEffect(() => {
    if (shown && !pending) fieldRef.current?.focus();
  }, [shown, pending]);

  if (!rect) return null;

  const handleSend = async () => {
    const field = fieldRef.current;
    const content = field?.value.trim();
    if (!content || pending) return;

    setPending(true);
    setHasInput(false);
    field!.value = "";
    await sendMessage(
      content,
      selectedModel || getDefaultModel()
    );
    setPending(false);
    autoResize();
    field?.focus();
  };

  const canSend = !pending && hasInput;

  const sendButtonStyle = pending
    ? {
        backgroundColor: "var(--ls-primary-accent-color)",
        color: "var(--ls-primary-accent-text-color)",
      }
    : canSend
      ? {
          backgroundColor: "var(--ls-primary-accent-color)",
          color: "var(--ls-primary-accent-text-color)",
        }
      : {
          backgroundColor: "var(--ls-secondary-background-color)",
          color: "var(--ls-secondary-text-color)",
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
        backgroundColor: "var(--ls-secondary-background-color)",
        borderTopColor: "var(--ls-border-color)",
        color: "var(--ls-primary-text-color)",
      }}
      onSubmit={(e) => {
        e.preventDefault();
        handleSend();
      }}
    >
      <div
        className="ai-assistant-box flex items-end gap-1 rounded-md border p-1"
        style={{
          backgroundColor: "var(--ls-primary-background-color)",
          borderColor: "var(--ls-secondary-border-color)",
        }}
      >
        <textarea
          ref={fieldRef}
          rows={1}
          placeholder="Type a message…"
          className="max-h-[200px] min-w-0 flex-1 resize-none bg-transparent px-1 py-0.5 text-sm outline-none"
          style={{
            color: "var(--ls-primary-text-color)",
          }}
          onInput={(e) => {
            setHasInput(!!e.currentTarget.value.trim());
            autoResize();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button
          type="button"
          disabled={!pending && !hasInput}
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
        style={{ color: "var(--ls-secondary-text-color)" }}
      >
        <span className="truncate text-[10px]">
          {sessionPage ?? `${SESSION_NAMESPACE}/…`}
        </span>
        <select
          className="max-w-[160px] shrink-0 bg-transparent text-[10px] outline-none"
          style={{ color: "var(--ls-secondary-text-color)" }}
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
