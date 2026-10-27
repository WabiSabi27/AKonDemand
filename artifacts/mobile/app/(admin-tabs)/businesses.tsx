import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useState } from "react";
import { router } from "expo-router";
import {
  Alert,
  FlatList,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BizAccount, useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

const BIZ_TYPE_LABELS: Record<string, string> = {
  "brick-and-mortar": "Brick & Mortar",
  "home-based": "Home-Based",
};

const PLAN_COLORS: Record<string, string> = { starter_gigger: "#5C6BC0", pro_business: "#FFB300" };
const PLAN_PRICES: Record<string, number> = { starter_gigger: 29, pro_business: 79 };
const PLAN_LABELS: Record<string, string> = { starter_gigger: "Starter Gigger", pro_business: "Pro Business" };
const FILTER_OPTS = ["All", "Starter Gigger", "Pro Business"] as const;
type FilterType = (typeof FILTER_OPTS)[number];
type ViewTab = "active" | "applications";

export default function AdminBusinessesTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { businesses, services, bookings, bizAccounts, acceptProvider, approveProvider, rejectProvider } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;

  const [viewTab, setViewTab] = useState<ViewTab>("applications");
  const [filter, setFilter] = useState<FilterType>("All");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** Application just accepted — drives the "next steps" panel. */
  const [nextStepApp, setNextStepApp] = useState<BizAccount | null>(null);

  const pendingApps = bizAccounts.filter((a) => a.status === "pending");
  const acceptedApps = bizAccounts.filter((a) => a.status === "accepted");
  const rejectedApps = bizAccounts.filter((a) => a.status === "rejected");
  const inReviewCount = pendingApps.length + acceptedApps.length;
  const filtered = businesses.filter((b) => filter === "All" || PLAN_LABELS[b.subscriptionPlan] === filter);

  async function doAccept(id: string) {
    await acceptProvider(id);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Show the post-accept "next steps" panel: login is active + schedule the
    // in-person meeting on the admin calendar.
    const app = bizAccounts.find((a) => a.id === id);
    if (app) setNextStepApp({ ...app, status: "accepted" });
  }

  function handleAccept(id: string, name: string) {
    const msg = `Accept "${name}"? They'll be prompted to pay the $2 onboarding fee to activate their account.`;
    if (Platform.OS === "web") {
      // RN-web Alert has no buttons — use the browser's native confirm.
      if (typeof window !== "undefined" && window.confirm(msg)) void doAccept(id);
      return;
    }
    Alert.alert("Accept Application", msg, [
      { text: "Cancel", style: "cancel" },
      { text: "Accept", onPress: () => void doAccept(id) },
    ]);
  }

  function handleApprove(id: string, name: string) {
    Alert.alert(
      "Approve Now (Override)",
      `Manually approve "${name}" without waiting for the $2 onboarding payment? This activates their provider account immediately.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Approve",
          onPress: async () => {
            await approveProvider(id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          },
        },
      ]
    );
  }

  function handleReject(id: string, name: string) {
    Alert.alert(
      "Reject Application",
      `Reject "${name}"'s application? They will not be able to access the platform.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reject",
          style: "destructive",
          onPress: async () => {
            await rejectProvider(id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          },
        },
      ]
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#0F1B2D" }]}>
        <Text style={styles.headerTitle}>Businesses</Text>
        <Text style={styles.headerSub}>
          {businesses.length} active · {inReviewCount} in review
        </Text>

        {/* View Switcher */}
        <View style={styles.viewSwitcher}>
          <TouchableOpacity
            style={[styles.viewBtn, viewTab === "applications" && { backgroundColor: "#FFB300" }]}
            onPress={() => setViewTab("applications")}
            activeOpacity={0.8}
          >
            {inReviewCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{inReviewCount}</Text>
              </View>
            )}
            <Text style={[styles.viewBtnText, { color: viewTab === "applications" ? "#fff" : "rgba(255,255,255,0.6)" }]}>
              Applications
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.viewBtn, viewTab === "active" && { backgroundColor: "#FFB300" }]}
            onPress={() => setViewTab("active")}
            activeOpacity={0.8}
          >
            <Text style={[styles.viewBtnText, { color: viewTab === "active" ? "#fff" : "rgba(255,255,255,0.6)" }]}>
              Active
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ── APPLICATIONS VIEW ── */}
      {viewTab === "applications" && (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.list, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 90 }]}
        >
          {inReviewCount + rejectedApps.length === 0 ? (
            <View style={styles.emptyBox}>
              <View style={[styles.emptyIcon, { backgroundColor: "#B39DDB18" }]}>
                <Feather name="check-circle" size={36} color="#B39DDB" />
              </View>
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>All caught up!</Text>
              <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
                No applications in review. New service provider sign-ups will appear here for your review.
              </Text>
            </View>
          ) : (
            <>
              {pendingApps.length > 0 && (
                <>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
                    AWAITING INTERVIEW · {pendingApps.length}
                  </Text>
                  {pendingApps.map((app) => (
                    <ApplicationCard
                      key={app.id}
                      app={app}
                      colors={colors}
                      expanded={expandedId === app.id}
                      onToggleExpand={() => setExpandedId(expandedId === app.id ? null : app.id)}
                      onAccept={() => handleAccept(app.id, app.businessName || app.name)}
                      onApprove={() => handleApprove(app.id, app.businessName || app.name)}
                      onReject={() => handleReject(app.id, app.businessName || app.name)}
                      statusColor="#FFB300"
                      statusLabel="Interview"
                      statusIcon="clock"
                      actions="accept"
                    />
                  ))}
                </>
              )}

              {acceptedApps.length > 0 && (
                <>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 16 }]}>
                    AWAITING ONBOARDING PAYMENT · {acceptedApps.length}
                  </Text>
                  {acceptedApps.map((app) => (
                    <ApplicationCard
                      key={app.id}
                      app={app}
                      colors={colors}
                      expanded={expandedId === app.id}
                      onToggleExpand={() => setExpandedId(expandedId === app.id ? null : app.id)}
                      onAccept={() => {}}
                      onApprove={() => handleApprove(app.id, app.businessName || app.name)}
                      onReject={() => handleReject(app.id, app.businessName || app.name)}
                      statusColor="#B39DDB"
                      statusLabel="Accepted"
                      statusIcon="award"
                      actions="approve"
                    />
                  ))}
                </>
              )}

              {rejectedApps.length > 0 && (
                <>
                  <Text style={[styles.sectionLabel, { color: colors.mutedForeground, marginTop: 16 }]}>
                    REJECTED
                  </Text>
                  {rejectedApps.map((app) => (
                    <ApplicationCard
                      key={app.id}
                      app={app}
                      colors={colors}
                      expanded={expandedId === app.id}
                      onToggleExpand={() => setExpandedId(expandedId === app.id ? null : app.id)}
                      onAccept={() => {}}
                      onApprove={() => {}}
                      onReject={() => {}}
                      statusColor="#F44336"
                      statusLabel="Rejected"
                      statusIcon="x-circle"
                      actions="none"
                    />
                  ))}
                </>
              )}
            </>
          )}
        </ScrollView>
      )}

      {/* ── ACTIVE BUSINESSES VIEW ── */}
      {viewTab === "active" && (
        <>
          <View style={[styles.filterBar, { backgroundColor: colors.card, borderBottomColor: colors.border }]}>
            <FlatList
              data={FILTER_OPTS as unknown as FilterType[]}
              keyExtractor={(i) => i}
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, gap: 8, paddingVertical: 10 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.chip, { backgroundColor: filter === item ? "#FFB300" : colors.secondary }]}
                  onPress={() => setFilter(item)}
                >
                  <Text style={[styles.chipText, { color: filter === item ? "#fff" : colors.mutedForeground }]}>{item}</Text>
                </TouchableOpacity>
              )}
            />
          </View>
          <FlatList
            data={filtered}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.list, { paddingBottom: Platform.OS === "web" ? 34 : insets.bottom + 90 }]}
            renderItem={({ item }) => {
              const planColor = PLAN_COLORS[item.subscriptionPlan] ?? "#78909C";
              const bizServices = services.filter((s) => s.businessId === item.id);
              const bizBookings = bookings.filter((b) => b.businessId === item.id);
              const bizFees = bizBookings.filter((b) => b.status !== "cancelled").reduce((s, b) => s + b.platformFee, 0);
              return (
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <View style={styles.cardTop}>
                    <View style={[styles.avatar, { backgroundColor: planColor + "20" }]}>
                      <Text style={[styles.avatarText, { color: planColor }]}>{item.name.charAt(0)}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.bizName, { color: colors.foreground }]}>{item.name}</Text>
                      <View style={styles.metaRow}>
                        <Feather name="map-pin" size={12} color={colors.mutedForeground} />
                        <Text style={[styles.metaText, { color: colors.mutedForeground }]}>{item.location || "—"}</Text>
                      </View>
                    </View>
                    <View style={[styles.planBadge, { backgroundColor: planColor }]}>
                      <Text style={styles.planBadgeText}>{PLAN_LABELS[item.subscriptionPlan] ?? item.subscriptionPlan}</Text>
                    </View>
                  </View>
                  <View style={[styles.divider, { backgroundColor: colors.border }]} />
                  <View style={styles.statsRow}>
                    <View style={styles.stat}>
                      <Text style={[styles.statNum, { color: colors.foreground }]}>{bizServices.length}</Text>
                      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Services</Text>
                    </View>
                    <View style={styles.stat}>
                      <Text style={[styles.statNum, { color: colors.foreground }]}>{bizBookings.length}</Text>
                      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Bookings</Text>
                    </View>
                    <View style={styles.stat}>
                      <Text style={[styles.statNum, { color: "#FFB300" }]}>${bizFees.toFixed(0)}</Text>
                      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Fees</Text>
                    </View>
                    <View style={styles.stat}>
                      <Text style={[styles.statNum, { color: planColor }]}>${PLAN_PRICES[item.subscriptionPlan] ?? "—"}/mo</Text>
                      <Text style={[styles.statLabel, { color: colors.mutedForeground }]}>Sub</Text>
                    </View>
                  </View>
                  <View style={[styles.statusRow, { borderTopColor: colors.border }]}>
                    <View style={[styles.statusDot, { backgroundColor: item.subscriptionActive ? "#B39DDB" : "#F44336" }]} />
                    <Text style={[styles.statusText, { color: item.subscriptionActive ? "#B39DDB" : "#F44336" }]}>
                      {item.subscriptionActive ? "Active" : "Inactive"}
                    </Text>
                    <Text style={[styles.joinDate, { color: colors.mutedForeground }]}>Joined {item.joinedDate}</Text>
                  </View>
                </View>
              );
            }}
          />
        </>
      )}

      {/* ── Post-accept "Next Steps" panel ── */}
      <Modal visible={!!nextStepApp} transparent animationType="fade" onRequestClose={() => setNextStepApp(null)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.card, borderColor: "#FFB30050" }]}>
            <View style={[styles.modalIconWrap, { backgroundColor: "#FFB30020" }]}>
              <Feather name="check-circle" size={28} color="#FFB300" />
            </View>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              {nextStepApp?.businessName} accepted!
            </Text>

            <View style={[styles.modalStep, { backgroundColor: colors.secondary }]}>
              <Feather name="key" size={15} color="#B39DDB" />
              <Text style={[styles.modalStepText, { color: colors.foreground }]}>
                Their login is ready — they sign in with {nextStepApp?.email} and the password they chose when applying. Access unlocks after they pay the onboarding fee.
              </Text>
            </View>
            <View style={[styles.modalStep, { backgroundColor: colors.secondary }]}>
              <Feather name="calendar" size={15} color="#FFB300" />
              <Text style={[styles.modalStepText, { color: colors.foreground }]}>
                Next: book the in-person meeting on your admin calendar.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.modalPrimaryBtn, { backgroundColor: "#FFB300" }]}
              activeOpacity={0.85}
              onPress={() => {
                const id = nextStepApp?.id;
                setNextStepApp(null);
                if (id) router.push({ pathname: "/(admin-tabs)/meetings", params: { bizAccountId: id } });
              }}
            >
              <Feather name="calendar" size={15} color="#0F1B2D" />
              <Text style={styles.modalPrimaryBtnText}>Schedule meeting</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalGhostBtn} onPress={() => setNextStepApp(null)} activeOpacity={0.7}>
              <Text style={[styles.modalGhostBtnText, { color: colors.mutedForeground }]}>Later</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ─── ApplicationCard Component ────────────────────────────────────────────────

