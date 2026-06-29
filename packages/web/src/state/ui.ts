import { create } from 'zustand';

interface UiState {
  activeNav: string;
  setActiveNav: (nav: string) => void;
}

export const useUiStore = create<UiState>((set) => ({
  activeNav: 'projects',
  setActiveNav: (activeNav) => set({ activeNav }),
}));
