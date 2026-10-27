import { Feather } from "@expo/vector-icons";
import { router, Stack, useLocalSearchParams } from "expo-router";
import React, { useMemo, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { ApiError } from "@workspace/api-client-react";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

const MIN_REASON = 10;
const MAX_REASON = 1000;

/**
 * /refund-request/[bookingId] — customer asks an admin to refund a paid
 * booking. Server enforces: caller is the customer, booking has a
 * paymentIntentId, status is confirmed/completed, no existing refund/dispute,
 * and no open request. Reason is required (10–1000 chars).
 */
export default function RefundRequestScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const { bookings, requestRefund, user } = useApp();

  const booking = useMemo(
    () => bookings.find((b) => b.id === bookingId),
    [bookings, bookingId],
  );

  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!booking) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="alert-circle" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Booking not found</Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (user?.role !== "customer" || booking.customerId !== user.id) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="lock" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Only the customer who booked can request a refund
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (!booking.paymentIntentId) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="info" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            This booking wasn't paid online — there's nothing to refund
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.disputeId) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="alert-triangle" size={40} color="#9C27B0" />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            A card dispute is open on this booking — your bank is handling the resolution
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.refundDecision === "denied") {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="x-circle" size={40} color="#C62828" />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            A previous refund request was denied{booking.refundDecisionReason ? `: ${booking.refundDecisionReason}` : ""}
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.refundRequestedAt && !booking.refundDecision) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="clock" size={40} color="#FFB300" />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            You've already requested a refund — an admin will review it shortly
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.status !== "confirmed" && booking.status !== "completed") {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="info" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Only confirmed or completed bookings can be refunded
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.refundId || booking.refundDecision === "approved") {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Refund request" }} />
        <View style={styles.empty}>
          <Feather name="check-circle" size={40} color="#22C55E" />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            This booking has already been refunded
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const trimmed = reason.trim();
  const valid = trimmed.length >= MIN_REASON && trimmed.length <= MAX_REASON;

  async function handleSubmit() {
    if (!valid) {
      Alert.alert("Add a bit more detail", `Please describe what went wrong (at least ${MIN_REASON} characters).`);
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await requestRefund(booking!.id, trimmed);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert(
        "Request submitted",
        "An admin will review your refund request and get back to you.",
        [{ text: "OK", onPress: () => router.back() }],
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        Alert.alert("Already requested", "A refund request is already on file for this booking.");
        router.back();
        return;
      }
      const message =
        err instanceof ApiError
          ? ((err.data as { error?: string } | null)?.error ?? "Could not submit refund request")
          : "Could not submit refund request";
      Alert.alert("Something went wrong", message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader title="Request a refund" />
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={[styles.summary, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>{booking.businessName}</Text>
          <Text style={[styles.summaryTitle, { color: colors.foreground }]}>{booking.serviceTitle}</Text>
          <Text style={[styles.summaryOption, { color: colors.mutedForeground }]}>
            {booking.optionName} · ${booking.total.toFixed(2)}
          </Text>
        </View>

        <View style={[styles.notice, { backgroundColor: "#FFB30015", borderColor: "#FFB30055" }]}>
          <Feather name="info" size={14} color="#B07300" />
          <Text style={[styles.noticeText, { color: "#7A4F00" }]}>
            Refunds are reviewed by an AK On Demand admin. If approved, the full amount goes back to your card within
            5–10 business days.
          </Text>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.foreground }]}>Why are you requesting a refund?</Text>
        <TextInput
          value={reason}
          onChangeText={setReason}
          placeholder="Tell us what happened so an admin can review (e.g. service didn't show up, work wasn't completed, etc.)."
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={MAX_REASON}
          style={[
            styles.input,
            { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground },
          ]}
        />
        <Text style={[styles.charCount, { color: colors.mutedForeground }]}>
          {trimmed.length}/{MAX_REASON} (min {MIN_REASON})
        </Text>

        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting || !valid}
          activeOpacity={0.85}
          style={[
            styles.submitBtn,
            { backgroundColor: submitting || !valid ? colors.mutedForeground : colors.primary },
          ]}
        >
          <Text style={styles.submitText}>{submitting ? "Submitting…" : "Submit refund request"}</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 20 },
  summary: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 16 },
  summaryLabel: { fontSize: 12, fontWeight: "600", marginBottom: 2 },
  summaryTitle: { fontSize: 18, fontWeight: "800" },
  summaryOption: { fontSize: 12, marginTop: 2 },
  notice: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    borderRadius: 10,
    borderWidth: 1,
    padding: 12,
    marginBottom: 22,
  },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "500" },
  sectionLabel: { fontSize: 15, fontWeight: "700", marginBottom: 10 },
  input: {
    minHeight: 140,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    fontSize: 15,
    textAlignVertical: "top",
  },
  charCount: { fontSize: 12, textAlign: "right", marginTop: 4 },
  submitBtn: { marginTop: 24, paddingVertical: 14, borderRadius: 12, alignItems: "center" },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  backBtn: { marginTop: 8, padding: 8 },
  backBtnText: { fontSize: 15, fontWeight: "700" },
});
