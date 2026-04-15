import "react-native-url-polyfill/auto";

import * as Contacts from "expo-contacts";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { getAvatarUrl, pickAndUploadAvatar } from "./src/lib/avatar";
import {
  type ClearChatScope,
  type ChatMessage,
  type ChatSummary,
  type MeProfile,
  type ReceiptStatus,
  type UserProfile,
  clearChatHistory,
  discoverContacts,
  fetchChats,
  fetchMe,
  fetchMessages,
  openDirectChat,
  removePushToken,
  searchUserByUsername,
  sendHeartbeat,
  sendMessage as sendMessageRequest,
  updateMyProfile,
  upsertPushToken,
} from "./src/lib/api";
import { registerForPushNotificationsAsync } from "./src/lib/notifications";
import { normalizePhoneE164 } from "./src/lib/phone";
import { supabase } from "./src/lib/supabase";
import { useSessionStore } from "./src/store/session";

type DraftMessage = ChatMessage & {
  status?: "pending" | "failed";
  error?: string;
};

const REALTIME_IDLE_TIMEOUT_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const CHAT_LIST_SYNC_INTERVAL_MS = 1_500;
const CHAT_MESSAGES_SYNC_INTERVAL_MS = 1_000;
const CHAT_PAGE_SIZE = 30;

const isSessionError = (message: string) => {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("session expired")
    || normalized.includes("invalid bearer token")
    || normalized.includes("missing authorization header")
    || normalized.includes("no active auth session")
  );
};

const formatTime = (value: string | null) => {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
};

const formatLastSeen = (value: string | null) => {
  if (!value) {
    return "Offline";
  }

  return `Last seen ${new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    day: "numeric",
  }).format(new Date(value))}`;
};

const displayName = (profile: Pick<UserProfile, "username" | "phone_e164"> | null | undefined) =>
  profile?.username?.trim() || profile?.phone_e164 || "Unknown";

const profilePresence = (profile: Pick<UserProfile, "is_online" | "last_seen_at"> | null | undefined) =>
  profile?.is_online ? "Online" : formatLastSeen(profile?.last_seen_at ?? null);

const sortChatsByActivity = (items: ChatSummary[]) =>
  [...items].sort((left, right) => {
    const leftTime = left.activity_at;
    const rightTime = right.activity_at;
    return rightTime.localeCompare(leftTime);
  });

const mergeChatSummaries = (current: ChatSummary[], incoming: ChatSummary[]) => {
  const nextById = new Map(incoming.map((chat) => [chat.id, chat]));

  for (const chat of current) {
    if (!nextById.has(chat.id)) {
      nextById.set(chat.id, chat);
    }
  }

  return sortChatsByActivity([...nextById.values()]);
};

const mergeDraftMessages = (current: DraftMessage[], incoming: ChatMessage[]) => {
  const merged = new Map<string, DraftMessage>();

  for (const message of current) {
    merged.set(message.id, message);
  }

  for (const message of incoming) {
    merged.set(message.id, message);
  }

  return [...merged.values()].sort((left, right) => left.created_at.localeCompare(right.created_at));
};

const receiptCopy = (status: ReceiptStatus | null | undefined) => {
  switch (status) {
    case "seen":
      return "Seen";
    case "delivered":
      return "Delivered";
    case "sent":
      return "Sent";
    default:
      return "";
  }
};

const nativePlatform = (): "ios" | "android" | "web" =>
  Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "web";

function Avatar({
  profile,
  size = 44,
}: {
  profile: Pick<UserProfile, "username" | "phone_e164" | "avatar_path"> | null | undefined;
  size?: number;
}) {
  const avatarUrl = getAvatarUrl(profile?.avatar_path);
  const label = displayName(profile).slice(0, 1).toUpperCase();

  if (avatarUrl) {
    return (
      <View style={[styles.avatarFrame, { width: size, height: size, borderRadius: size / 2 }]}>
        <Image
          source={{ uri: avatarUrl }}
          resizeMode="cover"
          style={styles.avatarImage}
        />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.avatarFallback,
        { width: size, height: size, borderRadius: size / 2 },
      ]}
    >
      <Text style={styles.avatarFallbackText}>{label}</Text>
    </View>
  );
}

