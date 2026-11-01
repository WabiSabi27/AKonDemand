import { Feather } from "@expo/vector-icons";
import React from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getGetAdminMetricsQueryKey, useGetAdminMetrics } from "@workspace/api-client-react";
import { router } from "expo-router";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { PaymentWebhookStatus } from "@/components/PaymentWebhookStatus";

/**
 * /(admin-tabs)/index — operational metrics dashboard (Phase 3 #9).
 *
 * Server-driven via GET /admin/metrics. Replaces the previous client-side
 * AppContext aggregation, which only saw whatever data the admin user
 * happened to have loaded into the cache.
 */

const ACCENT = "#FFB300";
const NAVY = "#0F1B2D";

function fmtUsdCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function pct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

function StatCard({
  label,
  value,
  sub,
  icon,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: keyof typeof Feather.glyphMap;
  color: string;
}) {
  const colors = useColors();
  return (
    <View style={[statStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[statStyles.iconBox, { backgroundColor: color + "18" }]}>
        <Feather name={icon} size={20} color={color} />
      </View>
      <Text style={[statStyles.value, { color: colors.foreground }]}>{value}</Text>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
      {sub && <Text style={[statStyles.sub, { color }]}>{sub}</Text>}
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: { flex: 1, minWidth: "45%", borderRadius: 16, borderWidth: 1, padding: 16, gap: 6, alignItems: "center" },
  iconBox: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  value: { fontSize: 22, fontWeight: "700" },
  label: { fontSize: 12, fontWeight: "600", textAlign: "center" },
  sub: { fontSize: 12, fontWeight: "700" },
});

export default function AdminOverviewTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { logout } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const metricsQ = useGetAdminMetrics({
    query: {
      queryKey: getGetAdminMetricsQueryKey(),
      // Surface newly failed emails while the dashboard stays open.
      refetchInterval: 60_000,
    },
  });
  const data = metricsQ.data;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      contentContainerStyle={{ paddingBottom: bottomInset + 90 }}
      showsVerticalScrollIndicator={false}
      refreshControl={undefined}
    >
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: NAVY }]}>
        <View style={styles.headerTopRow}>
          <View style={[styles.adminBadge, { backgroundColor: ACCENT + "20" }]}>
            <Feather name="shield" size={12} color={ACCENT} />
            <Text style={[styles.adminBadgeText, { color: ACCENT }]}>ADMIN</Text>
          </View>
          <TouchableOpacity style={styles.loginBtn} onPress={logout} activeOpacity={0.8}>
            <Feather name="log-in" size={14} color={ACCENT} />
            <Text style={styles.loginBtnText}>Login</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTitle}>Platform Overview</Text>
        <Text style={styles.headerSub}>AK On Demand LLC</Text>
      </View>

      <PaymentWebhookStatus readiness={data?.paymentWebhook} failed={Boolean(metricsQ.error)} />

      {metricsQ.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      ) : metricsQ.error || !data ? (
        <View style={styles.center}>
          <Feather name="alert-triangle" size={28} color={colors.destructive} />
          <Text style={[styles.errText, { color: colors.foreground }]}>Could not load metrics.</Text>
          <TouchableOpacity
            onPress={() => metricsQ.refetch()}
            style={[styles.retryBtn, { backgroundColor: ACCENT }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {/* ── Top-line stats ──────────────────────────────────────── */}
          <View style={styles.statsGrid}>
            <StatCard
              label="GMV (30d)"
              value={fmtUsdCents(data.gmv.last30Cents)}
              sub={`${fmtUsdCents(data.gmv.lifetimeCents)} lifetime`}
              icon="trending-up"
              color="#B39DDB"
            />
            <StatCard
              label="Platform Fees (30d)"
              value={fmtUsdCents(data.gmv.last30PlatformFeeCents)}
              sub={`${fmtUsdCents(data.gmv.lifetimePlatformFeeCents)} lifetime`}
              icon="dollar-sign"
              color="#FFB300"
            />
            <StatCard
              label="MRR"
              value={fmtUsdCents(data.subscriptions.mrrCents)}
              sub={`${data.subscriptions.totalActive} active subs`}
              icon="repeat"
              color="#5C6BC0"
            />
            <StatCard
              label="Active / Inactive"
              value={`${data.churn.activeNow} / ${data.churn.inactiveNow}`}
              sub={`${pct(data.churn.activeNow, data.churn.activeNow + data.churn.inactiveNow)} active`}
              icon="users"
              color={ACCENT}
            />
          </View>

          {/* ── Subscription breakdown ──────────────────────────────── */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Subscription Breakdown</Text>
            <View style={[styles.planCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {[
                { key: "starter_gigger" as const, label: "Starter Gigger", price: "$29/mo", color: "#5C6BC0" },
                { key: "pro_business" as const, label: "Pro Business", price: "$79/mo", color: ACCENT },
              ].map((plan, idx, arr) => {
                const tier = data.subscriptions.byTier[plan.key];
                return (
                  <View
                    key={plan.key}
                    style={[
                      styles.planRow,
                      {
                        borderBottomColor: colors.border,
                        borderBottomWidth: idx < arr.length - 1 ? 1 : 0,
                      },
                    ]}
                  >
                    <View style={[styles.planDot, { backgroundColor: plan.color }]} />
                    <Text style={[styles.planLabel, { color: colors.foreground }]}>{plan.label}</Text>
                    <Text style={[styles.planPrice, { color: colors.mutedForeground }]}>{plan.price}</Text>
                    <Text style={[styles.planCount, { color: plan.color }]}>{tier.count} businesses</Text>
                    <Text style={[styles.planRevenue, { color: colors.foreground }]}>
                      {fmtUsdCents(tier.mrrCents)}/mo
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>

          {/* ── Conversion funnel ───────────────────────────────────── */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Conversion Funnel</Text>
            <View style={[styles.planCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              {(() => {
                const f = data.funnel;
                const stages = [
                  { label: "Applications", value: f.applications, prev: null as number | null, color: "#78909C" },
                  { label: "Paid $1 fee", value: f.paid, prev: f.applications, color: "#5C6BC0" },
                  { label: "Approved", value: f.approved, prev: f.paid, color: "#26A69A" },
                  { label: "Active w/ booking", value: f.activeWithBooking, prev: f.approved, color: "#B39DDB" },
                ];
                return stages.map((s, idx) => (
                  <View
                    key={s.label}
                    style={[
                      styles.planRow,
                      {
                        borderBottomColor: colors.border,
                        borderBottomWidth: idx < stages.length - 1 ? 1 : 0,
                      },
                    ]}
                  >
                    <View style={[styles.planDot, { backgroundColor: s.color }]} />
                    <Text style={[styles.planLabel, { color: colors.foreground }]}>{s.label}</Text>
                    {s.prev !== null && (
                      <Text style={[styles.planPrice, { color: colors.mutedForeground }]}>
                        {pct(s.value, s.prev)} of prev
                      </Text>
                    )}
                    <Text style={[styles.planRevenue, { color: s.color }]}>{s.value}</Text>
                  </View>
                ));
              })()}
            </View>
          </View>

          {/* ── Audit log entry point (Phase 3 #10) ─────────────────── */}
          <View style={styles.section}>
            <TouchableOpacity
              onPress={() => router.push("/admin-audit-log")}
              activeOpacity={0.85}
              style={[styles.auditBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[statStyles.iconBox, { backgroundColor: ACCENT + "18" }]}>
                <Feather name="file-text" size={20} color={ACCENT} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.auditTitle, { color: colors.foreground }]}>Audit Log</Text>
                <Text style={[styles.auditSub, { color: colors.mutedForeground }]}>
                  Recent admin & SP actions
                </Text>
              </View>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* ── Stripe webhook dead-letter queue (TD-3) ─────────────── */}
          <View style={styles.section}>
            <TouchableOpacity
              onPress={() => router.push("/admin-stripe-webhooks")}
              activeOpacity={0.85}
              style={[styles.auditBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[statStyles.iconBox, { backgroundColor: "#EF535018" }]}>
                <Feather name="alert-octagon" size={20} color="#EF5350" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.auditTitle, { color: colors.foreground }]}>Stripe Webhook Queue</Text>
                <Text style={[styles.auditSub, { color: colors.mutedForeground }]}>
                  Failed events — review and replay
                </Text>
              </View>
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* ── Email outbox (Task #7, failed badge Task #13) ───────── */}
          <View style={styles.section}>
            <TouchableOpacity
              onPress={() => router.push("/admin-email-outbox")}
              activeOpacity={0.85}
              style={[
                styles.auditBtn,
                { backgroundColor: colors.card, borderColor: colors.border },
                data.emailOutbox.failedCount > 0 && { borderColor: "#EF5350" },
              ]}
            >
              <View
                style={[
                  statStyles.iconBox,
                  { backgroundColor: data.emailOutbox.failedCount > 0 ? "#EF535018" : "#66BB6A18" },
                ]}
              >
                <Feather
                  name="mail"
                  size={20}
                  color={data.emailOutbox.failedCount > 0 ? "#EF5350" : "#66BB6A"}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.auditTitle, { color: colors.foreground }]}>Email Outbox</Text>
                <Text style={[styles.auditSub, { color: colors.mutedForeground }]}>
                  {data.emailOutbox.failedCount > 0
                    ? "Emails gave up retrying — retry or dismiss"
                    : "Failed notification emails — retry or dismiss"}
                </Text>
              </View>
              {data.emailOutbox.failedCount > 0 && (
                <View style={styles.failedBadge}>
                  <Text style={styles.failedBadgeText}>
                    {data.emailOutbox.failedCount > 99 ? "99+" : data.emailOutbox.failedCount}
                  </Text>
                </View>
              )}
              <Feather name="chevron-right" size={20} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* ── Top categories ──────────────────────────────────────── */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Top Categories (30d)</Text>
            {data.topCategories.length === 0 ? (
              <View style={[styles.planCard, { backgroundColor: colors.card, borderColor: colors.border, padding: 16 }]}>
                <Text style={{ color: colors.mutedForeground, textAlign: "center" }}>
                  No bookings in the last 30 days yet.
                </Text>
              </View>
            ) : (
              <View style={[styles.planCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {(() => {
                  const max = Math.max(...data.topCategories.map((c) => c.gmvCents), 1);
                  return data.topCategories.map((c, idx, arr) => (
                    <View
                      key={c.id}
                      style={[
                        styles.catRow,
                        {
                          borderBottomColor: colors.border,
                          borderBottomWidth: idx < arr.length - 1 ? 1 : 0,
                        },
                      ]}
                    >
                      <View style={styles.catTopRow}>
                        <Text style={[styles.catName, { color: colors.foreground }]} numberOfLines={1}>
                          {c.name}
                        </Text>
                        <Text style={[styles.catGmv, { color: colors.foreground }]}>
                          {fmtUsdCents(c.gmvCents)}
                        </Text>
                      </View>
                      <View style={[styles.barTrack, { backgroundColor: colors.border }]}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              backgroundColor: ACCENT,
                              width: `${Math.max(4, Math.round((c.gmvCents / max) * 100))}%`,
                            },
                          ]}
                        />
                      </View>
                      <Text style={[styles.catSub, { color: colors.mutedForeground }]}>
                        {c.bookings} booking{c.bookings === 1 ? "" : "s"}
                      </Text>
                    </View>
                  ));
                })()}
              </View>
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { padding: 48, alignItems: "center", gap: 12 },
  errText: { fontSize: 15, fontWeight: "700" },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
  retryText: { color: "#0F1B2D", fontWeight: "800" },
  header: { paddingHorizontal: 20, paddingBottom: 24, gap: 6 },
  headerTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  adminBadge: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  adminBadgeText: { fontSize: 12, fontWeight: "800", letterSpacing: 0.5 },
  loginBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10, borderWidth: 1, borderColor: "rgba(255,179,0,0.35)", backgroundColor: "rgba(255,179,0,0.1)" },
  loginBtnText: { color: ACCENT, fontSize: 12, fontWeight: "700" },
  headerTitle: { color: "#fff", fontSize: 28, fontWeight: "900" },
  headerSub: { color: "rgba(255,255,255,0.55)", fontSize: 12 },
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10, padding: 16 },
  section: { paddingHorizontal: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 18, fontWeight: "800", marginBottom: 10 },
  planCard: { borderRadius: 14, borderWidth: 1, overflow: "hidden" },
  planRow: { flexDirection: "row", alignItems: "center", padding: 14, gap: 10 },
  planDot: { width: 10, height: 10, borderRadius: 5 },
  planLabel: { flex: 1, fontSize: 15, fontWeight: "700" },
  planPrice: { fontSize: 12 },
  planCount: { fontSize: 12, fontWeight: "700" },
  planRevenue: { fontSize: 15, fontWeight: "800" },
  catRow: { padding: 14, gap: 6 },
  catTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  catName: { flex: 1, fontSize: 15, fontWeight: "700" },
  catGmv: { fontSize: 15, fontWeight: "800" },
  catSub: { fontSize: 12 },
  barTrack: { height: 6, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
  auditBtn: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 14, borderWidth: 1 },
  failedBadge: { minWidth: 24, height: 24, borderRadius: 12, backgroundColor: "#EF5350", alignItems: "center", justifyContent: "center", paddingHorizontal: 7 },
  failedBadgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  auditTitle: { fontSize: 15, fontWeight: "800" },
  auditSub: { fontSize: 12, marginTop: 2 },
});
