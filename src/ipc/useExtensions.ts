// TanStack Query wrapper around the `list_extensions` IPC command. The configured
// extensions (MCP / plugins / skills / sub-agents) are a property of a directory
// (repo or worktree cwd), so the snapshot is cached per PATH and shared by every
// component asking for the same path — the per-conversation view and the per-repo
// modal dedupe to one request.
//
// This is the CONFIGURED picture (on-disk). The LIVE connection status comes from
// the running session's `SessionStatePayload.mcp_servers` and is merged in the UI
// (see features/extensions/mcpMerge).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { commands } from "./client";
import type { ExtensionsSnapshot, McpServerLive, PluginContents, Result } from "./client";

/** Throw on the Result.error branch so the query's error state is populated. */
async function unwrap<T>(p: Promise<Result<T, string>>): Promise<T> {
  const res = await p;
  if (res.status === "error") throw new Error(res.error);
  return res.data;
}

/** Query key for a path's extensions snapshot — shared so requests dedupe per path. */
export const extensionsKey = (path: string | null) => ["extensions", path] as const;

/**
 * The configured extensions visible to `path` (a repo root or a conversation's
 * cwd), across user / project / plugin scopes. Disabled when `path` is null.
 * Refetches on window focus so a plugin enabled / MCP server added from the CLI
 * (or our own toggles) shows up when the user returns, without watching the FS.
 */
export function useExtensions(path: string | null) {
  return useQuery({
    queryKey: extensionsKey(path),
    enabled: !!path,
    queryFn: () => unwrap(commands.listExtensions(path!)),
    // Config changes rarely; a few seconds of staleness avoids refetching on every
    // re-render of the panel.
    staleTime: 5_000,
  });
}

/**
 * Read a skill's `SKILL.md` / a sub-agent's `.md` (by absolute path) for the
 * markdown viewer. Reuses the editor's `read_file` (text, with binary/size guards).
 * Cached per path; disabled when `path` is null (viewer closed).
 */
export function useExtensionDoc(path: string | null) {
  return useQuery({
    queryKey: ["ext-doc", path] as const,
    enabled: !!path,
    queryFn: () => unwrap(commands.readFile(path!)),
    staleTime: 60_000,
  });
}

/**
 * Everything a single plugin provides (skills / sub-agents / MCP servers), for the
 * per-plugin explorer. Scanned regardless of the plugin's enabled state, so a
 * disabled plugin still opens. `path` roots the relevant install; disabled when
 * either `path` or `pluginId` is null (explorer closed). Cached per (path, plugin).
 */
export function usePluginContents(path: string | null, pluginId: string | null) {
  return useQuery<PluginContents>({
    queryKey: ["plugin-contents", path, pluginId] as const,
    enabled: !!path && !!pluginId,
    queryFn: () => unwrap(commands.listPluginContents(path!, pluginId!)),
    staleTime: 30_000,
  });
}

/** Query key for a session's live MCP status (keyed by the live session handle). */
export const mcpStatusKey = (handle: string | null) => ["mcp-status", handle] as const;

/**
 * The LIVE MCP server status of a running session (real connection state + tools
 * per server + scope), queried from the `claude` process via the `mcp_status`
 * control request. Disabled when `handle` is null (no live process). Light polling
 * while open so a server still connecting (claude.ai connectors take a few seconds)
 * settles from `pending`/`checking_status` to `connected` without a manual refresh.
 */
export function useMcpStatus(handle: string | null) {
  return useQuery<McpServerLive[]>({
    queryKey: mcpStatusKey(handle),
    enabled: !!handle,
    queryFn: () => unwrap(commands.mcpStatus(handle!)),
    staleTime: 2_000,
    refetchInterval: 4_000,
  });
}

/**
 * Live MCP actions for a running session (control channel). Each mutation, on
 * success, invalidates the session's `mcp_status` so the row reflects the new state
 * after the next poll. Disabled (no-op) when `handle` is null. These only exist in
 * the conversation lens — the project lens has no live process.
 */
export function useMcpActions(handle: string | null) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: mcpStatusKey(handle) });

  const toggle = useMutation({
    mutationFn: (a: { serverName: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.mcpToggle(handle!, a.serverName, a.enabled)),
    onSuccess: refresh,
  });
  const reconnect = useMutation({
    mutationFn: (serverName: string): Promise<null> =>
      unwrap(commands.mcpReconnect(handle!, serverName)),
    onSuccess: refresh,
  });
  const clearAuth = useMutation({
    mutationFn: (serverName: string): Promise<null> =>
      unwrap(commands.mcpClearAuth(handle!, serverName)),
    onSuccess: refresh,
  });
  // Authenticate: open the returned authUrl in the system browser. The CLI handles
  // the loopback callback itself in the common case; the 4s mcp_status poll then
  // settles the server from `needs-auth` to `connected` without a manual step.
  const authenticate = useMutation({
    mutationFn: async (serverName: string) => {
      const res = await unwrap(commands.mcpAuthenticate(handle!, serverName));
      if (res.error) throw new Error(res.error);
      if (res.auth_url) await openUrl(res.auth_url);
      // Non-loopback OAuth: the CLI can't complete the callback on its own and needs
      // the redirect URL pasted back (mcp_oauth_callback_url) — a flow not yet wired
      // here. Surface that instead of leaving the server silently stuck in needs-auth.
      if (res.requires_user_action) {
        throw new Error(
          "Termine l'authentification dans le navigateur. Ce serveur exige de recoller l'URL de redirection — un flux pas encore géré ici ; reconnecte le serveur une fois authentifié.",
        );
      }
      return res;
    },
    onSuccess: refresh,
  });

  return { toggle, reconnect, clearAuth, authenticate };
}

/**
 * Enable/disable a plugin (USER-GLOBAL — writes ~/.claude/settings.json). On
 * success it invalidates `path`'s snapshot so the panel reflects the new enabled
 * state and the skills/agents an enabled plugin now (un)contributes. The change
 * applies to a live session only on its next (re)start.
 */
export function useSetPluginEnabled(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { pluginId: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.setPluginEnabled(args.pluginId, args.enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: extensionsKey(path) }),
  });
}

export type { ExtensionsSnapshot };
