import { Feather } from "@expo/vector-icons";
import { Stack, router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Linking,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import {
  useGetAdminStripeWebhookDeadLetter,
  retryAdminStripeWebhookDeadLetter,
  ignoreAdminStripeWebhookDeadLetter,
  getGetAdminStripeWebhookDeadLetterQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { StripeManualReview } from "@/components/StripeManualReview";

/**
 * /admin-stripe-webhooks — TD-3 admin queue for Stripe webhook handler failures.
 *
 * Lists dead-letter rows (default: pending), with retry and ignore actions.
 * Retry re-dispatches the stored event payload through the same handler;
 * on success the row flips to `resolved`, on failure it stays `pending`
 * with an updated lastError so the operator can see what changed.
 */

const ACCENT = "#FFB300";
const NAVY = "#0F1B2D";

type Status = "pending" | "resolved" | "ignored" | "all";

const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "ignored", label: "Ignored" },
  { value: "all", label: "All" },
];

const STATUS_COLOR: Record<string, string> = {
  pending: "#EF5350",
  resolved: "#B39DDB",
  ignored: "#78909C",
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

async function openStripeReview(url: string) {
  // Only open the server's fixed Dashboard search route, never checkout URLs
  // or arbitrary URL schemes. Keep the recovery screen open on the web.
  if (!/^https:\/\/dashboard\.stripe\.com\/(?:acct_[A-Za-z0-9]+\/)?(?:test\/)?search\?query=cs_(?:test|live)_[A-Za-z0-9]+$/.test(url)) {
    Alert.alert("Link unavailable", "This is not a valid Stripe Dashboard review link.");
    return;
  }
  try {
    if (Platform.OS === "web") {
      window.open(url, "_blank", "noopener,noreferrer");
    } else {
      await Linking.openURL(url);
    }
  } catch {
    Alert.alert("Could not open Stripe", "Please try again. You will need to sign in to the matching Stripe account.");
  }
}

export default function AdminStripeWebhooksScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const [status, setStatus] = useState<Status>("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const params = { status, limit: 100 };
  const q = useGetAdminStripeWebhookDeadLetter(params, {
    query: { queryKey: getGetAdminStripeWebhookDeadLetterQueryKey(params), refetchInterval: 30_000, refetchOnMount: "always" },
  });
  const entries = q.data?.entries ?? [];

  function refresh() {
    qc.invalidateQueries({ queryKey: getGetAdminStripeWebhookDeadLetterQueryKey() });
  }

  async function onRetry(id: string) {
    setBusyId(id);
    try {
      await retryAdminStripeWebhookDeadLetter(id);
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Retry failed.";
      Alert.alert("Retry failed", msg);
      refresh();
    } finally {
      setBusyId(null);
    }
  }

  async function onIgnore(id: string) {
    Alert.alert("Ignore this event?", "It won't show in the pending queue, but stays on file.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Ignore",
        style: "destructive",
        onPress: async () => {
          setBusyId(id);
          try {
            await ignoreAdminStripeWebhookDeadLetter(id);
            refresh();
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Ignore failed.";
            Alert.alert("Could not ignore", msg);
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
      <ScreenHeader variant="dark" title="Stripe Webhook Queue" subtitle="Failed events — review and replay" />
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

      {q.error && q.data && (
        <Text accessibilityRole="alert" style={[styles.refreshError, { color: colors.destructive }]}>
          Could not refresh queue. Showing previously loaded events; your review draft is unchanged.
        </Text>
      )}
      {q.isLoading && entries.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : q.error && !q.data ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={28} color={colors.destructive} />
          <Text style={[styles.errText, { color: colors.foreground }]}>Could not load queue.</Text>
          <TouchableOpacity onPress={() => q.refetch()} style={[styles.retryBtn, { backgroundColor: ACCENT }]}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ padding: 16, paddingBottom: bottomInset + 32, gap: 10 }}
          keyboardShouldPersistTaps="handled"
          renderScrollComponent={Platform.OS === "web" ? undefined : (props) => <KeyboardAwareScrollView {...props} bottomOffset={60} />}
          refreshControl={<RefreshControl refreshing={q.isFetching && !q.data} onRefresh={() => q.refetch()} tintColor={ACCENT} />}
          ListEmptyComponent={
            <View style={[styles.emptyCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="check-circle" size={28} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No {status === "all" ? "" : status} events.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const statusColor = STATUS_COLOR[item.status] ?? colors.mutedForeground;
            const isBusy = busyId === item.id;
            const isPending = item.status === "pending";
            return (
              <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.rowTopLine}>
                  <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
                  <Text style={[styles.eventType, { color: colors.foreground }]} numberOfLines={1}>
                    {item.eventType}
                  </Text>
                  <Text style={[styles.when, { color: colors.mutedForeground }]}>{fmtWhen(item.createdAt)}</Text>
                </View>
                <View style={styles.metaRow}>
                  <Text style={[styles.metaTag, { backgroundColor: colors.muted, color: colors.mutedForeground }]}>
                    {item.handlerName}
                  </Text>
                  <Text style={[styles.metaAction, { color: statusColor }]}>{item.status}</Text>
                  <Text style={[styles.attempts, { color: colors.mutedForeground }]}>
                    {item.attempts} attempt{item.attempts === 1 ? "" : "s"}
                  </Text>
                </View>
                <Text style={[styles.errorBox, { color: colors.foreground, backgroundColor: colors.muted }]} numberOfLines={6}>
                  {item.lastError}
                </Text>
                <Text style={[styles.eventId, { color: colors.mutedForeground }]} numberOfLines={1}>
                  {item.eventId}
                </Text>
                {item.paymentReview && (
                  <View style={styles.reviewBox}>
                    <Text style={[styles.actionText, { color: colors.foreground }]}>
                      Duplicate payment review — {item.paymentReview.mode === "live" ? "Live mode" : item.paymentReview.mode === "test" ? "Test mode" : "Mode unavailable"}
                    </Text>
                    <Text style={[styles.reviewNote, { color: colors.mutedForeground }]}>
                      Opens a session search in Stripe Dashboard. Sign in to the matching account. No automatic refund; retrying does not remove an extra charge.
                    </Text>
                    {([
                      { label: "Find original payment in Stripe", id: item.paymentReview.originalSessionId, url: item.paymentReview.originalDashboardUrl },
                      { label: "Find extra payment in Stripe", id: item.paymentReview.extraSessionId, url: item.paymentReview.extraDashboardUrl },
                    ]).map((payment) => (
                      <View key={payment.label} style={styles.reviewBox}>
                        <Text selectable style={[styles.eventId, { color: colors.mutedForeground }]}>{payment.id}</Text>
                        {payment.url ? (
                          <TouchableOpacity
                            accessibilityRole="link"
                            accessibilityLabel={payment.label}
                            onPress={() => openStripeReview(payment.url!)}
                            style={[styles.actionBtn, styles.ignoreBtn, { borderColor: colors.border }]}
                          >
                            <Feather name="external-link" size={14} color={colors.foreground} />
                            <Text style={[styles.actionText, { color: colors.foreground }]}>{payment.label}</Text>
                          </TouchableOpacity>
                        ) : (
                          <Text style={[styles.reviewNote, { color: colors.mutedForeground }]}>
                            Stripe link unavailable — the saved event does not establish a safe account and mode.
                          </Text>
                        )}
                      </View>
                    ))}
                  </View>
                )}
                {(item.paymentReview || item.manualReviews.length > 0) && (
                  <StripeManualReview entryId={item.id} reviews={item.manualReviews} onSaved={refresh} />
                )}
                {isPending && (
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
                          <Feather name="refresh-cw" size={14} color={NAVY} />
                          <Text style={[styles.actionText, { color: NAVY }]}>Retry</Text>
                        </>
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => onIgnore(item.id)}
                      disabled={isBusy}
                      activeOpacity={0.85}
                      style={[styles.actionBtn, styles.ignoreBtn, { borderColor: colors.border, opacity: isBusy ? 0.5 : 1 }]}
                    >
                      <Feather name="x" size={14} color={colors.foreground} />
                      <Text style={[styles.actionText, { color: colors.foreground }]}>Ignore</Text>
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
  refreshError: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13 },
  center: { padding: 48, alignItems: "center", gap: 12 },
  errText: { fontSize: 15, fontWeight: "700" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: NAVY, fontWeight: "800" },
  header: { paddingHorizontal: 16, paddingBottom: 14, gap: 12 },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  backBtn: { width: 36, height: 36, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.1)" },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  headerSub: { color: "rgba(255,255,255,0.55)", fontSize: 12 },
  chipsWrap: { paddingHorizontal: 16, paddingBottom: 14, paddingTop: 4 },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: "700" },
  row: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 8 },
  rowTopLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  eventType: { flex: 1, fontSize: 15, fontWeight: "800" },
  when: { fontSize: 12 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  metaTag: { fontSize: 12, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: "hidden" },
  metaAction: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  attempts: { fontSize: 12 },
  errorBox: { fontSize: 12, padding: 10, borderRadius: 8, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  eventId: { fontSize: 12, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  actionsRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  reviewBox: { gap: 8 },
  reviewNote: { fontSize: 12, lineHeight: 18 },
  actionBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, minWidth: 90 },
  ignoreBtn: { backgroundColor: "transparent", borderWidth: 1 },
  actionText: { fontSize: 12, fontWeight: "800" },
  emptyCard: { padding: 32, borderRadius: 14, borderWidth: 1, alignItems: "center", gap: 10 },
  emptyText: { fontSize: 12, textAlign: "center" },
});
