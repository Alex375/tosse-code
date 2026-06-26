import { describe, expect, it } from "vitest";
import { mcpStepLabel, parseMcpToolName, prettyMcpServer } from "./toolNames";

describe("parseMcpToolName", () => {
  it("splits a server with single underscores from its tool on the `__` delimiter", () => {
    expect(parseMcpToolName("mcp__claude_ai_TOSSE__create_task")).toEqual({
      server: "claude_ai_TOSSE",
      tool: "create_task",
    });
    expect(parseMcpToolName("mcp__playwright__browser_click")).toEqual({
      server: "playwright",
      tool: "browser_click",
    });
  });

  it("keeps a tool segment that itself contains `__`", () => {
    expect(parseMcpToolName("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" });
  });

  it("returns null for non-MCP names and malformed inputs", () => {
    expect(parseMcpToolName("Read")).toBeNull();
    expect(parseMcpToolName("Bash")).toBeNull();
    expect(parseMcpToolName("mcp__onlyserver")).toBeNull(); // no tool segment
    expect(parseMcpToolName("mcp__")).toBeNull();
    expect(parseMcpToolName("mcp____tool")).toBeNull(); // empty server
  });
});

describe("prettyMcpServer", () => {
  it("turns underscores into spaces", () => {
    expect(prettyMcpServer("claude_ai_TOSSE")).toBe("claude ai TOSSE");
    expect(prettyMcpServer("playwright")).toBe("playwright");
    expect(prettyMcpServer("claude_ai_Google_Drive")).toBe("claude ai Google Drive");
  });
});

describe("mcpStepLabel", () => {
  it("renders `<server> : <tool>` for an MCP tool", () => {
    expect(mcpStepLabel("mcp__claude_ai_TOSSE__create_task")).toBe("claude ai TOSSE : create_task");
    expect(mcpStepLabel("mcp__playwright__browser_click")).toBe("playwright : browser_click");
  });

  it("returns null for a non-MCP name", () => {
    expect(mcpStepLabel("Read")).toBeNull();
  });
});
