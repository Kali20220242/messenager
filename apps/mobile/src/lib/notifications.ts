import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { env } from "./env";

export type E2EEPushData = {
  event?: string;
  chat_id?: string | null;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function registerForPushNotificationsAsync() {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", {
      name: "default",
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#183055",
    });
  }

  if (!Device.isDevice) {
    return null;
  }

  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    return null;
  }

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId
    ?? Constants.easConfig?.projectId
    ?? env.EXPO_PUBLIC_EAS_PROJECT_ID;

  if (!projectId) {
    return null;
  }

  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
}

export function parseE2EEPushData(
  notification: Notifications.Notification | Notifications.NotificationResponse["notification"],
): E2EEPushData | null {
  const data = notification.request.content.data as Record<string, unknown> | null | undefined;
  if (!data || data.event !== "e2ee_pending") {
    return null;
  }

  return {
    event: typeof data.event === "string" ? data.event : undefined,
    chat_id: typeof data.chat_id === "string" ? data.chat_id : null,
  };
}

export function getLastE2EEPushData(): E2EEPushData | null {
  const response = Notifications.getLastNotificationResponse();
  if (!response?.notification) {
    return null;
  }

  return parseE2EEPushData(response.notification);
}

export function clearLastE2EEPushData(): void {
  Notifications.clearLastNotificationResponse();
}

export function subscribeToE2EEPushWakeup(listener: (data: E2EEPushData) => void) {
  const receivedSubscription = Notifications.addNotificationReceivedListener((notification) => {
    const data = parseE2EEPushData(notification);
    if (data) {
      listener(data);
    }
  });

  const responseSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const data = parseE2EEPushData(response.notification);
    if (data) {
      listener(data);
    }
  });

  return () => {
    receivedSubscription.remove();
    responseSubscription.remove();
  };
}