export default function App() {
  const {
    session,
    currentScreen,
    pendingPhone,
    currentUserPhone,
    selectedChatId,
    realtimeStatus,
    setSession,
    setAuthStatus,
    setCurrentScreen,
    setPendingPhone,
    setCurrentUserPhone,
    selectChat,
    clearSelectedChat,
    setRealtimeStatus,
    reset,
  } = useSessionStore();

  const [phoneInput, setPhoneInput] = useState("");
  const [otpInput, setOtpInput] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<DraftMessage[]>([]);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [meProfile, setMeProfile] = useState<MeProfile | null>(null);
  const [searchResults, setSearchResults] = useState<UserProfile[]>([]);
  const [contactResults, setContactResults] = useState<UserProfile[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [contactError, setContactError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [isLoadingMoreChats, setIsLoadingMoreChats] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isDiscoveringContacts, setIsDiscoveringContacts] = useState(false);
  const [isOpeningChat, setIsOpeningChat] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [profileUsernameInput, setProfileUsernameInput] = useState("");
  const [chatCursor, setChatCursor] = useState<string | null>(null);
  const [hasMoreChats, setHasMoreChats] = useState(true);
  const [appStateStatus, setAppStateStatus] = useState(AppState.currentState);
  const listRef = useRef<FlatList<DraftMessage>>(null);
  const realtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const realtimeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatMessagesSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pushTokenRef = useRef<string | null>(null);

  const currentUserId = session?.user.id ?? null;
  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? null,
    [chats, selectedChatId],
  );
  const searchCandidates = useMemo(() => {
    const unique = new Map<string, UserProfile>();

    for (const result of searchResults) {
      unique.set(result.id, result);
    }

    for (const contact of contactResults) {
      unique.set(contact.id, contact);
    }

    return [...unique.values()].sort((left, right) =>
      displayName(left).localeCompare(displayName(right)),
    );
  }, [contactResults, searchResults]);

  useEffect(() => {
    const initialize = async () => {
      try {
        const {
          data: { session: initialSession },
        } = await supabase.auth.getSession();
        await applySession(initialSession);
      } finally {
        setIsBooting(false);
      }
    };

    void initialize();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      void applySession(nextSession);
    });

    const appStateSubscription = AppState.addEventListener("change", setAppStateStatus);

    return () => {
      subscription.unsubscribe();
      appStateSubscription.remove();
      clearSyncIntervals();
      stopRealtime();
    };
  }, []);

  useEffect(() => {
    if (!meProfile) {
      setProfileUsernameInput("");
      return;
    }

    setProfileUsernameInput(meProfile.username ?? "");
  }, [meProfile?.id, meProfile?.username]);

  useEffect(() => {
    if (!session || appStateStatus !== "active") {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
      return;
    }

    void sendHeartbeat().catch(() => {});

    heartbeatRef.current = setInterval(() => {
      void sendHeartbeat().catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [session, appStateStatus]);

  useEffect(() => {
    if (!session || Platform.OS === "web") {
      return;
    }

    const registerPushToken = async () => {
      try {
        const token = await registerForPushNotificationsAsync();
        if (!token) {
          return;
        }

        pushTokenRef.current = token;
        await upsertPushToken(token, nativePlatform());
      } catch (error) {
        console.warn("Push token registration failed", error);
      }
    };

    void registerPushToken();
  }, [session]);

  useEffect(() => {
    if (!session || currentScreen !== "chat-list") {
      if (chatListSyncRef.current) {
        clearInterval(chatListSyncRef.current);
        chatListSyncRef.current = null;
      }
      return;
    }

    void loadChats({ reset: true });

    chatListSyncRef.current = setInterval(() => {
      void loadChats({ silent: true });
    }, CHAT_LIST_SYNC_INTERVAL_MS);

    return () => {
      if (chatListSyncRef.current) {
        clearInterval(chatListSyncRef.current);
        chatListSyncRef.current = null;
      }
    };
  }, [session, currentScreen]);

  useEffect(() => {
    if (!session || !selectedChatId || currentScreen !== "chat") {
      if (chatMessagesSyncRef.current) {
        clearInterval(chatMessagesSyncRef.current);
        chatMessagesSyncRef.current = null;
      }
      stopRealtime();
      return;
    }

    void loadMessages(selectedChatId);
    void loadChats({ silent: true });
    startRealtime(selectedChatId);

    chatMessagesSyncRef.current = setInterval(() => {
      void loadMessages(selectedChatId, { silent: true });
      void loadChats({ silent: true });
    }, CHAT_MESSAGES_SYNC_INTERVAL_MS);

    return () => {
      if (chatMessagesSyncRef.current) {
        clearInterval(chatMessagesSyncRef.current);
        chatMessagesSyncRef.current = null;
      }
      stopRealtime();
    };
  }, [session, selectedChatId, currentScreen]);

  useEffect(() => {
    listRef.current?.scrollToEnd({ animated: true });
  }, [messages.length]);

  const clearSyncIntervals = () => {
    if (chatListSyncRef.current) {
      clearInterval(chatListSyncRef.current);
      chatListSyncRef.current = null;
    }

    if (chatMessagesSyncRef.current) {
      clearInterval(chatMessagesSyncRef.current);
      chatMessagesSyncRef.current = null;
    }

    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  };

  const applySession = async (nextSession: typeof session) => {
    setSession(nextSession);

    if (!nextSession) {
      setAuthStatus("signed-out");
      setCurrentUserPhone(null);
      setPendingPhone("");
      clearSelectedChat();
      setChats([]);
      setChatCursor(null);
      setHasMoreChats(true);
      setMessages([]);
      setMeProfile(null);
      startTransition(() => setCurrentScreen("phone-auth"));
      return;
    }

    setAuthStatus("signed-in");

    try {
      const me = await fetchMe();
      setMeProfile(me);
      setCurrentUserPhone(me.phone_e164);
      setAuthError(null);
      startTransition(() => setCurrentScreen("chat-list"));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load your profile.";

      if (isSessionError(message)) {
        await supabase.auth.signOut();
        reset();
        setPhoneInput("");
        setOtpInput("");
        setSearchInput("");
        setDraft("");
        setAuthError("Session expired. Please sign in again.");
        return;
      }

      setAuthError(message);
      startTransition(() => setCurrentScreen("chat-list"));
    }
  };

  const loadChats = async (options?: {
    silent?: boolean;
    reset?: boolean;
    append?: boolean;
  }) => {
    if (options?.append) {
      if (isLoadingMoreChats || !chatCursor) {
        return;
      }
      setIsLoadingMoreChats(true);
    } else if (!options?.silent) {
      setIsLoadingChats(true);
    }

    try {
      const nextChats = await fetchChats(
        options?.append ? chatCursor ?? undefined : undefined,
        CHAT_PAGE_SIZE,
      );

      if (options?.reset) {
        setChats(nextChats);
        setChatCursor(nextChats.length === CHAT_PAGE_SIZE ? nextChats.at(-1)?.activity_at ?? null : null);
        setHasMoreChats(nextChats.length === CHAT_PAGE_SIZE);
      } else if (options?.append) {
        setChats((current) => mergeChatSummaries(current, nextChats));
        setChatCursor(nextChats.length === CHAT_PAGE_SIZE ? nextChats.at(-1)?.activity_at ?? null : null);
        setHasMoreChats(nextChats.length === CHAT_PAGE_SIZE);
      } else {
        setChats((current) => mergeChatSummaries(current, nextChats));
      }

      setChatError(null);
    } catch (error) {
      if (!options?.silent) {
        setChatError(error instanceof Error ? error.message : "Failed to load chats.");
      }
    } finally {
      if (options?.append) {
        setIsLoadingMoreChats(false);
      } else if (!options?.silent) {
        setIsLoadingChats(false);
      }
    }
  };

  const loadMessages = async (chatId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoadingMessages(true);
    }

    try {
      const nextMessages = await fetchMessages(chatId);
      setMessages((current) => mergeDraftMessages(current, nextMessages));
      setChats((current) =>
        current.map((chat) => (chat.id === chatId ? { ...chat, unread_count: 0 } : chat)),
      );
      setChatError(null);
    } catch (error) {
      if (!options?.silent) {
        setChatError(error instanceof Error ? error.message : "Failed to load messages.");
      }
    } finally {
      if (!options?.silent) {
        setIsLoadingMessages(false);
      }
    }
  };

  const resetRealtimeTimer = () => {
    if (realtimeTimeoutRef.current) {
      clearTimeout(realtimeTimeoutRef.current);
    }

    realtimeTimeoutRef.current = setTimeout(() => {
      if (realtimeChannelRef.current) {
        void supabase.removeChannel(realtimeChannelRef.current);
        realtimeChannelRef.current = null;
      }
      setRealtimeStatus("paused");
    }, REALTIME_IDLE_TIMEOUT_MS);
  };

  const stopRealtime = () => {
    if (realtimeTimeoutRef.current) {
      clearTimeout(realtimeTimeoutRef.current);
      realtimeTimeoutRef.current = null;
    }

    if (realtimeChannelRef.current) {
      void supabase.removeChannel(realtimeChannelRef.current);
      realtimeChannelRef.current = null;
    }

    setRealtimeStatus("off");
  };

  const startRealtime = (chatId: string) => {
    stopRealtime();

    const channel = supabase
      .channel(`chat:${chatId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `chat_id=eq.${chatId}`,
        },
        (payload) => {
          const message = payload.new as ChatMessage;
          setMessages((current) => {
            if (current.some((item) => item.id === message.id)) {
              return current;
            }

            return [...current, message];
          });
          setChats((current) =>
            sortChatsByActivity(
              current.map((chat) =>
                chat.id === chatId
                  ? {
                      ...chat,
                      last_message: message.body,
                      last_message_at: message.created_at,
                      activity_at: message.created_at,
                      unread_count:
                        message.sender_id === currentUserId ? chat.unread_count : chat.unread_count + 1,
                    }
                  : chat,
              ),
            ),
          );
          void loadChats({ silent: true });
          resetRealtimeTimer();
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          setRealtimeStatus("live");
          resetRealtimeTimer();
        }
      });

    realtimeChannelRef.current = channel;
  };

  const ensureRealtime = () => {
    if (!selectedChatId) {
      return;
    }

    if (!realtimeChannelRef.current) {
      startRealtime(selectedChatId);
      return;
    }

    setRealtimeStatus("live");
    resetRealtimeTimer();
  };

  const handleSendCode = async () => {
    setIsSendingCode(true);
    setAuthError(null);

    try {
      const phone = normalizePhoneE164(phoneInput);
      const { error } = await supabase.auth.signInWithOtp({
        phone,
      });

      if (error) {
        throw error;
      }

      setPendingPhone(phone);
      setOtpInput("");
      startTransition(() => setCurrentScreen("otp-verify"));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to send code.";
      if (message.toLowerCase().includes("incorrect access_key")) {
        setAuthError("Supabase SMS provider is misconfigured: incorrect provider access key.");
      } else {
        setAuthError(message);
      }
    } finally {
      setIsSendingCode(false);
    }
  };

  const handleVerifyCode = async () => {
    setIsVerifyingCode(true);
    setAuthError(null);

    try {
      const { data, error } = await supabase.auth.verifyOtp({
        phone: pendingPhone,
        token: otpInput.trim(),
        type: "sms",
      });

      if (error) {
        throw error;
      }

      await applySession(data.session);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Failed to verify code.");
    } finally {
      setIsVerifyingCode(false);
    }
  };

  const handleSearch = async () => {
    setIsSearching(true);
    setSearchResults([]);
    setSearchError(null);

    try {
      const username = searchInput.trim().toLowerCase();
      const results = await searchUserByUsername(username);

      if (!results.length) {
        setSearchError("No user found for that username.");
        return;
      }

      setSearchResults(results);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search failed.";
      setSearchError(message);
    } finally {
      setIsSearching(false);
    }
  };

  const handleDiscoverContacts = async () => {
    if (Platform.OS === "web") {
      setContactError("Contacts discovery is available on iPhone and Android.");
      return;
    }

    setIsDiscoveringContacts(true);
    setContactError(null);

    try {
      const permission = await Contacts.requestPermissionsAsync();
      if (permission.status !== "granted") {
        throw new Error("Contacts permission was denied.");
      }

      const response = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
        pageSize: 1000,
      });

      const phones = new Set<string>();

      for (const contact of response.data) {
        for (const entry of contact.phoneNumbers ?? []) {
          if (!entry.number) {
            continue;
          }

          try {
            phones.add(normalizePhoneE164(entry.number));
          } catch {
            // Ignore non-E.164 compatible numbers from the address book.
          }
        }
      }

      const results = await discoverContacts([...phones]);
      setContactResults(results);
    } catch (error) {
      setContactError(
        error instanceof Error ? error.message : "Failed to discover contacts.",
      );
    } finally {
      setIsDiscoveringContacts(false);
    }
  };

  const handleOpenDirectChat = async (peer: UserProfile) => {
    setIsOpeningChat(true);
    setSearchError(null);

    try {
      const chat = await openDirectChat(peer.id);
      setChats((current) => {
        const withoutCurrent = current.filter((item) => item.id !== chat.id);
        return sortChatsByActivity([chat, ...withoutCurrent]);
      });
      selectChat(chat.id, chat.peer.phone_e164);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Failed to open chat.");
    } finally {
      setIsOpeningChat(false);
    }
  };

  const handleSelectChat = (chat: ChatSummary) => {
    setChats((current) =>
      current.map((item) => (item.id === chat.id ? { ...item, unread_count: 0 } : item)),
    );
    selectChat(chat.id, chat.peer.phone_e164);
  };

  const runClearHistory = async (scope: ClearChatScope) => {
    if (!selectedChatId) {
      return;
    }

    try {
      await clearChatHistory(selectedChatId, scope);
      setMessages([]);
      await loadChats({ reset: true, silent: true });
      if (selectedChatId) {
        await loadMessages(selectedChatId, { silent: true });
      }
      setChatError(null);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to clear chat history.");
    }
  };

  const handleClearHistory = () => {
    if (!selectedChatId) {
      return;
    }

    if (Platform.OS === "web") {
      const confirmOnWeb = (globalThis as { confirm?: (message: string) => boolean }).confirm;
      if (typeof confirmOnWeb === "function" && confirmOnWeb("Clear history only for you?")) {
        void runClearHistory("self_only");
        return;
      }
      if (typeof confirmOnWeb === "function" && confirmOnWeb("Clear history for both participants?")) {
        void runClearHistory("everyone");
      }
      return;
    }

    Alert.alert("Clear history", "Choose how to clear this chat.", [
      {
        style: "cancel",
        text: "Cancel",
      },
      {
        text: "Only for me",
        onPress: () => {
          void runClearHistory("self_only");
        },
      },
      {
        style: "destructive",
        text: "For everyone",
        onPress: () => {
          void runClearHistory("everyone");
        },
      },
    ]);
  };

  const handleSendMessage = async () => {
    const body = draft.trim();

    if (!selectedChatId || !body) {
      return;
    }

    ensureRealtime();
    setIsSendingMessage(true);
    setChatError(null);

    const tempId = `temp-${Date.now()}`;
    const optimisticMessage: DraftMessage = {
      id: tempId,
      chat_id: selectedChatId,
      sender_id: currentUserId ?? "unknown",
      body,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      receipt_status: "sent",
      status: "pending",
    };

    setDraft("");
    setMessages((current) => [...current, optimisticMessage]);

    try {
      const saved = await sendMessageRequest(selectedChatId, body);
      setMessages((current) => {
        const next = current.map((message) => (message.id === tempId ? saved : message));
        return next.filter(
          (message, index, collection) =>
            collection.findIndex((candidate) => candidate.id === message.id) === index,
        );
      });
      setChats((current) =>
        sortChatsByActivity(
          current.map((chat) =>
            chat.id === selectedChatId
              ? {
                  ...chat,
                  last_message: saved.body,
                  last_message_at: saved.created_at,
                  activity_at: saved.created_at,
                }
              : chat,
          ),
        ),
      );
      void loadChats({ silent: true });
      resetRealtimeTimer();
    } catch (error) {
      setMessages((current) =>
        current.map((message) =>
          message.id === tempId
            ? {
                ...message,
                status: "failed",
                error: error instanceof Error ? error.message : "Failed to send message.",
              }
            : message,
        ),
      );
      setChatError(error instanceof Error ? error.message : "Failed to send message.");
    } finally {
      setIsSendingMessage(false);
    }
  };

  const handleSaveProfile = async () => {
    setIsSavingProfile(true);
    setProfileError(null);

    try {
      const nextProfile = await updateMyProfile({
        username: profileUsernameInput.trim() || null,
        avatar_path: meProfile?.avatar_path ?? null,
      });
      setMeProfile(nextProfile);
      setCurrentUserPhone(nextProfile.phone_e164);
      startTransition(() => setCurrentScreen("chat-list"));
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Failed to save profile.");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleUploadAvatar = async () => {
    if (!currentUserId) {
      return;
    }

    setIsUploadingAvatar(true);
    setProfileError(null);

    try {
      const avatarPath = await pickAndUploadAvatar(currentUserId);
      if (!avatarPath) {
        return;
      }

      const nextProfile = await updateMyProfile({
        username: profileUsernameInput.trim() || null,
        avatar_path: avatarPath,
      });
      setMeProfile(nextProfile);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Failed to upload avatar.");
    } finally {
      setIsUploadingAvatar(false);
    }
  };

  const handleRemoveAvatar = async () => {
    setIsSavingProfile(true);
    setProfileError(null);

    try {
      const nextProfile = await updateMyProfile({
        username: profileUsernameInput.trim() || null,
        avatar_path: null,
      });
      setMeProfile(nextProfile);
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Failed to remove avatar.");
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleLogout = async () => {
    stopRealtime();

    if (pushTokenRef.current && Platform.OS !== "web") {
      try {
        await removePushToken(pushTokenRef.current, nativePlatform());
      } catch {
        // Ignore stale push token cleanup failures on logout.
      }
    }

    await supabase.auth.signOut();
    pushTokenRef.current = null;
    reset();
    setPhoneInput("");
    setOtpInput("");
    setSearchInput("");
    setDraft("");
    setContactResults([]);
    setSearchResults([]);
  };

  const renderPhoneAuth = () => (
    <View style={styles.screenCard}>
      <Text style={styles.kicker}>Messenger</Text>
      <Text style={styles.title}>Sign in with your phone number.</Text>
      <Text style={styles.subtitle}>
        Enter a real phone number in international format. Supabase will send a one-time code.
      </Text>

      <Text style={styles.label}>Phone number</Text>
      <TextInput
        style={styles.input}
        value={phoneInput}
        onChangeText={setPhoneInput}
        placeholder="+380..."
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor="#8a8f9f"
      />

      {authError ? <Text style={styles.errorText}>{authError}</Text> : null}

      <Pressable style={styles.primaryButton} onPress={handleSendCode} disabled={isSendingCode}>
        <Text style={styles.primaryButtonText}>
          {isSendingCode ? "Sending..." : "Send code"}
        </Text>
      </Pressable>
    </View>
  );

  const renderOtpVerify = () => (
    <View style={styles.screenCard}>
      <Text style={styles.kicker}>Verify</Text>
      <Text style={styles.title}>Enter the code from SMS.</Text>
      <Text style={styles.subtitle}>Code sent to {pendingPhone}</Text>

      <Text style={styles.label}>Code</Text>
      <TextInput
        style={styles.input}
        value={otpInput}
        onChangeText={setOtpInput}
        placeholder="123456"
        keyboardType="number-pad"
        placeholderTextColor="#8a8f9f"
      />

      {authError ? <Text style={styles.errorText}>{authError}</Text> : null}

      <Pressable
        style={styles.primaryButton}
        onPress={handleVerifyCode}
        disabled={isVerifyingCode}
      >
        <Text style={styles.primaryButtonText}>
          {isVerifyingCode ? "Verifying..." : "Verify"}
        </Text>
      </Pressable>

      <Pressable
        style={styles.secondaryButton}
        onPress={handleSendCode}
        disabled={isSendingCode}
      >
        <Text style={styles.secondaryButtonText}>Resend code</Text>
      </Pressable>

      <Pressable
        style={styles.linkButton}
        onPress={() => startTransition(() => setCurrentScreen("phone-auth"))}
      >
        <Text style={styles.linkButtonText}>Change phone number</Text>
      </Pressable>
    </View>
  );

  const renderChatList = () => (
    <View style={styles.flex}>
      <View style={styles.topBar}>
        <View style={styles.rowGap}>
          <Text style={styles.topBarTitle}>Chats</Text>
          <Text style={styles.topBarSubtitle}>{meProfile?.phone_e164 ?? currentUserPhone ?? "Signed in"}</Text>
        </View>
        <View style={styles.topBarActions}>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => startTransition(() => setCurrentScreen("profile"))}
          >
            <Text style={styles.secondaryButtonText}>Profile</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={handleLogout}>
            <Text style={styles.secondaryButtonText}>Log out</Text>
          </Pressable>
        </View>
      </View>

      <Pressable
        style={styles.primaryButton}
        onPress={() => startTransition(() => setCurrentScreen("search-user"))}
      >
        <Text style={styles.primaryButtonText}>Find by username</Text>
      </Pressable>

      {authError ? <Text style={styles.errorText}>{authError}</Text> : null}
      {chatError ? <Text style={styles.errorText}>{chatError}</Text> : null}

      {isLoadingChats ? (
        <ActivityIndicator color="#17305e" style={styles.loader} />
      ) : (
        <FlatList
          data={chats}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onEndReached={() => {
            if (hasMoreChats) {
              void loadChats({ append: true });
            }
          }}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            <Text style={styles.emptyState}>No chats yet. Search by username or discover contacts.</Text>
          }
          ListFooterComponent={
            isLoadingMoreChats ? <ActivityIndicator color="#17305e" style={styles.loader} /> : null
          }
          renderItem={({ item }) => (
            <Pressable style={styles.chatRow} onPress={() => handleSelectChat(item)}>
              <Avatar profile={item.peer} size={52} />
              <View style={styles.chatRowBody}>
                <View style={styles.chatRowHeader}>
                  <Text style={styles.chatPeer}>{displayName(item.peer)}</Text>
                  {item.peer.is_online ? <View style={styles.onlineDot} /> : null}
                </View>
                <Text style={styles.chatSubline}>{item.peer.phone_e164}</Text>
                <Text style={styles.chatPreview} numberOfLines={1}>
                  {item.last_message ?? "No messages yet"}
                </Text>
              </View>
              <View style={styles.chatMetaWrap}>
                <Text style={styles.chatMeta}>{formatTime(item.last_message_at ?? item.activity_at)}</Text>
                {item.unread_count > 0 ? (
                  <View style={styles.unreadBadge}>
                    <Text style={styles.unreadBadgeText}>{item.unread_count}</Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );

  const renderProfile = () => (
    <ScrollView style={styles.flex} contentContainerStyle={styles.profileContent}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>Profile</Text>
          <Text style={styles.topBarSubtitle}>Username, avatar, visible status</Text>
        </View>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => startTransition(() => setCurrentScreen("chat-list"))}
        >
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
      </View>

      <View style={styles.profileCard}>
        <View style={styles.profileHero}>
          <Avatar profile={meProfile} size={92} />
          <View style={styles.profileHeroBody}>
            <Text style={styles.profileTitle}>{displayName(meProfile)}</Text>
            <Text style={styles.profileSubtitle}>{meProfile?.phone_e164}</Text>
            <Text style={styles.profilePresenceCopy}>
              You appear online while the app is active. {profilePresence(meProfile)}
            </Text>
          </View>
        </View>

        <View style={styles.profileActions}>
          <Pressable
            style={styles.secondaryButton}
            onPress={handleUploadAvatar}
            disabled={isUploadingAvatar}
          >
            <Text style={styles.secondaryButtonText}>
              {isUploadingAvatar ? "Uploading..." : "Choose avatar"}
            </Text>
          </Pressable>
          {meProfile?.avatar_path ? (
            <Pressable
              style={styles.secondaryButton}
              onPress={handleRemoveAvatar}
              disabled={isSavingProfile}
            >
              <Text style={styles.secondaryButtonText}>Remove avatar</Text>
            </Pressable>
          ) : null}
        </View>

        <Text style={styles.label}>Username</Text>
        <TextInput
          style={styles.input}
          value={profileUsernameInput}
          onChangeText={setProfileUsernameInput}
          placeholder="Choose a unique username"
          placeholderTextColor="#8a8f9f"
          autoCapitalize="none"
          autoCorrect={false}
        />

        {profileError ? <Text style={styles.errorText}>{profileError}</Text> : null}

        <Pressable
          style={styles.primaryButton}
          onPress={handleSaveProfile}
          disabled={isSavingProfile}
        >
          <Text style={styles.primaryButtonText}>
            {isSavingProfile ? "Saving..." : "Save profile"}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );

  const renderSearch = () => (
    <ScrollView style={styles.flex} contentContainerStyle={styles.profileContent}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>Find user</Text>
          <Text style={styles.topBarSubtitle}>Exact username search or contact discovery</Text>
        </View>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            setSearchResults([]);
            setSearchError(null);
            setContactError(null);
            startTransition(() => setCurrentScreen("chat-list"));
          }}
        >
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
      </View>

      <View style={styles.profileCard}>
        <Text style={styles.label}>Username</Text>
        <TextInput
          style={styles.input}
          value={searchInput}
          onChangeText={setSearchInput}
          placeholder="username"
          autoCapitalize="none"
          autoCorrect={false}
          placeholderTextColor="#8a8f9f"
        />

        <Pressable style={styles.primaryButton} onPress={handleSearch} disabled={isSearching}>
          <Text style={styles.primaryButtonText}>{isSearching ? "Searching..." : "Search"}</Text>
        </Pressable>

        <Pressable
          style={styles.secondaryButton}
          onPress={handleDiscoverContacts}
          disabled={isDiscoveringContacts}
        >
          <Text style={styles.secondaryButtonText}>
            {isDiscoveringContacts ? "Discovering..." : "Discover from contacts"}
          </Text>
        </Pressable>

        {searchError ? <Text style={styles.errorText}>{searchError}</Text> : null}
        {contactError ? <Text style={styles.errorText}>{contactError}</Text> : null}
      </View>

      {searchCandidates.map((candidate) => (
        <View key={candidate.id} style={styles.resultCard}>
          <View style={styles.resultHeader}>
            <Avatar profile={candidate} size={52} />
            <View style={styles.resultBody}>
              <Text style={styles.resultTitle}>{displayName(candidate)}</Text>
              <Text style={styles.chatSubline}>
                {candidate.username ? `@${candidate.username}` : candidate.phone_e164}
              </Text>
              <Text style={styles.chatPreview}>{profilePresence(candidate)}</Text>
            </View>
          </View>
          <Pressable
            style={styles.primaryButton}
            onPress={() => handleOpenDirectChat(candidate)}
            disabled={isOpeningChat}
          >
            <Text style={styles.primaryButtonText}>
              {isOpeningChat ? "Opening..." : "Open chat"}
            </Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );

  const renderChat = () => (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.flex}
    >
      <View style={styles.topBar}>
        <View style={styles.chatHeader}>
          <Avatar profile={selectedChat?.peer} size={46} />
          <View>
            <Text style={styles.topBarTitle}>{displayName(selectedChat?.peer)}</Text>
            <Text style={styles.topBarSubtitle}>
              {profilePresence(selectedChat?.peer)} ·{" "}
              {realtimeStatus === "live"
                ? "Live"
                : realtimeStatus === "paused"
                  ? "Paused"
                  : "Connecting"}
            </Text>
          </View>
        </View>
        <View style={styles.topBarActions}>
          <Pressable
            style={styles.secondaryButton}
            onPress={handleClearHistory}
          >
            <Text style={styles.secondaryButtonText}>Clear history</Text>
          </Pressable>
          <Pressable
            style={styles.secondaryButton}
            onPress={() => {
              stopRealtime();
              clearSelectedChat();
              setMessages([]);
              startTransition(() => setCurrentScreen("chat-list"));
            }}
          >
            <Text style={styles.secondaryButtonText}>Back</Text>
          </Pressable>
        </View>
      </View>

      {chatError ? <Text style={styles.errorText}>{chatError}</Text> : null}

      {isLoadingMessages ? (
        <ActivityIndicator color="#17305e" style={styles.loader} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          renderItem={({ item }) => {
            const isOwn = item.sender_id === currentUserId;
            return (
              <View style={[styles.messageRow, isOwn ? styles.messageRowOwn : styles.messageRowPeer]}>
                <View style={[styles.messageBubble, isOwn ? styles.ownBubble : styles.peerBubble]}>
                  <Text style={[styles.messageBody, isOwn && styles.ownMessageBody]}>{item.body}</Text>
                  <Text style={[styles.messageMeta, isOwn && styles.ownMessageMeta]}>
                    {formatTime(item.created_at)}
                    {item.status === "pending" ? " · Sending" : ""}
                    {item.status === "failed" ? " · Failed" : ""}
                  </Text>
                  {isOwn && !item.status ? (
                    <Text style={[styles.messageMeta, styles.statusCopy, styles.ownMessageMeta]}>
                      {receiptCopy(item.receipt_status)}
                    </Text>
                  ) : null}
                  {item.error ? (
                    <Text style={[styles.messageMeta, styles.failedMessageText]}>{item.error}</Text>
                  ) : null}
                </View>
              </View>
            );
          }}
          ListEmptyComponent={<Text style={styles.emptyState}>No messages yet.</Text>}
        />
      )}

      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={draft}
          onChangeText={setDraft}
          placeholder="Message"
          placeholderTextColor="#8a8f9f"
          multiline
          onFocus={ensureRealtime}
        />
        <Pressable
          style={styles.primaryButton}
          onPress={handleSendMessage}
          disabled={isSendingMessage || draft.trim().length === 0}
        >
          <Text style={styles.primaryButtonText}>{isSendingMessage ? "Sending..." : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.appShell}>
        {isBooting || currentScreen === "booting" ? (
          <ActivityIndicator color="#17305e" style={styles.loader} />
        ) : null}

        {!isBooting && currentScreen === "phone-auth" ? renderPhoneAuth() : null}
        {!isBooting && currentScreen === "otp-verify" ? renderOtpVerify() : null}
        {!isBooting && currentScreen === "chat-list" ? renderChatList() : null}
        {!isBooting && currentScreen === "profile" ? renderProfile() : null}
        {!isBooting && currentScreen === "search-user" ? renderSearch() : null}
        {!isBooting && currentScreen === "chat" ? renderChat() : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#f4f1eb",
  },
  appShell: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  flex: {
    flex: 1,
  },
  rowGap: {
    gap: 2,
  },
  screenCard: {
    backgroundColor: "#fffdf8",
    borderColor: "#ddd5c8",
    borderRadius: 28,
    borderWidth: 1,
    gap: 12,
    marginTop: 48,
    padding: 22,
  },
  kicker: {
    color: "#7f6a51",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  title: {
    color: "#18243d",
    fontSize: 28,
    fontWeight: "800",
    lineHeight: 34,
  },
  subtitle: {
    color: "#566074",
    fontSize: 15,
    lineHeight: 22,
  },
  topBar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  topBarActions: {
    flexDirection: "row",
    gap: 8,
  },
  chatHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    maxWidth: "74%",
  },
  topBarTitle: {
    color: "#18243d",
    fontSize: 24,
    fontWeight: "800",
  },
  topBarSubtitle: {
    color: "#637089",
    fontSize: 13,
    marginTop: 2,
  },
  label: {
    color: "#637089",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  input: {
    backgroundColor: "#fffdf8",
    borderColor: "#d8d0c2",
    borderRadius: 18,
    borderWidth: 1,
    color: "#18243d",
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  primaryButton: {
    alignItems: "center",
    backgroundColor: "#183055",
    borderRadius: 18,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  primaryButtonText: {
    color: "#fffdf8",
    fontSize: 15,
    fontWeight: "800",
  },
  secondaryButton: {
    alignItems: "center",
    borderColor: "#c9cfdb",
    borderRadius: 14,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 42,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: "#183055",
    fontSize: 14,
    fontWeight: "700",
  },
  linkButton: {
    alignItems: "center",
    paddingVertical: 8,
  },
  linkButtonText: {
    color: "#183055",
    fontSize: 14,
    fontWeight: "700",
  },
  errorText: {
    color: "#b3261e",
    fontSize: 13,
    lineHeight: 18,
  },
  loader: {
    marginTop: 40,
  },
  listContent: {
    gap: 12,
    paddingBottom: 24,
  },
  chatRow: {
    alignItems: "center",
    backgroundColor: "#fffdf8",
    borderColor: "#ddd5c8",
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  chatRowBody: {
    flex: 1,
    gap: 2,
  },
  chatRowHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
  },
  chatPeer: {
    color: "#18243d",
    fontSize: 16,
    fontWeight: "700",
  },
  chatSubline: {
    color: "#637089",
    fontSize: 12,
  },
  chatPreview: {
    color: "#647188",
    fontSize: 13,
  },
  chatMetaWrap: {
    alignItems: "flex-end",
    gap: 8,
  },
  chatMeta: {
    color: "#8a8f9f",
    fontSize: 12,
  },
  unreadBadge: {
    alignItems: "center",
    backgroundColor: "#183055",
    borderRadius: 999,
    justifyContent: "center",
    minWidth: 24,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  unreadBadgeText: {
    color: "#fffdf8",
    fontSize: 12,
    fontWeight: "800",
  },
  onlineDot: {
    backgroundColor: "#2f9e44",
    borderRadius: 999,
    height: 8,
    width: 8,
  },
  emptyState: {
    color: "#647188",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 24,
    textAlign: "center",
  },
  profileContent: {
    gap: 16,
    paddingBottom: 32,
  },
  profileCard: {
    backgroundColor: "#fffdf8",
    borderColor: "#ddd5c8",
    borderRadius: 24,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  profileHero: {
    alignItems: "center",
    flexDirection: "row",
    gap: 16,
  },
  profileHeroBody: {
    flex: 1,
    gap: 4,
  },
  profileTitle: {
    color: "#18243d",
    fontSize: 20,
    fontWeight: "800",
  },
  profileSubtitle: {
    color: "#637089",
    fontSize: 13,
  },
  profilePresenceCopy: {
    color: "#647188",
    fontSize: 13,
    lineHeight: 18,
  },
  profileActions: {
    flexDirection: "row",
    gap: 10,
  },
  resultCard: {
    backgroundColor: "#fffdf8",
    borderColor: "#ddd5c8",
    borderRadius: 22,
    borderWidth: 1,
    gap: 16,
    padding: 18,
  },
  resultHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
  },
  resultBody: {
    flex: 1,
    gap: 2,
  },
  resultTitle: {
    color: "#18243d",
    fontSize: 18,
    fontWeight: "800",
  },
  avatarImage: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#d8d0c2",
  },
  avatarFrame: {
    backgroundColor: "#d8d0c2",
    overflow: "hidden",
  },
  avatarFallback: {
    alignItems: "center",
    backgroundColor: "#183055",
    justifyContent: "center",
  },
  avatarFallbackText: {
    color: "#fffdf8",
    fontSize: 18,
    fontWeight: "800",
  },
  messageList: {
    gap: 12,
    paddingBottom: 20,
  },
  messageRow: {
    flexDirection: "row",
  },
  messageRowOwn: {
    justifyContent: "flex-end",
  },
  messageRowPeer: {
    justifyContent: "flex-start",
  },
  messageBubble: {
    borderRadius: 20,
    maxWidth: "84%",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  ownBubble: {
    backgroundColor: "#183055",
  },
  peerBubble: {
    backgroundColor: "#fffdf8",
    borderColor: "#ddd5c8",
    borderWidth: 1,
  },
  messageBody: {
    color: "#18243d",
    fontSize: 15,
    lineHeight: 20,
  },
  ownMessageBody: {
    color: "#fffdf8",
  },
  messageMeta: {
    color: "#70809b",
    fontSize: 11,
    marginTop: 6,
  },
  ownMessageMeta: {
    color: "#cbd6ed",
  },
  statusCopy: {
    fontWeight: "700",
  },
  failedMessageText: {
    color: "#b3261e",
  },
  composer: {
    borderTopColor: "#ddd5c8",
    borderTopWidth: 1,
    gap: 12,
    paddingTop: 12,
  },
  composerInput: {
    backgroundColor: "#fffdf8",
    borderColor: "#d8d0c2",
    borderRadius: 18,
    borderWidth: 1,
    color: "#18243d",
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
