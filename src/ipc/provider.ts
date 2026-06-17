// The single runtime switch between the real Tauri IPC and the browser mock.
//
// In the packaged desktop app (Tauri webview) `window.__TAURI_INTERNALS__` exists
// and we use the tauri-specta generated bindings, talking to the Rust core.
// In a plain browser (Vite dev / Playwright) it does not exist, so `invoke`/`listen`
// would throw — we fall back to a mock that replays scripted fixtures. This lets us
// develop and screenshot the conversation UI without spawning a real `claude`.
//
// Feature code imports { commands, events } from "./client", never from here.

import { commands as realCommands, events as realEvents } from "./bindings";
import { mockCommands, mockEvents } from "./mock/mockBindings";

export const isTauri =
  typeof window !== "undefined" &&
  typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
    "undefined";

export const commands = isTauri
  ? realCommands
  : (mockCommands as unknown as typeof realCommands);

export const events = isTauri
  ? realEvents
  : (mockEvents as unknown as typeof realEvents);
