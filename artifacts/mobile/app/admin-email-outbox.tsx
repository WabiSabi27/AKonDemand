import { Feather } from "@expo/vector-icons";
import { Stack } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  useGetAdminEmailOutbox,
  retryAdminEmailOutbox,
  dismissAdminEmailOutbox,
  getGetAdminEmailOutboxQueryKey,
  getGetAdminMetricsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

/**
 * /admin-email-outbox — Task #7 admin queue for provider notification emails.
 *
 * Every meeting/interview email is written to the outbox before the first
 * send attempt; failed sends retry automatically with backoff. This screen
 * shows failed (default) / pending / sent rows, with retry-now and dismiss.
 */

const ACCENT = "#FFB300";
const NAVY = "#0F1B2D";

type Status = "pending" | "sent" | "failed" | "dismissed" | "all";

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "failed", label: "Failed" },
  { value: "pending", label: "Pending" },
  { value: "sent", label: "Sent" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

const STATUS_COLOR: Record<string, string> = {
  failed: "#EF5350",
  pending: "#FFB300",
  sent: "#66BB6A",
  dismissed: "#78909C",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function AdminEmailOutboxScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const [status, setStatus] = useState<Status>("failed");
  const [busyId, setBusyId] = useState<string | null>(null);
  const q = useGetAdminEmailOutbox({ status, limit: 100 });
  const entries = q.data?.entries ?? [];

  function refresh() {
    qc.invalidateQueries({ queryKey: getGetAdminEmailOutboxQueryKey() });
    // Keep the dashboard's failed-email badge (Task #13) in sync after
    // retry/dismiss actions change the failed count.
    qc.invalidateQueries({ queryKey: getGetAdminMetricsQueryKey() });
  }

  async function onRetry(id: string) {
    setBusyId(id);
    try {
      await retryAdminEmailOutbox(id);
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed.";
      Alert.alert("Send failed", msg);
      refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function onDismiss(id: string) {
    Alert.alert("Dismiss this email?", "It will never be retried, but stays on file.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Dismiss",
        style: "destructive",
        onPress: async () => {
          setBusyId(id);
          try {
            await dismissAdminEmailOutbox(id);
            refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Dismiss failed.";
            Alert.alert("Could not dismiss", msg);
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader variant="dark" title="Email Outbox" subtitle="Provider notification emails — retry state" />
      <View style={[styles.chipsWrap, { backgroundColor: NAVY }]}>
        <View style={styles.chipsRow}>
          {STATUS_OPTIONS.map((opt) => {
            const active = status === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setStatus(opt.value)}
                activeOpacity={0.85}
                style={[
                  styles.chip,
                  active
                    ? { backgroundColor: ACCENT, borderColor: ACCENT }
                    : { backgroundColor: "transparent", borderColor: "rgba(255,255,255,0.25)" },
                ]}
              >
                <Text style={[styles.chipText, { color: active ? NAVY : "#fff" }]}>{opt.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      {q.isLoading && entries.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : q.error ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={28} color={colors.destructive} />
          <Text style={[styles.errText, { color: colors.foreground }]}>Could not load outbox.</Text>
          <TouchableOpacity onPress={() => q.refetch()} style={[styles.retryBtn, { backgroundColor: ACCENT }]}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ padding: 16, paddingBottom: bottomInset + 32, gap: 10 }}
          refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={() => q.refetch()} tintColor={ACCENT} />}
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="check-circle" size={28} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No {status === "all" ? "" : status} emails.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const statusColor = STATUS_COLOR[item.status] ?? colors.mutedForeground;
            const isBusy = busyId === item.id;
            const actionable = item.status === "failed" || item.status === "pending";
            return (
              <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.rowTopLine}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.subject, { color: colors.foreground }]} numberOfLines={1}>
                    {item.subject}
                  </Text>
                  <Text style={[styles.when, { color: colors.mutedForeground }]}>{fmtWhen(item.createdAt)}</Text>
                </View>
                <Text style={[styles.toEmail, { color: colors.mutedForeground }]} numberOfLines={1}>
                  To: {item.toEmail}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.metaTag, { backgroundColor: colors.muted, color: colors.mutedForeground }]}>
                    {item.kind}
                  </Text>
                  <Text style={[styles.metaAction, { color: statusColor }]}>{item.status}</Text>
                  <Text style={[styles.attempts, { color: colors.mutedForeground }]}>
                    {item.attempts} attempt{item.attempts === 1 ? "" : "s"}
                  </Text>
                </View>
                {item.lastError ? (
                  <Text
                    style={[styles.errorBox, { color: colors.foreground, backgroundColor: colors.muted }]}
                    numberOfLines={6}
                  >
                    {item.lastError}
                  </Text>
                ) : null}
                {actionable && (
                  <View style={styles.actionsRow}>
                    <TouchableOpacity
                      onPress={() => onRetry(item.id)}
                      disabled={isBusy}
                      activeOpacity={0.85}
                      style={[styles.actionBtn, { backgroundColor: ACCENT, opacity: isBusy ? 0.5 : 1 }]}
                    >
                      {isBusy ? (
                        <ActivityIndicator size="small" color={NAVY} />
                      ) : (
                        <>
                          <Feather name="send" size={14} color={NAVY} />
                          <Text style={[styles.actionText, { color: NAVY }]}>Retry now</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onDismiss(item.id)}
                      disabled={isBusy}
                      activeOpacity={0.85}
                      style={[styles.actionBtn, styles.dismissBtn, { borderColor: colors.border, opacity: isBusy ? 0.5 : 1 }]}
                    >
                      <Feather name="x" size={14} color={colors.foreground} />
                      <Text style={[styles.actionText, { color: colors.foreground }]}>Dismiss</Text>
                    </TouchableOpacity>
                  </View>
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
  center: { padding: 48, alignItems: "center", gap: 12 },
  errText: { fontSize: 15, fontWeight: "700" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: NAVY, fontWeight: "800" },
  chipsWrap: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: "700" },
  row: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 8 },
  rowTopLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  subject: { flex: 1, fontSize: 15, fontWeight: "800" },
  when: { fontSize: 12 },
  toEmail: { fontSize: 12 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  metaTag: { fontSize: 12, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: "hidden" },
  metaAction: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  attempts: { fontSize: 12 },
  errorBox: { fontSize: 12, padding: 10, borderRadius: 8, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  actionsRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, minWidth: 90 },
  dismissBtn: { backgroundColor: "transparent", borderWidth: 1 },
  actionText: { fontSize: 12, fontWeight: "800" },
  emptyCard: { padding: 32, borderRadius: 14, borderWidth: 1, alignItems: "center", gap: 10 },
  emptyText: { fontSize: 12, textAlign: "center" },
});
