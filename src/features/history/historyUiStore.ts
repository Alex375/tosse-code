// Open/closed state for the conversation-history search panel (a single global
// modal, like the extensions manager — see extensionsUiStore). The sidebar's search
// bar opens it; the panel closes itself on reactivate / escape / scrim click.
import { create } from "zustand";

interface HistoryUiState {
  open: boolean;
  openPanel: () => void;
  closePanel: () => void;
}

export const useHistoryUi = create<HistoryUiState>((set) => ({
  open: false,
  openPanel: () => set({ open: true }),
  closePanel: () => set({ open: false }),
}));
