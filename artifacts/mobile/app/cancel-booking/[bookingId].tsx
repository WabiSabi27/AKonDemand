/**
 * Phase 3 #7 — Cancel-booking confirmation screen.
 *
 * Customer-facing. Loads the server's authoritative cancellation quote for
 * this booking (GET /bookings/:id/cancellation-quote), shows the refund the
 * customer would actually receive RIGHT NOW under the snapshotted policy,
 * and lets them confirm. Confirming PATCHes status=cancelled, which the
 * server turns into a partial-refund Stripe refund + status flip in one
 * shot (see routes/bookings.ts).
 *
 * Shape decisions:
 *   - We refetch the quote on focus so a customer who sits on this screen
 *     past a tier threshold doesn't think they're getting more than they
 *     will. (Server is the source of truth either way.)
 *   - Terminal states (already cancelled / completed) render the policy as
 *     read-only info and hide the confirm CTA.
 *   - Free (unpaid) bookings just need a confirm — no refund math.
 */

import { Feather } from "@expo/vector-icons";
import { router, useLocalSearchParams, Stack } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useQueryClient } from "@tanstack/react-query";

import {
  useGetCancellationQuote,
  useUpdateBookingStatus,
  getListBookingsQueryKey,
  getGetCancellationQuoteQueryKey,
} from "@workspace/api-client-react";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { BRAND } from "@/constants/colors";
import { policyBullets } from "@/utils/cancellationPolicy";
import { formatDateMMDDYY } from "@/utils/specialties";

