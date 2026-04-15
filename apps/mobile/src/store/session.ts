import type { Session } from "@supabase/supabase-js";
import { create } from "zustand";

export type ScreenState =
  | "booting"
  | "phone-auth"
  | "otp-verify"
  | "chat-list"
  | "profile"
  | "search-user"
  | "chat";

export type RealtimeStatus = "off" | "live" | "paused";

type SessionState = {
  session: Session | null;
  authStatus: "booting" | "signed-out" | "signed-in";
  currentScreen: ScreenState;
  pendingPhone: string;
  currentUserPhone: string | null;
  selectedChatId: string | null;
  selectedChatPeerPhone: string | null;
  realtimeStatus: RealtimeStatus;
  setSession: (session: Session | null) => void;
  setAuthStatus: (status: SessionState["authStatus"]) => void;
  setCurrentScreen: (screen: ScreenState) => void;
  setPendingPhone: (phone: string) => void;
  setCurrentUserPhone: (phone: string | null) => void;
  selectChat: (chatId: string, peerPhone: string) => void;
  clearSelectedChat: () => void;
  setRealtimeStatus: (status: RealtimeStatus) => void;
  reset: () => void;
};

const initialState = {
  session: null,
  authStatus: "booting" as const,
  currentScreen: "booting" as const,
  pendingPhone: "",
  currentUserPhone: null,
  selectedChatId: null,
  selectedChatPeerPhone: null,
  realtimeStatus: "off" as const,
};

export const useSessionStore = create<SessionState>((set) => ({
  ...initialState,
  setSession: (session) => set({ session }),
  setAuthStatus: (authStatus) => set({ authStatus }),
  setCurrentScreen: (currentScreen) => set({ currentScreen }),
  setPendingPhone: (pendingPhone) => set({ pendingPhone }),
  setCurrentUserPhone: (currentUserPhone) => set({ currentUserPhone }),
  selectChat: (selectedChatId, selectedChatPeerPhone) =>
    set({
      selectedChatId,
      selectedChatPeerPhone,
      currentScreen: "chat",
    }),
  clearSelectedChat: () =>
    set({
      selectedChatId: null,
      selectedChatPeerPhone: null,
      realtimeStatus: "off",
    }),
  setRealtimeStatus: (realtimeStatus) => set({ realtimeStatus }),
  reset: () =>
    set({
      ...initialState,
      authStatus: "signed-out",
      currentScreen: "phone-auth",
    }),
}));
