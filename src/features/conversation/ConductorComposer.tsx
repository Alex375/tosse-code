import { useRef, useState, type KeyboardEvent } from "react";
import type { PermissionMode } from "../../ipc/client";
import {
  useInterrupt,
  useSendMessage,
  useSetEffortLevel,
  useSetModel,
  useSetPermissionMode,
} from "../../ipc/useCommands";
import { useSessionState } from "../../store/conversationStore";
import { useConversationsStore } from "../../store/conversationsStore";
import { ChipBtn, ContextRing, Ico, Menu, MenuItem, MenuLabel } from "../../ui/kit";
import { EffortGauge, clampEffort, type EffortLevel } from "./EffortGauge";
import styles from "./ConductorComposer.module.css";

// The real Claude models. Wire value = CLI alias (sent verbatim to set_model and
// used at spawn); the hint surfaces Opus's 1M context window. Default = Opus 4.8.
const MODEL_OPTS: [string, string, string?][] = [
  ["Opus 4.8", "opus", "1M"],
  ["Sonnet 4.6", "sonnet"],
  ["Haiku 4.5", "haiku"],
];
const DEFAULT_MODEL = "opus";
const DEFAULT_EFFORT: EffortLevel = "xhigh";

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

/** Pretty label for the session's current model id (matches a MODEL_OPTS label). */
function modelLabel(id?: string | null): string {
  if (!id) return "Modèle";
  const s = id.toLowerCase();
  if (s.includes("opus")) return "Opus 4.8";
  if (s.includes("sonnet")) return "Sonnet 4.6";
  if (s.includes("haiku")) return "Haiku 4.5";
  return id;
}

export function ConductorComposer({ session, wide }: { session: string; wide?: boolean }) {
  const state = useSessionState(session);
  const send = useSendMessage(session);
  const interrupt = useInterrupt(session);
  const setMode = useSetPermissionMode(session);
  const setModel = useSetModel(session);
  const setEffortLevel = useSetEffortLevel(session);
  const [text, setText] = useState("");
  const [model, setModelLocal] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<EffortLevel>(DEFAULT_EFFORT);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const busy = state?.busy ?? false;
  // The generated contract types permission_mode loosely as string; the core only
  // ever emits valid modes, so narrow it back to PermissionMode for the helpers below.
  const permMode = (state?.permission_mode ?? "auto") as PermissionMode;
  const permLabel = PERM_LABEL[permMode] ?? "Auto mode";

  // Shift+Tab cycles the permission mode, like the Claude Code terminal.
  const cyclePermMode = () => {
    const idx = PERM_CYCLE.indexOf(permMode);
    setMode.mutate(PERM_CYCLE[(idx + 1) % PERM_CYCLE.length]);
  };

  const chooseModel = (value: string) => {
    setModelLocal(value);
    setModel.mutate(value);
    // Some models drop the current effort (e.g. xhigh / Ultra code on Sonnet).
    const clamped = clampEffort(effort, value);
    if (clamped !== effort) {
      setEffort(clamped);
      setEffortLevel.mutate(clamped);
    }
  };
  const chooseEffort = (lvl: EffortLevel) => {
    setEffort(lvl);
    setEffortLevel.mutate(lvl);
  };

  const autoGrow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  };

  const doSend = () => {
    const t = text.trim();
    if (!t || busy) return;
    // Sending always (re)starts the stream lazily if the session is off/ended,
    // so there is no separate "ended" lock — only "busy" blocks a new send.
    useConversationsStore.getState().noteFirstMessage(session, t);
    send.mutate(t);
    setText("");
    requestAnimationFrame(autoGrow);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      cyclePermMode();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      doSend();
    }
  };

  return (
    <div className="cv-composer" style={wide ? { maxWidth: 760, margin: "0 auto", width: "100%" } : undefined}>
      <div className="cv-input">
        <button className="cv-add" disabled title="Joindre — à venir">
          <Ico name="plus" className="sm" />
        </button>
        <textarea
          ref={taRef}
          className={styles.ta}
          rows={1}
          value={text}
          placeholder="Demande à l'agent, @ pour un fichier, / pour une commande…"
          onChange={(e) => {
            setText(e.target.value);
            autoGrow();
          }}
          onKeyDown={onKeyDown}
          aria-label="Message"
        />
        {busy ? (
          <button className="cv-send" onClick={() => interrupt.mutate()} title="Interrompre">
            <Ico name="stop" className="sm" />
          </button>
        ) : (
          <button
            className="cv-send"
            onClick={doSend}
            disabled={!text.trim()}
            title="Envoyer"
          >
            <Ico name="send" className="sm" />
          </button>
        )}
      </div>

      <div className="cv-comp-foot">
        {/* Model picker — wired to set_model. */}
        <Menu up trigger={<ChipBtn icon="diamond">{modelLabel(model)}</ChipBtn>}>
          <MenuLabel>Modèle</MenuLabel>
          {MODEL_OPTS.map(([label, value, hint]) => (
            <MenuItem key={value} on={model === value} hint={hint} onClick={() => chooseModel(value)}>
              {label}
            </MenuItem>
          ))}
        </Menu>
        {/* Effort gauge — per-model levels; wired to apply_flag_settings{effortLevel}. */}
        <EffortGauge model={model} value={effort} onChange={chooseEffort} />
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
              onClick={disabled ? undefined : () => setMode.mutate(value)}
            >
              <span className="cv-perm-dot" style={{ background: PERM_TONE[value] }} />
              {label}
            </MenuItem>
          ))}
        </Menu>
        <span style={{ marginLeft: "auto" }} />
        <ContextRing ctx={{ pct: 0, used: "—", max: "200k" }} disabled />
      </div>
    </div>
  );
}