export default function CancelBookingScreen() {
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { bookings } = useApp();
  const queryClient = useQueryClient();

  const id = bookingId ?? "";
  const booking = bookings.find((b) => b.id === id);

  const quoteQ = useGetCancellationQuote(id, {
    query: {
      queryKey: getGetCancellationQuoteQueryKey(id),
      enabled: !!id,
    },
  });
  const updateStatus = useUpdateBookingStatus();
  const [submitting, setSubmitting] = useState(false);

  const quote = quoteQ.data;
  const refundDollars =
    quote && quote.refundCents > 0 ? (quote.refundCents / 100).toFixed(2) : null;
  const totalDollars = quote ? (quote.totalCents / 100).toFixed(2) : null;

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await updateStatus.mutateAsync({ id, data: { status: "cancelled" } });
      // Refresh the customer's bookings list so the cancel + refund pill
      // are visible immediately when they navigate back.
      await queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });
      const msg =
        refundDollars
          ? `We've cancelled your booking and refunded $${refundDollars}. Refunds typically appear in 5–10 business days.`
          : "We've cancelled your booking. No refund was issued under the provider's cancellation policy.";
      Alert.alert("Booking cancelled", msg, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Could not cancel — please try again.";
      Alert.alert("Cancel failed", message);
    } finally {
      setSubmitting(false);
    }
  }

  // ── Render states ────────────────────────────────────────────────────────
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <ScreenHeader title="Cancel Booking" />

      {/* Render order matters: check error FIRST so a failed quote fetch
          shows a real error state instead of an infinite spinner. */}
      {quoteQ.isError ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={28} color={colors.destructive} />
          <Text style={[styles.errorText, { color: colors.foreground }]}>
            Could not load cancellation details. Please try again.
          </Text>
          <TouchableOpacity
            style={[styles.cancelBtn, { borderColor: colors.border, marginTop: 8 }]}
            onPress={() => router.back()}
          >
            <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      ) : !booking ? (
        <View style={styles.center}>
          <Feather name="inbox" size={28} color={colors.mutedForeground} />
          <Text style={[styles.errorText, { color: colors.foreground }]}>
            Booking not found in your list. Pull to refresh on Bookings and try again.
          </Text>
        </View>
      ) : quoteQ.isLoading || !quote ? (
        <View style={styles.center}>
          <ActivityIndicator color={BRAND.redViolet} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 20, paddingBottom: bottomInset + 120 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Booking summary card */}
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.bizName, { color: colors.mutedForeground }]} numberOfLines={1}>
              {booking.businessName}
            </Text>
            <Text style={[styles.svcTitle, { color: colors.foreground }]} numberOfLines={2}>
              {booking.serviceTitle}
            </Text>
            <Text style={[styles.svcOpt, { color: colors.mutedForeground }]}>
              {booking.optionName}
            </Text>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <View style={styles.detailRow}>
              <Feather name="calendar" size={13} color={colors.mutedForeground} />
              <Text style={[styles.detailText, { color: colors.foreground }]}>
                {formatDateMMDDYY(booking.scheduledDate)}
                {booking.scheduledTime ? ` · ${booking.scheduledTime}` : ""}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Feather name="dollar-sign" size={13} color={colors.mutedForeground} />
              <Text style={[styles.detailText, { color: colors.foreground }]}>
                ${totalDollars} paid
              </Text>
            </View>
          </View>

          {/* Refund quote — the headline number */}
          {quote.eligible ? (
            <View style={[
              styles.quoteCard,
              {
                backgroundColor: quote.tier === "full" ? "#22C55E15" : quote.tier === "partial" ? "#FFB30015" : "#6B7A8D15",
                borderColor:    quote.tier === "full" ? "#22C55E55" : quote.tier === "partial" ? "#FFB30055" : "#6B7A8D55",
              },
            ]}>
              <Feather
                name={quote.tier === "none" ? "alert-circle" : "check-circle"}
                size={22}
                color={quote.tier === "full" ? "#1B7F3A" : quote.tier === "partial" ? "#B07300" : "#4A5568"}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.quoteLabel, {
                  color: quote.tier === "full" ? "#1B7F3A" : quote.tier === "partial" ? "#B07300" : "#4A5568",
                }]}>
                  {quote.tier === "full" ? "Full refund"
                    : quote.tier === "partial" ? `${quote.policy.partialRefundPercent}% refund`
                    : "No refund"}
                </Text>
                <Text style={[styles.quoteAmount, { color: colors.foreground }]}>
                  {quote.paid === false
                    ? "Free booking — nothing to refund"
                    : quote.refundCents > 0
                      ? `You'll receive $${(quote.refundCents / 100).toFixed(2)} back`
                      : "Cancelling now means no refund"}
                </Text>
                <Text style={[styles.quoteSub, { color: colors.mutedForeground }]}>
                  {quote.hoursUntilScheduled > 0
                    ? `${quote.hoursUntilScheduled.toFixed(1)} hours until your scheduled time`
                    : `${Math.abs(quote.hoursUntilScheduled).toFixed(1)} hours past your scheduled time`}
                </Text>
              </View>
            </View>
          ) : (
            <View style={[styles.quoteCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
              <Feather name="info" size={22} color={colors.mutedForeground} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.quoteLabel, { color: colors.foreground }]}>
                  This booking can't be cancelled
                </Text>
                <Text style={[styles.quoteSub, { color: colors.mutedForeground }]}>
                  {quote.reason === "already_cancelled"
                    ? "It's already cancelled."
                    : "It's marked as completed."}
                </Text>
              </View>
            </View>
          )}

          {/* Policy breakdown */}
          <Text style={[styles.policyHeader, { color: colors.foreground }]}>
            Provider's cancellation policy
          </Text>
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: 8 }]}>
            {policyBullets(quote.policy).map((row, i) => {
              const active = row.tier === quote.tier;
              return (
                <View
                  key={i}
                  style={[
                    styles.bullet,
                    i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
                  ]}
                >
                  <View style={[styles.bulletDot, {
                    backgroundColor:
                      row.tier === "full" ? "#22C55E"
                      : row.tier === "partial" ? "#FFB300"
                      : "#6B7A8D",
                  }]} />
                  <Text style={[styles.bulletText, {
                    color: active ? colors.foreground : colors.mutedForeground,
                    fontWeight: active ? "700" : "500",
                  }]}>
                    {row.label}
                  </Text>
                  {active && (
                    <View style={[styles.activeBadge, { backgroundColor: BRAND.redViolet + "20" }]}>
                      <Text style={[styles.activeBadgeText, { color: BRAND.redViolet }]}>NOW</Text>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}

      {/* Sticky footer with confirm CTA */}
      {quote?.eligible && (
        <View style={[
          styles.footer,
          { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: bottomInset + 12 },
        ]}>
          <TouchableOpacity
            style={[styles.cancelBtn, { borderColor: colors.border }]}
            onPress={() => router.back()}
            disabled={submitting}
          >
            <Text style={[styles.cancelBtnText, { color: colors.foreground }]}>Keep booking</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.confirmBtn, { backgroundColor: colors.destructive, opacity: submitting ? 0.6 : 1 }]}
            onPress={handleConfirm}
            disabled={submitting}
            activeOpacity={0.85}
          >
            <Text style={styles.confirmBtnText}>
              {submitting
                ? "Cancelling…"
                : refundDollars
                  ? `Cancel & refund $${refundDollars}`
                  : "Cancel booking"}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 24 },
  errorText: { fontSize: 15, textAlign: "center" },

  card: { borderRadius: 14, borderWidth: 1, padding: 16 },
  bizName: { fontSize: 12, fontWeight: "500" },
  svcTitle: { fontSize: 18, fontWeight: "700", marginTop: 2, lineHeight: 22 },
  svcOpt: { fontSize: 12, marginTop: 2 },
  divider: { height: 1, marginVertical: 12 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  detailText: { fontSize: 12, fontWeight: "500" },

  quoteCard: {
    flexDirection: "row", gap: 12, padding: 16, borderRadius: 14, borderWidth: 1, marginTop: 14,
    alignItems: "flex-start",
  },
  quoteLabel: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.5 },
  quoteAmount: { fontSize: 18, fontWeight: "700", marginTop: 4, lineHeight: 22 },
  quoteSub: { fontSize: 12, marginTop: 4, fontWeight: "500" },

  policyHeader: { fontSize: 12, fontWeight: "700", marginTop: 24, textTransform: "uppercase", letterSpacing: 0.5 },
  bullet: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12 },
  bulletDot: { width: 10, height: 10, borderRadius: 5 },
  bulletText: { flex: 1, fontSize: 12, lineHeight: 18 },
  activeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  activeBadgeText: { fontSize: 12, fontWeight: "800", letterSpacing: 0.4 },

  footer: {
    position: "absolute",
    left: 0, right: 0, bottom: 0,
    flexDirection: "row", gap: 12,
    paddingHorizontal: 20, paddingTop: 12,
    borderTopWidth: 1,
  },
  cancelBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12, borderWidth: 1.5,
    alignItems: "center",
  },
  cancelBtnText: { fontSize: 15, fontWeight: "700" },
  confirmBtn: {
    flex: 1.4, paddingVertical: 14, borderRadius: 12,
    alignItems: "center", justifyContent: "center",
  },
  confirmBtnText: { fontSize: 15, fontWeight: "800", color: "#fff" },
});
