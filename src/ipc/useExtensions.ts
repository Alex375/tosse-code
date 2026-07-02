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
import type {
  ExtensionsSnapshot,
  MarketplaceInfo,
  McpServerLive,
  PluginContents,
  Result,
} from "./client";

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

// ---- Plugin updates (marketplaces + auto-update + on-demand update) -----------
//
// Marketplaces are USER-GLOBAL (not repo-scoped), so their list caches under a single
// key. Auto-update is a PER-MARKETPLACE flag (the only granularity Claude Code exposes)
// with a global master that flips them all. "Update now" is per-plugin: it shells out
// to `claude plugin update`, then hot-applies to a live session via `reload_plugins`.

/** Query key for the user-global marketplace list (with per-marketplace auto-update). */
export const marketplacesKey = () => ["marketplaces"] as const;

/**
 * The marketplaces registered with Claude Code, each with its resolved auto-update
 * state. User-global; `path` only gates the fetch (disabled when the manager is
 * closed / no target). Refetches on window focus so a marketplace added / auto-update
 * changed from the CLI shows up.
 */
export function useMarketplaces(path: string | null) {
  return useQuery<MarketplaceInfo[]>({
    queryKey: marketplacesKey(),
    enabled: !!path,
    queryFn: () => unwrap(commands.listMarketplaces()),
    // 0 so the section refetches whenever it (re)mounts — i.e. on every manager open,
    // matching the "fresh picture on each open" contract the extensions snapshot has.
    // Our own toggles/refresh invalidate this key too; this only adds the on-open read.
    staleTime: 0,
  });
}

/**
 * Refresh marketplace(s) from upstream — the network "Vérifier les mises à jour"
 * action (`claude plugin marketplace update`, all when `name` is omitted). On success
 * it invalidates BOTH the extensions snapshot (so per-plugin `update_available`
 * recomputes against the fresh pins) and the marketplace list. Can take a few seconds.
 */
export function useCheckPluginUpdates(path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name?: string | null): Promise<null> =>
      unwrap(commands.refreshPluginMarketplaces(name ?? null)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: extensionsKey(path) });
      void qc.invalidateQueries({ queryKey: marketplacesKey() });
    },
  });
}

/**
 * Update ONE plugin to its marketplace's latest version (`claude plugin update`),
 * then — when a live session exists — hot-apply it with `reload_plugins` so a running
 * conversation picks it up without a restart. A failed hot-reload is non-fatal (the
 * update is already on disk and lands on the next spawn; a genuine reject still
 * surfaces in the thread as a control error), so it never fails the mutation. On
 * success the extensions snapshot is invalidated so the "update available" badge clears.
 */
export function useUpdatePlugin(path: string | null, handle: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { pluginId: string; scope: string | null }): Promise<null> => {
      // Pass the repo/conversation cwd so project/local-scoped updates resolve the
      // right project (the CLI selects it from the working directory).
      await unwrap(commands.updatePlugin(args.pluginId, args.scope, path ?? ""));
      if (handle) {
        // Best-effort hot-apply; a dead session ("unknown session") is harmless here.
        try {
          await unwrap(commands.reloadPlugins(handle));
        } catch {
          /* update already written to disk; it applies on the next session spawn */
        }
      }
      return null;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: extensionsKey(path) }),
  });
}

/**
 * Toggle one marketplace's auto-update (writes settings.json). Invalidates the
 * marketplace list so the switch reflects the new state.
 */
export function useSetMarketplaceAutoUpdate(_path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { name: string; enabled: boolean }): Promise<null> =>
      unwrap(commands.setMarketplaceAutoUpdate(args.name, args.enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: marketplacesKey() }),
  });
}

/**
 * The global master: turn auto-update on/off for EVERY marketplace at once. `path`
 * is unused by the command (user-global) but kept in the signature for symmetry.
 */
export function useSetAllMarketplacesAutoUpdate(_path: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean): Promise<null> =>
      unwrap(commands.setAllMarketplacesAutoUpdate(enabled)),
    onSuccess: () => qc.invalidateQueries({ queryKey: marketplacesKey() }),
  });
}

export type { ExtensionsSnapshot, MarketplaceInfo };
