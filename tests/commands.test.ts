import { describe, expect, it } from "vitest";
import {
  listSlashCommands,
  matchSlashCommand,
  skillToCommand,
  SLASH_COMMANDS,
  type SlashCommand,
} from "../src/commands";

describe("SLASH_COMMANDS", () => {
  it("declares the built-in commands", () => {
    const names = SLASH_COMMANDS.map((cmd) => cmd.name);
    expect(names).toEqual(["compress", "remove", "skill"]);
  });
});

describe("listSlashCommands", () => {
  it("appends extra (skill) commands after the built-ins", () => {
    const extra: SlashCommand[] = [{ name: "Explain Code", description: "d" }];
    const all = listSlashCommands(extra);
    expect(all.map((cmd) => cmd.name)).toEqual([
      "compress",
      "remove",
      "skill",
      "Explain Code",
    ]);
    expect(listSlashCommands()).toHaveLength(3);
  });
});

describe("skillToCommand", () => {
  it("maps a skill to a slash command entry", () => {
    const cmd = skillToCommand({
      name: "Explain Code",
      description: "Explains code",
      content: "body",
      page: "ai_assistant/skills/explain-code",
    });
    expect(cmd).toEqual({
      name: "Explain Code",
      description: "Explains code",
    });
    const fallback = skillToCommand({
      name: "x",
      description: "",
      content: "body",
      page: "ai_assistant/skills/x",
    });
    expect(fallback.description).toBe("Skill ai_assistant/skills/x");
  });
});

describe("matchSlashCommand", () => {
  it("completes a partial command", () => {
    expect(matchSlashCommand("/comp")).toEqual({
      name: "compress",
      complete: "ress",
      exact: false,
    });
    expect(matchSlashCommand("/rem")).toEqual({
      name: "remove",
      complete: "ove",
      exact: false,
    });
  });

  it("is case-insensitive and ignores surrounding spaces", () => {
    expect(matchSlashCommand("  /COMP ")).toEqual({
      name: "compress",
      complete: "ress",
      exact: false,
    });
  });

  it("marks exact matches and completes the bare slash", () => {
    expect(matchSlashCommand("/compress")).toEqual({
      name: "compress",
      complete: "",
      exact: true,
    });
    expect(matchSlashCommand("/remove")).toEqual({
      name: "remove",
      complete: "",
      exact: true,
    });
    expect(matchSlashCommand("/")).toEqual({
      name: SLASH_COMMANDS[0].name,
      complete: SLASH_COMMANDS[0].name,
      exact: false,
    });
  });

  it("returns null for non-commands", () => {
    expect(matchSlashCommand("hello")).toBeNull();
    expect(matchSlashCommand("/foo")).toBeNull();
    expect(matchSlashCommand("/compress extra")).toBeNull();
    expect(matchSlashCommand("")).toBeNull();
  });

  it("completes multi-word skill names", () => {
    const extra: SlashCommand[] = [{ name: "Explain Code", description: "d" }];
    expect(matchSlashCommand("/expl", extra)).toEqual({
      name: "Explain Code",
      complete: "ain Code",
      exact: false,
      extra: true,
    });
    expect(matchSlashCommand("/explain code", extra)).toEqual({
      name: "Explain Code",
      complete: "",
      exact: true,
      extra: true,
    });
  });

  it("matches a skill invocation with arguments after the name", () => {
    const extra: SlashCommand[] = [{ name: "Translate RU", description: "d" }];
    expect(matchSlashCommand("/Translate RU hello world", extra)).toEqual({
      name: "Translate RU",
      complete: "",
      exact: true,
      extra: true,
    });
    expect(matchSlashCommand("/translate ru ", extra)).toEqual({
      name: "Translate RU",
      complete: "",
      exact: true,
      extra: true,
    });
  });

  it("keeps built-in commands strict about trailing text", () => {
    expect(matchSlashCommand("/compress extra")).toBeNull();
    expect(matchSlashCommand("/remove x")).toBeNull();
  });

  it("does not leak the extra flag for built-in commands", () => {
    expect(matchSlashCommand("/compress")).toEqual({
      name: "compress",
      complete: "",
      exact: true,
    });
  });
});
