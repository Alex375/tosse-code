import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { PermissionMode, SlashCommand } from "../../ipc/client";
import { useShallow } from "zustand/react/shallow";
import { useInterrupt, useSendMessage } from "../../ipc/useCommands";
import { useSessionState, useUserMessageHistory } from "../../store/conversationStore";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  useConversationsStore,
} from "../../store/conversationsStore";
import { prefetchSlashCommands, useSlashCommands } from "../../store/commandsStore";
import { useComposerDraft, useComposerDrafts } from "../../store/composerDrafts";
import { useExtensionsUi } from "../extensions/extensionsUiStore";
import { ChipBtn, ClaudeMark, ContextRing, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { useContextData } from "../../store/contextData";
import { usePlanUsage, PLAN_USAGE_STALE_MS } from "../../store/planUsage";
import { useUltraBlast } from "../../store/ultraBlast";
import { EffortGauge, clampEffort, type EffortLevel } from "./EffortGauge";
import {
  SlashCommandMenu,
  filterSlashCommands,
  slashTokenAt,
  type SlashToken,
} from "./SlashCommandMenu";
import {
  IDLE_NAV,
  caretOnFirstLine,
  caretOnLastLine,
  recallNext,
  recallPrev,
  type HistoryNav,
  type RecallResult,
} from "./messageHistory";
import styles from "./ConductorComposer.module.css";

// The real Claude models. Wire value = CLI alias (sent verbatim to set_model and
// used at spawn); the hint surfaces Opus's 1M context window. Default = Opus 4.8.
const MODEL_OPTS: [string, string, string?][] = [
  ["Opus 4.8", "opus", "1M"],
  ["Sonnet 4.6", "sonnet"],
  ["Haiku 4.5", "haiku"],
];

// Exact Claude Code permission modes (Shift+Tab selector), in the same order/labels.
// `bypassPermissions` is disabled: the server downgrades it to `default` unless the
// binary is spawned with --allow-dangerously-skip-permissions (not passed yet).
const PERM_OPTS: [string, PermissionMode, boolean?][] = [
  ["Auto mode", "auto"],
  ["Default", "default"],
  ["Auto-accept edits", "acceptEdits"],
  ["Plan mode", "plan"],
  ["Bypass permissions", "bypassPermissions", true],
];
const PERM_LABEL: Record<string, string> = {
  auto: "Auto mode",
  default: "Default",
  acceptEdits: "Auto-accept edits",
  plan: "Plan mode",
  bypassPermissions: "Bypass permissions",
  dontAsk: "Bypass permissions",
};
// Per-mode accent, à la Claude Code terminal: plan=bleu, default=gris,
// acceptEdits=violet, auto=jaune, bypass=rouge. Driven via CSS tokens.
const PERM_TONE: Record<string, string> = {
  auto: "var(--wf-perm-auto)",
  default: "var(--wf-perm-default)",
  acceptEdits: "var(--wf-perm-accept)",
  plan: "var(--wf-perm-plan)",
  bypassPermissions: "var(--wf-perm-bypass)",
  dontAsk: "var(--wf-perm-bypass)",
};
// Modes the user can cycle through with Shift+Tab (bypass is disabled — see PERM_OPTS).
const PERM_CYCLE = PERM_OPTS.filter(([, , disabled]) => !disabled).map(([, value]) => value);

/** Map any model id (a UI alias OR the resolved id `claude-opus-4-8[1m]`) to its
 *  picker alias, so the menu can highlight the live model even when the core
 *  reports a long resolved id. */
function modelFamily(id?: string | null): string | null {
  if (!id) return null;
  const s = id.toLowerCase();
  if (s.includes("opus")) return "opus";
  if (s.includes("sonnet")) return "sonnet";
  if (s.includes("haiku")) return "haiku";
  return null;
}

/** Pretty label for the session's current model id (matches a MODEL_OPTS label). */
function modelLabel(id?: string | null): string {
  if (!id) return "Modèle";
  const s = id.toLowerCase();
  if (s.includes("opus")) return "Opus 4.8";
  if (s.includes("sonnet")) return "Sonnet 4.6";
  if (s.includes("haiku")) return "Haiku 4.5";
  return id;
}

export interface ComposerHandle {
  /** Focus the message textarea. No-op when it's disabled (read-only session). */
  focus: () => void;
}

export const ConductorComposer = forwardRef<
  ComposerHandle,
  { session: string; onSent?: () => void }
>(function ConductorComposer({ session, onSent }, ref) {
  const state = useSessionState(session);
  const send = useSendMessage(session);
  const interrupt = useInterrupt(session);
  // The unsent draft is NOT component-local state: the conversation pane is keyed by
  // conv.id and remounts on every switch, which would wipe a useState("") and lose
  // what the user was typing. It lives in a per-conversation, localStorage-persisted
  // store instead — so switching away and back keeps the text, and it survives a quit.
  const text = useComposerDraft(session);
  const setText = (v: string) => useComposerDrafts.getState().setDraft(session, v);
  // The controls are NOT component-local state (that would reset on every
  // conversation switch and lie about the stream). DISPLAY source of truth, in
  // order: the LIVE session state while running, else this conversation's persisted
  // record, else the product default. The live session's get_settings/system/init
  // keep the live values honest; the persisted record carries them across (re)spawns.
  const ctl = useConversationsStore(
    useShallow((s) => {
      const c = s.conversations.find((cv) => cv.id === session);
      return {
        model: c?.model ?? null,
        effort: c?.effort ?? null,
        ultracode: c?.ultracode ?? false,
        permissionMode: c?.permissionMode ?? null,
      };
    }),
  );
  const modelId = state?.model ?? ctl.model ?? DEFAULT_MODEL;
  const effortLevel = (state?.effort ?? ctl.effort ?? DEFAULT_EFFORT) as EffortLevel;
  const ultracodeOn = state?.ultracode ?? ctl.ultracode;
  const gaugeValue: EffortLevel = ultracodeOn ? "ultracode" : effortLevel;
  // "Start this conversation in a fresh worktree" toggle — only meaningful on the
  // FIRST message (before the session spawns); it disappears once spawned.
  const [useWorktree, setUseWorktree] = useState(false);
  const isFresh = useConversationsStore((s) => {
    const c = s.conversations.find((cv) => cv.id === session);
    return !!c && !c.sessionId && !c.handle;
  });
  const taRef = useRef<HTMLTextAreaElement>(null);

  // ---- Shell-style ↑/↓ history recall -------------------------------------
  // The user's own previously-sent messages, oldest→newest (see selector). The
  // navigation cursor is a ref (no re-render needed) and resets on remount — the
  // pane is keyed by conv.id, so switching conversations starts fresh.
  const history = useUserMessageHistory(session);
  const histNav = useRef<HistoryNav>(IDLE_NAV);

  // Let the conversation view focus the input on a background click (see
  // ConductorConversation). Skips a disabled textarea so a read-only session
  // can't be focused.
  useImperativeHandle(ref, () => ({
    focus: () => {
      const ta = taRef.current;
      if (ta && !ta.disabled) ta.focus();
    },
  }), []);

  // ---- Slash-command autocomplete (the `/` menu) --------------------------
  // Commands are keyed by the conversation's working folder, so the menu works
  // even before the session spawns (typing `/pickup` as the first thing).
  const cwd = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.cwd ?? null,
  );
  const convName = useConversationsStore(
    (s) => s.conversations.find((c) => c.id === session)?.name ?? "Conversation",
  );
  const openExtensions = useExtensionsUi((s) => s.openManager);
  const commands = useSlashCommands(cwd);
  const [slashToken, setSlashToken] = useState<SlashToken | null>(null);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashActive, setSlashActive] = useState(0);

  // Load this repo's commands up front (once) so the `/` menu is ready before
  // the first message spawns the session. No-op if already cached.
  useEffect(() => {
    void prefetchSlashCommands(cwd);
  }, [cwd]);

  const slashMatches = useMemo(
    () => filterSlashCommands(commands, slashToken?.query ?? ""),
    [commands, slashToken?.query],
  );
  const slashOpen = slashToken !== null && !slashDismissed && slashMatches.length > 0;
  // Clamp the active row to the (possibly shrunk) match list.
  const activeIdx = slashMatches.length ? Math.min(slashActive, slashMatches.length - 1) : 0;

  // Reset the highlight to the top whenever the filtered set changes.
  useEffect(() => {
    setSlashActive(0);
  }, [slashToken?.query, commands]);

  // Escape closes the menu. We also grab it at the window level (capture phase)
  // while the menu is open — the OS webview (WKWebView) can swallow Escape inside
  // a focused textarea before React's onKeyDown sees it, so the textarea handler
  // alone isn't reliable. Mirrors how the VS Code extension captures keys while
  // its command menu is open.
  useEffect(() => {
    if (!slashOpen) return;
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
      }
    };
    window.addEventListener("keydown", onEsc, true);
    return () => window.removeEventListener("keydown", onEsc, true);
  }, [slashOpen]);

  /** Recompute the `/` token from the live textarea (value + caret). */
  const syncSlashToken = (el: HTMLTextAreaElement) => {
    setSlashToken(slashTokenAt(el.value, el.selectionStart ?? el.value.length));
  };

  const busy = state?.busy ?? false;
  // Permission DISPLAY source of truth, in order: live state, persisted record,
  // product default. The generated contract types permission_mode loosely as
  // string; narrow it back to PermissionMode for the helpers below.
  const permMode = (state?.permission_mode ??
    ctl.permissionMode ??
    DEFAULT_PERMISSION_MODE) as PermissionMode;
  const permLabel = PERM_LABEL[permMode] ?? PERM_LABEL[DEFAULT_PERMISSION_MODE];

  // Context fill (ring) — shared derivation keyed by stable id, reused by the
  // FlightDeck card's context bar (see useContextData).
  const { ctx: ctxData, ready: ctxReady, plan: planData } = useContextData(session);

  // Real plan-usage % (account-global, NOT per-conversation). Background-polled here
  // so the figure stays warm; the ring popover shows it + a manual refresh. On open
  // we refetch only when stale, to spare the rate-limited usage endpoint. Gated on
  // `ctxReady`: the popover is unreachable (ring disabled) until the first turn reports
  // context anyway, so don't read credentials / risk a Keychain prompt the instant a
  // brand-new conversation is merely selected.
  const planUsage = usePlanUsage({ enabled: ctxReady });
  const onOpenUsage = () => {
    // Throttle against the last attempt — success OR failure — so opening the popover
    // after an error (e.g. a 429) doesn't immediately hammer the endpoint again.
    const lastAttempt = Math.max(planUsage.dataUpdatedAt, planUsage.errorUpdatedAt);
    if (Date.now() - lastAttempt >= PLAN_USAGE_STALE_MS) void planUsage.refetch();
  };

  // Every control routes through the conversations store: it persists the choice
  // (so a pre-spawn pick survives and is applied at spawn) AND pushes it to the live
  // stream when running. The live get_settings read-back then confirms reality.
  const choosePerm = (mode: PermissionMode) =>
    useConversationsStore.getState().setConvPermission(session, mode);

  // Shift+Tab cycles the permission mode, like the Claude Code terminal.
  const cyclePermMode = () => {
    const idx = PERM_CYCLE.indexOf(permMode);
    choosePerm(PERM_CYCLE[(idx + 1) % PERM_CYCLE.length]);
  };

  const applyEffort = (lvl: EffortLevel) => {
    const store = useConversationsStore.getState();
    // "Ultra code" is not an effort value — it's xhigh + a separate flag.
    if (lvl === "ultracode") {
      // Fire the full-screen blast only on the OFF→ON transition, not on a
      // re-select while already ultra.
      if (gaugeValue !== "ultracode") useUltraBlast.getState().fire();
      store.setConvUltracode(session);
    } else store.setConvEffort(session, lvl);
  };

  const chooseModel = (value: string) => {
    useConversationsStore.getState().setConvModel(session, value);
    // Some models drop the current effort (e.g. xhigh / Ultra code on Sonnet) —
    // clamp the gauge value to what the new model supports and apply it.
    const clamped = clampEffort(gaugeValue, value);
    if (clamped !== gaugeValue) applyEffort(clamped);
  };
  const chooseEffort = (lvl: EffortLevel) => applyEffort(lvl);

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  // A restored draft can be multi-line; the textarea defaults to one row, so size it
  // to the content on mount (and whenever we switch to another conversation's draft)
  // rather than leaving it scrolled. autoGrow() reads taRef, set by render time.
  useEffect(() => {
    autoGrow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const sendText = (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    // NO busy gate: sending while the agent is working is supported and desirable.
    // The `claude` CLI natively queues a user message received mid-turn and injects
    // it at the next loop boundary (after a tool_result batch, before the next model
    // call), wrapped in "The user sent a new message while you were working: … /
    // IMPORTANT: After completing your current task, you MUST address the user's
    // message above." Holding it app-side until the turn ends would defeat that
    // mid-turn injection — the agent must see it in-flight, not only at the end.
    // Sending also (re)starts the stream lazily if the session is off/ended.
    useConversationsStore.getState().noteFirstMessage(session, t);
    // The worktree toggle only applies to the very first spawn of a conversation.
    // `queued`: busy at send time → the CLI will inject this mid-turn, so the
    // bubble shows an "en attente" badge until the turn ends.
    send.mutate({ text: t, worktree: useWorktree && isFresh, queued: busy });
    setText("");
    histNav.current = IDLE_NAV;
    setSlashToken(null);
    requestAnimationFrame(autoGrow);
    // Sending always snaps the thread to the bottom, even if the user had scrolled
    // up — this re-engages stick-to-bottom so the incoming reply stays in view.
    onSent?.();
  };

  const doSend = () => sendText(text);

  /**
   * Accept a slash command from the menu. Mirrors the VS Code extension:
   *  - a bare `/cmd` at the start of the input, taken with Enter/click → RUN it
   *    now (send `/cmd`);
   *  - taken with Tab, or with text before the `/` → INSERT `/cmd ` so arguments
   *    can be typed, caret placed right after.
   */
  const pickCommand = (cmd: SlashCommand, viaTab: boolean) => {
    if (!slashToken) return;
    const before = text.slice(0, slashToken.start);
    const after = text.slice(slashToken.end);
    const hasTextBefore = before.trim().length > 0;

    if (!viaTab && !hasTextBefore) {
      const rest = after.trim();
      sendText(rest ? `/${cmd.name} ${rest}` : `/${cmd.name}`);
      return;
    }

    const insert = `/${cmd.name} `;
    const next = before + insert + (after.startsWith(" ") ? after.slice(1) : after);
    const caret = before.length + insert.length;
    setText(next);
    setSlashToken(null);
    setSlashDismissed(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(caret, caret);
      autoGrow();
    });
  };

  /** Fill the composer with a recalled message and park the caret at its end. */
  const applyRecall = (res: RecallResult) => {
    histNav.current = res.nav;
    setText(res.text);
    setSlashToken(null);
    setSlashDismissed(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
      autoGrow();
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While the `/` menu is open it owns the navigation/commit keys.
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashActive((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashActive((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        pickCommand(slashMatches[activeIdx], e.key === "Tab");
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cyclePermMode();
      return;
    }
    // ↑/↓ recall previously-sent messages, shell-style — but only at the field's
    // edge (caret on the first line for ↑, last line for ↓) so multi-line editing
    // and the modifier combos (⌥/⌘/⇧ + arrow = caret/selection) keep working.
    const bareArrow = !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey;
    if (e.key === "ArrowUp" && bareArrow) {
      const ta = e.currentTarget;
      if (caretOnFirstLine(ta.value, ta.selectionStart ?? 0)) {
        const res = recallPrev(history, histNav.current, text);
        if (res) {
          e.preventDefault();
          applyRecall(res);
          return;
        }
      }
    }
    if (e.key === "ArrowDown" && bareArrow) {
      const ta = e.currentTarget;
      if (
        histNav.current.index !== null &&
        caretOnLastLine(ta.value, ta.selectionEnd ?? ta.value.length)
      ) {
        const res = recallNext(history, histNav.current);
        if (res) {
          e.preventDefault();
          applyRecall(res);
          return;
        }
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div className="cv-composer">
      {slashOpen ? (
        <SlashCommandMenu
          items={slashMatches}
          activeIndex={activeIdx}
          onHover={setSlashActive}
          onPick={(cmd) => pickCommand(cmd, false)}
        />
      ) : null}
      <div className="cv-input">
        <button className="cv-add" disabled title="Joindre — à venir">
          <Ico name="plus" className="sm" />
        </button>
        <textarea
          ref={taRef}
          className={styles.ta}
          rows={1}
          value={text}
          placeholder={
            busy
              ? "L'agent travaille — ton message sera pris en compte en cours de route…"
              : "Demande à l'agent, @ pour un fichier, / pour une commande…"
          }
          onChange={(e) => {
            // Genuine typing exits history navigation: the edited text becomes the
            // new live draft (a later ↑ re-stashes it and starts from the newest).
            histNav.current = IDLE_NAV;
            setText(e.target.value);
            setSlashDismissed(false);
            syncSlashToken(e.currentTarget);
            autoGrow();
          }}
          onSelect={(e) => syncSlashToken(e.currentTarget)}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        {/* While busy with an empty box, the action is "interrupt". As soon as there
            is text to send — busy or not — it's a send button: a message sent mid-turn
            is natively queued by the CLI and injected at the next loop boundary. */}
        {busy && !text.trim() ? (
          <button className="cv-send" onClick={() => interrupt.mutate()} title="Interrompre">
            <Ico name="stop" className="sm" />
          </button>
        ) : (
          <button
            className="cv-send"
            onClick={doSend}
            disabled={!text.trim()}
            title={busy ? "Envoyer — l'agent le traitera en cours de route" : "Envoyer"}
          >
            <Ico name="send" className="sm" />
          </button>
        )}
      </div>

      <div className="cv-comp-foot">
        {/* Model picker — reads the LIVE model (resolved id mapped to its alias),
            falls back to the persisted/default; wired to set_model + persistence. */}
        <Menu up trigger={<ChipBtn iconNode={<ClaudeMark />}>{modelLabel(modelId)}</ChipBtn>}>
          <MenuLabel>Modèle</MenuLabel>
          {MODEL_OPTS.map(([label, value, hint]) => (
            <MenuItem
              key={value}
              on={modelFamily(modelId) === value}
              hint={hint}
              onClick={() => chooseModel(value)}
            >
              {label}
            </MenuItem>
          ))}
        </Menu>
        {/* Effort gauge — reads the LIVE effort/ultracode (get_settings read-back),
            per-model levels; wired to apply_flag_settings + persistence. */}
        <EffortGauge model={modelId} value={gaugeValue} onChange={chooseEffort} />
        <span className="cv-foot-sep" />
        {/* Permissions IS wired (set_permission_mode). Shift+Tab cycles modes (see onKeyDown).
            Opens upward — the composer sits at the bottom. Colour-coded per mode. */}
        <Menu
          up
          trigger={
            <ChipBtn icon="shield" data-perm={permMode} title="Mode de permission — ⇧Tab pour changer">
              {permLabel}
            </ChipBtn>
          }
        >
          <MenuLabel>Mode de permission · ⇧Tab</MenuLabel>
          {PERM_OPTS.map(([label, value, disabled]) => (
            <MenuItem
              key={value}
              on={permMode === value}
              disabled={disabled}
              onClick={disabled ? undefined : () => choosePerm(value)}
            >
              <span className="cv-perm-dot" style={{ background: PERM_TONE[value] }} />
              {label}
            </MenuItem>
          ))}
        </Menu>
        <span style={{ marginLeft: "auto" }} />
        {/* Extensions panel — what this conversation's Claude sees (MCP + live
            status, plugins, skills, sub-agents), à la /mcp. Scans the session's
            current cwd so a worktree shows its own config. */}
        <button
          type="button"
          className="wf-chip"
          onClick={() =>
            openExtensions({
              kind: "conversation",
              path: state?.cwd ?? cwd ?? ".",
              title: convName,
              session,
            })
          }
          title="Extensions de cette conversation — MCP (statut live), plugins, skills, sous-agents"
        >
          <Ico name="layers" className="sm" />
          <span className="wf-chip-t">Extensions</span>
        </button>
        {/* Worktree checkbox — only before the session spawns (first message).
            Explicit empty/checked box so the on/off state is unambiguous. */}
        {isFresh ? (
          <button
            type="button"
            role="checkbox"
            aria-checked={useWorktree}
            className="cv-wt-toggle"
            onClick={() => setUseWorktree((v) => !v)}
            title="Démarrer cette conversation dans un nouveau worktree git"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              font: "inherit",
              fontSize: 11,
              cursor: "pointer",
              padding: "4px 9px",
              borderRadius: 7,
              border: `1px solid ${useWorktree ? "var(--wf-accent)" : "var(--wf-line)"}`,
              background: "transparent",
              color: useWorktree ? "var(--wf-accent)" : "var(--wf-tx-lo)",
            }}
          >
            <span
              style={{
                width: 13,
                height: 13,
                flex: "0 0 auto",
                borderRadius: 3,
                border: `1.5px solid ${useWorktree ? "var(--wf-accent)" : "var(--wf-line-2)"}`,
                background: useWorktree ? "var(--wf-accent)" : "transparent",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#1a0f0a",
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              {useWorktree ? "✓" : ""}
            </span>
            <Ico name="branch" className="sm" />
            <span className="cv-wt-label">Worktree</span>
          </button>
        ) : null}
        <ContextRing
          ctx={ctxData}
          plan={planData}
          disabled={!ctxReady}
          onCompact={() => sendText("/compact")}
          usage={planUsage.data ?? null}
          usageLoading={planUsage.isFetching}
          usageError={planUsage.error}
          usageUpdatedAt={planUsage.dataUpdatedAt}
          onOpenUsage={onOpenUsage}
          onRefreshUsage={() => void planUsage.refetch()}
        />
      </div>
    </div>
  );
});
