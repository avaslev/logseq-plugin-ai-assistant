import type { ToolSpec } from "./llm";
import { fetchWithTimeout, readResponseText } from "./http";

// F21: web search over DuckDuckGo Lite — no API key, read-only, the graph
// is never touched. Kept separate from graph tools (logseqTools.ts).

const SEARCH_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const SEARCH_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESULTS = 8;
const MAX_HTML_CHARS = 400_000;
const PAGE_TEXT_LIMIT = 8_000;
const MAX_WEB_OUTPUT = 4_000;
const RETRY_DELAY_MS = 800;
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export const WEB_TOOL_NAMES = ["web_search", "fetch_page"] as const;

export function isWebTool(name: string): boolean {
  return (WEB_TOOL_NAMES as readonly string[]).includes(name);
}

export function getWebToolSpecs(): ToolSpec[] {
  return [
    {
      type: "function",
      function: {
        name: "web_search",
        description:
          "Search the web via DuckDuckGo for up-to-date information beyond the user's graph: fresh documentation, bug reports, news, releases. Returns a list of {title, url, snippet}. Use 3-6 short keywords, not full sentences.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query keywords",
            },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fetch_page",
        description:
          "Download a web page and return its readable text (scripts, styles and markup stripped, ~8000 chars max). Use it to read a page found by web_search when the snippet is not enough.",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "Page URL (http/https)",
            },
          },
          required: ["url"],
        },
      },
    },
  ];
}

function truncate(data: unknown): string {
  return JSON.stringify(data).slice(0, MAX_WEB_OUTPUT);
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  signal?.throwIfAborted();
}

function isTransientStatus(status: number): boolean {
  return status >= 500;
}

// Runs the request twice: transient network failures, timeouts and 5xx are
// retried once after a short pause, like LLM requests. HTTP errors carry
// their status so 4xx responses fail fast without a retry.
async function requestText(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  let lastError: unknown = new Error("request failed");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await delay(RETRY_DELAY_MS, signal);
    try {
      const res = await fetchWithTimeout(
        url,
        { headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en,*" } },
        { signal, timeoutMs }
      );
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        const err = Object.assign(new Error(`HTTP ${res.status}`), {
          status: res.status,
        });
        if (isTransientStatus(res.status) && attempt === 0) {
          lastError = err;
          continue;
        }
        throw err;
      }
      return (await readResponseText(res, timeoutMs)).slice(0, MAX_HTML_CHARS);
    } catch (err) {
      signal?.throwIfAborted();
      // Errors without a status are network failures or timeouts.
      if ((err as { status?: number }).status !== undefined || attempt === 1) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;?/gi, " ")
    .replace(/&quot;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&");
}

function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// lite.duckduckgo.com renders results as a table: one row with a
// result-link anchor, the next row with a result-snippet cell.
export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function extractAttr(attrs: string, name: string): string {
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return match?.[2] ?? match?.[3] ?? "";
}

function extractDdgLinks(html: string): Array<{ href: string; text: string }> {
  const links: Array<{ href: string; text: string }> = [];
  const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchor.exec(html))) {
    if (!/result-link/.test(match[1])) continue;
    links.push({ href: extractAttr(match[1], "href"), text: match[2] });
  }
  return links;
}

function extractDdgSnippets(html: string): string[] {
  const snippets: string[] = [];
  const cell = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  let match: RegExpExecArray | null;
  while ((match = cell.exec(html))) {
    if (!/result-snippet/.test(match[1])) continue;
    snippets.push(htmlToText(match[2]));
  }
  return snippets;
}

// Lite results are direct URLs, but redirects of the form
// //duckduckgo.com/l/?uddg=<encoded>&rut=... also occur — unwrap them.
export function resolveResultUrl(href: string): string {
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      return decodeURIComponent(uddg[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

export function parseSearchResults(html: string): WebSearchResult[] {
  const links = extractDdgLinks(html);
  const snippets = extractDdgSnippets(html);
  const results: WebSearchResult[] = [];
  for (let i = 0; i < links.length && results.length < MAX_RESULTS; i += 1) {
    const url = resolveResultUrl(links[i].href);
    if (!/^https?:\/\//i.test(url)) continue;
    results.push({
      title: htmlToText(links[i].text),
      url,
      snippet: snippets[i] ?? "",
    });
  }
  return results;
}

export async function searchWeb(
  query: string,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  const url = `${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`;
  const html = await requestText(url, SEARCH_TIMEOUT_MS, signal);
  return parseSearchResults(html);
}

export function stripPageHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, " ")
    // Block boundaries become newlines, absorbing adjacent whitespace so a
    // literal "\n" next to a tag does not double the break.
    .replace(
      /\s*(<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|blockquote|pre)>)\s*/gi,
      "\n"
    )
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,;:!?])/g, "$1")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchPageText(
  url: string,
  signal?: AbortSignal
): Promise<string> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) URLs are supported");
  }
  const html = await requestText(url, FETCH_TIMEOUT_MS, signal);
  const text = decodeEntities(stripPageHtml(html)).slice(0, PAGE_TEXT_LIMIT);
  return text || "No readable text found on the page";
}

export async function executeWebTool(
  name: string,
  argsJson: string,
  signal?: AbortSignal
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argsJson || "{}");
  } catch {
    return "Invalid JSON arguments";
  }
  try {
    switch (name) {
      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return "query is required";
        return truncate(await searchWeb(query, signal));
      }
      case "fetch_page": {
        const url = String(args.url ?? "").trim();
        if (!url) return "url is required";
        return await fetchPageText(url, signal);
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    signal?.throwIfAborted();
    return `Web tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
