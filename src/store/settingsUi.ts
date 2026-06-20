// Whether the Settings panel is open. A tiny shared slice so the panel can be
// opened from anywhere — the sidebar "Réglages" entry AND the global update
// banner both flip the same flag (same pattern as worktreeUiStore).
import { create } from "zustand";

interface SettingsUiState {
  open: boolean;
  openSettings: () => void;
  closeSettings: () => void;
}

export const useSettingsUi = create<SettingsUiState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
}));
