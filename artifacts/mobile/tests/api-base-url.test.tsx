import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "react-native";
import { getApiBaseUrl, getLegacyApiBase } from "../utils/apiBaseUrl";

const originalPlatform = Platform.OS;
afterEach(() => {
  Platform.OS = originalPlatform;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("API origin routing", () => {
  it.each([
    "https://fork-preview.example.test",
    "https://published.example.test",
    "http://localhost:3000",
  ])("uses the page origin for a static export at %s", (origin) => {
    Platform.OS = "web";
    vi.stubGlobal("__DEV__", false);
    vi.stubEnv("EXPO_PUBLIC_DOMAIN", "obsolete-preview.example.test");
    vi.stubGlobal("window", { location: { origin, pathname: "/mobile/checkout" } });
    expect(getApiBaseUrl()).toBe(origin);
    expect(getLegacyApiBase()).toBe(`${origin}/api`);
  });

  it("keeps Expo's separate development host connected to its injected API", () => {
    Platform.OS = "web";
    vi.stubGlobal("__DEV__", true);
    vi.stubEnv("EXPO_PUBLIC_DOMAIN", "current-api.example.test");
    expect(getApiBaseUrl()).toBe("https://current-api.example.test");
  });

  it.each(["ios", "android"] as const)("preserves the configured %s API", (platform) => {
    Platform.OS = platform;
    vi.stubGlobal("__DEV__", false);
    vi.stubEnv("EXPO_PUBLIC_DOMAIN", "native-api.example.test");
    expect(getApiBaseUrl()).toBe("https://native-api.example.test");
  });

  it("retains the local API fallback outside a browser", () => {
    Platform.OS = "web";
    vi.stubGlobal("__DEV__", false);
    vi.stubGlobal("window", undefined);
    vi.stubEnv("EXPO_PUBLIC_DOMAIN", "");
    expect(getLegacyApiBase()).toBe("http://localhost:8080/api");
  });
});
