import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";

import { registerPushToken } from "@workspace/api-client-react";

/**
 * Foreground notification behavior — show banner + play sound even when the
 * app is open. Mirrors what most native iOS/Android apps do for booking
 * status notifications. Configured once at module load.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowAlert: true,
  }),
});

/**
 * Best-effort push registration. Requests permission, fetches the Expo push
 * token tied to this app's projectId, and PUTs it to the server. All failures
 * are swallowed so a denied permission or a web/Expo Go limitation can never
 * block login.
 */
export async function registerForPushNotificationsAsync(): Promise<void> {
  try {
    // expo-notifications no longer supports remote push in Expo Go on Android
    // (SDK 53+). Skip silently — login should still succeed.
    if (Platform.OS === "web") return;

    const settings = await Notifications.getPermissionsAsync();
    let status = settings.status;
    if (status !== "granted") {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
    if (status !== "granted") return;

    // Android requires a default channel to receive any notifications at all.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "default",
        importance: Notifications.AndroidImportance.DEFAULT,
        sound: "default",
      });
    }

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;

    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined,
    );
    const token = tokenResp?.data;
    if (!token) return;

    await registerPushToken({ pushToken: token });
  } catch {
    // Swallow: permission denied, no projectId, web platform, or network blip.
  }
}

/** Clear the server-side push token (best-effort) — called on logout. */
export async function clearPushTokenOnServer(): Promise<void> {
  try {
    await registerPushToken({ pushToken: null });
  } catch {
    /* swallow */
  }
}
