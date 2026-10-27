import { Platform } from "react-native";

/**
 * Static web exports can be copied between isolated previews. Never use their
 * build-time hostname in a browser: the API lives at /api on the page's origin.
 * Metro/Expo Go use a separate host, so development and native clients retain
 * the injected API domain. Return only the origin: generated paths include /api.
 */
export function getApiBaseUrl(): string {
  if (Platform.OS === "web" && !__DEV__ && typeof window !== "undefined") {
    return window.location.origin;
  }
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  return domain ? `https://${domain}` : "http://localhost:8080";
}

export function getLegacyApiBase(): string {
  return `${getApiBaseUrl()}/api`;
}
