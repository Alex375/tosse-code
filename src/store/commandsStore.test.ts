import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the IPC boundary: a controllable fetchSlashCommands. Same pattern as
// reminderSync.test / mentionCache.test.
vi.mock("../ipc/client", () => ({
  commands: { fetchSlashCommands: vi.fn() },
}));

import { commands } from "../ipc/client";
import type { SlashCommand } from "../ipc/client";
import { refetchSlashCommands, useCommandsStore } from "./commandsStore";

const fetchSlashCommands = commands.fetchSlashCommands as unknown as ReturnType<typeof vi.fn>;

const cmd = (name: string): SlashCommand => ({ name, description: "", argument_hint: "" });
const CWD = "/repo";
const OLD = [cmd("old")];
const NEW = [cmd("new-a"), cmd("new-b")];

beforeEach(() => {
  localStorage.clear();
  useCommandsStore.setState({ byCwd: {}, lastSeen: [] });
  fetchSlashCommands.mockReset();
});

describe("refetchSlashCommands", () => {
  it("OVERWRITES an already-cached catalogue (bypasses the prefetch guards)", async () => {
    useCommandsStore.getState().setCommands(CWD, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: NEW });

    await refetchSlashCommands(CWD);

    expect(fetchSlashCommands).toHaveBeenCalledWith(CWD);
    expect(useCommandsStore.getState().byCwd[CWD].map((c) => c.name)).toEqual(["new-a", "new-b"]);
  });

  it("keeps the old cache when the fetch returns an EMPTY list (spawn failure)", async () => {
    useCommandsStore.getState().setCommands(CWD, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "ok", data: [] });

    await refetchSlashCommands(CWD);

    // The invariant: a transient failure must never blank the menu.
    expect(useCommandsStore.getState().byCwd[CWD].map((c) => c.name)).toEqual(["old"]);
  });

  it("keeps the old cache on an error status", async () => {
    useCommandsStore.getState().setCommands(CWD, OLD);
    fetchSlashCommands.mockResolvedValue({ status: "error", error: "boom" });

    await refetchSlashCommands(CWD);

    expect(useCommandsStore.getState().byCwd[CWD].map((c) => c.name)).toEqual(["old"]);
  });

  it("keeps the old cache when the fetch throws", async () => {
    useCommandsStore.getState().setCommands(CWD, OLD);
    fetchSlashCommands.mockRejectedValue(new Error("transport died"));

    await refetchSlashCommands(CWD);

    expect(useCommandsStore.getState().byCwd[CWD].map((c) => c.name)).toEqual(["old"]);
  });

  it("is a no-op for a null/empty cwd (never spawns)", async () => {
    await refetchSlashCommands(null);
    await refetchSlashCommands("");
    expect(fetchSlashCommands).not.toHaveBeenCalled();
  });
});
