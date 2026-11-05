import { describe, expect, it } from "vitest";
import { matchSlashCommand, SLASH_COMMANDS } from "../src/commands";

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
});
