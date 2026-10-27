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

const RATING_LABELS: Record<number, string> = {
  1: "Poor",
  2: "Fair",
  3: "Good",
  4: "Very good",
  5: "Excellent",
};

/**
 * /review/[bookingId] — customer leaves a 1–5 star review + optional comment.
 * Validates client-side that the booking is `completed` and unreviewed; the
 * server enforces the same invariants and the unique-bookingId constraint.
 */
export default function ReviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { bookingId } = useLocalSearchParams<{ bookingId: string }>();
  const { bookings, createReview, user } = useApp();

  const booking = useMemo(
    () => bookings.find((b) => b.id === bookingId),
    [bookings, bookingId],
  );

  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Guard rails: bad URL, wrong user, or already-reviewed → friendly screen.
  if (!booking) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Review" }} />
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
        <Stack.Screen options={{ title: "Review" }} />
        <View style={styles.empty}>
          <Feather name="lock" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            Only the customer can review this booking
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.status !== "completed") {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Review" }} />
        <View style={styles.empty}>
          <Feather name="clock" size={40} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            You can review once the booking is completed
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  if (booking.reviewed) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: "Review" }} />
        <View style={styles.empty}>
          <Feather name="check-circle" size={40} color="#22C55E" />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
            You already reviewed this booking
          </Text>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={[styles.backBtnText, { color: colors.primary }]}>Go back</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  async function handleSubmit() {
    if (rating < 1 || rating > 5) {
      Alert.alert("Pick a rating", "Tap 1–5 stars to rate this booking.");
      return;
    }
    if (submitting) return;
    setSubmitting(true);
    try {
      await createReview({
        bookingId: booking!.id,
        rating,
        comment: comment.trim() || undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err) {
      // Server enforces the same one-review-per-booking rule via UNIQUE.
      // 409 = already reviewed (race with another device).
      if (err instanceof ApiError && err.status === 409) {
        Alert.alert("Already reviewed", "You have already submitted a review for this booking.");
        router.back();
        return;
      }
      const message =
        err instanceof ApiError
          ? ((err.data as { error?: string } | null)?.error ?? "Could not submit review")
          : "Could not submit review";
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
      <ScreenHeader title="Leave a review" />
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.summary,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}
        >
          <Text style={[styles.summaryLabel, { color: colors.mutedForeground }]}>
            {booking.businessName}
          </Text>
          <Text style={[styles.summaryTitle, { color: colors.foreground }]}>
            {booking.serviceTitle}
          </Text>
          <Text style={[styles.summaryOption, { color: colors.mutedForeground }]}>
            {booking.optionName}
          </Text>
        </View>

        <Text style={[styles.sectionLabel, { color: colors.foreground }]}>
          How was your experience?
        </Text>
        <View style={styles.starsRow}>
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= rating;
            return (
              <TouchableOpacity
                key={n}
                onPress={() => {
                  Haptics.selectionAsync();
                  setRating(n);
                }}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={`${n} star${n === 1 ? "" : "s"}`}
                hitSlop={8}
                style={styles.starBtn}
              >
                <Feather
                  name="star"
                  size={42}
                  color={filled ? colors.star : colors.border}
                />
              </TouchableOpacity>
            );
          })}
        </View>
        <Text style={[styles.ratingLabel, { color: colors.mutedForeground }]}>
          {rating > 0 ? RATING_LABELS[rating] : "Tap to rate"}
        </Text>

        <Text style={[styles.sectionLabel, { color: colors.foreground, marginTop: 28 }]}>
          Add a comment (optional)
        </Text>
        <TextInput
          value={comment}
          onChangeText={setComment}
          placeholder="What did you like? Anything to improve?"
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={1000}
          style={[
            styles.input,
            {
              backgroundColor: colors.card,
              borderColor: colors.border,
              color: colors.foreground,
            },
          ]}
        />
        <Text style={[styles.charCount, { color: colors.mutedForeground }]}>
          {comment.length}/1000
        </Text>

        <TouchableOpacity
          onPress={handleSubmit}
          disabled={submitting || rating < 1}
          activeOpacity={0.85}
          style={[
            styles.submitBtn,
            {
              backgroundColor:
                submitting || rating < 1 ? colors.mutedForeground : colors.primary,
            },
          ]}
        >
          <Text style={styles.submitText}>
            {submitting ? "Submitting…" : "Submit review"}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: 20 },
  summary: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 22,
  },
  summaryLabel: { fontSize: 12, fontWeight: "600", marginBottom: 2 },
  summaryTitle: { fontSize: 18, fontWeight: "800" },
  summaryOption: { fontSize: 12, marginTop: 2 },
  sectionLabel: { fontSize: 15, fontWeight: "700", marginBottom: 10 },
  starsRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginVertical: 4,
  },
  starBtn: { padding: 4 },
  ratingLabel: {
    textAlign: "center",
    fontSize: 12,
    fontWeight: "600",
    marginTop: 6,
  },
  input: {
    minHeight: 110,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    fontSize: 15,
    textAlignVertical: "top",
  },
  charCount: { fontSize: 12, textAlign: "right", marginTop: 4 },
  submitBtn: {
    marginTop: 24,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: "center",
  },
  submitText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", textAlign: "center" },
  backBtn: { marginTop: 8, padding: 8 },
  backBtnText: { fontSize: 15, fontWeight: "700" },
});
