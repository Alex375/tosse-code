// Codex slash-command catalogue for a conversation's cwd, fetched from the installed
// binary (`skills/list` via the transient app-server IPC) and mapped to the SAME
// `SlashCommand` shape the composer's `/` menu already renders for Claude. So a Codex
// conversation gets its own `/` menu (verified: 11 skills in a plain cwd), with the
// existing insert/run behaviour — a `/name` in the turn text invokes the skill (verified
// live: it reasons + runs the skill's command).
import { useQuery } from "@tanstack/react-query";
import { commands } from "../../ipc/client";
import type { SlashCommand } from "../../ipc/client";

/**
 * The Codex skills for `cwd` as slash commands. `null` cwd (not a Codex conversation, or
 * unknown cwd) disables the fetch and yields an empty list. Cached per cwd.
 */
export function useCodexSkills(cwd: string | null): SlashCommand[] {
  const q = useQuery({
    queryKey: ["codexSkills", cwd],
    enabled: cwd != null,
    staleTime: 5 * 60 * 1000,
    retry: 1,
    queryFn: async () => {
      const res = await commands.codexListSkills(cwd ? [cwd] : []);
      if (res.status === "error") throw new Error(res.error);
      return res.data;
    },
  });
  return (q.data ?? []).map((s) => ({
    name: s.name,
    description: s.description || "",
    argument_hint: "",
  }));
}
