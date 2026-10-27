import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  FlatList,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BookingCard } from "@/components/BookingCard";
import { NotificationBell } from "@/components/NotificationBell";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import * as Haptics from "expo-haptics";

const TABS = ["All", "Active", "Completed"] as const;
type Tab = (typeof TABS)[number];

export default function BookingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { bookings } = useApp();
  const [activeTab, setActiveTab] = useState<Tab>("All");
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const filtered = bookings.filter((b) => {
    if (activeTab === "Active") return b.status === "pending" || b.status === "confirmed";
    if (activeTab === "Completed") return b.status === "completed" || b.status === "cancelled";
    return true;
  });

  // Phase 3 #7 — Cancel always routes through the confirmation screen now,
  // so the customer sees the refund quote and policy *before* committing.
  function handleCancel(bookingId: string) {
    Haptics.selectionAsync();
    router.push({ pathname: "/cancel-booking/[bookingId]", params: { bookingId } });
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          {
            paddingTop: topInset + 12,
            backgroundColor: colors.card,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: colors.foreground }]}>My Bookings</Text>
          <NotificationBell />
        </View>
        <View style={[styles.tabBar, { backgroundColor: colors.secondary }]}>
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[
                styles.tabBtn,
                activeTab === tab && { backgroundColor: colors.primary },
              ]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.8}
            >
              <Text
                style={[
                  styles.tabText,
                  { color: activeTab === tab ? "#fff" : colors.mutedForeground },
                ]}
              >
                {tab}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="calendar" size={44} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No bookings yet</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            Browse services and book something today
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <BookingCard
              booking={item}
              onCancel={() => handleCancel(item.id)}
              onReview={() => router.push(`/review/${item.id}`)}
              onRequestRefund={() => router.push(`/refund-request/${item.id}`)}
              onMessage={() =>
                router.push({
                  pathname: "/messages/[bookingId]",
                  params: { bookingId: item.id, title: item.businessName },
                })
              }
            />
          )}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: Platform.OS === "web" ? 108 : insets.bottom + 80 },
          ]}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  title: {
    fontSize: 28,
    fontWeight: "800",
  },
  tabBar: {
    flexDirection: "row",
    borderRadius: 14,
    padding: 4,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 10,
    alignItems: "center",
  },
  tabText: {
    fontSize: 12,
    fontWeight: "700",
  },
  list: {
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
  },
  emptyText: {
    fontSize: 15,
    textAlign: "center",
    lineHeight: 20,
  },
});
