import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock every side-effecting boundary so we can assert exactly which channels fire.
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
}));
vi.mock("../ipc/client", () => ({
  commands: { requestUserAttention: vi.fn(async () => ({ status: "ok", data: null })) },
}));
vi.mock("./sound", () => ({ playChime: vi.fn() }));

import type { AgentNotification } from "./notify";
import { dispatchAgentNotification, noteInterrupt, initNotifications } from "./notify";
import { playChime } from "./sound";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { commands } from "../ipc/client";
import { useNotifications } from "../store/notifications";

const ev = (o: Partial<AgentNotification> = {}): AgentNotification => ({
  kind: "done",
  convId: "c1",
  title: "Ma conv",
  repoName: "repo",
  activeId: null,
  ...o,
});

let hasFocus: { mockReturnValue(v: boolean): unknown; mockRestore(): void };

beforeEach(async () => {
  vi.clearAllMocks();
  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  useNotifications.setState({ systemNotification: true, sound: true, dockBounce: true });
  hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  await initNotifications(); // grants OS permission (mocked) → sendNotification fires synchronously
  vi.clearAllMocks(); // drop init's calls so each test counts from zero
});

afterEach(() => {
  hasFocus.mockRestore();
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe("dispatchAgentNotification — channels", () => {
  it("fires all three channels when not watching and every pref is on", () => {
    dispatchAgentNotification(ev());
    expect(playChime).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(commands.requestUserAttention).toHaveBeenCalledOnce();
  });

  it("respects the sound toggle", () => {
    useNotifications.setState({ sound: false });
    dispatchAgentNotification(ev());
    expect(playChime).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledOnce();
  });

  it("respects the system-notification toggle", () => {
    useNotifications.setState({ systemNotification: false });
    dispatchAgentNotification(ev());
    expect(sendNotification).not.toHaveBeenCalled();
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("respects the dock-bounce toggle", () => {
    useNotifications.setState({ dockBounce: false });
    dispatchAgentNotification(ev());
    expect(commands.requestUserAttention).not.toHaveBeenCalled();
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("dock bounce is critical for attention, informational for done", () => {
    dispatchAgentNotification(ev({ kind: "attention" }));
    expect(commands.requestUserAttention).toHaveBeenLastCalledWith(true);
    dispatchAgentNotification(ev({ kind: "done" }));
    expect(commands.requestUserAttention).toHaveBeenLastCalledWith(false);
  });
});

describe("dispatchAgentNotification — focus suppression", () => {
  it("plays the SOUND but suppresses banner + dock when watching (active conv + focused)", () => {
    // The sound is decoupled from focus: the user asked to hear the chime even
    // while looking at the very conversation. Banner + Dock stay suppressed.
    hasFocus.mockReturnValue(true);
    dispatchAgentNotification(ev({ convId: "c1", activeId: "c1" }));
    expect(playChime).toHaveBeenCalledOnce();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(commands.requestUserAttention).not.toHaveBeenCalled();
  });

  it("honours the sound toggle even while watching (no chime when sound off)", () => {
    hasFocus.mockReturnValue(true);
    useNotifications.setState({ sound: false });
    dispatchAgentNotification(ev({ convId: "c1", activeId: "c1" }));
    expect(playChime).not.toHaveBeenCalled();
  });

  it("fires every channel for a background conversation while another is focused", () => {
    hasFocus.mockReturnValue(true);
    dispatchAgentNotification(ev({ convId: "c2", activeId: "c1" }));
    expect(playChime).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(commands.requestUserAttention).toHaveBeenCalledOnce();
  });

  it("fires every channel for the active conversation when the window is not focused", () => {
    hasFocus.mockReturnValue(false);
    dispatchAgentNotification(ev({ convId: "c1", activeId: "c1" }));
    expect(playChime).toHaveBeenCalledOnce();
    expect(sendNotification).toHaveBeenCalledOnce();
    expect(commands.requestUserAttention).toHaveBeenCalledOnce();
  });
});

describe("dispatchAgentNotification — interrupt suppression", () => {
  it("swallows the 'done' that follows a user-initiated interrupt", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playChime).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
    expect(commands.requestUserAttention).not.toHaveBeenCalled();
  });

  it("only suppresses 'done', never 'attention'", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "attention", convId: "c1" }));
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("is one-shot: a second 'done' notifies normally", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" })); // consumes the flag
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playChime).toHaveBeenCalledOnce();
  });

  it("an interrupt on one conversation doesn't mute another", () => {
    noteInterrupt("c1");
    dispatchAgentNotification(ev({ kind: "done", convId: "c2" }));
    expect(playChime).toHaveBeenCalledOnce();
  });
});

describe("dispatchAgentNotification — interrupt window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("suppresses a 'done' within the 15s window", () => {
    vi.setSystemTime(0);
    noteInterrupt("c1");
    vi.setSystemTime(5_000);
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playChime).not.toHaveBeenCalled();
  });

  it("does NOT suppress a 'done' that arrives after the window (stale flag)", () => {
    vi.setSystemTime(0);
    noteInterrupt("c1");
    vi.setSystemTime(20_000);
    dispatchAgentNotification(ev({ kind: "done", convId: "c1" }));
    expect(playChime).toHaveBeenCalledOnce();
  });
});
