// Extensions manager: a global modal with TWO DISTINCT lenses, chosen by the
// entry point that opened it (extensionsUiStore.target.kind):
//
//  - "project" (sidebar repo button): what is INSTALLED / available for the repo,
//    by scope — the configured inventory (on-disk scan). Plugins are toggle-able
//    here (management). No live connection status: this is "what's there".
//
//  - "conversation" (composer chip): THIS session's LIVE picture. MCP servers with
//    their REAL connection status + tools (queried from the running process via the
//    `mcp_status` control request — NOT the stale system/init snapshot), plus the
//    plugins/skills/sub-agents actually active. Read-only (MCP actions are Phase 2).
//
// The two views deliberately show different things; see memory
// "extensions-two-distinct-views".
import { useState } from "react";
import { Ico } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";
import { useExtensions, useMcpStatus, useSetPluginEnabled } from "../../ipc/useExtensions";
import { useConversationsStore } from "../../store/conversationsStore";
import type { AgentInfo, ExtScope, McpServerInfo, McpServerLive, PluginInfo, SkillInfo } from "../../ipc/client";
import { useExtensionsUi } from "./extensionsUiStore";
import styles from "./ExtensionsManager.module.css";

type ScopeFilter = "all" | "user" | "project" | "plugin";

const FILTERS: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "Tout" },
  { id: "project", label: "Projet" },
  { id: "user", label: "Utilisateur" },
  { id: "plugin", label: "Plugin" },
];

const CONFIG_SCOPE_LABEL: Record<ExtScope, string> = {
  user: "Utilisateur",
  project: "Projet",
  local: "Local",
  plugin: "Plugin",
};

/** Badge label + CSS class for a configured (on-disk) scope. */
function configBadge(scope: ExtScope): { label: string; cls: string } {
  return { label: CONFIG_SCOPE_LABEL[scope], cls: styles["scope_" + scope] ?? "" };
}

/** Badge label + CSS class for a LIVE scope string (from `mcp_status`). */
function liveBadge(scope: string | null | undefined): { label: string; cls: string } {
  switch (scope) {
    case "claudeai":
      return { label: "Connecteur Claude", cls: styles.scope_connector };
    case "dynamic":
      return { label: "Plugin", cls: styles.scope_plugin };
    case "project":
      return { label: "Projet", cls: styles.scope_project };
    case "local":
      return { label: "Local", cls: "" };
    case "user":
      return { label: "Utilisateur", cls: "" };
    default:
      return { label: scope ?? "—", cls: "" };
  }
}

/** Map a live MCP status to a dot tone class + a French label. */
function statusTone(status: string | null): { cls: string; label: string } {
  switch (status) {
    case "connected":
      return { cls: styles.sOk, label: "connecté" };
    case "pending":
    case "checking_status":
      return { cls: styles.sPending, label: "connexion…" };
    case "needs-auth":
      return { cls: styles.sWarn, label: "authentification requise" };
    case "failed":
      return { cls: styles.sErr, label: "échec" };
    case "disconnected":
      return { cls: styles.sOff, label: "déconnecté" };
    case "disabled":
      return { cls: styles.sOff, label: "désactivé" };
    default:
      return { cls: styles.sNone, label: status ?? "—" };
  }
}

function passes(scope: ExtScope, filter: ScopeFilter): boolean {
  if (filter === "all") return true;
  if (filter === "plugin") return scope === "plugin";
  if (filter === "project") return scope === "project" || scope === "local";
  return scope === "user";
}

export function ExtensionsManager() {
  const target = useExtensionsUi((s) => s.target);
  const close = useExtensionsUi((s) => s.closeManager);
  // Live session handle, only when opened for a conversation. Resolved from the
  // stable conversation id; null when the conversation has no live `claude` yet.
  const handle = useConversationsStore((s) =>
    target?.kind === "conversation" && target.session
      ? (s.conversations.find((c) => c.id === target.session)?.handle ?? null)
      : null,
  );
  const ext = useExtensions(target?.path ?? null);
  const live = useMcpStatus(handle);
  const setPluginEnabled = useSetPluginEnabled(target?.path ?? null);
  const [filter, setFilter] = useState<ScopeFilter>("all");

  // Hooks all above this guard so their order never changes between renders.
  if (!target) return null;
  const isConversation = target.kind === "conversation";

  return (
    <div className={styles.scrim} onClick={close}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <div className={styles.head}>
          <Ico name={isConversation ? "chat" : "layers"} className="sm" />
          <span className={styles.title}>
            {isConversation ? "Extensions de la conversation" : "Extensions du dépôt"}{" "}
            <span className={styles.titleSub}>· {target.title}</span>
          </span>
          <button
            className={styles.iconBtn}
            onClick={() => (isConversation ? void live.refetch() : void ext.refetch())}
            disabled={isConversation ? live.isFetching : ext.isFetching}
            title="Rafraîchir"
            aria-label="Rafraîchir"
          >
            <Ico
              name="refresh"
              className={
                "sm" + ((isConversation ? live.isFetching : ext.isFetching) ? " " + styles.spin : "")
              }
            />
          </button>
          <button className={styles.iconBtn} onClick={close} title="Fermer" aria-label="Fermer">
            ✕
          </button>
        </div>

        {isConversation ? (
          <ConversationBody ext={ext} live={live} hasHandle={handle != null} />
        ) : (
          <ProjectBody ext={ext} filter={filter} setFilter={setFilter} setPluginEnabled={setPluginEnabled} />
        )}
      </div>
    </div>
  );
}

