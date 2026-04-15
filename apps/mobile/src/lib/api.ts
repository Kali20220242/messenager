import { env } from "./env";
import { supabase } from "./supabase";

export type ReceiptStatus = "sent" | "delivered" | "seen";

export type UserProfile = {
  id: string;
  phone_e164: string;
  username: string | null;
  avatar_path: string | null;
  last_seen_at: string | null;
  is_online: boolean;
};

export type MeProfile = UserProfile;

export type ChatSummary = {
  id: string;
  peer: UserProfile;
  last_message: string | null;
  last_message_at: string | null;
  activity_at: string;
  unread_count: number;
};

export type ChatMessage = {
  id: string;
  chat_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  receipt_status?: ReceiptStatus | null;
};

type ApiMethod = "GET" | "POST" | "PATCH" | "DELETE";
export type ClearChatScope = "self_only" | "everyone";

type ApiRequestInit = {
  method?: ApiMethod;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

async function getAccessToken() {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const token = session?.access_token;

  if (!token) {
    throw new Error("No active auth session.");
  }

  return token;
}

function isInvalidBearerToken(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid bearer token")
    || normalized.includes("missing authorization header")
    || normalized.includes("expected bearer token")
  );
}

async function apiRequest<T>(
  path: string,
  init: ApiRequestInit = {},
  allowRetry = true,
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${env.EXPO_PUBLIC_API_URL.replace(/\/$/, "")}${path}`);

  if (init.query) {
    for (const [key, value] of Object.entries(init.query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;

    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) {
        message = payload.error;
      }
    } catch {
      // Use fallback status-based message.
    }

    if (response.status === 401 && allowRetry && isInvalidBearerToken(message)) {
      const { data, error } = await supabase.auth.refreshSession();

      if (!error && data.session) {
        return apiRequest<T>(path, init, false);
      }

      await supabase.auth.signOut();
      throw new Error("Session expired. Please sign in again.");
    }

    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function fetchMe() {
  return apiRequest<MeProfile>("/me");
}

export function updateMyProfile(payload: { username?: string | null; avatar_path?: string | null }) {
  return apiRequest<MeProfile>("/me", {
    method: "PATCH",
    body: payload,
  });
}

export function sendHeartbeat() {
  return apiRequest<void>("/presence/heartbeat", {
    method: "POST",
  });
}

export function upsertPushToken(expoPushToken: string, platform: "ios" | "android" | "web") {
  return apiRequest<void>("/devices/push-token", {
    method: "POST",
    body: {
      expo_push_token: expoPushToken,
      platform,
    },
  });
}

export function removePushToken(expoPushToken: string, platform: "ios" | "android" | "web") {
  return apiRequest<void>("/devices/push-token/remove", {
    method: "POST",
    body: {
      expo_push_token: expoPushToken,
      platform,
    },
  });
}

export function fetchChats(before?: string, limit = 30) {
  return apiRequest<ChatSummary[]>("/chats", {
    query: {
      before,
      limit,
    },
  });
}

export function searchUserByUsername(username: string) {
  return apiRequest<UserProfile[]>("/users/search", {
    query: { username },
  });
}

export function discoverContacts(phones: string[]) {
  return apiRequest<UserProfile[]>("/contacts/discover", {
    method: "POST",
    body: { phones },
  });
}

export function openDirectChat(peerUserId: string) {
  return apiRequest<ChatSummary>("/chats/direct", {
    method: "POST",
    body: {
      peer_user_id: peerUserId,
    },
  });
}

export function deleteChat(chatId: string) {
  return apiRequest<void>(`/chats/${chatId}`, {
    method: "DELETE",
  });
}

export function clearChatHistory(chatId: string, scope: ClearChatScope) {
  return apiRequest<void>(`/chats/${chatId}/clear`, {
    method: "POST",
    body: { scope },
  });
}

export function fetchMessages(chatId: string, before?: string, limit = 50) {
  return apiRequest<ChatMessage[]>(`/chats/${chatId}/messages`, {
    query: {
      before,
      limit,
    },
  });
}

export function sendMessage(chatId: string, body: string) {
  return apiRequest<ChatMessage>(`/chats/${chatId}/messages`, {
    method: "POST",
    body: { body },
  });
}
