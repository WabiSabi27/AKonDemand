import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * AsyncStorage-backed token store for the mobile app.
 *
 * The token is the JWT issued by `POST /api/auth/{customer,business/login,admin}`.
 * It is read by `setAuthTokenGetter` in `_layout.tsx` so every generated API call
 * automatically attaches `Authorization: Bearer <token>` when one is present.
 */
const TOKEN_KEY = "akodd_token";

let cachedToken: string | null | undefined = undefined;

/**
 * Returns the current token, or null if the user is logged out.
 * The first call hits AsyncStorage; subsequent calls return a cached value to
 * avoid an async hop on every request. Use {@link setToken} to invalidate the
 * cache on login/logout.
 */
export async function getToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  const stored = await AsyncStorage.getItem(TOKEN_KEY);
  cachedToken = stored;
  return cachedToken;
}

/** Synchronous accessor for the cached token. Returns undefined if not yet hydrated. */
export function getCachedToken(): string | null | undefined {
  return cachedToken;
}

/** Persist the token (or clear it with `null`). Updates the in-memory cache too. */
export async function setToken(token: string | null): Promise<void> {
  cachedToken = token;
  if (token === null) {
    await AsyncStorage.removeItem(TOKEN_KEY);
  } else {
    await AsyncStorage.setItem(TOKEN_KEY, token);
  }
}

export { getApiBaseUrl, getLegacyApiBase } from "./apiBaseUrl";
