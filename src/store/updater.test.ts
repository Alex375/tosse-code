import { describe, it, expect } from "vitest";
import { inAppReleaseNotes, GH_ONLY_MARKER } from "./updater";

describe("inAppReleaseNotes", () => {
  it("returns null for empty / missing input", () => {
    expect(inAppReleaseNotes(null)).toBeNull();
    expect(inAppReleaseNotes(undefined)).toBeNull();
    expect(inAppReleaseNotes("   \n  ")).toBeNull();
  });

  it("keeps only the part before the gh-only marker", () => {
    const body = [
      "## Nouveautés",
      "- Confirmation avant suppression d'une conversation en cours",
      "- Refonte de la page de mise à jour",
      "",
      GH_ONLY_MARKER,
      "⚠️ App signée mais non notarisée : clic droit → Ouvrir.",
    ].join("\n");
    const notes = inAppReleaseNotes(body);
    expect(notes).toContain("Nouveautés");
    expect(notes).toContain("Refonte de la page");
    expect(notes).not.toContain("notarisée");
    expect(notes).not.toContain(GH_ONLY_MARKER);
  });

  it("drops a legacy install-only body (no marker)", () => {
    const legacy = [
      "Build automatique depuis `main` — macOS universel.",
      "",
      "⚠️ App signée (certificat auto-signé) mais **non notarisée** : au premier lancement,",
      "faire **clic droit → Ouvrir**.",
    ].join("\n");
    expect(inAppReleaseNotes(legacy)).toBeNull();
  });

  it("passes through a plain changelog with no marker", () => {
    const body = "## Nouveautés\n- Correction de bugs";
    expect(inAppReleaseNotes(body)).toBe(body);
  });
});