// ---- Project view: configured inventory by scope -------------------------------

function ProjectBody({
  ext,
  filter,
  setFilter,
  setPluginEnabled,
}: {
  ext: ReturnType<typeof useExtensions>;
  filter: ScopeFilter;
  setFilter: (f: ScopeFilter) => void;
  setPluginEnabled: ReturnType<typeof useSetPluginEnabled>;
}) {
  const data = ext.data;
  const mcp = (data?.mcp_servers ?? []).filter((m) => passes(m.scope, filter));
  const plugins = (data?.plugins ?? []).filter((p) => passes(p.scope, filter));
  const skills = (data?.skills ?? []).filter((s) => passes(s.scope, filter));
  const agents = (data?.agents ?? []).filter((a) => passes(a.scope, filter));

  return (
    <>
      <div className={styles.filters}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={styles.filterBtn + (filter === f.id ? " " + styles.filterOn : "")}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
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
            <Section icon="term" title="Serveurs MCP configurés" count={mcp.length} empty="Aucun serveur MCP pour ce scope.">
              {mcp.map((m) => (
                <McpConfigRow key={(m.source ?? "") + ":" + m.name + ":" + m.scope} mcp={m} />
              ))}
            </Section>
            <Section icon="layers" title="Plugins" count={plugins.length} empty="Aucun plugin pour ce scope.">
              {plugins.map((p) => (
                <PluginRow
                  key={p.id}
                  plugin={p}
                  busy={setPluginEnabled.isPending}
                  onToggle={(enabled) => setPluginEnabled.mutate({ pluginId: p.id, enabled })}
                />
              ))}
            </Section>
            <Section icon="spark" title="Skills" count={skills.length} empty="Aucun skill pour ce scope.">
              {skills.map((s) => (
                <SkillRow key={(s.source ?? "") + ":" + s.name} skill={s} />
              ))}
            </Section>
            <Section icon="grid" title="Sous-agents" count={agents.length} empty="Aucun sous-agent pour ce scope.">
              {agents.map((a) => (
                <AgentRow key={(a.source ?? "") + ":" + a.name} agent={a} />
              ))}
            </Section>
          </>
        )}
      </div>
    </>
  );
}

// ---- Conversation view: this session's live picture ---------------------------

function ConversationBody({
  ext,
  live,
  hasHandle,
}: {
  ext: ReturnType<typeof useExtensions>;
  live: ReturnType<typeof useMcpStatus>;
  hasHandle: boolean;
}) {
  // Plugins/skills/agents ACTIVE in this session: enabled plugins + file-based
  // (the scan already excludes disabled plugins' skills/agents).
  const plugins = (ext.data?.plugins ?? []).filter((p) => p.enabled);
  const skills = ext.data?.skills ?? [];
  const agents = ext.data?.agents ?? [];
  const servers = live.data ?? [];

  return (
    <div className={styles.body}>
      <Section icon="term" title="Serveurs MCP (live)" count={servers.length} empty="">
        {!hasHandle ? (
          <div className={styles.sectionEmpty}>
            Démarre la conversation (envoie un message) pour voir l'état live des serveurs MCP.
          </div>
        ) : live.isLoading ? (
          <div className={styles.sectionEmpty}>Interrogation du process…</div>
        ) : live.isError ? (
          <div className={styles.error}>{(live.error as Error).message}</div>
        ) : servers.length === 0 ? (
          <div className={styles.sectionEmpty}>Aucun serveur MCP dans cette session.</div>
        ) : (
          <div className={styles.list}>
            {servers.map((m) => (
              <McpLiveRow key={m.name} mcp={m} />
            ))}
          </div>
        )}
      </Section>
      <Section icon="layers" title="Plugins actifs" count={plugins.length} empty="Aucun plugin actif.">
        {plugins.map((p) => (
          <PluginRow key={p.id} plugin={p} />
        ))}
      </Section>
      <Section icon="spark" title="Skills" count={skills.length} empty="Aucun skill actif.">
        {skills.map((s) => (
          <SkillRow key={(s.source ?? "") + ":" + s.name} skill={s} />
        ))}
      </Section>
      <Section icon="grid" title="Sous-agents" count={agents.length} empty="Aucun sous-agent actif.">
        {agents.map((a) => (
          <AgentRow key={(a.source ?? "") + ":" + a.name} agent={a} />
        ))}
      </Section>
    </div>
  );
}

// ---- Shared row / section components -------------------------------------------

