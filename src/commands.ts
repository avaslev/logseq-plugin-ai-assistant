import type { Skill } from "./skills";

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "compress",
    description: "Compress the active session into one summary block",
  },
  {
    name: "remove",
    description: "Delete the active session page (asks for confirmation)",
  },
  {
    name: "skill",
    description: "Create a new skill page and open it for editing",
  },
];

export interface SlashMatch {
  name: string;
  complete: string;
  exact: boolean;
  // True when the match comes from the dynamic list (skills), not SLASH_COMMANDS.
  extra?: boolean;
}

export function listSlashCommands(extra?: SlashCommand[]): SlashCommand[] {
  return extra && extra.length > 0 ? [...SLASH_COMMANDS, ...extra] : SLASH_COMMANDS;
}

export function skillToCommand(skill: Skill): SlashCommand {
  return {
    name: skill.name,
    description: skill.description || `Skill ${skill.page}`,
  };
}

export function matchSlashCommand(
  draft: string,
  extra?: SlashCommand[]
): SlashMatch | null {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/")) return null;
  const token = trimmed.slice(1).toLowerCase();
  const commands = listSlashCommands(extra);
  const first = commands[0];
  if (!token) {
    return { name: first.name, complete: first.name, exact: false };
  }
  // Tokens may include the request after the command name (skills take
  // arguments), so "prefix of the name" and "name + space + args" both
  // count as matches — the latter only for skills, built-in commands
  // stay strict.
  const found = commands.find((cmd) => {
    const name = cmd.name.toLowerCase();
    const isBuiltin = SLASH_COMMANDS.some((c) => c.name === cmd.name);
    return (
      name.startsWith(token) || (!isBuiltin && token.startsWith(`${name} `))
    );
  });
  if (!found) return null;
  const name = found.name.toLowerCase();
  const isExact = token === name || token.startsWith(`${name} `);
  const isExtra = !SLASH_COMMANDS.some((cmd) => cmd.name === found.name);
  return {
    name: found.name,
    complete: isExact ? "" : found.name.slice(token.length),
    exact: isExact,
    extra: isExtra ? true : undefined,
  };
}
