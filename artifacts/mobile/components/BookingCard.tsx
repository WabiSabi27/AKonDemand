import { Feather } from "@expo/vector-icons";
import React from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useColors } from "@/hooks/useColors";
import { BRAND } from "@/constants/colors";
import type { Booking } from "@/context/AppContext";
import { formatDateMMDDYY } from "@/utils/specialties";

const STATUS_COLORS: Record<string, string> = {
  pending: "#FFB300",
  confirmed: "#AB47BC",
  completed: "#22C55E",
  cancelled: "#6B7A8D",
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
};

interface BookingCardProps {
  booking: Booking;
  onCancel?: () => void;
  /**
   * When provided AND the booking is `completed` AND not yet reviewed, the
   * card surfaces a "Leave a review" button that calls back. Hide the prop on
   * SP-side surfaces (orders feed) where reviewing doesn't apply.
   */
  onReview?: () => void;
  /**
   * Phase 3 #2: customer-only "Request refund" button. Surfaced when the
   * booking was paid (paymentIntentId present), is confirmed/completed, has
   * no existing refund, and no pending refund request yet.
   */
  onRequestRefund?: () => void;
  /**
   * Phase 3 #6: opens the per-booking chat thread. Surfaced for any non-
   * cancelled booking when a handler is provided. Customer-side calls pass
   * this; SP-side surfaces use a separate dedicated button on the order card.
   */
  onMessage?: () => void;
}

