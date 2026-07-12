import { beforeEach, describe, expect, it } from "vitest";
import { useAccountLoginStore } from "./accountLogin";

describe("accountLogin store", () => {
  beforeEach(() => useAccountLoginStore.setState({ failures: {} }));

  it("keeps a failure reason so a closed panel can surface it later", () => {
    useAccountLoginStore.getState().recordOutcome("codex", false, "code expiré");
    expect(useAccountLoginStore.getState().failures.codex).toEqual({ error: "code expiré" });
  });

  it("keeps a null-reason failure (still surfaces, never a silent drop)", () => {
    useAccountLoginStore.getState().recordOutcome("codex", false, null);
    expect(useAccountLoginStore.getState().failures.codex).toEqual({ error: null });
  });

  it("clears the stashed failure on a subsequent success", () => {
    const st = useAccountLoginStore.getState();
    st.recordOutcome("codex", false, "boom");
    st.recordOutcome("codex", true, null);
    expect(useAccountLoginStore.getState().failures.codex).toBeUndefined();
  });

  it("clear() drops a backend's failure without touching others", () => {
    const st = useAccountLoginStore.getState();
    st.recordOutcome("codex", false, "boom");
    st.recordOutcome("claude", false, "nope");
    st.clear("codex");
    expect(useAccountLoginStore.getState().failures.codex).toBeUndefined();
    expect(useAccountLoginStore.getState().failures.claude).toEqual({ error: "nope" });
  });
});
