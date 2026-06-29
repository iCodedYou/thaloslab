import { create } from 'zustand';

interface UiState {
  activeNav: string;
  setActiveNav: (nav: string) => void;
  selectedProjectId?: string;
  setSelectedProjectId: (id?: string) => void;
  selectedTicketId?: string;
  setSelectedTicketId: (id?: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: 'tickets',
  setActiveNav: (activeNav) => set({ activeNav }),
  selectedProjectId: undefined,
  setSelectedProjectId: (selectedProjectId) => set({ selectedProjectId }),
  selectedTicketId: undefined,
  setSelectedTicketId: (selectedTicketId) => set({ selectedTicketId }),
}));
