import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  executeWebTool,
  fetchPageText,
  getWebToolSpecs,
  isWebTool,
  parseSearchResults,
  resolveResultUrl,
  stripPageHtml,
} from "../src/webTools";

const fetchMock = vi.fn();

function htmlResponse(status: number, body: string): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: { cancel: vi.fn().mockResolvedValue(undefined) },
    text: async () => body,
  };
}

const liteHtml = `
<html><body><table>
<tr><td>1.</td><td>
  <a rel="nofollow" href="https://example.com/docs" class='result-link'>Example <b>Docs</b></a>
</td></tr>
<tr><td class="result-snippet">The official documentation &amp; guides.</td></tr>
<tr><td>2.</td><td>
  <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.other.org%2Fapi&amp;rut=abc" class="result-link">Other API</a>
</td></tr>
<tr><td class="result-snippet">Other API reference</td></tr>
</table></body></html>`;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web tool specs", () => {
  it("declares the read-only web tools", () => {
    const specs = getWebToolSpecs();
    expect(specs.map((s) => s.function.name)).toEqual([
      "web_search",
      "fetch_page",
    ]);
    expect(specs[0].function.parameters).toMatchObject({
      type: "object",
      required: ["query"],
    });
    expect(specs[1].function.parameters).toMatchObject({
      type: "object",
      required: ["url"],
    });
  });

  it("recognizes its own tool names", () => {
    expect(isWebTool("web_search")).toBe(true);
    expect(isWebTool("fetch_page")).toBe(true);
    expect(isWebTool("search_graph")).toBe(false);
  });
});

describe("parseSearchResults", () => {
  it("extracts titles, urls and snippets from the lite markup", () => {
    const results = parseSearchResults(liteHtml);
    expect(results).toEqual([
      {
        title: "Example Docs",
        url: "https://example.com/docs",
        snippet: "The official documentation & guides.",
      },
      {
        title: "Other API",
        url: "https://docs.other.org/api",
        snippet: "Other API reference",
      },
    ]);
  });

  it("unwraps duckduckgo redirect links", () => {
    expect(
      resolveResultUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.b%2Fc&rut=x")
    ).toBe("https://a.b/c");
    expect(resolveResultUrl("https://direct.example.com")).toBe(
      "https://direct.example.com"
    );
  });

  it("caps the results at 8", () => {
    const rows = Array.from(
      { length: 12 },
      (_, i) =>
        `<tr><td><a class="result-link" href="https://x.org/${i}">t${i}</a></td></tr>` +
        `<tr><td class="result-snippet">s${i}</td></tr>`
    ).join("");
    expect(parseSearchResults(`<table>${rows}</table>`)).toHaveLength(8);
  });

  it("keeps non-http hrefs out of the results", () => {
    const html = `<a class="result-link" href="javascript:alert(1)">bad</a>`;
    expect(parseSearchResults(html)).toEqual([]);
  });
});

describe("executeWebTool", () => {
  it("returns search results as JSON", async () => {
    fetchMock.mockResolvedValue(htmlResponse(200, liteHtml));
    const result = await executeWebTool(
      "web_search",
      '{"query":"logseq docs"}'
    );
    const parsed = JSON.parse(result) as Array<{ url: string }>;
    expect(parsed).toHaveLength(2);
    expect(parsed[0].url).toBe("https://example.com/docs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("lite.duckduckgo.com/lite/?q=");
    expect(init.headers["User-Agent"]).toBeTruthy();
  });

  it("retries once after a 5xx response", async () => {
    fetchMock
      .mockResolvedValueOnce(htmlResponse(503, "unavailable"))
      .mockResolvedValueOnce(htmlResponse(200, liteHtml));

    const result = await executeWebTool("web_search", '{"query":"x"}');

    expect(JSON.parse(result)).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with a tool error after the retry is exhausted", async () => {
    fetchMock.mockRejectedValue(new Error("connection reset"));

    const result = await executeWebTool("web_search", '{"query":"x"}');

    expect(result).toContain("Web tool error");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects 4xx without a retry", async () => {
    fetchMock.mockResolvedValue(htmlResponse(403, "forbidden"));

    const result = await executeWebTool("web_search", '{"query":"x"}');

    expect(result).toContain("Web tool error: HTTP 403");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates arguments", async () => {
    expect(await executeWebTool("web_search", "{broken")).toBe(
      "Invalid JSON arguments"
    );
    expect(await executeWebTool("web_search", "{}")).toBe(
      "query is required"
    );
    expect(await executeWebTool("fetch_page", "{}")).toBe("url is required");
    expect(await executeWebTool("web_delete", "{}")).toBe(
      "Unknown tool: web_delete"
    );
  });
});

describe("fetch_page", () => {
  it("strips scripts, styles and markup", async () => {
    fetchMock.mockResolvedValue(
      htmlResponse(
        200,
        `<html><head><style>p{color:red}</style></head><body>
          <h1>Title</h1><script>alert(1)</script>
          <p>First &amp; only <b>paragraph</b>.</p>
          <ul><li>one</li><li>two</li></ul>
        </body></html>`
      )
    );
    const text = await executeWebTool(
      "fetch_page",
      '{"url":"https://example.com/post"}'
    );
    expect(text).toContain("Title");
    expect(text).toContain("First & only paragraph.");
    expect(text).toContain("one\ntwo");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
  });

  it("truncates long pages to ~8000 chars", async () => {
    const long = `<p>${"word ".repeat(4000)}</p>`;
    fetchMock.mockResolvedValue(htmlResponse(200, long));
    const text = await fetchPageText("https://example.com/long");
    expect(text.length).toBeLessThanOrEqual(8000);
  });

  it("allows only http(s) urls", async () => {
    await expect(fetchPageText("file:///etc/passwd")).rejects.toThrow(
      /http\(s\)/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("stripPageHtml", () => {
  it("collapses whitespace and keeps line breaks", () => {
    const text = stripPageHtml(
      "<div>  a   b  </div>\n<div>c</div><p></p><p></p><p>d</p>"
    );
    expect(text).toBe("a b\nc\n\nd");
  });
});
