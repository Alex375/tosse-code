import { describe, it, expect } from "vitest";
import { viewForShortcut, type ViewShortcutEvent } from "./shortcuts";

function ev(p: Partial<ViewShortcutEvent>): ViewShortcutEvent {
  return { code: "Digit1", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p };
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
