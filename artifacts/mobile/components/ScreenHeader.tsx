import React from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

const NAVY = "#0F1B2D";

export type ScreenHeaderVariant = "light" | "dark";

interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  variant?: ScreenHeaderVariant;
  /** Override the back action (defaults to router.back()). */
  onBack?: () => void;
  /** Hide the home button (rare — use only for terminal/auth screens). */
  hideHome?: boolean;
  /** Override the home destination (rare). */
  homeHref?: string;
  /** Background color override (e.g. brand hero gradient). Falls back to variant default. */
  backgroundColor?: string;
}

/**
 * Standardized navigation header used across every stack screen.
 *
 * Layout: [back ◀]   Title (centered, optional subtitle)   [home ▢]
 *
 * - Back is always top-left (chevron-left, 24px).
 * - Home is always top-right (home icon, 22px) and routes to the
 *   role-appropriate tab root (customer/business/admin). Logout lives
 *   inside the tab screens themselves and isn't duplicated here.
 * - `light` = card surface + foreground text; `dark` = NAVY surface + white.
 */
export function ScreenHeader({
  title,
  subtitle,
  variant = "light",
  onBack,
  hideHome,
  homeHref,
  backgroundColor,
}: ScreenHeaderProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const isDark = variant === "dark";
  const fg = isDark ? "#fff" : colors.foreground;
  const sub = isDark ? "rgba(255,255,255,0.7)" : colors.mutedForeground;
  const bg = backgroundColor ?? (isDark ? NAVY : colors.card);
  const border = isDark ? "rgba(255,255,255,0.1)" : colors.border;
  const iconBg = isDark ? "rgba(255,255,255,0.12)" : "transparent";

  function handleHome() {
    if (homeHref) {
      router.replace(homeHref as never);
      return;
    }
    const role = user?.role;
    if (role === "admin") router.replace("/(admin-tabs)" as never);
    else if (role === "business") router.replace("/(business-tabs)" as never);
    else router.replace("/(tabs)" as never);
  }

  function handleBack() {
    if (onBack) {
      onBack();
      return;
    }
    if (router.canGoBack()) router.back();
    else handleHome();
  }

  return (
    <View
      style={[
        styles.wrap,
        { paddingTop: topInset + 10, backgroundColor: bg, borderBottomColor: border },
      ]}
    >
      <View style={styles.row}>
        <TouchableOpacity
          onPress={handleBack}
          style={[styles.iconBtn, { backgroundColor: iconBg }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          activeOpacity={0.7}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Feather name="chevron-left" size={24} color={fg} />
        </TouchableOpacity>

        <View style={styles.titleWrap} pointerEvents="none">
          <Text style={[styles.title, { color: fg }]} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={[styles.subtitle, { color: sub }]} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>

        {hideHome ? (
          <View style={styles.iconBtn} />
        ) : (
          <TouchableOpacity
            onPress={handleHome}
            style={[styles.iconBtn, { backgroundColor: iconBg }]}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            activeOpacity={0.7}
            accessibilityLabel="Go home"
            accessibilityRole="button"
          >
            <Feather name="home" size={20} color={fg} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 40,
  },
  iconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  titleWrap: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    letterSpacing: 0.1,
  },
  subtitle: {
    fontSize: 12,
    fontWeight: "500",
    marginTop: 2,
  },
});
