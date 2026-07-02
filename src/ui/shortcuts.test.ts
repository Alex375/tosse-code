import { describe, it, expect } from "vitest";
import {
  isEditableTarget,
  isSettingsChord,
  isSoundToggleChord,
  isUndoChord,
  viewForShortcut,
  type SettingsChordEvent,
  type SoundToggleChordEvent,
  type UndoChordEvent,
  type ViewShortcutEvent,
} from "./shortcuts";

function ev(p: Partial<ViewShortcutEvent>): ViewShortcutEvent {
  return { code: "Digit1", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function uev(p: Partial<UndoChordEvent>): UndoChordEvent {
  return { key: "z", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function sev(p: Partial<SoundToggleChordEvent>): SoundToggleChordEvent {
  return { key: "m", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

function cev(p: Partial<SettingsChordEvent>): SettingsChordEvent {
  return { key: ",", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
}

describe("viewForShortcut", () => {
  it("⌘1 / Ctrl+1 → conversation, ⌘2 / Ctrl+2 → flight deck", () => {
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit1" }))).toBe("conversation");
    expect(viewForShortcut(ev({ ctrlKey: true, code: "Digit1" }))).toBe("conversation");
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit2" }))).toBe("flightdeck");
    expect(viewForShortcut(ev({ ctrlKey: true, code: "Digit2" }))).toBe("flightdeck");
  });

  it("keys off the PHYSICAL e.code, so other digits/codes don't match (AZERTY safety)", () => {
    // On AZERTY ⌘1 fires with e.key="&" but e.code="Digit1"; matching e.code is what
    // makes the chord layout-independent. A non-Digit1/2 code never matches.
    expect(viewForShortcut(ev({ metaKey: true, code: "Digit3" }))).toBeNull();
    expect(viewForShortcut(ev({ metaKey: true, code: "Numpad1" }))).toBeNull();
    expect(viewForShortcut(ev({ metaKey: true, code: "KeyA" }))).toBeNull();
  });

  it("requires ⌘/Ctrl and rejects Shift or Alt", () => {
    expect(viewForShortcut(ev({ code: "Digit1" }))).toBeNull(); // bare digit, no modifier
    expect(viewForShortcut(ev({ metaKey: true, shiftKey: true, code: "Digit1" }))).toBeNull();
    expect(viewForShortcut(ev({ metaKey: true, altKey: true, code: "Digit1" }))).toBeNull();
    expect(viewForShortcut(ev({ ctrlKey: true, shiftKey: true, code: "Digit2" }))).toBeNull();
  });
});

describe("isUndoChord", () => {
  it("⌘Z / Ctrl+Z is the undo chord", () => {
    expect(isUndoChord(uev({ metaKey: true }))).toBe(true);
    expect(isUndoChord(uev({ ctrlKey: true }))).toBe(true);
  });

  it("keys off the PRODUCED letter e.key (case-insensitive), not the physical code", () => {
    // Unlike the digit chords, a LETTER's e.key is the same on every layout — it's the
    // QWERTY-positional e.code that drifts (AZERTY 'z' sits at code 'KeyW'). So undo
    // tracks the key that types "z", which is what e.key gives us.
    expect(isUndoChord(uev({ metaKey: true, key: "Z" }))).toBe(true); // capitalised (no shift)
    expect(isUndoChord(uev({ metaKey: true, key: "w" }))).toBe(false);
    expect(isUndoChord(uev({ metaKey: true, key: "a" }))).toBe(false);
  });

  it("requires ⌘/Ctrl and rejects Shift (redo) or Alt", () => {
    expect(isUndoChord(uev({}))).toBe(false); // bare z, no modifier
    expect(isUndoChord(uev({ metaKey: true, shiftKey: true }))).toBe(false); // ⌘⇧Z = redo
    expect(isUndoChord(uev({ metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("isSoundToggleChord", () => {
  it("⌘⇧M / Ctrl+⇧M is the sound-toggle chord", () => {
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true }))).toBe(true);
    expect(isSoundToggleChord(sev({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it("keys off the PRODUCED letter e.key (case-insensitive), not the physical code", () => {
    // Same AZERTY reasoning as undo: a letter's e.key is layout-stable, e.code is not
    // (AZERTY 'm' sits at QWERTY's Semicolon position). Shift uppercases it to "M".
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true, key: "M" }))).toBe(true);
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true, key: "n" }))).toBe(false);
  });

  it("REQUIRES Shift (bare ⌘M minimises the window) and rejects Alt / no modifier", () => {
    expect(isSoundToggleChord(sev({ metaKey: true }))).toBe(false); // ⌘M without Shift
    expect(isSoundToggleChord(sev({ shiftKey: true }))).toBe(false); // ⇧M without ⌘/Ctrl
    expect(isSoundToggleChord(sev({ metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(isSoundToggleChord(sev({ key: "m" }))).toBe(false); // bare m
  });
});

describe("isSettingsChord", () => {
  it("⌘, / Ctrl+, is the settings chord", () => {
    expect(isSettingsChord(cev({ metaKey: true }))).toBe(true);
    expect(isSettingsChord(cev({ ctrlKey: true }))).toBe(true);
  });

  it("keys off the PRODUCED character e.key, not the physical code (AZERTY safety)", () => {
    // The comma is a character whose physical position moves across layouts: on AZERTY
    // the key read as "," produces e.key="," unshifted but sits at QWERTY's KeyM
    // position (e.code="Comma" there is the ";" key). So we track the produced ",",
    // same reasoning as the letter chords — never the physical e.code.
    expect(isSettingsChord(cev({ metaKey: true, key: ";" }))).toBe(false);
    expect(isSettingsChord(cev({ metaKey: true, key: "." }))).toBe(false);
  });

  it("requires ⌘/Ctrl and rejects Shift or Alt", () => {
    expect(isSettingsChord(cev({}))).toBe(false); // bare comma, no modifier
    expect(isSettingsChord(cev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSettingsChord(cev({ metaKey: true, altKey: true }))).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("treats text inputs, textareas and selects as editable", () => {
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
  });

  it("treats a contenteditable element as editable", () => {
    const el = document.createElement("div");
    el.setAttribute("contenteditable", "true");
    // jsdom derives isContentEditable from the attribute.
    expect(isEditableTarget(el)).toBe(true);
  });

  it("treats a node inside the Monaco editor or the xterm terminal as editable", () => {
    const monaco = document.createElement("div");
    monaco.className = "monaco-editor";
    const inner = document.createElement("span");
    monaco.appendChild(inner);
    expect(isEditableTarget(inner)).toBe(true);

    const term = document.createElement("div");
    term.className = "xterm";
    const cell = document.createElement("span");
    term.appendChild(cell);
    expect(isEditableTarget(cell)).toBe(true);
  });

  it("is false for a plain element and for null (no focus)", () => {
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
