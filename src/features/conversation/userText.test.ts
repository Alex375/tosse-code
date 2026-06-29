import { describe, it, expect } from "vitest";
import { parseSlashCommand } from "./userText";

describe("parseSlashCommand", () => {
  it("extracts a bare command (with and without args)", () => {
    expect(
      parseSlashCommand(
        "<command-message>clear</command-message>\n<command-name>/clear</command-name>\n<command-args></command-args>",
      ),
    ).toEqual({ command: "/clear", args: "" });

    expect(
      parseSlashCommand(
        "<command-name>/pickup</command-name><command-args>abc-123</command-args>",
      ),
    ).toEqual({ command: "/pickup", args: "abc-123" });
  });

  it("prefixes a slash when the wrapped name lacks one", () => {
    expect(parseSlashCommand("<command-name>tosse-workflow:list-tasks</command-name>")).toEqual({
      command: "/tosse-workflow:list-tasks",
      args: "",
    });
  });

  it("returns null for a normal prompt", () => {
    expect(parseSlashCommand("just fix the login bug please")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });
});
