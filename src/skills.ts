import "@logseq/libs";
import { buildDefaultSystemPromptBody, sanitizeSessionSlug } from "./format";

// Skills and the user-editable system prompt live in the graph (F18):
// - ai_assistant/system          — optional system prompt override
// - ai_assistant/skills/<name>   — one skill per page

export const SYSTEM_PROMPT_PAGE = "ai_assistant/system";
export const SKILLS_NAMESPACE = "ai_assistant/skills";

const PROMPT_CACHE_TTL_MS = 10_000;

export interface Skill {
  name: string;
  description: string;
  content: string;
  page: string;
}

export function parseSkillMeta(content: string): {
  name: string | null;
  description: string | null;
} {
  const name = /^[ \t]*name::[ \t]*(.+)$/im.exec(content)?.[1]?.trim() ?? null;
  const description =
    /^[ \t]*description::[ \t]*(.+)$/im.exec(content)?.[1]?.trim() ?? null;
  return { name: name || null, description: description || null };
}

export function buildSkillPrompt(skill: Skill): string {
  const header = `Skill: ${skill.name}`;
  const description = skill.description
    ? `(${skill.description})`
    : "";
  return [
    "The user invoked a skill. Follow its instructions for this request:",
    header,
    description,
    "",
    skill.content,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// Compact catalog for the system prompt: names and one-line descriptions
// only, so the model can decide whether to load a skill via use_skill.
export function buildSkillsCatalog(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((skill) => {
    const description = skill.description.replace(/\s+/g, " ").trim();
    return `- ${skill.name}${description ? ` — ${description}` : ""}`;
  });
  return [
    "Available skills (the user can also invoke them explicitly as /name):",
    ...lines,
    "When the request clearly matches a skill, call the use_skill tool with its exact name to load the full instructions before answering; do not call it for unrelated requests.",
  ].join("\n");
}

function treeToText(nodes: unknown): string {
  const list = Array.isArray(nodes) ? nodes : [];
  return list
    .map((node) => String((node as { content?: unknown })?.content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
}

let promptCache: { at: number; text: string | null } | null = null;

export function resetPromptCache(): void {
  promptCache = null;
}

// Materializes the system prompt into the graph on startup (F18): if the
// ai_assistant/system page is missing, it is created with the built-in
// prompt as its content; from then on the page is user-managed and always
// wins over the built-in default. Deleting the page restores the default
// on the next plugin launch.
export async function ensureSystemPromptPage(
  enableWriteTools = false
): Promise<void> {
  try {
    const page = await logseq.Editor.getPage(SYSTEM_PROMPT_PAGE);
    if (page?.uuid) return;
    await logseq.Editor.createPage(
      SYSTEM_PROMPT_PAGE,
      {},
      { redirect: false, createFirstBlock: false }
    );
    await logseq.Editor.appendBlockInPage(
      SYSTEM_PROMPT_PAGE,
      buildDefaultSystemPromptBody(enableWriteTools)
    );
    resetPromptCache();
    console.info(
      `[ai-assistant] system prompt page seeded: ${SYSTEM_PROMPT_PAGE}`
    );
  } catch (err) {
    console.warn(
      "[ai-assistant] failed to create the system prompt page:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function readSystemPromptOverride(): Promise<string | null> {
  if (promptCache && Date.now() - promptCache.at < PROMPT_CACHE_TTL_MS) {
    return promptCache.text;
  }
  let text: string | null = null;
  try {
    const page = await logseq.Editor.getPage(SYSTEM_PROMPT_PAGE);
    if (page?.uuid) {
      const tree = await logseq.Editor.getPageBlocksTree(page.uuid);
      const joined = treeToText(tree);
      if (joined) text = joined;
    }
  } catch {
    text = null;
  }
  promptCache = { at: Date.now(), text };
  return text;
}

async function readSkillPage(pageName: string): Promise<Skill | null> {
  let page: { uuid?: string } | null = null;
  try {
    page = (await logseq.Editor.getPage(pageName)) as { uuid?: string } | null;
  } catch {
    return null;
  }
  if (!page?.uuid) return null;
  let tree: Array<{ content?: unknown }> = [];
  try {
    tree =
      ((await logseq.Editor.getPageBlocksTree(
        page.uuid
      )) as Array<{ content?: unknown }>) ?? [];
  } catch {
    return null;
  }
  const blocks = tree
    .map((node) => String(node?.content ?? "").trim())
    .filter(Boolean);
  if (blocks.length === 0) return null;

  const first = blocks[0];
  const isMeta = /^\s*AI Skill\s*(?:\n|$)/i.test(first) && /name::/.test(first);
  const metaSource = isMeta ? first : "";
  const meta = parseSkillMeta(metaSource || first);
  const slug = pageName.slice(SKILLS_NAMESPACE.length + 1);
  const body = (isMeta ? blocks.slice(1) : blocks).join("\n\n");

  return {
    name: meta.name || slug,
    description: meta.description || "",
    content: body || metaSource,
    page: pageName,
  };
}

const SKILLS_CACHE_TTL_MS = 3000;

let skillsCache: { at: number; skills: Skill[] } | null = null;

export function resetSkillsCache(): void {
  skillsCache = null;
}

export async function listSkills(force = false): Promise<Skill[]> {
  if (!force && skillsCache && Date.now() - skillsCache.at < SKILLS_CACHE_TTL_MS) {
    return skillsCache.skills;
  }
  let pages: Array<{ name?: unknown }> = [];
  try {
    const all = await logseq.Editor.getAllPages();
    pages = Array.isArray(all) ? (all as Array<{ name?: unknown }>) : [];
  } catch {
    return skillsCache?.skills ?? [];
  }
  const names = pages
    .map((page) => String(page?.name ?? ""))
    .filter((name) =>
      name.toLowerCase().startsWith(`${SKILLS_NAMESPACE.toLowerCase()}/`)
    );
  const skills: Skill[] = [];
  for (const name of names) {
    const skill = await readSkillPage(name);
    if (skill && skill.content) skills.push(skill);
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  skillsCache = { at: Date.now(), skills };
  console.info(`[ai-assistant] loaded ${skills.length} skill(s)`);
  return skills;
}

export async function findSkill(name: string): Promise<Skill | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const direct = await readSkillPage(`${SKILLS_NAMESPACE}/${name.trim()}`);
  if (direct) return direct;
  const skills = await listSkills();
  return (
    skills.find((skill) => skill.name.toLowerCase() === wanted) ??
    skills.find((skill) =>
      skill.page.slice(SKILLS_NAMESPACE.length + 1).toLowerCase() === wanted
    ) ??
    null
  );
}

const SKILL_TEMPLATE_BODY =
  "Describe here what the skill should do: when it applies, steps to perform, and the expected result format.";

export async function createSkillPage(
  title: string
): Promise<{ page: string }> {
  const slug =
    sanitizeSessionSlug(title) || `skill-${formatTimeCompact(new Date())}`;
  const base = `${SKILLS_NAMESPACE}/${slug}`;
  let name = base;
  let counter = 2;
  while (await logseq.Editor.getPage(name)) {
    name = `${base} (${counter++})`;
  }
  await logseq.Editor.createPage(
    name,
    {},
    { redirect: false, createFirstBlock: false }
  );
  await logseq.Editor.appendBlockInPage(
    name,
    `AI Skill\nname:: ${title.trim() || slug}\ndescription:: `
  );
  await logseq.Editor.appendBlockInPage(name, SKILL_TEMPLATE_BODY);
  resetSkillsCache();
  return { page: name };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatTimeCompact(date: Date): string {
  return `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(
    date.getSeconds()
  )}`;
}
