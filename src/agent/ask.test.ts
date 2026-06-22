import { describe, it, expect } from "vitest";
import { classifyAsk, field } from "./ask";
import type { PermissionRequestPayload } from "../ipc/client";

function req(p: Partial<PermissionRequestPayload>): PermissionRequestPayload {
  return {
    request_id: "r1",
    tool_name: "Bash",
    tool_use_id: "t1",
    input: {},
    title: null,
    description: null,
    suggestions: null,
    ...p,
  };
}

describe("classifyAsk", () => {
  it("previews a Bash command", () => {
    const a = classifyAsk(req({ tool_name: "Bash", input: { command: "pnpm test" } }));
    expect(a).toEqual({
      kind: "permission",
      text: "Autoriser l'exécution de la commande ?",
      cmd: "pnpm test",
    });
  });

  it("names the edited file for an edit/write tool", () => {
    const a = classifyAsk(req({ tool_name: "Edit", input: { file_path: "src/x.ts" } }));
    expect(a.kind).toBe("permission");
    expect(a.text).toContain("src/x.ts");
    expect(a.cmd).toBeUndefined();
  });

  it("prefers the request description when present", () => {
    const a = classifyAsk(
      req({ tool_name: "Write", description: "Créer le fichier", input: { file_path: "a" } }),
    );
    expect(a.text).toBe("Créer le fichier");
  });

  it("falls back to the tool name when nothing else is known", () => {
    const a = classifyAsk(req({ tool_name: "WebFetch", input: {} }));
    expect(a.text).toBe("Autoriser WebFetch ?");
  });
});

describe("field", () => {
  it("reads a string field from an input object", () => {
    expect(field({ command: "ls" }, "command")).toBe("ls");
  });

  it("returns undefined for non-objects, arrays, missing keys, or non-strings", () => {
    expect(field(null, "x")).toBeUndefined();
    expect(field([1, 2], "0")).toBeUndefined();
    expect(field({ x: 3 }, "x")).toBeUndefined();
    expect(field({}, "x")).toBeUndefined();
  });
});