function Section({
  icon,
  title,
  count,
  empty,
  children,
}: {
  icon: string;
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionH}>
        <Ico name={icon} className="sm" />
        <span className={styles.sectionT}>{title}</span>
        <span className={styles.sectionC}>{count}</span>
      </div>
      {count === 0 && empty ? (
        <div className={styles.sectionEmpty}>{empty}</div>
      ) : count === 0 ? (
        children /* the section renders its own empty/placeholder (e.g. MCP live) */
      ) : (
        <div className={styles.list}>{children}</div>
      )}
    </div>
  );
}

function Badge({ label, cls }: { label: string; cls: string }) {
  return <span className={`${styles.badge} ${cls}`}>{label}</span>;
}

function McpConfigRow({ mcp }: { mcp: McpServerInfo }) {
  const b = configBadge(mcp.scope);
  const detail = mcp.command ?? mcp.url ?? (mcp.transport ? `(${mcp.transport})` : "");
  return (
    <div className={styles.row}>
      <span className={`${styles.dot} ${mcp.enabled ? styles.sOk : styles.sOff}`} />
      <span className={styles.rowName}>{mcp.name}</span>
      <Badge label={b.label} cls={b.cls} />
      {detail ? <span className={styles.rowDetail}>{detail}</span> : null}
      <span className={styles.spacer} />
      <span className={styles.statusLabel}>{mcp.enabled ? "activé" : "désactivé"}</span>
    </div>
  );
}

function McpLiveRow({ mcp }: { mcp: McpServerLive }) {
  const tone = statusTone(mcp.status);
  const b = liveBadge(mcp.scope);
  const detail = mcp.command ?? mcp.url ?? (mcp.transport ? `(${mcp.transport})` : "");
  return (
    <div className={styles.row}>
      <span className={`${styles.dot} ${tone.cls}`} title={tone.label} />
      <span className={styles.rowName}>{mcp.name}</span>
      <Badge label={b.label} cls={b.cls} />
      {mcp.tool_count > 0 ? <span className={styles.modelTag}>{mcp.tool_count} tools</span> : null}
      {detail ? <span className={styles.rowDetail}>{detail}</span> : null}
      <span className={styles.spacer} />
      <span className={styles.statusLabel}>{tone.label}</span>
    </div>
  );
}

function PluginRow({
  plugin,
  busy,
  onToggle,
}: {
  plugin: PluginInfo;
  busy?: boolean;
  onToggle?: (enabled: boolean) => void;
}) {
  const b = configBadge(plugin.scope);
  const parts: string[] = [];
  if (plugin.skill_count) parts.push(`${plugin.skill_count} skill${plugin.skill_count > 1 ? "s" : ""}`);
  if (plugin.agent_count) parts.push(`${plugin.agent_count} agent${plugin.agent_count > 1 ? "s" : ""}`);
  if (plugin.command_count) parts.push(`${plugin.command_count} cmd`);
  if (plugin.mcp_count) parts.push(`${plugin.mcp_count} MCP`);
  return (
    <div className={styles.row}>
      <span className={`${styles.dot} ${plugin.enabled ? styles.sOk : styles.sOff}`} />
      <span className={styles.rowName}>{plugin.name}</span>
      <Badge label={b.label} cls={b.cls} />
      <span className={styles.rowDetail}>
        {plugin.marketplace}
        {plugin.version ? ` · v${plugin.version}` : ""}
        {parts.length ? ` · ${parts.join(" · ")}` : ""}
      </span>
      <span className={styles.spacer} />
      {onToggle ? (
        <Toggle
          checked={plugin.enabled}
          disabled={busy}
          onChange={onToggle}
          label={`${plugin.enabled ? "Désactiver" : "Activer"} ${plugin.name}`}
        />
      ) : (
        <span className={styles.statusLabel}>{plugin.enabled ? "actif" : "inactif"}</span>
      )}
    </div>
  );
}

function SkillRow({ skill }: { skill: SkillInfo }) {
  const b = configBadge(skill.scope);
  return (
    <div className={styles.rowCol}>
      <div className={styles.rowTop}>
        <span className={styles.rowName}>{skill.name}</span>
        <Badge label={b.label} cls={b.cls} />
        {skill.source ? <span className={styles.src}>{skill.source}</span> : null}
      </div>
      {skill.description ? <div className={styles.desc}>{skill.description}</div> : null}
    </div>
  );
}

function AgentRow({ agent }: { agent: AgentInfo }) {
  const b = configBadge(agent.scope);
  return (
    <div className={styles.rowCol}>
      <div className={styles.rowTop}>
        <span className={styles.rowName}>{agent.name}</span>
        <Badge label={b.label} cls={b.cls} />
        {agent.model ? <span className={styles.modelTag}>{agent.model}</span> : null}
        {agent.source ? <span className={styles.src}>{agent.source}</span> : null}
      </div>
      {agent.description ? <div className={styles.desc}>{agent.description}</div> : null}
    </div>
  );
}
