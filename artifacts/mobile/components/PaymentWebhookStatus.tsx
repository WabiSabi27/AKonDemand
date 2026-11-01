import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { Feather } from "@expo/vector-icons";
import type { AdminWebhookReadiness } from "@workspace/api-client-react";
import { useColors } from "@/hooks/useColors";

export function PaymentWebhookStatus({
  readiness,
  failed,
}: {
  readiness?: AdminWebhookReadiness;
  failed: boolean;
}) {
  const colors = useColors();
  const status = failed ? undefined : readiness?.status;
  const ready = status === "ready";
  const unavailable = status === "unavailable";
  const color = ready ? "#26A69A" : unavailable || failed ? "#EF5350" : "#FFB300";
  const title = failed
    ? "Payment update status could not be checked"
    : ready
      ? "Automatic payment updates available"
      : unavailable
        ? readiness?.environment === "preview"
          ? "Automatic payment updates unavailable in this preview"
          : "Automatic payment updates unavailable"
        : "Checking automatic payment updates…";
  const reason = failed
    ? "Refresh the dashboard to check again. Availability is unknown."
    : readiness?.reason ?? "Waiting for payment callback startup verification.";

  return (
    <View
      accessibilityLiveRegion="polite"
      style={[styles.card, { backgroundColor: colors.card, borderColor: color }]}
    >
      <View style={styles.heading}>
        <Feather name={ready ? "check-circle" : unavailable || failed ? "alert-triangle" : "clock"} size={20} color={color} />
        <Text style={[styles.title, { color: colors.foreground }]}>{title}</Text>
      </View>
      <Text style={[styles.reason, { color: colors.foreground }]}>{reason}</Text>
      <Text style={[styles.note, { color: colors.mutedForeground }]}>
        Startup verification only. API availability does not confirm delivery of individual payment updates.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 16, padding: 16, borderWidth: 1, borderRadius: 14, gap: 8 },
  heading: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { flex: 1, fontSize: 15, fontWeight: "800" },
  reason: { fontSize: 13, lineHeight: 19 },
  note: { fontSize: 12, lineHeight: 18 },
});
