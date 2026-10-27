import { Feather } from "@expo/vector-icons";
import React, { useMemo, useState } from "react";
import { FlatList, Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

const TABS = ["All", "Pending", "Confirmed", "Completed", "Cancelled"] as const;
type TabType = (typeof TABS)[number];

const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending: { bg: "#FFB30020", text: "#FFB300" },
  confirmed: { bg: "#5C6BC020", text: "#5C6BC0" },
  completed: { bg: "#B39DDB20", text: "#B39DDB" },
  cancelled: { bg: "#F4433620", text: "#F44336" },
};

export default function AdminBookingsTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { bookings } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const [activeTab, setActiveTab] = useState<TabType>("All");

  const sorted = useMemo(() => [...bookings].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()), [bookings]);

  const filtered = sorted.filter((b) => activeTab === "All" || b.status === activeTab.toLowerCase());

  const totalFees = bookings.filter(b => b.status !== "cancelled").reduce((s, b) => s + b.platformFee, 0);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#0F1B2D" }]}>
        <Text style={styles.headerTitle}>All Platform Bookings</Text>
        <Text style={styles.headerSub}>{bookings.length} total · ${totalFees.toFixed(2)} in platform fees</Text>
      </View>

      <View style={[styles.tabBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <FlatList
          data={TABS as unknown as TabType[]}
          keyExtractor={(i) => i}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingVertical: 10 }}
          renderItem={({ item }) => (
            <TouchableOpacity
              style={[styles.chip, { backgroundColor: activeTab === item ? "#FFB300" : colors.secondary }]}
              onPress={() => setActiveTab(item)}
            >
              <Text style={[styles.chipText, { color: activeTab === item ? "#fff" : colors.mutedForeground }]}>{item}</Text>
            </TouchableOpacity>
          )}
        />
      </View>

      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="calendar" size={44} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No bookings</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>Bookings will appear here as customers book services.</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.list, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 90 }]}
          renderItem={({ item }) => {
            const sc = STATUS_COLORS[item.status] ?? STATUS_COLORS.pending;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.serviceTitle, { color: colors.foreground }]}>{item.serviceTitle}</Text>
                    <Text style={[styles.bizName, { color: colors.mutedForeground }]}>{item.businessName}</Text>
                  </View>
                  <View style={[styles.statusBadge, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.statusText, { color: sc.text }]}>{item.status}</Text>
                  </View>
                </View>
                <View style={styles.detailsRow}>
                  <View style={styles.detail}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Option</Text>
                    <Text style={[styles.detailValue, { color: colors.foreground }]}>{item.optionName}</Text>
                  </View>
                  <View style={styles.detail}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Date</Text>
                    <Text style={[styles.detailValue, { color: colors.foreground }]}>{new Date(item.scheduledDate).toLocaleDateString()}</Text>
                  </View>
                  <View style={styles.detail}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Total</Text>
                    <Text style={[styles.detailValue, { color: colors.foreground }]}>${item.total.toFixed(2)}</Text>
                  </View>
                  <View style={styles.detail}>
                    <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>Platform Fee</Text>
                    <Text style={[styles.detailValue, { color: "#FFB300", fontWeight: "800" }]}>+${item.platformFee.toFixed(2)}</Text>
                  </View>
                </View>
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
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  headerSub: { color: "rgba(255,255,255,0.55)", fontSize: 12 },
  tabBar: { borderBottomWidth: 1 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
  chipText: { fontSize: 12, fontWeight: "600" },
  list: { padding: 16, gap: 12 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  serviceTitle: { fontSize: 15, fontWeight: "700" },
  bizName: { fontSize: 12, marginTop: 2 },
  statusBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  statusText: { fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  detailsRow: { flexDirection: "row", justifyContent: "space-between" },
  detail: { alignItems: "center", gap: 2 },
  detailLabel: { fontSize: 12, fontWeight: "600" },
  detailValue: { fontSize: 12, fontWeight: "700" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 20 },
});
