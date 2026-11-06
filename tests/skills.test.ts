import { beforeEach, describe, expect, it, vi } from "vitest";

const logseqMock = vi.hoisted(() => ({
  Editor: {
    getPage: vi.fn(),
    getPageBlocksTree: vi.fn(),
    getAllPages: vi.fn(),
    createPage: vi.fn(),
    appendBlockInPage: vi.fn(),
  },
}));

vi.mock("@logseq/libs", () => {
  (globalThis as { logseq?: unknown }).logseq = logseqMock;
  return { default: logseqMock, logseq: logseqMock };
});

import {
  buildSkillPrompt,
  buildSkillsCatalog,
  createSkillPage,
  ensureSystemPromptPage,
  findSkill,
  listSkills,
  parseSkillMeta,
  readSystemPromptOverride,
  resetPromptCache,
  resetSkillsCache,
  SKILLS_NAMESPACE,
  SYSTEM_PROMPT_PAGE,
} from "../src/skills";

beforeEach(() => {
  vi.clearAllMocks();
  resetPromptCache();
  resetSkillsCache();
});

describe("parseSkillMeta", () => {
  it("extracts name and description properties", () => {
    const meta = parseSkillMeta(
      "AI Skill\nname:: Explain Code\ndescription:: Explains snippets"
    );
    expect(meta).toEqual({
      name: "Explain Code",
      description: "Explains snippets",
    });
  });

  it("returns nulls when properties are missing", () => {
    expect(parseSkillMeta("plain block")).toEqual({
      name: null,
      description: null,
    });
    expect(parseSkillMeta("name::\ndescription:: ")).toEqual({
      name: null,
      description: null,
    });
  });
});

describe("buildSkillPrompt", () => {
  it("wraps the skill content with instructions", () => {
    const prompt = buildSkillPrompt({
      name: "Explain Code",
      description: "Explains snippets",
      content: "Step 1. Read the code.",
      page: "ai_assistant/skills/explain",
    });
    expect(prompt).toContain("invoked a skill");
    expect(prompt).toContain("Skill: Explain Code");
    expect(prompt).toContain("(Explains snippets)");
    expect(prompt).toContain("Step 1. Read the code.");
  });

  it("omits an empty description line", () => {
    const prompt = buildSkillPrompt({
      name: "S",
      description: "",
      content: "body",
      page: "p",
    });
    expect(prompt).not.toContain("()");
  });
});

describe("buildSkillsCatalog", () => {
  it("returns an empty string for no skills", () => {
    expect(buildSkillsCatalog([])).toBe("");
  });

  it("lists skills with one-line descriptions and the tool hint", () => {
    const text = buildSkillsCatalog([
      {
        name: "Explain Code",
        description: "Explains snippets\nof  code",
        content: "steps",
        page: "ai_assistant/skills/explain",
      },
      {
        name: "Translate",
        description: "",
        content: "steps",
        page: "ai_assistant/skills/translate",
      },
    ]);
    expect(text).toContain("Available skills");
    expect(text).toContain("- Explain Code — Explains snippets of code");
    expect(text).toContain("- Translate");
    expect(text).toContain("use_skill");
  });
});

