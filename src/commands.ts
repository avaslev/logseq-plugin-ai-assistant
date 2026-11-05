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
    description: "Delete the active session page",
  },
];

export interface SlashMatch {
  name: string;
  complete: string;
  exact: boolean;
}

export function matchSlashCommand(draft: string): SlashMatch | null {
  const trimmed = draft.trim();
  if (!trimmed.startsWith("/")) return null;
  const token = trimmed.slice(1).toLowerCase();
  if (/\s/.test(token)) return null;
  const first = SLASH_COMMANDS[0];
  if (!token) {
    return { name: first.name, complete: first.name, exact: false };
  }
  const found = SLASH_COMMANDS.find((cmd) => cmd.name.startsWith(token));
  if (!found) return null;
  return {
    name: found.name,
    complete: found.name.slice(token.length),
    exact: token === found.name,
  };
}
