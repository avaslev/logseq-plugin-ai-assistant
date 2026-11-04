import "@logseq/libs";
import type { SettingSchemaDesc } from "@logseq/libs/dist/LSPlugin";
import { listModels } from "./llm";

const DEFAULTS = {
  apiBaseUrl: "http://localhost:1234/v1",
  apiKey: "",
  defaultModel: "",
  mcpServers: "[]",
};

export interface AppSettings {
  apiBaseUrl: string;
  apiKey: string;
  defaultModel: string;
  mcpServers: string;
}

let availableModels: string[] = [];
const modelsListeners = new Set<(models: string[]) => void>();

export function getSettings(): AppSettings {
  const raw = (logseq.settings ?? {}) as Record<string, unknown>;
  return {
    apiBaseUrl:
      typeof raw.apiBaseUrl === "string" && raw.apiBaseUrl.length > 0
        ? raw.apiBaseUrl
        : DEFAULTS.apiBaseUrl,
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    defaultModel: typeof raw.defaultModel === "string" ? raw.defaultModel : "",
    mcpServers:
      typeof raw.mcpServers === "string" ? raw.mcpServers : DEFAULTS.mcpServers,
  };
}

export function getAvailableModels(): string[] {
  return availableModels;
}

export function getDefaultModel(): string {
  const { defaultModel } = getSettings();
  if (defaultModel && availableModels.includes(defaultModel)) return defaultModel;
  return availableModels[0] ?? defaultModel;
}

export function onAvailableModels(cb: (models: string[]) => void): () => void {
  modelsListeners.add(cb);
  return () => modelsListeners.delete(cb);
}

function registerSchema(): void {
  const schemas: SettingSchemaDesc[] = [
    {
      key: "llm-heading",
      type: "heading",
      default: null,
      title: "LLM API (OpenAI-compatible)",
      description: "",
    },
    {
      key: "apiBaseUrl",
      type: "string",
      default: DEFAULTS.apiBaseUrl,
      title: "API base URL",
      description:
        "e.g. http://localhost:1234/v1 (LM Studio) or http://localhost:11434/v1 (Ollama)",
    },
    {
      key: "apiKey",
      type: "string",
      default: DEFAULTS.apiKey,
      title: "API token",
      description: "Bearer token; leave empty for local servers",
    },
    {
      key: "defaultModel",
      type: "enum",
      default: getSettings().defaultModel,
      title: "Default model",
      description:
        availableModels.length > 0
          ? "Loaded from the API"
          : "Fill in API base URL above, then reload the plugin to load models",
      enumChoices: availableModels.length > 0 ? availableModels : [""],
      enumPicker: "select",
    },
    {
      key: "mcp-heading",
      type: "heading",
      default: null,
      title: "MCP servers",
      description: "",
    },
    {
      key: "mcpServers",
      type: "string",
      inputAs: "textarea",
      default: DEFAULTS.mcpServers,
      title: "MCP servers (JSON)",
      description:
        '[{"name":"my-mcp","url":"http://localhost:8000/mcp","headers":{"Authorization":"Bearer x"}}]',
    },
  ];
  logseq.useSettingsSchema(schemas);
}

export async function refreshModels(): Promise<void> {
  const { apiBaseUrl, apiKey } = getSettings();
  if (!apiBaseUrl) return;
  try {
    availableModels = await listModels(apiBaseUrl, apiKey);
  } catch (err) {
    console.warn(
      "[ai-assistant] model list refresh failed:",
      err instanceof Error ? err.message : err
    );
    return;
  }
  const { defaultModel } = getSettings();
  if (availableModels.length > 0 && !availableModels.includes(defaultModel)) {
    try {
      logseq.updateSettings({ defaultModel: availableModels[0] });
    } catch {
      if (logseq.settings) logseq.settings.defaultModel = availableModels[0];
    }
  }
  registerSchema();
  modelsListeners.forEach((cb) => cb(availableModels));
}

export function initSettings(): void {
  registerSchema();
  void refreshModels();

  let prevBaseUrl = getSettings().apiBaseUrl;
  let prevApiKey = getSettings().apiKey;
  logseq.onSettingsChanged(() => {
    const settings = getSettings();
    if (
      settings.apiBaseUrl !== prevBaseUrl ||
      settings.apiKey !== prevApiKey
    ) {
      prevBaseUrl = settings.apiBaseUrl;
      prevApiKey = settings.apiKey;
      void refreshModels();
    }
  });
}
