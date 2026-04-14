import "react-native-url-polyfill/auto";

import { useEffect, useMemo, useRef, useState, startTransition } from "react";
import { StatusBar } from "expo-status-bar";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  type ChatMessage,
  type ChatSummary,
  type UserProfile,
  fetchChats,
  fetchMe,
  fetchMessages,
  openDirectChat,
  searchUserByPhone,
  sendMessage as sendMessageRequest,
} from "./src/lib/api";
import { normalizePhoneE164 } from "./src/lib/phone";
import { supabase } from "./src/lib/supabase";
import { useSessionStore } from "./src/store/session";

type DraftMessage = ChatMessage & {
  status?: "pending" | "failed";
  error?: string;
};

const REALTIME_IDLE_TIMEOUT_MS = 60_000;
const CHAT_LIST_SYNC_INTERVAL_MS = 1_500;
const CHAT_MESSAGES_SYNC_INTERVAL_MS = 1_000;

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

const sortChatsByActivity = (items: ChatSummary[]) =>
  [...items].sort((left, right) => {
    const leftTime = left.last_message_at ?? "";
    const rightTime = right.last_message_at ?? "";
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

export default function App() {
  const {
    session,
    currentScreen,
    pendingPhone,
    currentUserPhone,
    selectedChatId,
    selectedChatPeerPhone,
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
  const [searchResult, setSearchResult] = useState<UserProfile | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [chatError, setChatError] = useState<string | null>(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isSendingCode, setIsSendingCode] = useState(false);
  const [isVerifyingCode, setIsVerifyingCode] = useState(false);
  const [isLoadingChats, setIsLoadingChats] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isOpeningChat, setIsOpeningChat] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSendingMessage, setIsSendingMessage] = useState(false);
  const listRef = useRef<FlatList<DraftMessage>>(null);
  const realtimeChannelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const realtimeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatListSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const chatMessagesSyncRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const currentUserId = session?.user.id ?? null;
  const selectedChat = useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? null,
    [chats, selectedChatId],
  );

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

    return () => {
      subscription.unsubscribe();
      if (chatListSyncRef.current) {
        clearInterval(chatListSyncRef.current);
        chatListSyncRef.current = null;
      }
      if (chatMessagesSyncRef.current) {
        clearInterval(chatMessagesSyncRef.current);
        chatMessagesSyncRef.current = null;
      }
      stopRealtime();
    };
  }, []);

  useEffect(() => {
    if (!session || currentScreen !== "chat-list") {
      if (chatListSyncRef.current) {
        clearInterval(chatListSyncRef.current);
        chatListSyncRef.current = null;
      }
      return;
    }

    void loadChats();

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

  const applySession = async (nextSession: typeof session) => {
    setSession(nextSession);

    if (!nextSession) {
      setAuthStatus("signed-out");
      setCurrentUserPhone(null);
      setPendingPhone("");
      clearSelectedChat();
      setChats([]);
      setMessages([]);
      startTransition(() => setCurrentScreen("phone-auth"));
      return;
    }

    setAuthStatus("signed-in");

    try {
      const me = await fetchMe();
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

  const loadChats = async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setIsLoadingChats(true);
    }

    try {
      const nextChats = await fetchChats();
      setChats((current) => mergeChatSummaries(current, nextChats));
      setChatError(null);
    } catch (error) {
      if (!options?.silent) {
        setChatError(error instanceof Error ? error.message : "Failed to load chats.");
      }
    } finally {
      if (!options?.silent) {
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
                    }
                  : chat,
              ),
            ),
          );
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
      setAuthError(error instanceof Error ? error.message : "Failed to send code.");
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
    setSearchResult(null);
    setSearchError(null);

    try {
      const phone = normalizePhoneE164(searchInput);
      const result = await searchUserByPhone(phone);
      setSearchResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Search failed.";
      if (message.toLowerCase().includes("not found")) {
        setSearchResult(null);
        setSearchError("No user found for that phone number.");
      } else {
        setSearchError(message);
      }
    } finally {
      setIsSearching(false);
    }
  };

  const handleOpenDirectChat = async (peerUserId: string) => {
    setIsOpeningChat(true);
    setSearchError(null);

    try {
      const chat = await openDirectChat(peerUserId);
      setChats((current) => {
        const withoutCurrent = current.filter((item) => item.id !== chat.id);
        return [chat, ...withoutCurrent];
      });
      selectChat(chat.id, chat.peer.phone_e164);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Failed to open chat.");
    } finally {
      setIsOpeningChat(false);
    }
  };

  const handleSelectChat = (chat: ChatSummary) => {
    selectChat(chat.id, chat.peer.phone_e164);
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

  const handleLogout = async () => {
    stopRealtime();
    await supabase.auth.signOut();
    reset();
    setPhoneInput("");
    setOtpInput("");
    setSearchInput("");
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
        <View>
          <Text style={styles.topBarTitle}>Chats</Text>
          <Text style={styles.topBarSubtitle}>{currentUserPhone ?? "Signed in"}</Text>
        </View>
        <Pressable style={styles.secondaryButton} onPress={handleLogout}>
          <Text style={styles.secondaryButtonText}>Log out</Text>
        </Pressable>
      </View>

      <Pressable
        style={styles.primaryButton}
        onPress={() => startTransition(() => setCurrentScreen("search-user"))}
      >
        <Text style={styles.primaryButtonText}>Find by phone</Text>
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
          ListEmptyComponent={
            <Text style={styles.emptyState}>No chats yet. Search by a full phone number.</Text>
          }
          renderItem={({ item }) => (
            <Pressable style={styles.chatRow} onPress={() => handleSelectChat(item)}>
              <View style={styles.chatRowBody}>
                <Text style={styles.chatPeer}>{item.peer.phone_e164}</Text>
                <Text style={styles.chatPreview} numberOfLines={1}>
                  {item.last_message ?? "No messages yet"}
                </Text>
              </View>
              <Text style={styles.chatMeta}>{formatTime(item.last_message_at)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );

  const renderSearch = () => (
    <View style={styles.flex}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>Find user</Text>
          <Text style={styles.topBarSubtitle}>Exact match by E.164 number</Text>
        </View>
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            setSearchResult(null);
            setSearchError(null);
            startTransition(() => setCurrentScreen("chat-list"));
          }}
        >
          <Text style={styles.secondaryButtonText}>Back</Text>
        </Pressable>
      </View>

      <Text style={styles.label}>Phone number</Text>
      <TextInput
        style={styles.input}
        value={searchInput}
        onChangeText={setSearchInput}
        placeholder="+380..."
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor="#8a8f9f"
      />

      <Pressable style={styles.primaryButton} onPress={handleSearch} disabled={isSearching}>
        <Text style={styles.primaryButtonText}>{isSearching ? "Searching..." : "Search"}</Text>
      </Pressable>

      {searchError ? <Text style={styles.errorText}>{searchError}</Text> : null}

      {searchResult ? (
        <View style={styles.resultCard}>
          <Text style={styles.resultTitle}>{searchResult.phone_e164}</Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => handleOpenDirectChat(searchResult.id)}
            disabled={isOpeningChat}
          >
            <Text style={styles.primaryButtonText}>
              {isOpeningChat ? "Opening..." : "Open chat"}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  const renderChat = () => (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={styles.flex}
    >
      <View style={styles.topBar}>
        <View>
          <Text style={styles.topBarTitle}>{selectedChatPeerPhone ?? selectedChat?.peer.phone_e164}</Text>
          <Text style={styles.topBarSubtitle}>
            {realtimeStatus === "live"
              ? "Live"
              : realtimeStatus === "paused"
                ? "Paused after inactivity"
                : "Connecting"}
          </Text>
        </View>
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
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  chatRowBody: {
    flex: 1,
    gap: 4,
    marginRight: 12,
  },
  chatPeer: {
    color: "#18243d",
    fontSize: 16,
    fontWeight: "700",
  },
  chatPreview: {
    color: "#647188",
    fontSize: 13,
  },
  chatMeta: {
    color: "#8a8f9f",
    fontSize: 12,
  },
  emptyState: {
    color: "#647188",
    fontSize: 14,
    lineHeight: 20,
    marginTop: 24,
    textAlign: "center",
  },
  resultCard: {
    backgroundColor: "#fffdf8",
    borderColor: "#ddd5c8",
    borderRadius: 22,
    borderWidth: 1,
    gap: 16,
    marginTop: 20,
    padding: 18,
  },
  resultTitle: {
    color: "#18243d",
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