describe("ensureSystemPromptPage", () => {
  it("creates the page with the built-in prompt when it is missing", async () => {
    logseqMock.Editor.getPage.mockResolvedValue(null);
    logseqMock.Editor.createPage.mockResolvedValue({ name: "x" });
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "b" });

    await ensureSystemPromptPage(false);

    expect(logseqMock.Editor.getPage).toHaveBeenCalledWith(SYSTEM_PROMPT_PAGE);
    expect(logseqMock.Editor.createPage).toHaveBeenCalledWith(
      SYSTEM_PROMPT_PAGE,
      {},
      { redirect: false, createFirstBlock: false }
    );
    const content = logseqMock.Editor.appendBlockInPage.mock.calls[0][1];
    expect(content).toContain("SINGLE Logseq block");
    expect(content).not.toContain("Today's date");
    expect(content).not.toContain("Page editing rules");
  });

  it("seeds the write-tools section when enabled", async () => {
    logseqMock.Editor.getPage.mockResolvedValue(null);
    logseqMock.Editor.createPage.mockResolvedValue({ name: "x" });
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "b" });

    await ensureSystemPromptPage(true);

    const content = logseqMock.Editor.appendBlockInPage.mock.calls[0][1];
    expect(content).toContain("Page editing rules");
  });

  it("leaves an existing page untouched", async () => {
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "exists" });

    await ensureSystemPromptPage(false);

    expect(logseqMock.Editor.createPage).not.toHaveBeenCalled();
    expect(logseqMock.Editor.appendBlockInPage).not.toHaveBeenCalled();
  });

  it("swallows editor failures", async () => {
    logseqMock.Editor.getPage.mockRejectedValue(new Error("blocked"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(ensureSystemPromptPage(false)).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});

describe("readSystemPromptOverride", () => {
  it("returns null when the page does not exist", async () => {
    logseqMock.Editor.getPage.mockResolvedValue(null);
    await expect(readSystemPromptOverride()).resolves.toBeNull();
  });

  it("joins page blocks into the override text", async () => {
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "page-uuid" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "Custom rule one" },
      { content: "Custom rule two" },
    ]);
    await expect(readSystemPromptOverride()).resolves.toBe(
      "Custom rule one\n\nCustom rule two"
    );
  });

  it("caches the result for repeated reads", async () => {
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "page-uuid" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "cached prompt" },
    ]);
    await readSystemPromptOverride();
    await readSystemPromptOverride();
    expect(logseqMock.Editor.getPage).toHaveBeenCalledTimes(1);
  });

  it("resetPromptCache forces a re-read", async () => {
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "page-uuid" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([{ content: "x" }]);
    await readSystemPromptOverride();
    resetPromptCache();
    await readSystemPromptOverride();
    expect(logseqMock.Editor.getPage).toHaveBeenCalledTimes(2);
  });

  it("survives editor errors", async () => {
    logseqMock.Editor.getPage.mockRejectedValue(new Error("blocked"));
    await expect(readSystemPromptOverride()).resolves.toBeNull();
  });
});

describe("listSkills", () => {
  it("reads skill pages from the skills namespace", async () => {
    logseqMock.Editor.getAllPages.mockResolvedValue([
      { name: "journals" },
      { name: `${SKILLS_NAMESPACE}/explain-code` },
      { name: `${SKILLS_NAMESPACE}/Review` },
    ]);
    logseqMock.Editor.getPage.mockImplementation(async (name: string) => ({
      uuid: `uuid-${name}`,
    }));
    logseqMock.Editor.getPageBlocksTree.mockImplementation(
      async (uuid: string) => {
        if (uuid.includes("explain-code")) {
          return [
            {
              content:
                "AI Skill\nname:: Explain Code\ndescription:: Explains code",
            },
            { content: "Read the snippet." },
          ];
        }
        return [{ content: "no meta, pure body" }];
      }
    );

    const skills = await listSkills();
    expect(skills).toHaveLength(2);
    expect(skills[0]).toMatchObject({
      name: "Explain Code",
      description: "Explains code",
      content: "Read the snippet.",
      page: `${SKILLS_NAMESPACE}/explain-code`,
    });
    expect(skills[1]).toMatchObject({
      name: "Review",
      content: "no meta, pure body",
    });
  });

  it("returns an empty list when getAllPages fails", async () => {
    logseqMock.Editor.getAllPages.mockRejectedValue(new Error("blocked"));
    await expect(listSkills()).resolves.toEqual([]);
  });

  it("serves repeated reads from the cache", async () => {
    logseqMock.Editor.getAllPages.mockResolvedValue([
      { name: `${SKILLS_NAMESPACE}/one` },
    ]);
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "u1" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "AI Skill\nname:: One" },
      { content: "body" },
    ]);

    const first = await listSkills();
    const second = await listSkills();
    expect(second).toEqual(first);
    expect(logseqMock.Editor.getAllPages).toHaveBeenCalledTimes(1);
  });

  it("re-reads after resetSkillsCache", async () => {
    logseqMock.Editor.getAllPages.mockResolvedValue([
      { name: `${SKILLS_NAMESPACE}/one` },
    ]);
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "u1" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "AI Skill\nname:: One" },
      { content: "body" },
    ]);
    await listSkills();
    resetSkillsCache();
    await listSkills();
    expect(logseqMock.Editor.getAllPages).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache with force=true", async () => {
    logseqMock.Editor.getAllPages.mockResolvedValue([
      { name: `${SKILLS_NAMESPACE}/one` },
    ]);
    logseqMock.Editor.getPage.mockResolvedValue({ uuid: "u1" });
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "AI Skill\nname:: One" },
      { content: "body" },
    ]);
    await listSkills();
    await listSkills(true);
    expect(logseqMock.Editor.getAllPages).toHaveBeenCalledTimes(2);
  });
});

