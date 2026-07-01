// Pure keyboard-shortcut decisions for the top-level view switch, lifted out of the
// App effect so they can be unit-tested without a DOM. We match the PHYSICAL key via
// `e.code` ("Digit1"/"Digit2"), NOT the produced character (`e.key`): on AZERTY 1/2
// sit on Shift positions, so under ⌘ `e.key` is "&"/"é". ⌘/Ctrl is required; Alt or
// Shift disqualify the chord (so ⌘⇧1, ⌥⌘1, … stay free for other bindings).

export type View = "conversation" | "flightdeck";

/** The minimal shape of the keyboard event we decide on (a DOM `KeyboardEvent`
 *  satisfies it structurally, so the App handler passes its event straight in). */
export interface ViewShortcutEvent {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Which view a ⌘/Ctrl+digit chord selects, or null if the chord doesn't match. */
export function viewForShortcut(e: ViewShortcutEvent): View | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return null;
  if (e.code === "Digit1") return "conversation";
  if (e.code === "Digit2") return "flightdeck";
  return null;
}

/** The minimal shape we decide the undo chord on. Unlike the view chords we read the
 *  PRODUCED character `e.key`, not the physical `e.code` — see [isUndoChord]. */
export interface UndoChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether `e` is the "undo" chord: ⌘/Ctrl+Z, with neither Shift (⌘⇧Z is redo) nor Alt.
 *
 * We match the produced letter `e.key === "z"`, NOT the physical `e.code === "KeyZ"`
 * — the OPPOSITE of the view chords above, on purpose. For a DIGIT, AZERTY puts it on
 * a Shift position so its unshifted `e.key` is a symbol ("&"…) and only `e.code` is
 * stable. For a LETTER it is reversed: `e.key` is the same letter on every layout,
 * while `e.code` names the QWERTY POSITION — and AZERTY's "z" sits where QWERTY has
 * "w" (`code === "KeyW"`). So keying off `e.code === "KeyZ"` would fire undo on the
 * AZERTY user's "w" key and never on the key they read as Z. `e.key` is the
 * layout-robust choice for the undo letter.
 */
export function isUndoChord(e: UndoChordEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return false;
  return e.key.toLowerCase() === "z";
}

/** The minimal shape we decide the sound-toggle chord on — a LETTER chord, so like
 *  {@link UndoChordEvent} it reads the produced `e.key`, not the physical `e.code`. */
export interface SoundToggleChordEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether `e` is the "toggle notification sound" chord: ⌘/Ctrl+⇧+M.
 *
 * Like {@link isUndoChord} — and for the same AZERTY reason — we match the PRODUCED
 * letter `e.key === "m"` (case-insensitive), NOT the physical `e.code === "KeyM"`:
 * on AZERTY the M key sits at QWERTY's `Semicolon` position, so keying off `e.code`
 * would fire on the wrong physical key. Shift is REQUIRED because bare ⌘M minimises
 * the window on macOS; Alt disqualifies. This chord is app-global (it never types a
 * character), so App.tsx fires it without the `isEditableTarget` guard the undo
 * chord needs.
 */
export function isSoundToggleChord(e: SoundToggleChordEvent): boolean {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return false;
  return e.key.toLowerCase() === "m";
}

/**
 * Whether focus sits in a control that owns its OWN undo, so a global ⌘Z must not be
 * hijacked from it: a text input/textarea/select, any contenteditable, the Monaco
 * editor (`.monaco-editor`), the sidebar rename input, or the xterm terminal
 * (`.xterm`). Pure (takes the element) so it unit-tests under jsdom.
 */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  // A contenteditable host, or a node inside Monaco / the xterm terminal, owns its own
  // undo. `closest` catches both the focused element AND an editable ancestor; matching
  // the contenteditable ATTRIBUTE (rather than the `isContentEditable` IDL prop) keeps
  // this representable under jsdom — and covers the real-browser case just as well.
  return (
    el.closest(
      '.monaco-editor, .xterm, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ) != null
  );
}