interface AppCardProps {
  app: BizAccount;
  colors: any;
  expanded: boolean;
  onToggleExpand: () => void;
  onAccept: () => void;
  onApprove: () => void;
  onReject: () => void;
  statusColor: string;
  statusLabel: string;
  statusIcon: string;
  actions: "accept" | "approve" | "none";
}

function ApplicationCard({ app, colors, expanded, onToggleExpand, onAccept, onApprove, onReject, statusColor, statusLabel, statusIcon, actions }: AppCardProps) {
  const bizTypeBorderColor = statusColor + "40";

  return (
    <View style={[styles.appCard, { backgroundColor: colors.card, borderColor: bizTypeBorderColor }]}>
      {/* Header Row */}
      <View style={styles.appTop}>
        <View style={[styles.appAvatar, { backgroundColor: statusColor + "20" }]}>
          <Text style={[styles.appAvatarText, { color: statusColor }]}>
            {(app.businessName || app.name).charAt(0).toUpperCase()}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.appName, { color: colors.foreground }]}>{app.businessName || app.name}</Text>
          <Text style={[styles.appEmail, { color: colors.mutedForeground }]}>
            {app.ownerName ? `Owner: ${app.ownerName}` : app.email}
          </Text>
        </View>
        <View style={[styles.pendingBadge, { backgroundColor: statusColor + "20" }]}>
          <Feather name={statusIcon as any} size={11} color={statusColor} />
          <Text style={[styles.pendingBadgeText, { color: statusColor }]}>{statusLabel}</Text>
        </View>
      </View>

      <View style={[styles.appDivider, { backgroundColor: colors.border }]} />

      {/* Key Info Row */}
      <View style={styles.keyInfoRow}>
        {app.businessType && (
          <View style={[styles.keyInfoBadge, { backgroundColor: "#5C6BC020", borderColor: "#5C6BC030" }]}>
            <Feather name={app.businessType === "brick-and-mortar" ? "home" : "map-pin"} size={11} color="#5C6BC0" />
            <Text style={[styles.keyInfoBadgeText, { color: "#5C6BC0" }]}>{BIZ_TYPE_LABELS[app.businessType] || app.businessType}</Text>
          </View>
        )}
        {app.yearsInBusiness && (
          <View style={[styles.keyInfoBadge, { backgroundColor: "rgba(255,255,255,0.05)", borderColor: "rgba(255,255,255,0.1)" }]}>
            <Feather name="clock" size={11} color={colors.mutedForeground} />
            <Text style={[styles.keyInfoBadgeText, { color: colors.mutedForeground }]}>{app.yearsInBusiness === "New Business" ? "New Business" : `${app.yearsInBusiness} yrs`}</Text>
          </View>
        )}
        <View style={[styles.feePaidBadge, { backgroundColor: "#FFB30020" }]}>
          <Feather name="check-circle" size={11} color="#FFB300" />
          <Text style={[styles.feePaidText, { color: "#FFB300" }]}>$1 Paid</Text>
        </View>
      </View>

      {/* Dates */}
      <View style={styles.appMeta}>
        <View style={styles.appMetaItem}>
          <Feather name="calendar" size={12} color={colors.mutedForeground} />
          <Text style={[styles.appDate, { color: colors.mutedForeground }]}>
            Applied {new Date(app.appliedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
          </Text>
        </View>
        {app.expiresAt && (
          <View style={styles.appMetaItem}>
            <Feather name="alert-circle" size={12} color={colors.mutedForeground} />
            <Text style={[styles.appDate, { color: colors.mutedForeground }]}>
              Exp. {new Date(app.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </Text>
          </View>
        )}
      </View>

      {/* Expand / Collapse */}
      <TouchableOpacity style={styles.expandBtn} onPress={onToggleExpand} activeOpacity={0.7}>
        <Text style={[styles.expandBtnText, { color: colors.mutedForeground }]}>{expanded ? "Hide Details" : "View Full Application"}</Text>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={15} color={colors.mutedForeground} />
      </TouchableOpacity>

      {/* Expanded Details */}
      {expanded && (
        <View style={[styles.expandedSection, { borderTopColor: colors.border }]}>
          <DetailRow label="Email" value={app.email} icon="mail" colors={colors} />
          {app.phone && <DetailRow label="Phone" value={app.phone} icon="phone" colors={colors} />}
          {app.alaskaLicenseNumber && <DetailRow label="AK License" value={app.alaskaLicenseNumber} icon="award" colors={colors} />}

          {app.businessDescription ? (
            <>
              <Text style={[styles.expandLabel, { color: colors.mutedForeground }]}>BUSINESS DESCRIPTION</Text>
              <Text style={[styles.expandBody, { color: colors.foreground }]}>{app.businessDescription}</Text>
            </>
          ) : null}

          {app.services && app.services.length > 0 ? (
            <>
              <Text style={[styles.expandLabel, { color: colors.mutedForeground, marginTop: 10 }]}>SERVICES OFFERED</Text>
              {app.services.map((svc, i) => (
                <View key={svc.id || i} style={[styles.svcRow, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.svcName, { color: colors.foreground }]}>{svc.name}</Text>
                    {svc.description ? <Text style={[styles.svcDesc, { color: colors.mutedForeground }]}>{svc.description}</Text> : null}
                  </View>
                  <Text style={[styles.svcCost, { color: "#FFB300" }]}>${parseFloat(svc.cost || "0").toFixed(2)}</Text>
                </View>
              ))}
            </>
          ) : null}
        </View>
      )}

      {/* Action Buttons */}
      {actions === "accept" && (
        <View style={styles.appActions}>
          <TouchableOpacity style={[styles.rejectBtn, { borderColor: "#F44336", backgroundColor: "#F4433618" }]} onPress={onReject} activeOpacity={0.8}>
            <Feather name="x" size={15} color="#F44336" />
            <Text style={[styles.rejectBtnText, { color: "#F44336" }]}>Reject</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.approveBtn, { backgroundColor: "#FFB300" }]} onPress={onAccept} activeOpacity={0.85}>
            <Feather name="check" size={15} color="#0F1B2D" />
            <Text style={[styles.approveBtnText, { color: "#0F1B2D" }]}>Accept</Text>
          </TouchableOpacity>
        </View>
      )}
      {actions === "approve" && (
        <>
          <View style={[styles.onboardingNote, { backgroundColor: "#B39DDB18", borderColor: "#B39DDB40" }]}>
            <Feather name="clock" size={13} color="#B39DDB" />
            <Text style={[styles.onboardingNoteText, { color: "#B39DDB" }]}>
              Awaiting their $2 onboarding payment. Approving now overrides this.
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.onboardingNote, { backgroundColor: "#FFB30014", borderColor: "#FFB30040" }]}
            activeOpacity={0.8}
            onPress={() => router.push({ pathname: "/(admin-tabs)/meetings", params: { bizAccountId: app.id } })}
          >
            <Feather name="calendar" size={13} color="#FFB300" />
            <Text style={[styles.onboardingNoteText, { color: "#FFB300" }]}>
              {app.meetingAt
                ? `Meeting: ${new Date(app.meetingAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${new Date(app.meetingAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })} — tap to change`
                : "No in-person meeting booked — tap to schedule"}
            </Text>
          </TouchableOpacity>
          <View style={styles.appActions}>
            <TouchableOpacity style={[styles.rejectBtn, { borderColor: "#F44336", backgroundColor: "#F4433618" }]} onPress={onReject} activeOpacity={0.8}>
              <Feather name="x" size={15} color="#F44336" />
              <Text style={[styles.rejectBtnText, { color: "#F44336" }]}>Reject</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.approveBtn, { backgroundColor: "#B39DDB" }]} onPress={onApprove} activeOpacity={0.85}>
              <Feather name="check" size={15} color="#fff" />
              <Text style={styles.approveBtnText}>Approve now</Text>
            </TouchableOpacity>
          </View>
        </>
      )}
    </View>
  );
}

