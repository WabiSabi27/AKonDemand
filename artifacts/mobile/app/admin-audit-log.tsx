import { Feather } from "@expo/vector-icons";
import { Stack, router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useGetAdminAuditLog } from "@workspace/api-client-react";

import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

/**
 * /admin-audit-log — Phase 3 #10 admin-only audit feed.
 *
 * Lists the most recent rows from `audit_log`, newest first, with optional
 * client-side filtering by entity type. Tapping the type chip set narrows the
 * server query (server enforces the filter so paging stays consistent).
 */

const ACCENT = "#FFB300";
const NAVY = "#0F1B2D";

type EntityType = "service" | "service_option" | "booking" | "biz_account" | "business";

const TYPE_OPTIONS: { value: EntityType | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "booking", label: "Bookings" },
  { value: "service", label: "Services" },
  { value: "service_option", label: "Options" },
  { value: "biz_account", label: "Applications" },
  { value: "business", label: "Businesses" },
];

const ROLE_COLOR: Record<string, string> = {
  admin: "#EF5350",
  business: "#5C6BC0",
  customer: "#26A69A",
};

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = Date.now();
  const diff = now - d.getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function AdminAuditLogScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const [filter, setFilter] = useState<EntityType | "all">("all");
  const params = filter === "all" ? { limit: 100 } : { limit: 100, entityType: filter };
  const q = useGetAdminAuditLog(params);
  const entries = q.data?.entries ?? [];

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScreenHeader variant="dark" title="Audit Log" subtitle="Who changed what, and when" />
      <View style={[styles.chipsWrap, { backgroundColor: NAVY }]}>
        <View style={styles.chipsRow}>
          {TYPE_OPTIONS.map((opt) => {
            const active = filter === opt.value;
            return (
              <TouchableOpacity
                key={opt.value}
                onPress={() => setFilter(opt.value)}
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
          <Text style={[styles.errText, { color: colors.foreground }]}>Could not load audit log.</Text>
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
              <Feather name="inbox" size={28} color={colors.mutedForeground} />
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No audit entries yet for this filter.
              </Text>
            </View>
          }
          renderItem={({ item }) => {
            const roleColor = item.actorRole ? (ROLE_COLOR[item.actorRole] ?? colors.mutedForeground) : colors.mutedForeground;
            const actorName = item.actorLabel ?? (item.actorRole ? `(${item.actorRole})` : "system");
            return (
              <View style={[styles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.rowTopLine}>
                  <View style={[styles.roleDot, { backgroundColor: roleColor }]} />
                  <Text style={[styles.actor, { color: colors.foreground }]} numberOfLines={1}>
                    {actorName}
                  </Text>
                  <Text style={[styles.when, { color: colors.mutedForeground }]}>{fmtWhen(item.at)}</Text>
                </View>
                <Text style={[styles.summary, { color: colors.foreground }]}>{item.summary || item.action}</Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.metaTag, { backgroundColor: colors.muted, color: colors.mutedForeground }]}>
                    {item.entityType}
                  </Text>
                  <Text style={[styles.metaAction, { color: roleColor }]}>{item.action}</Text>
                  <Text style={[styles.metaId, { color: colors.mutedForeground }]} numberOfLines={1}>
                    {item.entityId}
                  </Text>
                </View>
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
  roleDot: { width: 8, height: 8, borderRadius: 4 },
  actor: { flex: 1, fontSize: 12, fontWeight: "700" },
  when: { fontSize: 12 },
  summary: { fontSize: 15, fontWeight: "600", lineHeight: 19 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  metaTag: { fontSize: 12, fontWeight: "700", paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, overflow: "hidden" },
  metaAction: { fontSize: 12, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  metaId: { fontSize: 12, flex: 1, fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  emptyCard: { padding: 32, borderRadius: 14, borderWidth: 1, alignItems: "center", gap: 10 },
  emptyText: { fontSize: 12, textAlign: "center" },
});
