import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

interface Props {
  /** Tint of the bell icon. Defaults to current foreground color. */
  color?: string;
  /** Override hit area / icon size. Default 22. */
  size?: number;
}

/**
 * Reusable header bell. Shows the unread notification count as a small badge
 * (or a dot when count is 0 and you still want feedback). Tapping navigates
 * to the dedicated /notifications screen.
 */
export function NotificationBell({ color, size = 22 }: Props) {
  const colors = useColors();
  const { unreadNotificationCount } = useApp();
  const tint = color ?? colors.foreground;
  const showBadge = unreadNotificationCount > 0;
  const label = unreadNotificationCount > 99 ? "99+" : String(unreadNotificationCount);

  return (
    <TouchableOpacity
      onPress={() => router.push("/notifications")}
      activeOpacity={0.7}
      hitSlop={10}
      style={styles.wrap}
      accessibilityRole="button"
      accessibilityLabel={
        showBadge ? `Notifications, ${unreadNotificationCount} unread` : "Notifications"
      }
    >
      <Feather name="bell" size={size} color={tint} />
      {showBadge ? (
        <View style={[styles.badge, { backgroundColor: "#F44336", borderColor: colors.card }]}>
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
  },
  badge: {
    position: "absolute",
    top: 2,
    right: 2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1.5,
  },
  badgeText: {
    color: "#fff",
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    lineHeight: 12,
  },
});
