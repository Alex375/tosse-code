// Decoupling shim so conversation deletion can dispose integrated terminals
// WITHOUT pulling xterm.js into the startup bundle. The conversations store is
// loaded eagerly at boot; termManager (and thus xterm) is lazy. So the store
// imports only this tiny module and calls `disposeTerminal`/`disposeAllTerminals`;
// termManager registers its real disposers here the first time it loads (i.e. the
// first time a terminal is opened). Until then these are no-ops — which is exactly
// correct, since no terminal can exist before termManager has loaded.

let disposeOne: ((id: string) => void) | null = null;
let disposeAll: (() => void) | null = null;

/** Called once by termManager when it loads, to wire the real disposers. */
export function registerTerminalDisposers(one: (id: string) => void, all: () => void): void {
  disposeOne = one;
  disposeAll = all;
}

/** Kill + free the terminal for a conversation (no-op if none / termManager unloaded). */
export function disposeTerminal(id: string): void {
  disposeOne?.(id);
}

/** Kill + free every live terminal (no-op if termManager unloaded). */
export function disposeAllTerminals(): void {
  disposeAll?.();
}
