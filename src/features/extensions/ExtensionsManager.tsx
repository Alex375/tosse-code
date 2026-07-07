// Extensions manager: a global modal with TWO DISTINCT lenses, chosen by the
// entry point that opened it (extensionsUiStore.target.kind):
//
//  - "project" (sidebar repo button): what is INSTALLED / available for the repo,
//    by scope — the configured inventory (on-disk scan). Plugins are toggle-able.
//  - "conversation" (composer chip): THIS session's LIVE picture. MCP servers with
//    real connection status + tools (from the `mcp_status` control request), plus
//    the plugins/skills/sub-agents active.
//
// Section order (both lenses): MCP servers → skills (file-based, du dépôt) →
// sub-agents (file-based) → plugins. MCP servers are sorted into three ordered
// buckets — dépôt, plugin, connecteurs cloud — and within each bucket the
// connected/enabled ones come first (a sort that reads as sections).
//
// Interactions: an MCP row expands to reveal its tools; a file-based skill /
// sub-agent opens a clean markdown view of its SKILL.md / .md; a PLUGIN opens a
// 3-pane explorer (rail / list / detail) of its own skills / MCP / sub-agents,
// modelled on Claude.ai's Customize panel. See memory "extensions-two-distinct-views".
import { useEffect, useMemo, useRef, useState } from "react";
import { Ico } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";
import { commands } from "../../ipc/client";
import { refetchSlashCommands } from "../../store/commandsStore";
import {
  useCheckPluginUpdates,
  useExtensions,
  useExtensionDoc,
  useMarketplaces,
  useMcpActions,
  useMcpStatus,
  usePluginContents,
  useSetAllMarketplacesAutoUpdate,
  useSetMarketplaceAutoUpdate,
  useSetPluginEnabled,
  useUpdatePlugin,
} from "../../ipc/useExtensions";
import { useConversationsStore } from "../../store/conversationsStore";
import type { Conversation } from "../../store/conversationsStore";
import { StreamMarkdown } from "../conversation/StreamMarkdown";
import type {
  AgentInfo,
  ExtScope,
  McpServerInfo,
  McpServerLive,
  PluginInfo,
  SkillInfo,
} from "../../ipc/client";
import { useExtensionsUi } from "./extensionsUiStore";
import { distinctCwds, resolveReloadTargets } from "./pluginReload";
import {
  allMarketplacesAuto,
  cliScope,
  totalUpdates,
  updateBadgeLabel,
  updatesForMarketplace,
} from "./pluginUpdates";
import styles from "./ExtensionsManager.module.css";

const CONFIG_SCOPE_LABEL: Record<ExtScope, string> = {
  user: "Utilisateur",
  project: "Repo",
  local: "Local",
  plugin: "Plugin",
};

/** A skill / sub-agent doc to render in the standalone markdown viewer overlay. */
interface OpenDoc {
  name: string;
  source: string;
  path: string;
  description?: string | null;
}

/** Plugin NAME from a plugin id (`railway@claude-plugins-official` → `railway`). */
function pluginName(source: string): string {
  return source.split("@")[0] ?? source;
}

/**
 * Drop a leading YAML frontmatter block (`---` … `---`) from a SKILL.md / agent .md
 * before rendering its body. Without this, the closing `---` turns the `name:` /
 * `description:` lines above it into a setext heading — the garbled "table at the
 * top" the body would otherwise start with. The frontmatter fields are surfaced in
 * our own metadata strip instead (matching Claude.ai's Customize panel).
 */
function stripFrontmatter(text: string): string {
  if (!text.startsWith("---")) return text;
  // First line must be exactly `---` (allow trailing CR); find the closing `---`.
  const lines = text.split("\n");
  if (lines[0].trim() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return lines.slice(i + 1).join("\n").replace(/^\s+/, "");
    }
  }
  return text; // no closing fence — leave it untouched
}

/** Badge class for a configured (on-disk) scope. */
function configBadgeCls(scope: ExtScope): string {
  return styles["scope_" + scope] ?? "";
}

/** Badge label + class for a LIVE scope string (from `mcp_status`). */
function liveBadge(scope: string | null | undefined): { label: string; cls: string } {
  switch (scope) {
    case "claudeai":
      return { label: "Connecteur Claude", cls: styles.scope_connector };
    case "dynamic":
      return { label: "Plugin", cls: styles.scope_plugin };
    case "project":
      return { label: "Repo", cls: styles.scope_project };
    case "local":
      return { label: "Local", cls: "" };
    case "user":
      return { label: "Utilisateur", cls: "" };
    default:
      return { label: scope ?? "—", cls: "" };
  }
}

/** Clear status word + dot tone for a live MCP status. */
function statusInfo(status: string | null): { cls: string; label: string } {
  switch (status) {
    case "connected":
      return { cls: styles.sOk, label: "Connecté" };
    case "pending":
    case "checking_status":
      return { cls: styles.sPending, label: "Connexion…" };
    case "needs-auth":
      return { cls: styles.sWarn, label: "Authentification requise" };
    case "failed":
      return { cls: styles.sErr, label: "Échec" };
    case "disconnected":
      return { cls: styles.sOff, label: "Déconnecté" };
    case "disabled":
      return { cls: styles.sOff, label: "Désactivé" };
    default:
      return { cls: styles.sNone, label: status ?? "—" };
  }
}

/** Local (stdio) vs network (http/sse) connection, with a short detail. */
function connType(
  mcp: { transport: string | null; command: string | null; url: string | null },
): { kind: string; icon: string; detail: string } | null {
  if (mcp.url) {
    let host = mcp.url;
    try {
      host = new URL(mcp.url).host || mcp.url;
    } catch {
      /* keep the raw url */
    }
    return { kind: "Réseau", icon: "globe", detail: host };
  }
  if (mcp.command) return { kind: "Local", icon: "term", detail: mcp.command };
  if (mcp.transport) return { kind: mcp.transport, icon: "term", detail: "" };
  return null;
}

// ---- MCP buckets (the requested absolute sort) ---------------------------------

type McpBucket = "repo" | "user" | "plugin" | "connector";
// Plugin (`dynamic`) servers are intentionally NOT a live bucket — they're shown as
// "Fournis par des plugins" boxes instead (consistent with plugin skills/sub-agents),
// so they don't appear twice. Order: Dépôt → Utilisateur → Connecteurs cloud.
const BUCKET_ORDER: McpBucket[] = ["repo", "user", "connector"];
const BUCKET_LABEL: Record<McpBucket, string> = {
  repo: "Dépôt",
  user: "Utilisateur",
  plugin: "Plugin",
  connector: "Connecteurs cloud",
};

/** Live `mcp_status` scope → bucket. A `user`-scope server (global, e.g. a
 *  file-configured `playwright` in ~/.claude.json) is its OWN bucket — it is NOT
 *  repo-specific, so it must not read as "Dépôt". `dynamic` (plugin) servers map to
 *  "plugin" but that bucket isn't in BUCKET_ORDER → they're dropped from the live
 *  list and surfaced via the plugin boxes instead. */
function liveBucket(scope: string | null | undefined): McpBucket {
  if (scope === "claudeai") return "connector";
  if (scope === "dynamic") return "plugin";
  if (scope === "user") return "user";
  return "repo"; // project / local
}

