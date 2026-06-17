// Slash-command autocomplete — the `/` menu in the composer.
//
// Modeled on the VS Code Claude Code extension (the project's behavioural
// reference): a popover opens above the composer the moment a `/` token is
// typed, filters live as you type, and is driven by ↑/↓ + Enter/Tab. This file
// owns the pure pieces — slash-token detection and command filtering — plus the
// presentational popover. Keyboard navigation lives in the composer (the single
// owner of the textarea), which keeps the menu purely declarative.

import { useEffect, useRef } from "react";
import type { SlashCommand } from "../../ipc/client";

/** A `/` token found under the caret: the text after the slash and its span. */
export interface SlashToken {
  /** Text after the `/` (the live filter), e.g. `"pick"` for `/pick`. */
  query: string;
  /** Index of the `/` character in the input. */
  start: number;
  /** Index just past the token. */
  end: number;
}

/**
 * Find a slash-command token under the caret, mirroring the extension's rule:
 * a `/` at the start of the input or after whitespace, followed by non-space,
 * non-slash characters (so it never fires mid-word or inside a path like `a/b`).
 * Returns null when the caret is not inside such a token.
 */
export function slashTokenAt(text: string, caret: number): SlashToken | null {
  const re = /(?:^|\s)\/[^\s/]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const slash = text.indexOf("/", m.index);
    const end = m.index + m[0].length;
    if (caret >= slash && caret <= end) {
      return { query: text.slice(slash + 1, end), start: slash, end };
    }
  }
  return null;
}

/** The bare command name without its `plugin:` namespace (for matching `pickup`
 *  against `tosse-workflow:pickup`). */
function bareName(name: string): string {
  const i = name.indexOf(":");
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Does `q` appear as an in-order subsequence of `s`? (loose fuzzy match) */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/** Lower rank = better match; -1 = no match. */
function score(name: string, desc: string, q: string): number {
  const bare = bareName(name);
  if (name === q || bare === q) return 0; // exact
  if (name.startsWith(q) || bare.startsWith(q)) return 1; // prefix
  if (name.includes(q)) return 2; // substring
  if (isSubsequence(q, name)) return 3; // fuzzy on name
  if (desc.includes(q)) return 4; // description fallback
  return -1;
}

/**
 * Filter + rank commands for a query (the text after `/`). An empty query keeps
 * the full list in its natural order; otherwise matches are ranked exact →
 * prefix → substring → fuzzy → description, tie-broken by name length then alpha.
 */
export function filterSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands
    .map((cmd) => ({ cmd, rank: score(cmd.name.toLowerCase(), cmd.description.toLowerCase(), q) }))
    .filter((s) => s.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.cmd.name.length - b.cmd.name.length ||
        a.cmd.name.localeCompare(b.cmd.name),
    )
    .map((s) => s.cmd);
}

export function SlashCommandMenu({
  items,
  activeIndex,
  onHover,
  onPick,
}: {
  items: SlashCommand[];
  activeIndex: number;
  /** Hovering a row makes it active (so Enter then picks it). */
  onHover: (index: number) => void;
  onPick: (command: SlashCommand) => void;
}) {
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the active row in view as ↑/↓ moves the selection.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="cv-slash" role="listbox" aria-label="Commandes">
      <div className="cv-slash-list">
        {items.map((cmd, i) => (
          <button
            key={cmd.name}
            ref={i === activeIndex ? activeRef : null}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            className={"cv-slash-item" + (i === activeIndex ? " on" : "")}
            // mousedown (not click) so the textarea never loses focus first.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(cmd);
            }}
            onMouseMove={() => onHover(i)}
            title={cmd.description || undefined}
          >
            <span className="cv-slash-name">
              /{cmd.name}
              {cmd.argument_hint ? (
                <span className="cv-slash-arg wf-mono"> {cmd.argument_hint}</span>
              ) : null}
            </span>
            {cmd.description ? (
              <span className="cv-slash-desc">{cmd.description}</span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
