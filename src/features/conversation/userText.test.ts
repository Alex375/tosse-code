import { describe, it, expect } from "vitest";
import { parseSkillInvocation, parseSlashCommand } from "./userText";

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

describe("parseSkillInvocation", () => {
  it("drops a plugin namespace to the short command", () => {
    expect(parseSkillInvocation({ skill: "tosse-workflow:done" })).toEqual({
      command: "/done",
      qualified: "tosse-workflow:done",
      args: "",
    });
  });

  it("keeps a bare project skill as-is and carries args", () => {
    expect(parseSkillInvocation({ skill: "code-review", args: "20" })).toEqual({
      command: "/code-review",
      qualified: "code-review",
      args: "20",
    });
    expect(parseSkillInvocation({ skill: "start" })).toEqual({
      command: "/start",
      qualified: "start",
      args: "",
    });
  });

  it("returns null when there is no skill field", () => {
    expect(parseSkillInvocation({})).toBeNull();
    expect(parseSkillInvocation({ skill: "  " })).toBeNull();
    expect(parseSkillInvocation("not an object" as never)).toBeNull();
  });
});