interface McpGroup<T> {
  bucket: McpBucket;
  items: T[];
}

/** Connected/enabled first inside a bucket, then by name. */
function liveRank(status: string): number {
  return status === "connected" ? 0 : status === "needs-auth" ? 1 : status === "pending" || status === "checking_status" ? 2 : 3;
}

/** Partition servers into buckets, PRESERVING input order (the caller freezes the
 *  order at window-open via `useStableOrder`). No re-sort here — so toggling a server
 *  doesn't make it jump within its bucket. Empty buckets are dropped. */
function bucketizeLive(servers: McpServerLive[]): McpGroup<McpServerLive>[] {
  return BUCKET_ORDER.map((bucket) => ({
    bucket,
    items: servers.filter((m) => liveBucket(m.scope) === bucket),
  })).filter((g) => g.items.length > 0);
}

/**
 * Freeze a list's order at window-open, then keep it STABLE across re-renders so
 * toggling an item (enable/disable) doesn't reorder the list under the user's cursor.
 * The order is computed ONCE (by `rank`, lower first) the first time items arrive for
 * a given `resetToken`, then every later render arranges the current items by that
 * frozen position (unseen items go after, by key). Reopening the window (new token)
 * recomputes. Live state (enabled/status) keeps updating in place — only the ORDER
 * is frozen.
 */
function useStableOrder<T>(
  items: T[],
  key: (x: T) => string,
  rank: (x: T) => number,
  resetToken: string,
): T[] {
  const ref = useRef<{ token: string | null; keys: string[] }>({ token: null, keys: [] });
  if (ref.current.token !== resetToken) {
    ref.current = { token: resetToken, keys: [] }; // window (re)opened → refreeze
  }
  if (ref.current.keys.length === 0 && items.length > 0) {
    ref.current.keys = [...items]
      .sort((a, b) => rank(a) - rank(b) || key(a).localeCompare(key(b)))
      .map(key);
  }
  const order = ref.current.keys;
  const pos = (k: string) => {
    const i = order.indexOf(k);
    return i === -1 ? order.length : i; // items unseen at freeze-time go last
  };
  return [...items].sort((a, b) => pos(key(a)) - pos(key(b)) || key(a).localeCompare(key(b)));
}

interface Group<T> {
  key: string;
  label: string;
  isPlugin: boolean;
  items: T[];
}

/** Group file-based skills/sub-agents by their scope (Projet / Utilisateur). Plugin
 *  items are excluded upstream — they live in the per-plugin explorer instead. */
function groupBySource<T extends { source: string | null; scope: ExtScope }>(items: T[]): Group<T>[] {
  const map = new Map<string, Group<T>>();
  for (const it of items) {
    const key = it.source ?? `scope:${it.scope}`;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        label: it.source ? pluginName(it.source) : CONFIG_SCOPE_LABEL[it.scope],
        isPlugin: it.source != null,
        items: [],
      };
      map.set(key, g);
    }
    g.items.push(it);
  }
  return [...map.values()].sort((a, b) => {
    if (a.isPlugin !== b.isPlugin) return a.isPlugin ? 1 : -1; // file-based first
    return a.label.localeCompare(b.label);
  });
}

