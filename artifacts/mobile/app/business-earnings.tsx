/**
 * SP Earnings Dashboard (Phase 3 #5).
 *
 * Drives off `useGetMyEarnings()` — a single payload with lifetime + 30-day
 * rollup, Stripe Connect pending balance, and the 25 most-recent paid
 * bookings. Money is integer USD cents from the wire; we format to dollars
 * client-side with `formatUsdCents`.
 *
 * "Download CSV" hits /me/earnings/export.csv with the Bearer token. On
 * native we save via expo-file-system + share sheet; on web we trigger a
 * direct browser download with a Blob.
 */
import { Feather } from "@expo/vector-icons";
import { router, Stack } from "expo-router";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useGetMyEarnings, type EarningsBucket, type EarningsRecentItem } from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { API_BASE } from "@/utils/api";
import { getToken } from "@/utils/authStorage";

const ACCENT = "#5C6BC0";

function formatUsdCents(c: number): string {
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}$${(abs / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatShortDate(yyyyMmDd: string): string {
  const [y, m, d] = yyyyMmDd.split("-").map((s) => Number(s));
  if (!y || !m || !d) return yyyyMmDd;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

export default function BusinessEarningsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "web" ? 12 : insets.top;
  const bottomInset = Platform.OS === "web" ? 16 : insets.bottom;

  // Refetch on focus is the React Query default; we set staleTime in
  // _layout.tsx. Money data is OK to be a few seconds old.
  const earningsQ = useGetMyEarnings();
  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    const token = await getToken().catch(() => null);
    if (!token) {
      Alert.alert("Not signed in", "Please sign in again to export.");
      return;
    }
    setExporting(true);
    try {
      const url = `${API_BASE}/me/earnings/export.csv`;
      const filename = `earnings-${new Date().toISOString().slice(0, 10)}.csv`;

      if (Platform.OS === "web") {
        // Web: fetch with auth header, blob → anchor click → download
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const blob = await res.blob();
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      } else {
        // Native: download to cache dir then open share sheet
        const dest = `${FileSystem.cacheDirectory ?? ""}${filename}`;
        const dl = await FileSystem.downloadAsync(url, dest, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (dl.status !== 200) throw new Error(`Export failed (${dl.status})`);
        if (await Sharing.isAvailableAsync()) {
          await Sharing.shareAsync(dl.uri, { mimeType: "text/csv", dialogTitle: "Export earnings" });
        } else {
          Alert.alert("Saved", `CSV saved to ${dl.uri}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not export earnings";
      Alert.alert("Export failed", msg);
    } finally {
      setExporting(false);
    }
  }

  const data = earningsQ.data;

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <ScreenHeader title="Earnings" />

        {earningsQ.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : earningsQ.error || !data ? (
          <View style={styles.center}>
            <Feather name="alert-triangle" size={28} color={colors.destructive} />
            <Text style={[styles.errText, { color: colors.foreground }]}>Could not load earnings.</Text>
            <TouchableOpacity onPress={() => earningsQ.refetch()} style={[styles.retryBtn, { backgroundColor: ACCENT }]}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={data.recentPayments}
            keyExtractor={(i) => i.bookingId}
            contentContainerStyle={{ paddingBottom: bottomInset + 32 }}
            ListHeaderComponent={
              <View style={{ paddingHorizontal: 16, paddingTop: 6 }}>
                <BucketCard title="Lifetime" bucket={data.lifetime} colors={colors} accent={ACCENT} primary />
                <BucketCard title="Last 30 days" bucket={data.last30Days} colors={colors} accent="#26A69A" />

                {/* Stripe balance */}
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.cardHeader}>
                    <Feather name="dollar-sign" size={15} color={colors.mutedForeground} />
                    <Text style={[styles.cardLabel, { color: colors.mutedForeground }]}>STRIPE BALANCE</Text>
                  </View>
                  {data.balance ? (
                    <View style={{ gap: 6 }}>
                      <BalanceRow label="Pending payout" value={formatUsdCents(data.balance.pendingCents)} colors={colors} />
                      <BalanceRow label="Available now" value={formatUsdCents(data.balance.availableCents)} colors={colors} bold />
                      <Text style={[styles.balanceHint, { color: colors.mutedForeground }]}>
                        Stripe pays out automatically on a rolling schedule.
                      </Text>
                    </View>
                  ) : (
                    <Text style={[styles.balanceHint, { color: colors.mutedForeground }]}>
                      Finish Stripe onboarding from your Account tab to see live balance.
                    </Text>
                  )}
                </View>

                {/* Export */}
                <TouchableOpacity
                  style={[styles.exportBtn, { borderColor: ACCENT, backgroundColor: ACCENT + "10" }]}
                  onPress={handleExport}
                  disabled={exporting || data.recentPayments.length === 0}
                  activeOpacity={0.8}
                >
                  {exporting ? (
                    <ActivityIndicator size="small" color={ACCENT} />
                  ) : (
                    <Feather name="download" size={16} color={ACCENT} />
                  )}
                  <Text style={[styles.exportText, { color: ACCENT }]}>
                    {exporting ? "Preparing CSV…" : "Download all as CSV"}
                  </Text>
                </TouchableOpacity>

                <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent payments</Text>
              </View>
            }
            renderItem={({ item }) => (
              <PaymentRow item={item} colors={colors} />
            )}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
            ListEmptyComponent={
              <View style={{ paddingHorizontal: 24, paddingVertical: 32, alignItems: "center" }}>
                <Feather name="inbox" size={28} color={colors.mutedForeground} />
                <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                  No paid bookings yet. Earnings will appear here once your first customer pays.
                </Text>
              </View>
            }
          />
        )}
      </View>
    </>
  );
}

function BucketCard({
  title, bucket, colors, accent, primary,
}: {
  title: string; bucket: EarningsBucket; colors: ReturnType<typeof useColors>; accent: string; primary?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        primary
          ? { backgroundColor: accent, borderColor: accent }
          : { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.cardLabel, { color: primary ? "rgba(255,255,255,0.85)" : colors.mutedForeground, marginBottom: 6 }]}>
        {title.toUpperCase()}
      </Text>
      <Text style={[styles.netBig, { color: primary ? "#fff" : colors.foreground }]}>
        {formatUsdCents(bucket.net)}
      </Text>
      <Text style={[styles.netSub, { color: primary ? "rgba(255,255,255,0.85)" : colors.mutedForeground }]}>
        net from {bucket.count} {bucket.count === 1 ? "booking" : "bookings"}
      </Text>

      <View style={[styles.breakdownRow, { borderTopColor: primary ? "rgba(255,255,255,0.2)" : colors.border }]}>
        <BreakdownCol label="Gross"   value={formatUsdCents(bucket.gross)}   primary={primary} colors={colors} />
        <BreakdownCol label="Fees"    value={`-${formatUsdCents(bucket.fees)}`} primary={primary} colors={colors} />
        <BreakdownCol label="Refunds" value={bucket.refunded > 0 ? `-${formatUsdCents(bucket.refunded)}` : "$0.00"} primary={primary} colors={colors} />
      </View>
    </View>
  );
}

function BreakdownCol({
  label, value, primary, colors,
}: { label: string; value: string; primary?: boolean; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={[styles.breakdownLabel, { color: primary ? "rgba(255,255,255,0.75)" : colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.breakdownValue, { color: primary ? "#fff" : colors.foreground }]}>{value}</Text>
    </View>
  );
}

function BalanceRow({
  label, value, bold, colors,
}: { label: string; value: string; bold?: boolean; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={styles.balanceRow}>
      <Text style={[styles.balanceLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.balanceValue, { color: colors.foreground, fontWeight: bold ? "700" : "600" }]}>
        {value}
      </Text>
    </View>
  );
}

function PaymentRow({ item, colors }: { item: EarningsRecentItem; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[styles.payRow, { backgroundColor: colors.card, borderColor: colors.border, marginHorizontal: 16 }]}>
      <View style={{ flex: 1 }}>
        <Text style={[styles.payTitle, { color: colors.foreground }]} numberOfLines={1}>
          {item.serviceTitle}
        </Text>
        <Text style={[styles.paySub, { color: colors.mutedForeground }]} numberOfLines={1}>
          {item.customerName} · {formatShortDate(item.scheduledDate)}
        </Text>
      </View>
      <View style={{ alignItems: "flex-end" }}>
        <Text
          style={[
            styles.payNet,
            { color: item.refunded ? colors.mutedForeground : colors.foreground, textDecorationLine: item.refunded ? "line-through" : "none" },
          ]}
        >
          {/* For refunded rows the API returns netCents=0 — show the original
              gross-minus-fee amount with strikethrough so the SP can see what
              they would have earned. For kept rows show the actual net. */}
          {formatUsdCents(item.refunded ? item.grossCents - item.feeCents : item.netCents)}
        </Text>
        {item.refunded ? (
          <Text style={[styles.refundPill, { color: "#E53935" }]}>Refunded</Text>
        ) : (
          <Text style={[styles.payFee, { color: colors.mutedForeground }]}>
            -{formatUsdCents(item.feeCents)} fee
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: 16, paddingBottom: 10, paddingTop: 4,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", borderWidth: 1,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  errText: { fontSize: 15 },
  retryBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: "#fff", fontWeight: "700" },

  card: {
    borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 12,
  },
  cardHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  cardLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },

  netBig: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  netSub: { fontSize: 12, marginTop: 2 },

  breakdownRow: {
    flexDirection: "row", gap: 8, marginTop: 14, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth,
  },
  breakdownLabel: { fontSize: 12, fontWeight: "600", letterSpacing: 0.4, marginBottom: 2 },
  breakdownValue: { fontSize: 15, fontWeight: "700" },

  balanceRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 4 },
  balanceLabel: { fontSize: 12 },
  balanceValue: { fontSize: 15 },
  balanceHint: { fontSize: 12, marginTop: 6, lineHeight: 16 },

  exportBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    borderWidth: 1, borderRadius: 12, paddingVertical: 13, marginBottom: 18,
  },
  exportText: { fontSize: 15, fontWeight: "700" },

  sectionTitle: { fontSize: 15, fontWeight: "700", marginBottom: 8, paddingHorizontal: 2 },

  payRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    borderRadius: 12, borderWidth: 1, padding: 14,
  },
  payTitle: { fontSize: 15, fontWeight: "700" },
  paySub: { fontSize: 12, marginTop: 2 },
  payNet: { fontSize: 15, fontWeight: "700" },
  payFee: { fontSize: 12, marginTop: 2 },
  refundPill: { fontSize: 12, fontWeight: "700", marginTop: 2 },

  emptyText: { fontSize: 12, textAlign: "center", marginTop: 8, lineHeight: 18 },
});
