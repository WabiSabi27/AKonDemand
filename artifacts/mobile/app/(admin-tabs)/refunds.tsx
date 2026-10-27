import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError } from "@workspace/api-client-react";

import type { Booking } from "@/context/AppContext";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

/**
 * /(admin-tabs)/refunds — admin arbitration queue. Shows every booking with
 * an open refund request. Approve triggers the actual Stripe refund; deny
 * requires a written reason that's surfaced back to the customer.
 */
export default function AdminRefundsTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { pendingRefundRequests, decideRefundRequest } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const [denyTarget, setDenyTarget] = useState<Booking | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function handleApprove(b: Booking) {
    Alert.alert(
      "Approve refund?",
      `Issue a $${b.total.toFixed(2)} refund to ${b.customerName} for "${b.serviceTitle}"? This charges Stripe immediately and cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve & refund",
          style: "destructive",
          onPress: async () => {
            setBusy(b.id);
            try {
              await decideRefundRequest(b.id, "approved");
            } catch (err) {
              const message =
                err instanceof ApiError
                  ? ((err.data as { error?: string } | null)?.error ?? "Refund failed")
                  : "Refund failed";
              Alert.alert("Could not approve", message);
            } finally {
              setBusy(null);
            }
          },
        },
      ],
    );
  }

  async function handleDenySubmit() {
    if (!denyTarget) return;
    const trimmed = denyReason.trim();
    if (trimmed.length < 5) {
      Alert.alert("Reason required", "Please provide a short explanation (at least 5 characters) for the customer.");
      return;
    }
    setBusy(denyTarget.id);
    try {
      await decideRefundRequest(denyTarget.id, "denied", trimmed);
      setDenyTarget(null);
      setDenyReason("");
    } catch (err) {
      const message =
        err instanceof ApiError
          ? ((err.data as { error?: string } | null)?.error ?? "Could not deny request")
          : "Could not deny request";
      Alert.alert("Something went wrong", message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#0F1B2D" }]}>
        <Text style={styles.headerTitle}>Refund requests</Text>
        <Text style={styles.headerSub}>
          {pendingRefundRequests.length} pending · approving issues a Stripe refund immediately
        </Text>
      </View>

      {pendingRefundRequests.length === 0 ? (
        <View style={styles.empty}>
          <Feather name="check-circle" size={44} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>All caught up</Text>
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            No open refund requests right now
          </Text>
        </View>
      ) : (
        <FlatList
          data={pendingRefundRequests}
          keyExtractor={(b) => b.id}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: Platform.OS === "web" ? 100 : insets.bottom + 100 },
          ]}
          renderItem={({ item }) => {
            const isBusy = busy === item.id;
            return (
              <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.cardTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.business, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {item.businessName}
                    </Text>
                    <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={2}>
                      {item.serviceTitle}
                    </Text>
                    <Text style={[styles.option, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {item.optionName} · {item.customerName}
                    </Text>
                  </View>
                  <View style={styles.amountBox}>
                    <Text style={[styles.amount, { color: colors.foreground }]}>${item.total.toFixed(2)}</Text>
                    <Text style={[styles.amountLabel, { color: colors.mutedForeground }]}>refund</Text>
                  </View>
                </View>

                <View style={[styles.reasonBox, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.reasonLabel, { color: colors.mutedForeground }]}>Customer reason</Text>
                  <Text style={[styles.reasonText, { color: colors.foreground }]}>
                    {item.refundReason ?? "(no reason provided)"}
                  </Text>
                  {item.refundRequestedAt && (
                    <Text style={[styles.reasonMeta, { color: colors.mutedForeground }]}>
                      Requested {new Date(item.refundRequestedAt).toLocaleString()}
                    </Text>
                  )}
                </View>

                <View style={styles.actions}>
                  <TouchableOpacity
                    style={[styles.denyBtn, { borderColor: colors.destructive, opacity: isBusy ? 0.5 : 1 }]}
                    disabled={isBusy}
                    onPress={() => {
                      setDenyTarget(item);
                      setDenyReason("");
                    }}
                  >
                    <Feather name="x" size={14} color={colors.destructive} />
                    <Text style={[styles.denyText, { color: colors.destructive }]}>Deny</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.approveBtn, { backgroundColor: "#22C55E", opacity: isBusy ? 0.5 : 1 }]}
                    disabled={isBusy}
                    onPress={() => handleApprove(item)}
                  >
                    <Feather name="check" size={14} color="#fff" />
                    <Text style={styles.approveText}>{isBusy ? "Working…" : "Approve & refund"}</Text>
                  </TouchableOpacity>
                </View>
              </View>
            );
          }}
        />
      )}

      <Modal
        visible={!!denyTarget}
        animationType="slide"
        transparent
        onRequestClose={() => setDenyTarget(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card }]}>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>Deny refund</Text>
            <Text style={[styles.modalSub, { color: colors.mutedForeground }]}>
              The customer will see this reason on their booking.
            </Text>
            <TextInput
              value={denyReason}
              onChangeText={setDenyReason}
              placeholder="Explain why this refund is being denied (e.g. service was completed as scheduled)."
              placeholderTextColor={colors.mutedForeground}
              multiline
              maxLength={1000}
              style={[
                styles.modalInput,
                { backgroundColor: colors.secondary, borderColor: colors.border, color: colors.foreground },
              ]}
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalCancel, { borderColor: colors.border }]}
                onPress={() => setDenyTarget(null)}
              >
                <Text style={[styles.modalCancelText, { color: colors.foreground }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalSubmit, { backgroundColor: colors.destructive }]}
                onPress={handleDenySubmit}
                disabled={busy === denyTarget?.id}
              >
                <Text style={styles.modalSubmitText}>
                  {busy === denyTarget?.id ? "Denying…" : "Deny refund"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 18 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "800" },
  headerSub: { color: "#B0BEC5", fontSize: 12, marginTop: 4 },
  list: { padding: 16, gap: 12 },
  card: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    gap: 12,
  },
  cardTop: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  business: { fontSize: 12, fontWeight: "600" },
  title: { fontSize: 15, fontWeight: "700", lineHeight: 19, marginTop: 2 },
  option: { fontSize: 12, marginTop: 2 },
  amountBox: { alignItems: "flex-end" },
  amount: { fontSize: 18, fontWeight: "800" },
  amountLabel: { fontSize: 12 },
  reasonBox: { borderRadius: 10, padding: 12, gap: 4 },
  reasonLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.5 },
  reasonText: { fontSize: 12, lineHeight: 18, fontWeight: "500" },
  reasonMeta: { fontSize: 12, marginTop: 2 },
  actions: { flexDirection: "row", gap: 10 },
  denyBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  denyText: { fontSize: 12, fontWeight: "700" },
  approveBtn: {
    flex: 1.5,
    paddingVertical: 10,
    borderRadius: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  approveText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 8, paddingHorizontal: 40 },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyText: { fontSize: 12, textAlign: "center" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalCard: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 12 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  modalSub: { fontSize: 12 },
  modalInput: {
    minHeight: 110,
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    fontSize: 15,
    textAlignVertical: "top",
  },
  modalActions: { flexDirection: "row", gap: 10, marginTop: 4 },
  modalCancel: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: "center",
  },
  modalCancelText: { fontSize: 15, fontWeight: "700" },
  modalSubmit: { flex: 1.4, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  modalSubmitText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