describe("findSkill", () => {
  it("reads the direct page by name first", async () => {
    logseqMock.Editor.getPage.mockImplementation(async (name: string) => ({
      uuid: `uuid-${name}`,
    }));
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "AI Skill\nname:: My Skill" },
      { content: "body" },
    ]);
    const skill = await findSkill("my-skill");
    expect(skill?.page).toBe(`${SKILLS_NAMESPACE}/my-skill`);
    expect(logseqMock.Editor.getAllPages).not.toHaveBeenCalled();
  });

  it("falls back to matching by skill name", async () => {
    logseqMock.Editor.getPage.mockImplementation(async (name: string) =>
      name === `${SKILLS_NAMESPACE}/other` ? { uuid: "u-other" } : null
    );
    logseqMock.Editor.getAllPages.mockResolvedValue([
      { name: `${SKILLS_NAMESPACE}/other` },
    ]);
    logseqMock.Editor.getPageBlocksTree.mockResolvedValue([
      { content: "AI Skill\nname:: Find Me" },
      { content: "body" },
    ]);
    const skill = await findSkill("find me");
    expect(skill?.name).toBe("Find Me");
  });

  it("returns null for an empty name", async () => {
    await expect(findSkill("  ")).resolves.toBeNull();
  });
});

describe("createSkillPage", () => {
  it("creates the page with the meta block and template body", async () => {
    logseqMock.Editor.getPage.mockResolvedValue(null);
    logseqMock.Editor.createPage.mockResolvedValue({ name: "x" });
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "b" });

    const { page } = await createSkillPage("Explain Code");
    expect(page).toBe(`${SKILLS_NAMESPACE}/Explain Code`);
    expect(logseqMock.Editor.createPage).toHaveBeenCalledWith(
      page,
      {},
      { redirect: false, createFirstBlock: false }
    );
    const calls = logseqMock.Editor.appendBlockInPage.mock.calls;
    expect(calls[0][1]).toContain("AI Skill");
    expect(calls[0][1]).toContain("name:: Explain Code");
    expect(calls[1][1]).toContain("Describe here what the skill should do");
  });

  it("deduplicates the page name with a counter", async () => {
    logseqMock.Editor.getPage
      .mockResolvedValueOnce({ name: "taken" })
      .mockResolvedValue(null);
    logseqMock.Editor.createPage.mockResolvedValue({ name: "x" });
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "b" });

    const { page } = await createSkillPage("Review");
    expect(page).toBe(`${SKILLS_NAMESPACE}/Review (2)`);
  });

  it("falls back to a timestamped slug for an empty title", async () => {
    logseqMock.Editor.getPage.mockResolvedValue(null);
    logseqMock.Editor.createPage.mockResolvedValue({ name: "x" });
    logseqMock.Editor.appendBlockInPage.mockResolvedValue({ uuid: "b" });

    const { page } = await createSkillPage("");
    expect(page).toMatch(new RegExp(`^${SKILLS_NAMESPACE}/skill-\\d{6}$`));
  });
});
