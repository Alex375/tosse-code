// Which conversation is open in the Flight Deck reply modal, if any. A tiny shared
// slice so the stream cards' attention actions (StateActions) can open the modal
// without threading a callback down through FlightDeck → StreamCard, mirroring the
// store-driven pattern of the other globally-mounted dialogs (worktreeUiStore,
// extensions manager, history panel). Live-only, keyed by the STABLE conversation
// id — the modal reads everything else by that id, independent of the app's single
// "active conversation" selection.
import { create } from "zustand";

interface FlightdeckModalState {
  /** Stable id of the conversation shown in the modal, or null when closed. */
  convId: string | null;
  open: (convId: string) => void;
  close: () => void;
}

export const useFlightdeckModal = create<FlightdeckModalState>((set) => ({
  convId: null,
  open: (convId) => set({ convId }),
  close: () => set({ convId: null }),
}));
