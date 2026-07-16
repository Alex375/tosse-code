import { Ico } from "../../ui/kit";
import { useCaffeinate } from "../../store/caffeinate";

/**
 * Always-visible title-bar toggle for "Caffeinate" — keep the Mac awake while agents
 * work. Mirrors SoundToggle/EditorToggle/TerminalToggle (`wf-icon-btn`, goes `.on` when
 * armed) and drives the SAME persisted pref as the Settings → Caffeinate switch, so both
 * stay in sync.
 *
 * The button only ARMS the feature; whether the Mac is actually held awake right now
 * depends on the mode (Settings): in Light it follows fleet activity, in Hard it's
 * permanent. CaffeinateHost turns "armed + mode + activity" into the real assertion.
 */
export function CaffeinateToggle() {
  const enabled = useCaffeinate((s) => s.enabled);
  const mode = useCaffeinate((s) => s.mode);
  const toggle = useCaffeinate((s) => s.toggleEnabled);

  const title = enabled
    ? mode === "hard"
      ? "Keeping the Mac awake (Hard) — click to let it sleep"
      : "Keeping the Mac awake while agents work (Light) — click to let it sleep"
    : "Let the Mac sleep — click to keep it awake";

  return (
    <button
      type="button"
      className={"wf-icon-btn" + (enabled ? " on" : "")}
      data-on={enabled ? "" : undefined}
      onClick={toggle}
      title={title}
      aria-label="Toggle Caffeinate (keep the Mac awake)"
      aria-pressed={enabled}
    >
      <Ico name="coffee" className="sm" />
    </button>
  );
}
