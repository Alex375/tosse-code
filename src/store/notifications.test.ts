import { describe, it, expect, beforeEach, vi } from "vitest";

const KEY = "tosse:notifications";

// The store reads localStorage at module-eval time, so each load-behaviour test
// sets localStorage then imports a FRESH module instance.
async function freshStore() {
  vi.resetModules();
  return (await import("./notifications")).useNotifications;
}

describe("notifications store", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to all channels on when nothing is stored", async () => {
    const useNotifications = await freshStore();
    const st = useNotifications.getState();
    expect(st.systemNotification).toBe(true);
    expect(st.sound).toBe(true);
    expect(st.dockBounce).toBe(true);
  });

  it("loads a stored partial, merging over the defaults", async () => {
    localStorage.setItem(KEY, JSON.stringify({ sound: false }));
    const st = (await freshStore()).getState();
    expect(st.sound).toBe(false);
    expect(st.systemNotification).toBe(true); // default kept
    expect(st.dockBounce).toBe(true);
  });

  it("falls back to defaults on malformed JSON", async () => {
    localStorage.setItem(KEY, "{ not valid json");
    expect((await freshStore()).getState().sound).toBe(true);
  });

  it("set() updates state and persists to localStorage", async () => {
    const useNotifications = await freshStore();
    useNotifications.getState().set({ dockBounce: false });
    expect(useNotifications.getState().dockBounce).toBe(false);
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.dockBounce).toBe(false);
    expect(stored.sound).toBe(true); // others persisted too
  });

  it("set() leaves the untouched prefs and the action intact", async () => {
    const useNotifications = await freshStore();
    useNotifications.getState().set({ sound: false });
    const st = useNotifications.getState();
    expect(st.sound).toBe(false);
    expect(st.systemNotification).toBe(true);
    expect(st.dockBounce).toBe(true);
    expect(typeof st.set).toBe("function");
  });

  it("toggleSound() flips the sound pref, persists, and leaves others untouched", async () => {
    const useNotifications = await freshStore();
    expect(useNotifications.getState().sound).toBe(true); // default on
    useNotifications.getState().toggleSound();
    expect(useNotifications.getState().sound).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY)!).sound).toBe(false);
    expect(useNotifications.getState().systemNotification).toBe(true); // untouched
    useNotifications.getState().toggleSound();
    expect(useNotifications.getState().sound).toBe(true); // back on
  });
});
