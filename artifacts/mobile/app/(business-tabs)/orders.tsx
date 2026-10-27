import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { NotificationBell } from "@/components/NotificationBell";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { formatDateMMDDYY } from "@/utils/specialties";

const TABS = ["All", "Pending", "Confirmed", "Completed", "Cancelled"] as const;
type TabType = (typeof TABS)[number];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#FFB30020", text: "#FFB300" },
  confirmed: { bg: "#5C6BC020", text: "#5C6BC0" },
  completed: { bg: "#B39DDB20", text: "#B39DDB" },
  cancelled: { bg: "#F4433620", text: "#F44336" },
};

function formatBookingTime(t: string): string {
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

export default function BusinessOrdersTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, businesses, bookings, updateBookingStatus } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const myBusiness = businesses.find((b) => b.ownerId === user?.id);
  const myBookings = bookings.filter((b) => b.businessId === myBusiness?.id);

  const [activeTab, setActiveTab] = useState<TabType>("All");

  const filtered = myBookings.filter((b) => {
    if (activeTab === "All") return true;
    return b.status === activeTab.toLowerCase();
  });

  function handleStatusChange(bookingId: string, newStatus: "confirmed" | "completed" | "cancelled") {
    const labels: Record<string, string> = { confirmed: "Confirm", completed: "Mark Complete", cancelled: "Cancel" };
    Alert.alert(labels[newStatus] + " Order?", "This will update the order status for the customer.", [
      { text: "No", style: "cancel" },
      {
        text: "Yes",
        onPress: async () => {
          await updateBookingStatus(bookingId, newStatus);
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        },
      },
    ]);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#5C6BC0" }]}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>Customer Orders</Text>
            <Text style={styles.headerSub}>{myBookings.length} total orders</Text>
          </View>
          <NotificationBell color="#fff" />
        </View>
      </View>

      <View style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <FlatList
          data={TABS as unknown as TabType[]}
          keyExtractor={(item) => item}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingVertical: 10 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.tabChip, { backgroundColor: activeTab === item ? "#5C6BC0" : colors.secondary }]}
              onPress={() => setActiveTab(item)}
              activeOpacity={0.8}
            >
              <Text style={[styles.tabChipText, { color: activeTab === item ? "#fff" : colors.mutedForeground }]}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="calendar" size={44} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No orders here</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            {activeTab === "All" ? "Customer bookings will appear here once you have active services." : `No ${activeTab.toLowerCase()} orders.`}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 90 }]}
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => {
            const sc = STATUS_COLORS[item.status] ?? STATUS_COLORS.pending;
            const netEarning = item.price - item.platformFee;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.serviceTitle, { color: colors.foreground }]}>{item.serviceTitle}</Text>
                    <Text style={[styles.optionName, { color: colors.mutedForeground }]}>{item.optionName}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.statusText, { color: sc.text }]}>{item.status}</Text>
                  </View>
                </View>

                <View style={[styles.divider, { backgroundColor: colors.border }]} />

                <View style={styles.cardMeta}>
                  <View style={styles.metaRow}>
                    <Feather name="calendar" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{formatDateMMDDYY(item.scheduledDate)}</Text>
                  </View>
                  {item.scheduledTime && (
                    <View style={styles.metaRow}>
                      <Feather name="clock" size={13} color={colors.mutedForeground} />
                      <Text style={[styles.metaText, { color: "#5C6BC0", fontWeight: "700" }]}>
                        {formatBookingTime(item.scheduledTime)}
                        {item.durationMinutes ? ` · ${item.durationMinutes} min` : ""}
                      </Text>
                    </View>
                  )}
                  <View style={styles.metaRow}>
                    <Feather name="user" size={13} color={colors.mutedForeground} />
                    <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{item.customerName || "Customer"}</Text>
                  </View>
                </View>

                <View style={styles.earningsRow}>
                  <View>
                    <Text style={[styles.earningsLabel, { color: colors.mutedForeground }]}>You earn</Text>
                    <Text style={[styles.earningsValue, { color: "#FFB300" }]}>${netEarning.toFixed(2)}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={[styles.earningsLabel, { color: colors.mutedForeground }]}>Platform fee (8%)</Text>
                    <Text style={[styles.feeValue, { color: colors.mutedForeground }]}>-${item.platformFee.toFixed(2)}</Text>
                  </View>
                </View>

                {(item.status === "pending" || item.status === "confirmed") && (
                  <View style={styles.actions}>
                    {item.status === "pending" && (
                      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#5C6BC020", borderColor: "#5C6BC0" }]} onPress={() => handleStatusChange(item.id, "confirmed")}>
                        <Text style={[styles.actionBtnText, { color: "#5C6BC0" }]}>Confirm</Text>
                      </TouchableOpacity>
                    )}
                    {item.status === "confirmed" && (
                      <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#B39DDB20", borderColor: "#B39DDB" }]} onPress={() => handleStatusChange(item.id, "completed")}>
                        <Text style={[styles.actionBtnText, { color: "#B39DDB" }]}>Mark Complete</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: "#F4433620", borderColor: "#F44336" }]} onPress={() => handleStatusChange(item.id, "cancelled")}>
                      <Text style={[styles.actionBtnText, { color: "#F44336" }]}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                )}

                {item.status !== "cancelled" && (
                  <TouchableOpacity
                    style={[styles.messageBtn, { borderColor: "#5C6BC0" }]}
                    onPress={() =>
                      router.push({
                        pathname: "/messages/[bookingId]",
                        params: { bookingId: item.id, title: item.customerName || "Customer" },
                      })
                    }
                    activeOpacity={0.85}
                  >
                    <Feather name="message-circle" size={14} color="#5C6BC0" />
                    <Text style={styles.messageBtnText}>Message customer</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20, gap: 4 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  headerSub: { color: "rgba(255,255,255,0.65)", fontSize: 12 },
  tabBar: { borderBottomWidth: 1 },
  tabChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
  tabChipText: { fontSize: 12, fontWeight: "600" },
  list: { padding: 16, gap: 12 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  serviceTitle: { fontSize: 15, fontWeight: "700" },
  optionName: { fontSize: 12, marginTop: 2 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusText: { fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  divider: { height: 1 },
  cardMeta: { gap: 6 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  metaText: { fontSize: 12 },
  earningsRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  earningsLabel: { fontSize: 12, fontWeight: "600" },
  earningsValue: { fontSize: 18, fontWeight: "800" },
  feeValue: { fontSize: 15, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 8 },
  actionBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, borderWidth: 1, alignItems: "center" },
  actionBtnText: { fontSize: 12, fontWeight: "700" },
  messageBtn: { paddingVertical: 9, borderRadius: 10, borderWidth: 1.5, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  messageBtnText: { fontSize: 12, fontWeight: "700", color: "#5C6BC0" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 20 },
});
