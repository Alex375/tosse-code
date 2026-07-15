// Shared building blocks for the Settings panel — the page heading, the titled
// "group card", and a toggle row inside it. Every tab composes these so the whole
// panel stays visually consistent (see SettingsPanel.module.css). All three import
// the SAME CSS module as SettingsPanel.tsx, so the hashed class names line up.
import type { ReactNode } from "react";
import { Ico } from "../../ui/kit";
import { Toggle } from "../../ui/Toggle";
import styles from "./SettingsPanel.module.css";

/** The heading at the top of a settings tab: a bold title + a muted one-liner. */
export function PageHead({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className={styles.pageHead}>
      <div className={styles.pageTitle}>{title}</div>
      {subtitle ? <div className={styles.pageSub}>{subtitle}</div> : null}
    </div>
  );
}

/** A titled card grouping related settings. `icon` is a kit glyph name shown in coral
 *  next to the (uppercase) group title; the children are the rows inside the card. */
export function SettingsGroup({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.group}>
      <div className={styles.groupHead}>
        {icon ? (
          <span className={styles.groupIco}>
            <Ico name={icon} className="sm" />
          </span>
        ) : null}
        <span className={styles.groupTitle}>{title}</span>
      </div>
      <div className={styles.card}>{children}</div>
    </section>
  );
}

/** A single row inside a {@link SettingsGroup} card: a title + optional hint on the
 *  left, and a control on the right — a {@link Toggle} by default, or `control` for a
 *  custom right-hand element. `action` places an extra element just left of the toggle
 *  (e.g. a "Tester" button). */
export function ToggleRow({
  title,
  hint,
  checked,
  onChange,
  label,
  action,
  control,
}: {
  title: string;
  hint?: ReactNode;
  checked?: boolean;
  onChange?: (next: boolean) => void;
  label?: string;
  action?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className={styles.trow}>
      <div className={styles.ttext}>
        <div className={styles.ttitle}>{title}</div>
        {hint ? <div className={styles.thint}>{hint}</div> : null}
      </div>
      {action}
      {control ?? (
        <Toggle checked={!!checked} onChange={onChange ?? (() => {})} label={label ?? title} />
      )}
    </div>
  );
}

/** A "pick one" rail of selectable option cards — each shows a label, a description, and a
 *  check when selected. Shared by the settings tabs that offer a small enumerated choice
 *  (Markdown rendering mode, Caffeinate mode…) so the pattern lives in ONE place. Pass
 *  `className` to override the rail layout (e.g. a fixed-width sticky column). */
export function OptionCardRail<T extends string>({
  options,
  selected,
  onSelect,
  ariaLabel,
  className,
}: {
  options: ReadonlyArray<{ id: T; label: string; desc: string }>;
  selected: T;
  onSelect: (id: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={styles.modeRail + (className ? " " + className : "")}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={styles.opt}
          aria-pressed={selected === o.id}
          data-on={selected === o.id ? "" : undefined}
          onClick={() => onSelect(o.id)}
        >
          <span className={styles.optTop}>
            <span className={styles.optName}>{o.label}</span>
            {selected === o.id ? <Ico name="check" className={"sm " + styles.optCheck} /> : null}
          </span>
          <span className={styles.optDesc}>{o.desc}</span>
        </button>
      ))}
    </div>
  );
}
