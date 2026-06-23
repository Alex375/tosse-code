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