function formatBookingTime(t: string): string {
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

export function BookingCard({ booking, onCancel, onReview, onRequestRefund, onMessage }: BookingCardProps) {
  const colors = useColors();
  const statusColor = STATUS_COLORS[booking.status] ?? colors.mutedForeground;

  // Cancel CTA: pending/confirmed only, when caller passes a handler.
  const showCancel =
    (booking.status === "pending" || booking.status === "confirmed") && !!onCancel;
  // Review CTA: customer-only flows pass `onReview`; only shown for completed
  // bookings the customer hasn't already reviewed.
  const showReview = booking.status === "completed" && !!onReview && !booking.reviewed;
  const showReviewedBadge = booking.status === "completed" && booking.reviewed;

  // Phase 3 #2 — refund state derivations
  const refundPending = !!booking.refundRequestedAt && !booking.refundDecision;
  const refundDenied = booking.refundDecision === "denied";
  const refundApproved = !!booking.refundId || booking.refundDecision === "approved";
  const showRefundRequest =
    !!onRequestRefund &&
    !!booking.paymentIntentId &&
    (booking.status === "confirmed" || booking.status === "completed") &&
    !refundPending &&
    !refundApproved &&
    !refundDenied &&
    !booking.disputeId;

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={[styles.business, { color: colors.mutedForeground }]} numberOfLines={1}>
            {booking.businessName}
          </Text>
          <Text style={[styles.service, { color: colors.foreground }]} numberOfLines={2}>
            {booking.serviceTitle}
          </Text>
          <Text style={[styles.option, { color: colors.mutedForeground }]}>
            {booking.optionName}
          </Text>
        </View>
        <View style={[styles.statusBadge, { backgroundColor: statusColor + "20" }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>
            {STATUS_LABELS[booking.status]}
          </Text>
        </View>
      </View>

      <View style={[styles.divider, { backgroundColor: colors.border }]} />

      <View style={styles.detailsRow}>
        <View style={styles.detail}>
          <Feather name="calendar" size={13} color={colors.mutedForeground} />
          <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
            {formatDateMMDDYY(booking.scheduledDate)}
          </Text>
        </View>
        {booking.scheduledTime && (
          <View style={styles.detail}>
            <Feather name="clock" size={13} color={colors.mutedForeground} />
            <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
              {formatBookingTime(booking.scheduledTime)}
            </Text>
          </View>
        )}
        <View style={styles.detail}>
          <Feather name="dollar-sign" size={13} color={colors.mutedForeground} />
          <Text style={[styles.detailText, { color: colors.mutedForeground }]}>
            ${booking.total.toFixed(2)} total
          </Text>
        </View>
      </View>

      {showCancel && (
        <TouchableOpacity
          style={[styles.cancelBtn, { borderColor: colors.destructive }]}
          onPress={onCancel}
          activeOpacity={0.8}
        >
          <Text style={[styles.cancelText, { color: colors.destructive }]}>Cancel Booking</Text>
        </TouchableOpacity>
      )}

      {showReview && (
        <TouchableOpacity
          style={[styles.reviewBtn, { backgroundColor: colors.primary }]}
          onPress={onReview}
          activeOpacity={0.85}
        >
          <Feather name="star" size={14} color="#fff" />
          <Text style={styles.reviewBtnText}>Leave a review</Text>
        </TouchableOpacity>
      )}

      {showReviewedBadge && (
        <View style={[styles.reviewedRow, { borderColor: colors.border }]}>
          <Feather name="check-circle" size={14} color="#22C55E" />
          <Text style={[styles.reviewedText, { color: colors.mutedForeground }]}>
            Review submitted
          </Text>
        </View>
      )}

      {refundPending && (
        <View style={[styles.refundPill, { backgroundColor: "#FFB30015", borderColor: "#FFB30055" }]}>
          <Feather name="clock" size={13} color="#B07300" />
          <Text style={[styles.refundPillText, { color: "#B07300" }]}>
            Refund requested — awaiting review
          </Text>
        </View>
      )}
      {refundDenied && (
        <View style={[styles.refundPill, { backgroundColor: "#F4433615", borderColor: "#F4433655" }]}>
          <Feather name="x-circle" size={13} color="#C62828" />
          <Text style={[styles.refundPillText, { color: "#C62828" }]} numberOfLines={3}>
            Refund denied{booking.refundDecisionReason ? `: ${booking.refundDecisionReason}` : ""}
          </Text>
        </View>
      )}
      {refundApproved && (
        <View style={[styles.refundPill, { backgroundColor: "#22C55E15", borderColor: "#22C55E55" }]}>
          <Feather name="check-circle" size={13} color="#1B7F3A" />
          <Text style={[styles.refundPillText, { color: "#1B7F3A" }]}>
            {typeof booking.cancellationRefundCents === "number" && booking.cancellationRefundCents > 0
              ? `Refund issued: $${(booking.cancellationRefundCents / 100).toFixed(2)}`
              : "Refund issued"}
          </Text>
        </View>
      )}
      {/* Phase 3 #7 — Customer cancelled but policy gave them no refund. */}
      {booking.status === "cancelled" && booking.cancellationRefundCents === 0 && !refundApproved && (
        <View style={[styles.refundPill, { backgroundColor: "#6B7A8D15", borderColor: "#6B7A8D55" }]}>
          <Feather name="info" size={13} color="#4A5568" />
          <Text style={[styles.refundPillText, { color: "#4A5568" }]}>
            Cancelled — no refund (inside policy window)
          </Text>
        </View>
      )}
      {!!booking.disputeId && (
        <View style={[styles.refundPill, { backgroundColor: "#9C27B015", borderColor: "#9C27B055" }]}>
          <Feather name="alert-triangle" size={13} color="#6A1B9A" />
          <Text style={[styles.refundPillText, { color: "#6A1B9A" }]} numberOfLines={2}>
            Card dispute opened{booking.disputeStatus ? ` (${booking.disputeStatus})` : ""}
          </Text>
        </View>
      )}

      {showRefundRequest && (
        <TouchableOpacity
          style={[styles.refundBtn, { borderColor: colors.border, backgroundColor: colors.secondary }]}
          onPress={onRequestRefund}
          activeOpacity={0.85}
        >
          <Feather name="rotate-ccw" size={14} color={colors.foreground} />
          <Text style={[styles.refundBtnText, { color: colors.foreground }]}>Request refund</Text>
        </TouchableOpacity>
      )}

      {!!onMessage && booking.status !== "cancelled" && (
        <TouchableOpacity
          style={[styles.messageBtn, { borderColor: colors.primary }]}
          onPress={onMessage}
          activeOpacity={0.85}
        >
          <Feather name="message-circle" size={14} color={colors.primary} />
          <Text style={[styles.messageBtnText, { color: colors.primary }]}>Message provider</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  headerLeft: {
    flex: 1,
    gap: 2,
  },
  business: {
    fontSize: 12,
    fontWeight: "500",
  },
  service: {
    fontSize: 15,
    fontWeight: "700",
    lineHeight: 20,
  },
  option: {
    fontSize: 12,
    marginTop: 2,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "700",
  },
  divider: {
    height: 1,
    marginVertical: 12,
  },
  detailsRow: {
    flexDirection: "row",
    gap: 20,
  },
  detail: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
  },
  detailText: {
    fontSize: 12,
    fontWeight: "500",
  },
  cancelBtn: {
    marginTop: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
  },
  cancelText: {
    fontSize: 12,
    fontWeight: "700",
  },
  reviewBtn: {
    marginTop: 12,
    paddingVertical: 10,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  reviewBtnText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#fff",
  },
  reviewedRow: {
    marginTop: 12,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  reviewedText: {
    fontSize: 12,
    fontWeight: "600",
  },
  refundPill: {
    marginTop: 10,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  refundPillText: {
    fontSize: 12,
    fontWeight: "600",
    flex: 1,
  },
  refundBtn: {
    marginTop: 10,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  refundBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },
  messageBtn: {
    marginTop: 10,
    paddingVertical: 9,
    borderRadius: 10,
    borderWidth: 1.5,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  messageBtnText: {
    fontSize: 12,
    fontWeight: "700",
  },
});
