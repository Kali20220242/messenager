import { create } from "zustand";

type SessionState = {
  isReady: boolean;
  setReady: (value: boolean) => void;
};

export const useSessionStore = create<SessionState>((set) => ({
  isReady: false,
  setReady: (value) => set({ isReady: value }),
}));
