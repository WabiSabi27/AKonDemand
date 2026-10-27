import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import React from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp, type Notification, type NotificationKind } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

const KIND_META: Record<NotificationKind, { icon: keyof typeof Feather.glyphMap; tint: string }> = {
  booking_created: { icon: "plus-circle", tint: "#5C6BC0" },
  booking_confirmed: { icon: "check-circle", tint: "#B39DDB" },
  booking_completed: { icon: "award", tint: "#26A69A" },
  booking_cancelled: { icon: "x-circle", tint: "#F44336" },
  booking_payment_failed: { icon: "alert-triangle", tint: "#E53935" },
  booking_refunded: { icon: "rotate-ccw", tint: "#FB8C00" },
  refund_requested: { icon: "rotate-ccw", tint: "#FFB300" },
  refund_approved: { icon: "check-circle", tint: "#22C55E" },
  refund_denied: { icon: "x-circle", tint: "#C62828" },
  dispute_opened: { icon: "alert-triangle", tint: "#9C27B0" },
  dispute_closed: { icon: "shield", tint: "#6A1B9A" },
  message_received: { icon: "message-circle", tint: "#5C6BC0" },
};

/** Format an ISO timestamp as a friendly relative label (e.g. "2h ago"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, now - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function NotificationsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const {
    user,
    notifications,
    unreadNotificationCount,
    markNotificationRead,
    markAllNotificationsRead,
  } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  /** Tap → mark read, then navigate to the relevant bookings screen. */
  async function handleTap(n: Notification) {
    if (!n.read) {
      void markNotificationRead(n.id);
    }
    if (user?.role === "business") {
      router.replace("/(business-tabs)/orders");
    } else {
      router.replace("/(tabs)/bookings");
    }
  }

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Notifications" />
        {unreadNotificationCount > 0 ? (
          <View style={[styles.subActionRow, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={markAllNotificationsRead} hitSlop={10} activeOpacity={0.7}>
              <Text style={[styles.markAll, { color: colors.primary }]}>Mark all read</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {notifications.length === 0 ? (
          <View style={styles.empty}>
            <Feather name="bell-off" size={44} color={colors.mutedForeground} />
            <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No notifications</Text>
            <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
              You'll see booking updates here.
            </Text>
          </View>
        ) : (
          <FlatList
            data={notifications}
            keyExtractor={(n) => n.id}
            contentContainerStyle={{ paddingVertical: 8 }}
            renderItem={({ item }) => {
              const meta = KIND_META[item.kind];
              return (
                <TouchableOpacity
                  activeOpacity={0.7}
                  onPress={() => handleTap(item)}
                  style={[
                    styles.row,
                    {
                      backgroundColor: item.read ? colors.background : colors.card,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  <View style={[styles.iconWrap, { backgroundColor: meta.tint + "20" }]}>
                    <Feather name={meta.icon} size={20} color={meta.tint} />
                  </View>
                  <View style={styles.body}>
                    <View style={styles.titleRow}>
                      <Text
                        style={[
                          styles.rowTitle,
                          { color: colors.foreground, fontFamily: item.read ? "Inter_500Medium" : "Inter_700Bold" },
                        ]}
                        numberOfLines={1}
                      >
                        {item.title}
                      </Text>
                      {!item.read ? <View style={[styles.dot, { backgroundColor: colors.primary }]} /> : null}
                    </View>
                    <Text style={[styles.rowBody, { color: colors.mutedForeground }]} numberOfLines={3}>
                      {item.body}
                    </Text>
                    <Text style={[styles.time, { color: colors.mutedForeground }]}>
                      {relativeTime(item.createdAt)}
                    </Text>
                  </View>
                </TouchableOpacity>
              );
            }}
          />
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 22, fontFamily: "Inter_700Bold" },
  markAll: { fontSize: 14, fontFamily: "Inter_600SemiBold" },
  subActionRow: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  emptyTitle: { fontSize: 18, fontFamily: "Inter_600SemiBold", marginTop: 8 },
  emptyText: { fontSize: 15, fontFamily: "Inter_400Regular", textAlign: "center" },
  row: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { flex: 1, gap: 4 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontSize: 15, flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  rowBody: { fontSize: 12, fontFamily: "Inter_400Regular", lineHeight: 18 },
  time: { fontSize: 12, fontFamily: "Inter_400Regular", marginTop: 2 },
});
