import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsUi } from "./settingsUi";

beforeEach(() => useSettingsUi.setState({ open: false, section: "general" }));

describe("settingsUi store", () => {
  it("opens without changing the current section", () => {
    useSettingsUi.getState().openSettings();
    expect(useSettingsUi.getState().open).toBe(true);
    expect(useSettingsUi.getState().section).toBe("general");
  });

  it("opens directly on a given section (deep-link, e.g. the update banner)", () => {
    useSettingsUi.getState().openSettings("updates");
    const st = useSettingsUi.getState();
    expect(st.open).toBe(true);
    expect(st.section).toBe("updates");
  });

  it("remembers the section across close then reopen", () => {
    useSettingsUi.getState().openSettings("notifications");
    useSettingsUi.getState().closeSettings();
    expect(useSettingsUi.getState().open).toBe(false);
    expect(useSettingsUi.getState().section).toBe("notifications");
    useSettingsUi.getState().openSettings();
    expect(useSettingsUi.getState().section).toBe("notifications");
  });

  it("setSection switches the active tab", () => {
    useSettingsUi.getState().setSection("data");
    expect(useSettingsUi.getState().section).toBe("data");
  });
});
