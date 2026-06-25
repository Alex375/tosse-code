// A small, accessible on/off switch (role="switch"). Reusable across settings
// sections — styled with the design tokens so it themes with the rest.
import styles from "./Toggle.module.css";

export function Toggle({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Accessible name when there's no visible <label> tied to it. */
  label?: string;
  /** Optional hover tooltip (e.g. to flag a non-obvious effect/scope). */
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={styles.switch}
      data-on={checked ? "" : undefined}
      onClick={() => onChange(!checked)}
    >
      <span className={styles.knob} />
    </button>
  );
}