function DetailRow({ label, value, icon, colors }: { label: string; value: string; icon: string; colors: any }) {
  return (
    <View style={styles.detailRow}>
      <Feather name={icon as any} size={13} color={colors.mutedForeground} />
      <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>{label}:</Text>
      <Text style={[styles.detailValue, { color: colors.foreground }]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", alignItems: "center", justifyContent: "center", padding: 24 },
  modalCard: { width: "100%", maxWidth: 420, borderRadius: 20, borderWidth: 1, padding: 22, alignItems: "center", gap: 12 },
  modalIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center" },
  modalTitle: { fontSize: 17, fontWeight: "700", textAlign: "center" },
  modalStep: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderRadius: 12, padding: 12, width: "100%" },
  modalStepText: { flex: 1, fontSize: 13, lineHeight: 19 },
  modalPrimaryBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 12, paddingVertical: 13, width: "100%", marginTop: 4 },
  modalPrimaryBtnText: { color: "#0F1B2D", fontSize: 14.5, fontWeight: "700" },
  modalGhostBtn: { paddingVertical: 8 },
  modalGhostBtnText: { fontSize: 13, fontWeight: "600" },
  header: { paddingHorizontal: 20, paddingBottom: 16, gap: 4 },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  headerSub: { color: "rgba(255,255,255,0.55)", fontSize: 12, marginBottom: 12 },
  viewSwitcher: { flexDirection: "row", backgroundColor: "rgba(255,255,255,0.08)", borderRadius: 12, padding: 4, gap: 4 },
  viewBtn: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  viewBtnText: { fontSize: 12, fontWeight: "700" },
  badge: { backgroundColor: "#F44336", borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  filterBar: { borderBottomWidth: 1 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20 },
  chipText: { fontSize: 12, fontWeight: "600" },
  list: { padding: 16, gap: 12 },
  sectionLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.8, marginBottom: 8 },
  appCard: { borderRadius: 16, borderWidth: 1.5, padding: 16, gap: 10 },
  appTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  appAvatar: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  appAvatarText: { fontSize: 22, fontWeight: "800" },
  appName: { fontSize: 15, fontWeight: "700" },
  appEmail: { fontSize: 12, marginTop: 2 },
  pendingBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 },
  pendingBadgeText: { fontSize: 12, fontWeight: "700" },
  appDivider: { height: 1 },
  keyInfoRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  keyInfoBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, borderWidth: 1 },
  keyInfoBadgeText: { fontSize: 12, fontWeight: "600" },
  appMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 4 },
  appMetaItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  appDate: { fontSize: 12 },
  feePaidBadge: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  feePaidText: { fontSize: 12, fontWeight: "700" },
  expandBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 8 },
  expandBtnText: { fontSize: 12, fontWeight: "600" },
  expandedSection: { borderTopWidth: 1, paddingTop: 12, gap: 6 },
  expandLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.8, marginTop: 4 },
  expandBody: { fontSize: 12, lineHeight: 19 },
  detailRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  detailLabel: { fontSize: 12, width: 60 },
  detailValue: { fontSize: 12, fontWeight: "600", flex: 1 },
  svcRow: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 10, padding: 10, marginTop: 4 },
  svcName: { fontSize: 12, fontWeight: "700" },
  svcDesc: { fontSize: 12, marginTop: 2 },
  svcCost: { fontSize: 15, fontWeight: "800" },
  appActions: { flexDirection: "row", gap: 10 },
  rejectBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 12, borderWidth: 1 },
  rejectBtnText: { fontSize: 15, fontWeight: "700" },
  approveBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 12 },
  approveBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  onboardingNote: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 12 },
  onboardingNoteText: { flex: 1, fontSize: 12, lineHeight: 18, fontWeight: "600" },
  emptyBox: { alignItems: "center", gap: 12, paddingVertical: 48, paddingHorizontal: 24 },
  emptyIcon: { width: 72, height: 72, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 18, fontWeight: "700" },
  emptyText: { fontSize: 15, textAlign: "center", lineHeight: 20 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 12 },
  avatar: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 18, fontWeight: "800" },
  bizName: { fontSize: 15, fontWeight: "700", marginBottom: 3 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 12 },
  planBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7 },
  planBadgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  divider: { height: 1 },
  statsRow: { flexDirection: "row", justifyContent: "space-between" },
  stat: { alignItems: "center", gap: 2 },
  statNum: { fontSize: 15, fontWeight: "800" },
  statLabel: { fontSize: 12, fontWeight: "600" },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 10, borderTopWidth: 1 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, fontWeight: "700" },
  joinDate: { marginLeft: "auto", fontSize: 12 },
});
