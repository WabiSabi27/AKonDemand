import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";
import { Redirect, Stack, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { LogBox } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AppProvider, useApp } from "@/context/AppContext";
import { getApiBaseUrl, getToken } from "@/utils/authStorage";

// Suppress the noisy React 19 "forwardRef render functions accept exactly two
// parameters" dev warning. It originates from third-party libraries (not our
// code) that still use the legacy forwardRef pattern; it has no effect on
// functionality and is stripped from production builds.
LogBox.ignoreLogs([
  "forwardRef render functions accept exactly two parameters",
]);

SplashScreen.preventAutoHideAsync();

// Configure the generated API client BEFORE React Query mounts. setBaseUrl makes
// every relative call (e.g. "/categories") hit our backend; setAuthTokenGetter
// attaches `Authorization: Bearer <token>` automatically when a session exists.
setBaseUrl(getApiBaseUrl());
setAuthTokenGetter(getToken);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // React Native has no window-focus / network-reconnect events out of the
      // box and we don't want a flood of refetches on every screen mount —
      // 30s staleTime keeps the UI snappy without serving truly stale data.
      staleTime: 30_000,
      retry: 1,
    },
  },
});


function RoleGate() {
  const { user, isLoading } = useApp();
  const segments = useSegments();

  if (isLoading) return null;

  const inAuth =
    segments[0] === "login" ||
    segments[0] === "forgot-password" ||
    segments[0] === "reset-password";
  const inPaymentReturn = segments[0] === "payment-return";
  const inCustomer = segments[0] === "(tabs)";
  const inBusiness = segments[0] === "(business-tabs)";
  const inAdmin = segments[0] === "(admin-tabs)" || segments[0] === "admin-stripe-webhooks";
  const inNotifications = segments[0] === "notifications";

  if (!user) {
    // Business and admin areas always require a login
    if (inBusiness || inAdmin || inNotifications) return <Redirect href="/login" />;
    // Guests can freely browse the customer tabs, service detail, and checkout pages
    const inServiceDetail = segments[0] === "service";
    const inCheckout = segments[0] === "checkout";
    if (!inAuth && !inPaymentReturn && !inCustomer && !inServiceDetail && !inCheckout) {
      return <Redirect href="/(tabs)" />;
    }
    return null;
  }

  const inServiceDetail = segments[0] === "service";
  const inCheckout = segments[0] === "checkout";
  // Notifications screen is reachable from any role.
  if (user.role === "customer" && !inCustomer && !inServiceDetail && !inCheckout && !inNotifications) {
    return <Redirect href="/(tabs)" />;
  }
  if (user.role === "business" && !inBusiness && !inNotifications) {
    return <Redirect href="/(business-tabs)" />;
  }
  if (user.role === "admin" && !inAdmin && !inNotifications) {
    return <Redirect href="/(admin-tabs)" />;
  }

  return null;
}

function RootLayoutNav() {
  return (
    <>
      <RoleGate />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="payment-return" options={{ headerShown: false }} />
        <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
        <Stack.Screen name="reset-password" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(business-tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(admin-tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="service/[id]"
          options={{ headerShown: false, presentation: "card" }}
        />
        <Stack.Screen
          name="checkout"
          options={{ headerShown: false, presentation: "card" }}
        />
        <Stack.Screen
          name="business-portal"
          options={{ headerShown: false, presentation: "modal" }}
        />
        <Stack.Screen
          name="notifications"
          options={{ headerShown: false, presentation: "card" }}
        />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    // Load the Feather icon font from the app's own assets. The key MUST be the
    // lowercase "feather" because @expo/vector-icons builds the component with
    // createIconSet(glyphMap, "feather", font) — i.e. it renders glyphs using
    // fontFamily "feather". Registering it under "Feather" (capital) loads the
    // font under the wrong name, so glyphs stay blank on native (web is lenient).
    feather: require("../assets/fonts/Feather.ttf"),
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <AppProvider>
            <GestureHandlerRootView style={{ flex: 1 }}>
              <KeyboardProvider>
                <RootLayoutNav />
              </KeyboardProvider>
            </GestureHandlerRootView>
          </AppProvider>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