export function ExtensionsManager() {
  const target = useExtensionsUi((s) => s.target);
  const close = useExtensionsUi((s) => s.closeManager);
  const handle = useConversationsStore((s) =>
    target?.kind === "conversation" && target.session
      ? (s.conversations.find((c) => c.id === target.session)?.handle ?? null)
      : null,
  );
  const ext = useExtensions(target?.path ?? null);
  const live = useMcpStatus(handle);
  const setPluginEnabled = useSetPluginEnabled(target?.path ?? null);
  const [doc, setDoc] = useState<OpenDoc | null>(null);
  // The plugin explorer carries WHICH section to open at (a contribution box jumps
  // straight to skills / mcp / agents).
  const [pluginView, setPluginView] = useState<{ plugin: PluginInfo; section: ExplorerSectionKey } | null>(null);
  // The Marketplaces page (auto-update management), reached from the Plugins section.
  const [mktOpen, setMktOpen] = useState(false);
  const openPlugin = (p: PluginInfo, section: ExplorerSectionKey = "skills") =>
    setPluginView({ plugin: p, section });

  // ---- Live plugin-reload bar --------------------------------------------------
  // Toggling a plugin only writes settings.json (USER-GLOBAL). A RUNNING session
  // reads `enabledPlugins` at spawn, so the change would otherwise take effect only
  // on restart — and the `/` command menu never refreshes. So we collect the toggles
  // made while the manager is open and offer to hot-apply them to the repo's LIVE
  // conversations: `reload_plugins` re-scans the plugin ON the live session (its
  // skills included — VERIFIED live against the binary), and `refetchSlashCommands`
  // re-reads the disk so the `/` menu (dis)appears the plugin's commands. Grouped:
  // N toggles → one reload. The bar shows only when ≥1 live conversation exists.
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [reloading, setReloading] = useState(false);
  const allConvs = useConversationsStore((s) => s.conversations);
  const allRepos = useConversationsStore((s) => s.repos);
  const { liveConvs, currentConv } = useMemo(
    () => resolveReloadTargets(target, allConvs, allRepos),
    [target, allConvs, allRepos],
  );

  // The toggle's settings.json write is async (a mutation). Track those writes so a
  // reload can wait for them to land before the live sessions re-read disk — else a
  // fast click on the bar could race the toggle's own write.
  const pendingWrites = useRef<Promise<unknown>[]>([]);
  const onPluginToggle = (pluginId: string, enabled: boolean) => {
    pendingWrites.current.push(setPluginEnabled.mutateAsync({ pluginId, enabled }).catch(() => {}));
    setTouched((prev) => (prev.has(pluginId) ? prev : new Set(prev).add(pluginId)));
  };
  const applyReload = async (convs: Conversation[]) => {
    setReloading(true);
    try {
      // 1. Make sure every pending settings.json write has landed on disk.
      await Promise.allSettled(pendingWrites.current);
      pendingWrites.current = [];
      // 2. Couche 1 (capacité live): hot-reload plugins on each live session. Best-effort
      //    — a dead session ("unknown session") is harmless (reads it on its next spawn).
      await Promise.all(
        convs.map(async (c) => {
          if (!c.handle) return;
          try {
            await commands.reloadPlugins(c.handle);
          } catch {
            /* applies on next spawn */
          }
        }),
      );
      // 3. Couche 2 (menu `/`): refresh the catalogue once per DISTINCT effective cwd
      //    (worktree-aware) — several sessions can share a cwd.
      await Promise.all(distinctCwds(convs).map((cwd) => refetchSlashCommands(cwd)));
    } finally {
      setReloading(false);
      setTouched(new Set());
    }
  };

  // Force a fresh read every time the manager OPENS (target set / changed). Without
  // this, reopening within the query's staleTime shows the cached snapshot — the
  // user expects an up-to-date picture on each open. The live MCP status also polls
  // on its own every 4s while open; this covers the configured snapshot.
  const refetchExt = ext.refetch;
  const refetchLive = live.refetch;
  const openKey = target ? `${target.kind}:${target.path}:${target.session ?? ""}` : null;
  useEffect(() => {
    if (!openKey) return;
    void refetchExt();
    if (handle) void refetchLive();
    // A fresh open starts with no pending plugin toggles.
    setTouched(new Set());
    pendingWrites.current = [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  if (!target) return null;
  const isConversation = target.kind === "conversation";

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name={isConversation ? "chat" : "layers"} className="sm" />
          <span className={styles.title}>
            {isConversation ? "Extensions de la conversation" : "Extensions du dépôt"}
            <span className={styles.titleSub}>{target.title}</span>
          </span>
          <button
            className={styles.iconBtn}
            onClick={() => {
              // The conversation lens reads BOTH the live MCP status and the
              // configured snapshot (skills/agents/plugins) — refresh both, so a
              // failed `ext` query can be retried from here (not just `live`).
              void ext.refetch();
              if (isConversation) void live.refetch();
            }}
            disabled={isConversation ? live.isFetching || ext.isFetching : ext.isFetching}
            title="Rafraîchir"
            aria-label="Rafraîchir"
          >
            <Ico
              name="refresh"
              className={"sm" + ((isConversation ? live.isFetching : ext.isFetching) ? " " + styles.spin : "")}
            />
          </button>
          <button className={styles.iconBtn} onClick={close} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>

        {touched.size > 0 && liveConvs.length > 0 ? (
          <PluginReloadBar
            count={touched.size}
            liveCount={liveConvs.length}
            hasCurrent={currentConv != null}
            busy={reloading}
            onReloadCurrent={() => currentConv && void applyReload([currentConv])}
            onReloadAll={() => void applyReload(liveConvs)}
            onDismiss={() => setTouched(new Set())}
          />
        ) : null}

        {isConversation ? (
          <ConversationBody
            ext={ext}
            live={live}
            handle={handle}
            path={target.path}
            setPluginEnabled={setPluginEnabled}
            onPluginToggle={onPluginToggle}
            onOpenDoc={setDoc}
            onOpenPlugin={openPlugin}
            onOpenMarketplaces={() => setMktOpen(true)}
            resetToken={openKey ?? ""}
          />
        ) : (
          <ProjectBody
            ext={ext}
            path={target.path}
            setPluginEnabled={setPluginEnabled}
            onPluginToggle={onPluginToggle}
            onOpenDoc={setDoc}
            onOpenPlugin={openPlugin}
            onOpenMarketplaces={() => setMktOpen(true)}
          />
        )}
      </div>

      {pluginView ? (
        <PluginExplorer
          plugin={pluginView.plugin}
          initialSection={pluginView.section}
          repoPath={target.path}
          onClose={() => setPluginView(null)}
        />
      ) : null}
      {doc ? <DocViewer doc={doc} onClose={() => setDoc(null)} /> : null}
      {mktOpen ? (
        <MarketplacesPage
          path={target.path}
          plugins={ext.data?.plugins ?? []}
          onClose={() => setMktOpen(false)}
        />
      ) : null}
    </div>
  );
}

// ---- Project view: configured inventory by scope -------------------------------

function ProjectBody({
  ext,
  path,
  setPluginEnabled,
  onPluginToggle,
  onOpenDoc,
  onOpenPlugin,
  onOpenMarketplaces,
}: {
  ext: ReturnType<typeof useExtensions>;
  path: string;
  setPluginEnabled: ReturnType<typeof useSetPluginEnabled>;
  onPluginToggle: (pluginId: string, enabled: boolean) => void;
  onOpenDoc: (d: OpenDoc) => void;
  onOpenPlugin: (p: PluginInfo) => void;
  onOpenMarketplaces: () => void;
}) {
  // No live session in the project lens → updates apply on the next session spawn
  // (handle is null, so no reload_plugins hot-apply).
  const updatePlugin = useUpdatePlugin(path, null);
  const data = ext.data;
  // No active/inactive state here — that is only knowable inside a live conversation
  // (see the conversation lens). The project lens shows what is CONFIGURED, grouped
  // by scope so "what's on the repo" (Projet/Local) reads apart from user-global.
  // File-based / non-plugin only — plugin-provided MCP, skills and agents live in
  // the per-plugin explorer, so they are NOT duplicated at the top level (consistent
  // across all three categories).
  const mcp = (data?.mcp_servers ?? []).filter((m) => m.source == null);
  const plugins = data?.plugins ?? [];
  const skills = (data?.skills ?? []).filter((s) => s.source == null);
  const agents = (data?.agents ?? []).filter((a) => a.source == null);

  return (
    <div className={styles.body}>
      {ext.isLoading ? (
        <div className={styles.empty}>Chargement…</div>
      ) : ext.isError ? (
        <div className={styles.error}>{(ext.error as Error).message}</div>
      ) : (
        <>
          {setPluginEnabled.isError ? (
            <div className={styles.error}>{(setPluginEnabled.error as Error).message}</div>
          ) : null}
          <WarningBanner warnings={ext.data?.warnings ?? []} />
          <GroupedSection icon="term" title="Serveurs MCP configurés" groups={groupBySource(mcp)} render={(m) => (
            <McpConfigRow key={(m.source ?? "") + ":" + m.name + ":" + m.scope} mcp={m} />
          )} empty="Aucun serveur MCP configuré pour ce dépôt." />
          <GroupedSection icon="spark" title="Skills" groups={groupBySource(skills)} render={(s) => (
            <SkillRow key={s.path} skill={s} onOpen={() => onOpenDoc({ name: s.name, source: CONFIG_SCOPE_LABEL[s.scope], path: s.path, description: s.description })} />
          )} empty="Aucun skill de fichier." />
          {agents.length > 0 ? (
            <GroupedSection icon="grid" title="Sous-agents" groups={groupBySource(agents)} render={(a) => (
              <AgentRow key={a.path} agent={a} onOpen={() => onOpenDoc({ name: a.name, source: CONFIG_SCOPE_LABEL[a.scope], path: a.path, description: a.description })} />
            )} empty="" />
          ) : null}
          {updatePlugin.isError ? (
            <div className={styles.error}>{(updatePlugin.error as Error).message}</div>
          ) : null}
          <Section
            icon="layers"
            title="Plugins"
            count={plugins.length}
            empty="Aucun plugin pour ce dépôt."
            action={<MarketplacesButton updates={totalUpdates(plugins)} onOpen={onOpenMarketplaces} />}
          >
            {plugins.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                busy={setPluginEnabled.isPending}
                onToggle={(enabled) => onPluginToggle(p.id, enabled)}
                onOpen={() => onOpenPlugin(p)}
                onUpdate={() => updatePlugin.mutate({ pluginId: p.id, scope: cliScope(p.scope) })}
                updating={updatePlugin.isPending && updatePlugin.variables?.pluginId === p.id}
                anyUpdating={updatePlugin.isPending}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}

// ---- Conversation view: this session's live picture ---------------------------

function ConversationBody({
  ext,
  live,
  handle,
  path,
  setPluginEnabled,
  onPluginToggle,
  onOpenDoc,
  onOpenPlugin,
  onOpenMarketplaces,
  resetToken,
}: {
  ext: ReturnType<typeof useExtensions>;
  live: ReturnType<typeof useMcpStatus>;
  handle: string | null;
  path: string;
  setPluginEnabled: ReturnType<typeof useSetPluginEnabled>;
  onPluginToggle: (pluginId: string, enabled: boolean) => void;
  onOpenDoc: (d: OpenDoc) => void;
  onOpenPlugin: (p: PluginInfo, section?: ExplorerSectionKey) => void;
  onOpenMarketplaces: () => void;
  resetToken: string;
}) {
  const actions = useMcpActions(handle);
  // A live session lets an update hot-apply via reload_plugins (handle non-null);
  // otherwise it lands on the next spawn.
  const updatePlugin = useUpdatePlugin(path, handle);
  // Order FROZEN at window-open (enabled/connected first), then stable — toggling an
  // item must not make it jump under the cursor (see useStableOrder).
  const plugins = useStableOrder(
    ext.data?.plugins ?? [],
    (p) => p.id,
    (p) => (p.enabled ? 0 : 1),
    resetToken,
  );
  const allPlugins = ext.data?.plugins ?? [];
  // File-based only — plugin skills/agents are summarized as boxes below + live in
  // the per-plugin explorer (never mixed in as if they were normal rows).
  const skills = (ext.data?.skills ?? []).filter((s) => s.source == null);
  const agents = (ext.data?.agents ?? []).filter((a) => a.source == null);
  const orderedServers = useStableOrder(
    live.data ?? [],
    // Two servers can share a name across scopes (e.g. a `local` and a `project`
    // `playwright`, both folded into the "repo" bucket) — key by scope+name so they
    // don't collide in the freeze order nor as React keys below.
    (s) => `${s.scope ?? ""}:${s.name}`,
    (s) => liveRank(s.status),
    resetToken,
  );
  const mcpGroups = bucketizeLive(orderedServers);
  const mcpTotal = mcpGroups.reduce((n, g) => n + g.items.length, 0);
  // Enabled plugins that contribute skills / sub-agents / MCP → one summary box each.
  const skillContribs = allPlugins.filter((p) => p.enabled && p.skill_count > 0);
  const agentContribs = allPlugins.filter((p) => p.enabled && p.agent_count > 0);
  const mcpContribs = allPlugins.filter((p) => p.enabled && p.mcp_count > 0);
  const sum = (ps: PluginInfo[], pick: (p: PluginInfo) => number) => ps.reduce((n, p) => n + pick(p), 0);

  return (
    <div className={styles.body}>
      {actions.toggle.isError || actions.reconnect.isError || actions.authenticate.isError || actions.clearAuth.isError ? (
        <div className={styles.error}>
          {((actions.toggle.error || actions.reconnect.error || actions.authenticate.error || actions.clearAuth.error) as Error)?.message}
        </div>
      ) : null}
      {/* A failed plugin toggle (settings.json write) must be visible here too — the
          toggle is interactive in this lens, not only the project one. */}
      {setPluginEnabled.isError ? (
        <div className={styles.error}>{(setPluginEnabled.error as Error).message}</div>
      ) : null}
      {/* A failed config snapshot read must NOT read as "empty repo" — surface it,
          distinct from the sections' "Aucun …" placeholders. */}
      {ext.isError ? (
        <div className={styles.error}>
          Lecture de la configuration des extensions impossible : {(ext.error as Error).message}
        </div>
      ) : null}
      <WarningBanner warnings={ext.data?.warnings ?? []} />
      <div className={styles.section}>
        <div className={styles.sectionH}>
          <Ico name="globe" className="sm" />
          <span className={styles.sectionT}>Serveurs MCP</span>
          <span className={styles.sectionC}>{mcpTotal + sum(mcpContribs, (p) => p.mcp_count)}</span>
        </div>
        {handle == null ? (
          <div className={styles.sectionEmpty}>
            Démarre la conversation (envoie un message) pour voir l'état live des serveurs MCP.
          </div>
        ) : live.isLoading ? (
          <div className={styles.sectionEmpty}>Interrogation du process…</div>
        ) : live.isError ? (
          <div className={styles.error}>{(live.error as Error).message}</div>
        ) : mcpTotal === 0 && mcpContribs.length === 0 ? (
          <div className={styles.sectionEmpty}>Aucun serveur MCP dans cette session.</div>
        ) : (
          mcpGroups.map((g) => (
            <div key={g.bucket} className={styles.bucket}>
              <div className={styles.bucketH}>
                <span>{BUCKET_LABEL[g.bucket]}</span>
                <span className={styles.bucketC}>{g.items.length}</span>
              </div>
              <div className={styles.list}>
                {g.items.map((m) => (
                  <McpLiveRow key={`${m.scope ?? ""}:${m.name}`} mcp={m} actions={actions} />
                ))}
              </div>
            </div>
          ))
        )}
        {/* Plugin-provided MCP servers as one box each (consistent with plugin
            skills/sub-agents) — click opens the plugin explorer at its Connecteurs. */}
        {mcpContribs.length ? <PluginContribFooter plugins={mcpContribs} kind="mcp" onOpen={onOpenPlugin} /> : null}
      </div>
      <GroupedSection
        icon="spark"
        title="Skills"
        groups={groupBySource(skills)}
        render={(s) => (
          <SkillRow key={s.path} skill={s} onOpen={() => onOpenDoc({ name: s.name, source: CONFIG_SCOPE_LABEL[s.scope], path: s.path, description: s.description })} />
        )}
        empty="Aucun skill de fichier."
        extraCount={sum(skillContribs, (p) => p.skill_count)}
        footer={skillContribs.length ? <PluginContribFooter plugins={skillContribs} kind="skills" onOpen={onOpenPlugin} /> : null}
      />
      {agents.length > 0 || agentContribs.length > 0 ? (
        <GroupedSection
          icon="grid"
          title="Sous-agents"
          groups={groupBySource(agents)}
          render={(a) => (
            <AgentRow key={a.path} agent={a} onOpen={() => onOpenDoc({ name: a.name, source: CONFIG_SCOPE_LABEL[a.scope], path: a.path, description: a.description })} />
          )}
          empty=""
          extraCount={sum(agentContribs, (p) => p.agent_count)}
          footer={agentContribs.length ? <PluginContribFooter plugins={agentContribs} kind="agents" onOpen={onOpenPlugin} /> : null}
        />
      ) : null}
      {updatePlugin.isError ? (
        <div className={styles.error}>{(updatePlugin.error as Error).message}</div>
      ) : null}
      <Section
        icon="layers"
        title="Plugins"
        count={plugins.length}
        empty="Aucun plugin."
        action={<MarketplacesButton updates={totalUpdates(allPlugins)} onOpen={onOpenMarketplaces} />}
      >
        {plugins.map((p) => (
          <PluginRow
            key={p.id}
            plugin={p}
            busy={setPluginEnabled.isPending}
            onToggle={(enabled) => onPluginToggle(p.id, enabled)}
            onOpen={() => onOpenPlugin(p)}
            onUpdate={() => updatePlugin.mutate({ pluginId: p.id, scope: cliScope(p.scope) })}
            updating={updatePlugin.isPending && updatePlugin.variables?.pluginId === p.id}
            anyUpdating={updatePlugin.isPending}
          />
        ))}
      </Section>
    </div>
  );
}

// ---- Live plugin-reload bar ----------------------------------------------------

/** Inline bar (not a popup): after toggling plugin(s) with live conversations open,
 *  offer to hot-apply the change to the running session(s). "This conversation" shows
 *  only in the conversation lens when its session is live; "all live conversations of
 *  the repo" always shows (it is the sole option in the repo lens or when the current
 *  conversation is off). Hidden entirely when no conversation of the repo is live. */
function PluginReloadBar({
  count,
  liveCount,
  hasCurrent,
  busy,
  onReloadCurrent,
  onReloadAll,
  onDismiss,
}: {
  count: number;
  liveCount: number;
  hasCurrent: boolean;
  busy: boolean;
  onReloadCurrent: () => void;
  onReloadAll: () => void;
  onDismiss: () => void;
}) {
  const s = count > 1 ? "s" : "";
  return (
    <div className={styles.reloadBar}>
      <Ico name="refresh" className={"sm" + (busy ? " " + styles.spin : "")} />
      <span className={styles.reloadBarText}>
        {count} plugin{s} modifié{s} — appliquer aux conversations en cours&nbsp;?
      </span>
      <span className={styles.reloadBarSpacer} />
      {hasCurrent ? (
        <button className={styles.reloadBtnPrimary} onClick={onReloadCurrent} disabled={busy}>
          Cette conversation
        </button>
      ) : null}
      {!hasCurrent || liveCount > 1 ? (
        <button
          className={hasCurrent ? styles.reloadBtnGhost : styles.reloadBtnPrimary}
          onClick={onReloadAll}
          disabled={busy}
        >
          {hasCurrent ? `Toutes (${liveCount})` : `Toutes les conversations allumées (${liveCount})`}
        </button>
      ) : null}
      <button
        className={styles.reloadDismiss}
        onClick={onDismiss}
        disabled={busy}
        title="Ignorer"
        aria-label="Ignorer"
      >
        ✕
      </button>
    </div>
  );
}

// ---- Sections ------------------------------------------------------------------

function Section({
  icon,
  title,
  count,
  empty,
  children,
  action,
}: {
  icon: string;
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
  /** Optional right-aligned control in the section header (e.g. a "Marketplaces" button). */
  action?: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionH}>
        <Ico name={icon} className="sm" />
        <span className={styles.sectionT}>{title}</span>
        <span className={styles.sectionC}>{count}</span>
        {action ? (
          <>
            <span className={styles.spacer} />
            {action}
          </>
        ) : null}
      </div>
      {count === 0 && empty ? (
        <div className={styles.sectionEmpty}>{empty}</div>
      ) : count === 0 ? (
        children
      ) : (
        <div className={styles.list}>{children}</div>
      )}
    </div>
  );
}

/** A section whose items are grouped by origin (one sub-header per scope). `footer`
 *  renders inside the section after the groups (e.g. plugin-contribution boxes);
 *  `extraCount` adds those items to the header count. The empty state shows only
 *  when there are neither groups nor a footer. */
function GroupedSection<T extends { source: string | null; scope: ExtScope }>({
  icon,
  title,
  groups,
  render,
  empty,
  footer = null,
  extraCount = 0,
}: {
  icon: string;
  title: string;
  groups: Group<T>[];
  render: (item: T) => React.ReactNode;
  empty: string;
  footer?: React.ReactNode;
  extraCount?: number;
}) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const hasFooter = footer != null;
  return (
    <div className={styles.section}>
      <div className={styles.sectionH}>
        <Ico name={icon} className="sm" />
        <span className={styles.sectionT}>{title}</span>
        <span className={styles.sectionC}>{total + extraCount}</span>
      </div>
      {total === 0 && !hasFooter ? (
        <div className={styles.sectionEmpty}>{empty}</div>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.key} className={styles.group}>
              <div className={styles.groupH}>
                <Ico name={g.isPlugin ? "layers" : "folder"} className="sm" />
                <span>{g.label}</span>
                <span className={styles.groupTag}>{g.isPlugin ? "plugin" : "fichiers"}</span>
                <span className={styles.groupC}>{g.items.length}</span>
              </div>
              <div className={styles.list}>{g.items.map(render)}</div>
            </div>
          ))}
          {footer}
        </>
      )}
    </div>
  );
}

/** A small "Marketplaces" button for a section header — opens [`MarketplacesPage`].
 *  Shows an amber count when some plugins have an update, as a discoverable hint. */
function MarketplacesButton({ updates, onOpen }: { updates: number; onOpen: () => void }) {
  return (
    <button
      className={styles.actBtn}
      onClick={onOpen}
      title="Gérer les marketplaces et les mises à jour automatiques"
    >
      <Ico name="layers" className="sm" />
      Marketplaces
      {updates > 0 ? <span className={styles.updateBadge}>{updates}</span> : null}
    </button>
  );
}

/** The Marketplaces page — a dedicated overlay reached from the Plugins section header.
 *  Auto-update is PER-MARKETPLACE (the only granularity Claude Code exposes), so it
 *  belongs here rather than as a general section: the global master toggle, one toggle
 *  per marketplace, and the network "Vérifier" (marketplace refresh). Per-plugin update
 *  stays on each PluginRow; the counts here are derived from the plugin list. */
function MarketplacesPage({
  path,
  plugins,
  onClose,
}: {
  path: string;
  plugins: PluginInfo[];
  onClose: () => void;
}) {
  const marketplaces = useMarketplaces(path);
  const check = useCheckPluginUpdates(path);
  const setAuto = useSetMarketplaceAutoUpdate(path);
  const setAllAuto = useSetAllMarketplacesAutoUpdate(path);
  const list = marketplaces.data ?? [];
  const total = totalUpdates(plugins);
  const allOn = allMarketplacesAuto(list);

  // Escape closes the overlay, like the app's other dialogs. Fullscreen is protected
  // globally by the capture-phase guard in App.tsx (which always preventDefaults Escape),
  // so this no longer needs to preventDefault or gate on `defaultPrevented`.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className={styles.mktScrim} onClick={onClose}>
      <div className={styles.mktPanel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="layers" className="sm" />
          <span className={styles.title}>
            Marketplaces
            <span className={styles.titleSub}>
              Mise à jour automatique des plugins{total > 0 ? ` · ${total} MAJ dispo` : ""}
            </span>
          </span>
          <span className={styles.spacer} />
          <button
            className={styles.actBtn}
            onClick={() => check.mutate(null)}
            disabled={check.isPending}
            title="Rafraîchir les marketplaces et re-vérifier les mises à jour disponibles"
          >
            <Ico name="refresh" className={"sm" + (check.isPending ? " " + styles.spin : "")} />
            {check.isPending ? "Vérification…" : "Vérifier les mises à jour"}
          </button>
          <button className={styles.iconBtn} onClick={onClose} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>
        <div className={styles.body}>
          {check.isError ? <div className={styles.error}>{(check.error as Error).message}</div> : null}
          {setAuto.isError ? <div className={styles.error}>{(setAuto.error as Error).message}</div> : null}
          {setAllAuto.isError ? <div className={styles.error}>{(setAllAuto.error as Error).message}</div> : null}
          {marketplaces.isLoading ? (
            <div className={styles.sectionEmpty}>Chargement des marketplaces…</div>
          ) : marketplaces.isError ? (
            <div className={styles.error}>{(marketplaces.error as Error).message}</div>
          ) : list.length === 0 ? (
            <div className={styles.sectionEmpty}>Aucun marketplace enregistré.</div>
          ) : (
            <div className={styles.list}>
              <div className={styles.mktRow}>
                <Ico name="bolt" className="sm" />
                <div className={styles.rowMain}>
                  <span className={styles.rowName}>Mise à jour automatique</span>
                  <span className={styles.rowMeta}>Tous les marketplaces à la fois</span>
                </div>
                <Toggle
                  checked={allOn}
                  disabled={setAuto.isPending || setAllAuto.isPending}
                  onChange={(v) => setAllAuto.mutate(v)}
                  label="Mise à jour automatique de tous les marketplaces"
                />
              </div>
              {list.map((m) => {
                const n = updatesForMarketplace(plugins, m.name);
                return (
                  <div key={m.name} className={styles.mktRow}>
                    <Ico name="layers" className="sm" />
                    <div className={styles.rowMain}>
                      <span className={styles.rowName}>
                        {m.name}
                        {n > 0 ? <span className={styles.updateBadge}>{n} MAJ</span> : null}
                      </span>
                      {m.source ? <span className={styles.rowMeta}>{m.source}</span> : null}
                    </div>
                    <Toggle
                      checked={m.auto_update}
                      disabled={setAuto.isPending || setAllAuto.isPending}
                      onChange={(v) => setAuto.mutate({ name: m.name, enabled: v })}
                      label={`Mise à jour automatique de ${m.name}`}
                      title="Mise à jour automatique de ce marketplace"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Plugin contributions to a category, shown as ONE summary box per plugin (NOT as
 *  individual rows) — "Tosse workflow · 5 skills" — clickable into the plugin
 *  explorer at that category. Only enabled plugins (they alone contribute live). */
function PluginContribFooter({
  plugins,
  kind,
  onOpen,
}: {
  plugins: PluginInfo[];
  kind: ExplorerSectionKey;
  onOpen: (p: PluginInfo, section?: ExplorerSectionKey) => void;
}) {
  if (!plugins.length) return null;
  const count = (p: PluginInfo) =>
    kind === "skills" ? p.skill_count : kind === "agents" ? p.agent_count : p.mcp_count;
  const noun = (n: number) =>
    kind === "skills"
      ? `${n} skill${n > 1 ? "s" : ""}`
      : kind === "agents"
        ? `${n} sous-agent${n > 1 ? "s" : ""}`
        : `${n} serveur${n > 1 ? "s" : ""} MCP`;
  return (
    <div className={styles.group}>
      <div className={styles.groupH}>
        <Ico name="layers" className="sm" />
        <span>Fournis par des plugins</span>
      </div>
      <div className={styles.list}>
        {plugins.map((p) => (
          <button
            key={p.id}
            className={styles.contribBox}
            onClick={() => onOpen(p, kind)}
            title={`Explorer ${p.name}`}
          >
            <Ico name="layers" className="sm" />
            <span className={styles.rowName}>{p.name}</span>
            <span className={styles.contribCount}>{noun(count(p))}</span>
            <Ico name="arrow" className={"sm " + styles.openArrow} />
          </button>
        ))}
      </div>
    </div>
  );
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`${styles.badge} ${cls}`}>{label}</span>;
}

/** Non-blocking banner for config files that exist but couldn't be read/parsed —
 *  so a corrupt config is never indiscernible from an empty inventory. */
function WarningBanner({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className={styles.warn}>
      Configuration partiellement illisible — l'inventaire ci-dessous peut être incomplet :
      <ul>
        {warnings.map((w) => (
          <li key={w}>{w}</li>
        ))}
      </ul>
    </div>
  );
}

// ---- MCP rows ------------------------------------------------------------------

function McpLiveRow({ mcp, actions }: { mcp: McpServerLive; actions: ReturnType<typeof useMcpActions> }) {
  const [open, setOpen] = useState(false);
  const tone = statusInfo(mcp.status);
  const b = liveBadge(mcp.scope);
  const conn = connType(mcp);
  const canExpand = mcp.tools.length > 0;
  const enabled = mcp.status !== "disabled";
  // claude.ai connectors (`claudeai-proxy`) have their connection + auth managed by
  // the Claude app — we expose ONLY enable/disable for them and leave the rest to
  // the Cloud app (it rejects clear_auth, and reconnect/auth don't apply per-server).
  const isCloud = mcp.scope === "claudeai";
  const isNetwork = mcp.url != null; // OAuth-capable http/sse server (not a connector)
  const busy =
    actions.toggle.isPending ||
    actions.reconnect.isPending ||
    actions.authenticate.isPending ||
    actions.clearAuth.isPending;
  return (
    <div className={styles.mcpRow}>
      <div className={styles.mcpHead}>
        <span className={`${styles.dot} ${tone.cls}`} />
        <span className={styles.rowName}>{mcp.name}</span>
        <Badge label={b.label} cls={b.cls} />
        <span className={styles.spacer} />
        {mcp.tool_count > 0 ? <span className={styles.toolPill}>{mcp.tool_count} outils</span> : null}
        {canExpand ? (
          <button
            className={styles.chevBtn}
            onClick={() => setOpen((o) => !o)}
            title={open ? "Masquer les outils" : "Voir les outils"}
            aria-label="Voir les outils"
          >
            <Ico name="chev" className={"sm " + styles.chev + (open ? " " + styles.chevOpen : "")} />
          </button>
        ) : null}
      </div>
      <div className={styles.mcpSub}>
        <span className={`${styles.statusWord} ${tone.cls}`}>{tone.label}</span>
        {conn ? (
          <>
            <span className={styles.subSep}>·</span>
            <Ico name={conn.icon} className="sm" />
            <span>{conn.kind}</span>
            {conn.detail ? <span className={styles.subDetail}>{conn.detail}</span> : null}
          </>
        ) : null}
        <span className={styles.spacer} />
        <div className={styles.mcpActions}>
          {/* Auth + reconnect only for real servers — never claude.ai connectors. */}
          {!isCloud && mcp.status === "needs-auth" ? (
            <button
              className={styles.actBtn + " " + styles.actPrimary}
              disabled={busy}
              onClick={() => actions.authenticate.mutate(mcp.name)}
            >
              S'authentifier
            </button>
          ) : null}
          {!isCloud && (mcp.status === "failed" || mcp.status === "disconnected") ? (
            <button className={styles.actBtn} disabled={busy} onClick={() => actions.reconnect.mutate(mcp.name)}>
              Reconnecter
            </button>
          ) : null}
          {!isCloud && isNetwork && (mcp.status === "connected" || mcp.status === "needs-auth") ? (
            <button className={styles.actBtn} disabled={busy} onClick={() => actions.clearAuth.mutate(mcp.name)}>
              Réinit. auth
            </button>
          ) : null}
          {isCloud && (mcp.status === "needs-auth" || mcp.status === "failed") ? (
            <span
              className={styles.cloudHint}
              title="Connecteur géré par l'application Claude. Authentifie-le dans Claude, puis rafraîchis."
            >
              Géré par l'app Claude
            </span>
          ) : null}
          <Toggle
            checked={enabled}
            disabled={busy}
            onChange={(v) => actions.toggle.mutate({ serverName: mcp.name, enabled: v })}
            label={`${enabled ? "Désactiver" : "Activer"} ${mcp.name}`}
          />
        </div>
      </div>
      {open ? (
        <div className={styles.toolList}>
          {mcp.tools.map((t) => (
            <span key={t} className={styles.toolChip}>{t}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function McpConfigRow({ mcp }: { mcp: McpServerInfo }) {
  const conn = connType(mcp);
  // No enabled/disabled state: a server's live connection is only knowable in a
  // conversation. This is purely "what's configured for the repo" (the scope lives
  // in the group sub-header). Lead with the connection-type icon.
  return (
    <div className={styles.mcpRow}>
      <div className={styles.mcpHead + " " + styles.noExpand}>
        <Ico name={conn?.icon ?? "term"} className="sm" />
        <span className={styles.rowName}>{mcp.name}</span>
        <span className={styles.spacer} />
        {conn ? <span className={styles.connKind}>{conn.kind}</span> : null}
      </div>
      {conn?.detail ? (
        <div className={styles.mcpSub}>
          <span className={styles.subDetail}>{conn.detail}</span>
        </div>
      ) : null}
    </div>
  );
}

// ---- Plugin / skill / agent rows ----------------------------------------------

/** Count summary line for a plugin ("5 skills · 1 agent · 1 MCP"). */
function pluginParts(plugin: { skill_count: number; agent_count: number; command_count: number; mcp_count: number }): string {
  const parts: string[] = [];
  if (plugin.skill_count) parts.push(`${plugin.skill_count} skill${plugin.skill_count > 1 ? "s" : ""}`);
  if (plugin.agent_count) parts.push(`${plugin.agent_count} agent${plugin.agent_count > 1 ? "s" : ""}`);
  if (plugin.command_count) parts.push(`${plugin.command_count} cmd`);
  if (plugin.mcp_count) parts.push(`${plugin.mcp_count} MCP`);
  return parts.join(" · ");
}

function PluginRow({
  plugin,
  busy,
  onToggle,
  onOpen,
  onUpdate,
  updating,
  anyUpdating,
}: {
  plugin: PluginInfo;
  busy?: boolean;
  onToggle?: (enabled: boolean) => void;
  onOpen: () => void;
  /** Trigger an on-demand update. The button is ALWAYS shown when provided (on-demand
   *  update is a requirement, and pin-less plugins never flip `update_available`); it's
   *  just emphasised when an update was detected. */
  onUpdate?: () => void;
  /** This row's update is in flight. */
  updating?: boolean;
  /** Any plugin's update is in flight (disables every row's button to avoid one shared
   *  mutation hijacking another row's spinner/error). */
  anyUpdating?: boolean;
}) {
  const parts = pluginParts(plugin);
  return (
    <div className={styles.pluginRow}>
      <button className={styles.pluginMain} onClick={onOpen} title="Explorer le plugin">
        <span className={`${styles.dot} ${plugin.enabled ? styles.sOk : styles.sOff}`} />
        <div className={styles.rowMain}>
          <span className={styles.rowName}>
            {plugin.name}
            <Badge label={`Installé : ${CONFIG_SCOPE_LABEL[plugin.scope]}`} cls={configBadgeCls(plugin.scope)} />
            {plugin.update_available ? (
              <span className={styles.updateBadge}>{updateBadgeLabel(plugin.version, plugin.latest_version)}</span>
            ) : null}
          </span>
          <span className={styles.rowMeta}>
            {plugin.marketplace}
            {parts ? ` · ${parts}` : ""}
          </span>
        </div>
        <Ico name="arrow" className={"sm " + styles.openArrow} />
      </button>
      {onUpdate ? (
        <button
          className={plugin.update_available || updating ? styles.updateBtn : styles.updateBtnGhost}
          onClick={onUpdate}
          disabled={updating || anyUpdating}
          title={
            plugin.update_available
              ? "Mettre à jour ce plugin maintenant"
              : "Forcer la mise à jour à la dernière version du marketplace"
          }
        >
          <Ico name="refresh" className={"sm" + (updating ? " " + styles.spin : "")} />
          {updating ? "Mise à jour…" : "Mettre à jour"}
        </button>
      ) : null}
      {onToggle ? (
        <Toggle
          checked={plugin.enabled}
          disabled={busy}
          onChange={onToggle}
          label={`${plugin.enabled ? "Désactiver" : "Activer"} ${plugin.name}`}
          title="Réglage global (tous les dépôts) · une barre propose de l'appliquer aux conversations en cours"
        />
      ) : (
        <span className={styles.statusWord + " " + (plugin.enabled ? styles.sOk : styles.sOff)}>
          {plugin.enabled ? "Actif" : "Inactif"}
        </span>
      )}
    </div>
  );
}

function SkillRow({ skill, onOpen }: { skill: SkillInfo; onOpen: () => void }) {
  return (
    <button className={styles.docRow} onClick={onOpen} title="Ouvrir le skill">
      <Ico name="spark" className="sm" />
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{skill.name}</span>
        {skill.description ? <span className={styles.desc}>{skill.description}</span> : null}
      </div>
      <Ico name="arrow" className={"sm " + styles.openArrow} />
    </button>
  );
}

function AgentRow({ agent, onOpen }: { agent: AgentInfo; onOpen: () => void }) {
  return (
    <button className={styles.docRow} onClick={onOpen} title="Ouvrir le sous-agent">
      <Ico name="grid" className="sm" />
      <div className={styles.rowMain}>
        <span className={styles.rowName}>
          {agent.name}
          {agent.model ? <span className={styles.modelTag}>{agent.model}</span> : null}
        </span>
        {agent.description ? <span className={styles.desc}>{agent.description}</span> : null}
      </div>
      <Ico name="arrow" className={"sm " + styles.openArrow} />
    </button>
  );
}

// ---- Plugin explorer (3 panes: rail / list / detail) --------------------------

type ExplorerSectionKey = "skills" | "mcp" | "agents";

interface ExplorerItem {
  key: string;
  name: string;
  /** Markdown file to render (skill/agent); null for an MCP server (info card). */
  path: string | null;
  mcp?: McpServerInfo;
  model?: string | null;
  description?: string | null;
}

function PluginExplorer({
  plugin,
  initialSection,
  repoPath,
  onClose,
}: {
  plugin: PluginInfo;
  initialSection: ExplorerSectionKey;
  repoPath: string;
  onClose: () => void;
}) {
  const { data, isLoading, isError, error } = usePluginContents(repoPath, plugin.id);
  const [section, setSection] = useState<ExplorerSectionKey>(initialSection);
  const [itemKey, setItemKey] = useState<string | null>(null);

  // Section descriptors in the requested order: Skills → Connecteurs → Sous-agents.
  const allSections: { key: ExplorerSectionKey; label: string; icon: string; items: ExplorerItem[] }[] = [
    {
      key: "skills",
      label: "Skills",
      icon: "spark",
      items: (data?.skills ?? []).map((s) => ({ key: s.path, name: s.name, path: s.path, description: s.description })),
    },
    {
      key: "mcp",
      label: "Connecteurs",
      icon: "term",
      items: (data?.mcp_servers ?? []).map((m) => ({ key: m.name, name: m.name, path: null, mcp: m })),
    },
    {
      key: "agents",
      label: "Sous-agents",
      icon: "grid",
      items: (data?.agents ?? []).map((a) => ({ key: a.path, name: a.name, path: a.path, model: a.model, description: a.description })),
    },
  ];
  const sections = allSections.filter((s) => s.items.length > 0);

  // Once contents load, default to the first non-empty section and its first item.
  useEffect(() => {
    if (!sections.length) return;
    const cur = sections.find((s) => s.key === section) ?? sections[0];
    if (cur.key !== section) setSection(cur.key);
    if (!cur.items.some((it) => it.key === itemKey)) setItemKey(cur.items[0]?.key ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, section]);

  const active = sections.find((s) => s.key === section);
  const item = active?.items.find((it) => it.key === itemKey) ?? null;

  return (
    <div className={styles.pluginScrim} onClick={onClose}>
      <div className={styles.pluginPanel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="layers" className="sm" />
          <span className={styles.title}>
            {plugin.name}
            <span className={styles.titleSub}>{plugin.marketplace}</span>
          </span>
          {plugin.version ? <span className={styles.verTag}>v{plugin.version}</span> : null}
          <span className={styles.spacer} />
          <button className={styles.iconBtn} onClick={onClose} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>

        {isLoading ? (
          <div className={styles.pluginLoading}>Chargement du plugin…</div>
        ) : isError ? (
          <div className={styles.error} style={{ margin: 16 }}>{(error as Error).message}</div>
        ) : sections.length === 0 ? (
          <div className={styles.pluginLoading}>Ce plugin ne fournit ni skill, ni connecteur, ni sous-agent.</div>
        ) : (
          <div className={styles.pluginCols}>
            <div className={styles.pluginRail}>
              {plugin.description ? <div className={styles.railDesc}>{plugin.description}</div> : null}
              {sections.map((s) => (
                <button
                  key={s.key}
                  className={styles.railItem + (s.key === section ? " " + styles.railItemOn : "")}
                  onClick={() => {
                    setSection(s.key);
                    setItemKey(s.items[0]?.key ?? null);
                  }}
                >
                  <Ico name={s.icon} className="sm" />
                  <span>{s.label}</span>
                  <span className={styles.railCount}>{s.items.length}</span>
                </button>
              ))}
            </div>

            <div className={styles.pluginList}>
              {active?.items.map((it) => (
                <button
                  key={it.key}
                  className={styles.listItem + (it.key === itemKey ? " " + styles.listItemOn : "")}
                  onClick={() => setItemKey(it.key)}
                >
                  <Ico name={active.icon} className="sm" />
                  <div className={styles.rowMain}>
                    <span className={styles.rowName}>{it.name}</span>
                    {it.description ? <span className={styles.listItemSub}>{it.description}</span> : null}
                  </div>
                </button>
              ))}
            </div>

            <div className={styles.pluginDetail}>
              {item ? (
                <ItemDetail item={item} sectionKey={section} pluginName={plugin.name} />
              ) : (
                <div className={styles.detailEmpty}>Sélectionne un élément.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Right pane: a metadata strip + rendered markdown (skill/agent) or an MCP card. */
function ItemDetail({ item, sectionKey, pluginName }: { item: ExplorerItem; sectionKey: ExplorerSectionKey; pluginName: string }) {
  const typeLabel = sectionKey === "skills" ? "Skill" : sectionKey === "agents" ? "Sous-agent" : "Serveur MCP";
  return (
    <>
      <div className={styles.detailHead}>
        <span className={styles.detailName}>{item.name}</span>
        <div className={styles.metaGrid}>
          <span className={styles.metaKey}>Fourni par</span>
          <span className={styles.metaVal}>{pluginName}</span>
          <span className={styles.metaKey}>Type</span>
          <span className={styles.metaVal}>{typeLabel}</span>
          {item.model ? (
            <>
              <span className={styles.metaKey}>Modèle</span>
              <span className={styles.metaVal}>{item.model}</span>
            </>
          ) : null}
        </div>
        {item.description ? <p className={styles.detailDesc}>{item.description}</p> : null}
      </div>
      {item.path ? <DocBody path={item.path} /> : item.mcp ? <McpDetailCard mcp={item.mcp} /> : null}
    </>
  );
}

/** The shared load → error → binary/too-large → markdown ladder for a doc file.
 *  Reused by the detail pane (DocBody) and the standalone viewer (DocViewer) so the
 *  four-way state handling and frontmatter strip live in one place. */
function DocMarkdown({ path }: { path: string }) {
  const { data, isLoading, isError, error } = useExtensionDoc(path);
  if (isLoading) return <div className={styles.empty}>Chargement…</div>;
  if (isError) return <div className={styles.error}>{(error as Error).message}</div>;
  if (data?.binary || data?.too_large)
    return <div className={styles.empty}>Fichier non affichable.</div>;
  return <StreamMarkdown text={stripFrontmatter(data?.content ?? "")} />;
}

/** Read + render a SKILL.md / agent .md inside a detail pane (frontmatter stripped). */
function DocBody({ path }: { path: string }) {
  return (
    <div className={styles.detailBody}>
      <DocMarkdown path={path} />
      <div className={styles.docPathFoot}>{path}</div>
    </div>
  );
}

/** MCP server detail (no markdown doc): connection type + endpoint. */
function McpDetailCard({ mcp }: { mcp: McpServerInfo }) {
  const conn = connType(mcp);
  return (
    <div className={styles.detailBody}>
      <div className={styles.mcpCard}>
        {conn ? (
          <div className={styles.mcpCardLine}>
            <Ico name={conn.icon} className="sm" />
            <span className={styles.mcpCardKind}>{conn.kind}</span>
            {conn.detail ? <span className={styles.subDetail}>{conn.detail}</span> : null}
          </div>
        ) : (
          <div className={styles.mcpCardLine}>Connexion non décrite.</div>
        )}
        {mcp.transport ? (
          <div className={styles.mcpCardMeta}>Transport : {mcp.transport}</div>
        ) : null}
      </div>
    </div>
  );
}

// ---- Standalone markdown viewer (file-based skill / sub-agent) -----------------

function DocViewer({ doc, onClose }: { doc: OpenDoc; onClose: () => void }) {
  return (
    <div className={styles.docScrim} onClick={onClose}>
      <div className={styles.docPanel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name="file" className="sm" />
          <span className={styles.title}>
            {doc.name}
            <span className={styles.titleSub}>{doc.source}</span>
          </span>
          <button className={styles.iconBtn} onClick={onClose} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>
        <div className={styles.docBody}>
          {doc.description ? <p className={styles.detailDesc}>{doc.description}</p> : null}
          <DocMarkdown path={doc.path} />
        </div>
        <div className={styles.docFoot}>{doc.path}</div>
      </div>
    </div>
  );
}
