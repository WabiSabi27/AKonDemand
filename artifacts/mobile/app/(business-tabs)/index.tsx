import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError, useGetMyBizAccount, getGetMyBizAccountQueryKey } from "@workspace/api-client-react";

import { useApp } from "@/context/AppContext";
import type { Service, ServiceOption } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { useMeetingExpiry } from "@/hooks/useMeetingExpiry";
import { getSpecialtiesForCategory, parseDurationMinutes, minutesToTimeLabel, timeStrToMinutes } from "@/utils/specialties";

const PLAN_COLORS: Record<string, string> = {
  starter_gigger: "#5C6BC0",
  pro_business: "#FFB300",
};

const PLAN_LABELS: Record<string, string> = {
  starter_gigger: "Starter Gigger",
  pro_business: "Pro Business",
};

// Threshold above which a pricing option is considered "long duration" and the
// SP gets the Default Start Time picker. 480 min = 8h = "full day".
const LONG_DURATION_THRESHOLD_MIN = 480;
// Default start time the picker pre-selects when an SP first marks an option as long-duration.
const DEFAULT_LONG_DURATION_START = "08:00";
// Preset starts the picker offers as one-tap chips.
const START_TIME_PRESETS = ["06:00", "07:00", "08:00", "09:00", "10:00"];

function isLongDuration(durationText: string): boolean {
  const mins = parseDurationMinutes(durationText);
  return mins !== null && mins >= LONG_DURATION_THRESHOLD_MIN;
}

interface ServiceFormOption {
  name: string;
  description: string;
  price: string;
  duration: string;
  defaultStartTime: string;
}

const emptyOption = (): ServiceFormOption => ({ name: "", description: "", price: "", duration: "", defaultStartTime: "" });

function formatBookingTime(t: string): string {
  const [hStr, mStr] = t.split(":");
  let h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "PM" : "AM";
  if (h === 0) h = 12; else if (h > 12) h -= 12;
  return `${h}:${m} ${ampm}`;
}

function StatCard({ label, value, icon, color }: { label: string; value: string; icon: string; color: string }) {
  const colors = useColors();
  return (
    <View style={[statStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[statStyles.icon, { backgroundColor: color + "18" }]}>
        <Feather name={icon as any} size={18} color={color} />
      </View>
      <Text style={[statStyles.value, { color: colors.foreground }]}>{value}</Text>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: { flex: 1, borderRadius: 14, borderWidth: 1, padding: 14, alignItems: "center", gap: 6 },
  icon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  value: { fontSize: 22, fontWeight: "800" },
  label: { fontSize: 12, fontWeight: "600", textAlign: "center" },
});

export default function BusinessDashboardTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, updateUser, services, bookings, businesses, categories, addService, updateService, deleteService, addBusiness, logout, subscription, openSubscriptionCheckout } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const myBusiness = businesses.find((b) => b.ownerId === user?.id);

  // Own biz_account snapshot — surfaces a still-upcoming meeting (e.g. an
  // admin-scheduled follow-up) inside the logged-in provider dashboard.
  const bizAccountQ = useGetMyBizAccount({
    query: {
      queryKey: getGetMyBizAccountQueryKey(),
      enabled: user?.role === "business",
      refetchInterval: 60_000,
    },
  });
  const meetingAtStr = bizAccountQ.data?.meetingAt ?? null;
  useMeetingExpiry(meetingAtStr);
  const upcomingMeeting =
    meetingAtStr && new Date(meetingAtStr).getTime() > Date.now()
      ? {
          at: new Date(meetingAtStr),
          location: bizAccountQ.data?.meetingLocation ?? null,
          durationMinutes: bizAccountQ.data?.meetingDurationMinutes ?? null,
        }
      : null;
  const myServices = services.filter((s) => s.businessId === myBusiness?.id);
  const myBookings = bookings.filter((b) => b.businessId === myBusiness?.id);
  const pendingBookings = myBookings.filter((b) => b.status === "pending" || b.status === "confirmed");
  const netRevenue = myBookings
    .filter((b) => b.status !== "cancelled")
    .reduce((sum, b) => sum + (b.price - b.platformFee), 0);

  const [kebabOpen, setKebabOpen] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [editingService, setEditingService] = useState<Service | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategoryId, setFormCategoryId] = useState(categories[0]?.id ?? "");
  const [formOptions, setFormOptions] = useState<ServiceFormOption[]>([emptyOption()]);
  const [formRequiredSpecialty, setFormRequiredSpecialty] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const myEmployees = myBusiness?.employees ?? [];
  const formSpecialtyChoices = getSpecialtiesForCategory(formCategoryId);
  const matchingEmpCountForForm = formRequiredSpecialty
    ? myEmployees.filter((e) => e.specialty === formRequiredSpecialty).length
    : myEmployees.length;

  const [setupVisible, setSetupVisible] = useState(false);
  const [bizName, setBizName] = useState("");
  const [bizDesc, setBizDesc] = useState("");
  const [bizPhone, setBizPhone] = useState("");
  const [bizLocation, setBizLocation] = useState("");
  const [settingUp, setSettingUp] = useState(false);

  function openAddModal() {
    setEditingService(null);
    setFormTitle(""); setFormDescription("");
    setFormCategoryId(categories[0]?.id ?? "");
    setFormOptions([emptyOption()]);
    setFormRequiredSpecialty(null);
    setModalVisible(true);
  }

  function openEditModal(service: Service) {
    setEditingService(service);
    setFormTitle(service.title);
    setFormDescription(service.description);
    setFormCategoryId(service.categoryId);
    setFormOptions(service.options.map((o) => {
      // For long-duration options, normalize a missing/empty defaultStartTime
      // to "08:00" so the picker's visual selection matches what gets saved.
      // Without this, the chip shows 8 AM as selected but state stays empty,
      // and handleSave drops it — so the customer never gets a pinned slot.
      const long = isLongDuration(o.duration);
      const dst = o.defaultStartTime ?? "";
      return {
        name: o.name,
        description: o.description,
        price: String(o.price),
        duration: o.duration,
        defaultStartTime: long && !dst ? DEFAULT_LONG_DURATION_START : dst,
      };
    }));
    setFormRequiredSpecialty(service.requiredSpecialty ?? null);
    setModalVisible(true);
    Haptics.selectionAsync();
  }

  function updateOption(idx: number, field: keyof ServiceFormOption, value: string) {
    setFormOptions(
      formOptions.map((o, i) => {
        if (i !== idx) return o;
        const next = { ...o, [field]: value };
        // When the SP types a duration that flips into "long" territory (≥ 8h)
        // and they haven't picked a start time yet, default to 8:00 AM. When
        // they shorten back below 8h, clear the pinned time so we don't write
        // a stale value to the server.
        if (field === "duration") {
          if (isLongDuration(value) && !next.defaultStartTime) {
            next.defaultStartTime = DEFAULT_LONG_DURATION_START;
          } else if (!isLongDuration(value) && next.defaultStartTime) {
            next.defaultStartTime = "";
          }
        }
        return next;
      }),
    );
  }

  async function handleSave() {
    if (!formTitle.trim() || !myBusiness) return;
    const validOptions = formOptions.filter((o) => o.name.trim() && o.price.trim());
    if (validOptions.length === 0) { Alert.alert("Required", "Add at least one pricing option."); return; }
    setSaving(true);
    const options: ServiceOption[] = validOptions.map((o, i) => {
      const dur = o.duration.trim() || "TBD";
      const opt: ServiceOption = {
        id: editingService?.options[i]?.id ?? `${Date.now()}_${i}`,
        name: o.name.trim(),
        description: o.description.trim(),
        price: parseFloat(o.price) || 0,
        duration: dur,
      };
      // Only persist a defaultStartTime for long-duration options; short
      // services use the normal multi-slot availability picker.
      if (isLongDuration(dur) && o.defaultStartTime) {
        opt.defaultStartTime = o.defaultStartTime;
      }
      return opt;
    });
    const startingPrice = Math.min(...options.map((o) => o.price));
    const cleanedSpecialty = formRequiredSpecialty?.trim() || undefined;
    try {
      if (editingService) {
        await updateService({ ...editingService, title: formTitle.trim(), description: formDescription.trim(), categoryId: formCategoryId, options, startingPrice, requiredSpecialty: cleanedSpecialty });
      } else {
        await addService({ id: `svc_${Date.now()}`, businessId: myBusiness.id, businessName: myBusiness.name, categoryId: formCategoryId, title: formTitle.trim(), description: formDescription.trim(), rating: 0, reviewCount: 0, startingPrice, options, tags: [], featured: false, reviews: [], requiredSpecialty: cleanedSpecialty });
      }
      setModalVisible(false);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      // 402 = paywall hit (over plan cap or subscription inactive). Server
      // returns a friendly `error` message; surface it and offer to jump to
      // the plan picker. Any other error falls through to a generic alert.
      if (err instanceof ApiError && err.status === 402) {
        const data = (err.data ?? {}) as { error?: string; reason?: string };
        const message = data.error ?? "Your current plan won't allow another listing. Upgrade to add more.";
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        Alert.alert("Upgrade required", message, [
          { text: "Not now", style: "cancel" },
          { text: "View plans", onPress: () => { setModalVisible(false); router.push("/business-portal"); } },
        ]);
      } else {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert("Couldn't save", err instanceof Error ? err.message : "Please try again.");
      }
    } finally {
      setSaving(false);
    }
  }

  /** Trigger Stripe Checkout to move to Pro Business (the only paid upgrade target). */
  async function handleUpgradePress() {
    const next = "pro_business" as const;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await openSubscriptionCheckout(next);
    } catch (err) {
      Alert.alert("Checkout failed", err instanceof Error ? err.message : "Please try again.");
    }
  }

  function handleDelete(service: Service) {
    Alert.alert("Delete Service", `Delete "${service.title}"?`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: async () => { await deleteService(service.id); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } },
    ]);
  }

  async function handleSetupBusiness() {
    if (!bizName.trim() || !user) return;
    setSettingUp(true);
    const newBusiness = { id: `biz_${Date.now()}`, ownerId: user.id, name: bizName.trim(), description: bizDesc.trim(), categoryId: categories[0]?.id ?? "cleaning", rating: 0, reviewCount: 0, subscriptionActive: true, subscriptionPlan: "starter_gigger" as const, phone: bizPhone.trim(), location: bizLocation.trim(), joinedDate: new Date().toISOString().split("T")[0], serviceCount: 0, stripeAccountStatus: "none" as const, stripePayoutsEnabled: false, cancellationFullRefundHours: 24, cancellationPartialRefundHours: 2, cancellationPartialRefundPercent: 50 };
    await addBusiness(newBusiness);
    await updateUser({ role: "business", businessId: newBusiness.id });
    setSettingUp(false); setSetupVisible(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  if (!myBusiness) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#5C6BC0" }]}>
          <Text style={styles.headerTitle}>Business Dashboard</Text>
        </View>
        <View style={styles.emptyCenter}>
          <View style={[styles.emptyIcon, { backgroundColor: "#5C6BC018" }]}>
            <Feather name="briefcase" size={40} color="#5C6BC0" />
          </View>
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Set Up Your Business</Text>
          <Text style={[styles.emptyDesc, { color: colors.mutedForeground }]}>
            Create your business profile to start adding services and accepting bookings from customers.
          </Text>
          <TouchableOpacity style={[styles.setupBtn, { backgroundColor: "#5C6BC0" }]} onPress={() => setSetupVisible(true)} activeOpacity={0.85}>
            <Text style={styles.setupBtnText}>Create Business Profile</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.portalBtn, { borderColor: colors.border }]} onPress={() => router.push("/business-portal")} activeOpacity={0.85}>
            <Text style={[styles.portalBtnText, { color: "#5C6BC0" }]}>View Subscription Plans</Text>
          </TouchableOpacity>
        </View>
        <Modal visible={setupVisible} animationType="slide" presentationStyle="pageSheet">
          <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
            <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
              <TouchableOpacity onPress={() => setSetupVisible(false)}><Feather name="x" size={22} color={colors.foreground} /></TouchableOpacity>
              <Text style={[styles.modalTitle, { color: colors.foreground }]}>Create Business Profile</Text>
              <TouchableOpacity onPress={handleSetupBusiness} disabled={settingUp}><Text style={[styles.modalSave, { color: "#5C6BC0", opacity: settingUp ? 0.5 : 1 }]}>{settingUp ? "Saving..." : "Create"}</Text></TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Business Name *</Text>
              <TextInput style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="e.g. ABC Cleaning Co." placeholderTextColor={colors.mutedForeground} value={bizName} onChangeText={setBizName} />
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Description</Text>
              <TextInput style={[styles.fieldInput, styles.textArea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="What makes your business special..." placeholderTextColor={colors.mutedForeground} value={bizDesc} onChangeText={setBizDesc} multiline numberOfLines={3} />
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Phone</Text>
              <TextInput style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="+1 555-0100" placeholderTextColor={colors.mutedForeground} value={bizPhone} onChangeText={setBizPhone} keyboardType="phone-pad" />
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Service Area</Text>
              <TextInput style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="e.g. Downtown, Metro area" placeholderTextColor={colors.mutedForeground} value={bizLocation} onChangeText={setBizLocation} />
              <View style={{ height: 40 }} />
            </ScrollView>
          </View>
        </Modal>
      </View>
    );
  }

  const planColor = PLAN_COLORS[myBusiness.subscriptionPlan] ?? "#5C6BC0";

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: bottomInset + 90 }}>
        <View style={[styles.header, { paddingTop: topInset + 16, backgroundColor: "#5C6BC0" }]}>
          <View style={styles.headerRow}>
            <Text style={styles.headerTitle}>{myBusiness.name}</Text>
            <TouchableOpacity
              onPress={() => setKebabOpen(true)}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Feather name="more-vertical" size={22} color="rgba(255,255,255,0.9)" />
            </TouchableOpacity>
          </View>
          <View style={[styles.planBadge, { backgroundColor: planColor }]}>
            <Text style={styles.planBadgeText}>{PLAN_LABELS[myBusiness.subscriptionPlan] ?? myBusiness.subscriptionPlan}</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <StatCard label="Services" value={String(myServices.length)} icon="list" color="#5C6BC0" />
          <StatCard label="Orders" value={String(myBookings.length)} icon="calendar" color={colors.accent} />
          <StatCard label="Earned" value={`$${netRevenue.toFixed(0)}`} icon="dollar-sign" color="#FFB300" />
        </View>

        {/* ── Plan & usage card ── server is the source of truth via /me/subscription;
            falls back to the businesses-row hint while the query loads so the card
            doesn't pop in. Shows "Upgrade" CTA when at-cap or subscription inactive. */}
        {(() => {
          const plan = subscription?.plan ?? myBusiness.subscriptionPlan;
          const active = subscription?.active ?? myBusiness.subscriptionActive;
          const used = subscription?.servicesUsed ?? myServices.length;
          // null limit = Premium / unlimited
          const limit = subscription?.servicesLimit ?? null;
          const cardColor = PLAN_COLORS[plan] ?? "#5C6BC0";
          const atCap = limit !== null && used >= limit;
          const showUpgrade = !active || atCap;
          const usageText =
            limit === null ? `${used} services · unlimited` : `${used} of ${limit} services used`;
          const pct = limit === null ? 1 : Math.min(1, used / Math.max(1, limit));
          return (
            <View style={[styles.planCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <View style={styles.planCardHeader}>
                <View style={[styles.planCardDot, { backgroundColor: cardColor }]} />
                <Text style={[styles.planCardName, { color: colors.foreground }]}>
                  {PLAN_LABELS[plan] ?? plan} plan
                </Text>
                {!active && (
                  <View style={[styles.planCardChip, { backgroundColor: "#E5393520" }]}>
                    <Text style={[styles.planCardChipText, { color: "#E53935" }]}>Inactive</Text>
                  </View>
                )}
              </View>
              <Text style={[styles.planCardUsage, { color: colors.mutedForeground }]}>{usageText}</Text>
              <View style={[styles.planCardBarTrack, { backgroundColor: colors.border }]}>
                <View
                  style={[
                    styles.planCardBarFill,
                    { width: `${pct * 100}%`, backgroundColor: atCap ? "#E53935" : cardColor },
                  ]}
                />
              </View>
              {showUpgrade ? (
                <TouchableOpacity
                  style={[styles.planCardCta, { backgroundColor: cardColor }]}
                  onPress={handleUpgradePress}
                  activeOpacity={0.85}
                >
                  <Feather name="arrow-up-circle" size={15} color="#fff" />
                  <Text style={styles.planCardCtaText}>
                    {!active ? "Reactivate subscription" : "Upgrade to Pro Business"}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.planCardCtaGhost, { borderColor: colors.border }]}
                  onPress={() => router.push("/business-portal")}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.planCardCtaGhostText, { color: colors.mutedForeground }]}>Manage plan</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })()}

        {/* ── Upcoming meeting card ── shown when the admin has a future
            meeting scheduled on the provider's biz_account. */}
        {upcomingMeeting && (
          <View style={[styles.meetingCard, { backgroundColor: colors.card, borderColor: "#5C6BC0" }]}>
            <View style={styles.meetingHeader}>
              <View style={[styles.meetingIcon, { backgroundColor: "#5C6BC018" }]}>
                <Feather name="calendar" size={18} color="#5C6BC0" />
              </View>
              <Text style={[styles.meetingTitle, { color: colors.foreground }]}>Upcoming Meeting</Text>
            </View>
            <Text style={[styles.meetingTime, { color: colors.foreground }]}>
              {upcomingMeeting.at.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              {" · "}
              {upcomingMeeting.at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              {upcomingMeeting.durationMinutes ? ` (${upcomingMeeting.durationMinutes} min)` : ""}
            </Text>
            {upcomingMeeting.location ? (
              <View style={styles.meetingLocRow}>
                <Feather name="map-pin" size={13} color={colors.mutedForeground} />
                <Text style={[styles.meetingLoc, { color: colors.mutedForeground }]}>{upcomingMeeting.location}</Text>
              </View>
            ) : null}
          </View>
        )}

        {pendingBookings.length > 0 && (
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Pending Orders <Text style={{ color: "#5C6BC0" }}>({pendingBookings.length})</Text></Text>
            {pendingBookings.map((b) => (
              <View key={b.id} style={[styles.bookingCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.bookingRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.bookingTitle, { color: colors.foreground }]}>{b.serviceTitle}</Text>
                    <Text style={[styles.bookingMeta, { color: colors.mutedForeground }]}>{b.optionName} · {new Date(b.scheduledDate).toLocaleDateString()}{b.scheduledTime ? ` · ${formatBookingTime(b.scheduledTime)}` : ""}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end", gap: 4 }}>
                    <Text style={[styles.bookingPrice, { color: colors.foreground }]}>${b.price.toFixed(2)}</Text>
                    <View style={[styles.statusBadge, { backgroundColor: "#5C6BC020" }]}><Text style={[styles.statusText, { color: "#5C6BC0" }]}>{b.status}</Text></View>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}

        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>My Services</Text>
            <TouchableOpacity style={[styles.addBtn, { backgroundColor: "#5C6BC0" }]} onPress={openAddModal} activeOpacity={0.85}>
              <Feather name="plus" size={15} color="#fff" />
              <Text style={styles.addBtnText}>Add Service</Text>
            </TouchableOpacity>
          </View>
          {myServices.length === 0 ? (
            <TouchableOpacity style={[styles.emptyServices, { backgroundColor: colors.card, borderColor: colors.border }]} onPress={openAddModal} activeOpacity={0.85}>
              <Feather name="plus-circle" size={32} color="#5C6BC0" />
              <Text style={[styles.emptyServicesTitle, { color: colors.foreground }]}>Add Your First Service</Text>
              <Text style={[styles.emptyServicesDesc, { color: colors.mutedForeground }]}>Customers will browse and book your services directly in the app.</Text>
            </TouchableOpacity>
          ) : (
            myServices.map((service) => (
              <View key={service.id} style={[styles.serviceCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={styles.serviceRow}>
                  <View style={[styles.serviceIcon, { backgroundColor: "#5C6BC018" }]}><Feather name="briefcase" size={18} color="#5C6BC0" /></View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.serviceTitle, { color: colors.foreground }]}>{service.title}</Text>
                    <Text style={[styles.serviceMeta, { color: colors.mutedForeground }]}>{service.options.length} option{service.options.length !== 1 ? "s" : ""} · from ${service.startingPrice}</Text>
                  </View>
                  <View style={styles.serviceActions}>
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: colors.secondary }]} onPress={() => openEditModal(service)}><Feather name="edit-2" size={14} color={colors.foreground} /></TouchableOpacity>
                    <TouchableOpacity style={[styles.actionBtn, { backgroundColor: colors.destructive + "18" }]} onPress={() => handleDelete(service)}><Feather name="trash-2" size={14} color={colors.destructive} /></TouchableOpacity>
                  </View>
                </View>
                {service.requiredSpecialty && (
                  <View style={[styles.optionPill, { backgroundColor: "#5C6BC014", flexDirection: "row", alignItems: "center", gap: 4 }]}>
                    <Feather name="award" size={11} color="#5C6BC0" />
                    <Text style={[styles.optionPillText, { color: "#5C6BC0", fontWeight: "700" }]}>Specialty: {service.requiredSpecialty}</Text>
                  </View>
                )}
                {service.options.slice(0, 2).map((opt) => (
                  <View key={opt.id} style={[styles.optionPill, { backgroundColor: colors.secondary }]}>
                    <Text style={[styles.optionPillText, { color: colors.mutedForeground }]}>{opt.name} — ${opt.price} · {opt.duration}</Text>
                  </View>
                ))}
              </View>
            ))
          )}
        </View>
      </ScrollView>

      {/* Kebab dropdown */}
      <Modal visible={kebabOpen} transparent animationType="fade" onRequestClose={() => setKebabOpen(false)}>
        <Pressable style={styles.kebabBackdrop} onPress={() => setKebabOpen(false)}>
          <View style={[styles.kebabDropdown, { top: topInset + 44 }]}>
            <TouchableOpacity
              style={styles.kebabItem}
              onPress={() => { setKebabOpen(false); logout(); }}
              activeOpacity={0.8}
            >
              <Feather name="log-out" size={17} color="#E53935" />
              <Text style={[styles.kebabItemLabel, { color: "#E53935" }]}>Logout</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      <Modal visible={modalVisible} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modalContainer, { backgroundColor: colors.background }]}>
          <View style={[styles.modalHeader, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={() => setModalVisible(false)}><Feather name="x" size={22} color={colors.foreground} /></TouchableOpacity>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>{editingService ? "Edit Service" : "Add Service"}</Text>
            <TouchableOpacity onPress={handleSave} disabled={saving}><Text style={[styles.modalSave, { color: "#5C6BC0", opacity: saving ? 0.5 : 1 }]}>{saving ? "Saving..." : "Save"}</Text></TouchableOpacity>
          </View>
          <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled">
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Service Title *</Text>
            <TextInput style={[styles.fieldInput, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="e.g. Deep Home Cleaning" placeholderTextColor={colors.mutedForeground} value={formTitle} onChangeText={setFormTitle} />
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Description</Text>
            <TextInput style={[styles.fieldInput, styles.textArea, { backgroundColor: colors.card, borderColor: colors.border, color: colors.foreground }]} placeholder="What's included..." placeholderTextColor={colors.mutedForeground} value={formDescription} onChangeText={setFormDescription} multiline numberOfLines={3} />
            <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>Category</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
              {categories.map((cat) => (
                <TouchableOpacity key={cat.id} style={[styles.categoryChip, { backgroundColor: formCategoryId === cat.id ? "#5C6BC0" : colors.card, borderColor: formCategoryId === cat.id ? "#5C6BC0" : colors.border }]} onPress={() => setFormCategoryId(cat.id)}>
                  <Text style={[styles.categoryChipText, { color: formCategoryId === cat.id ? "#fff" : colors.foreground }]}>{cat.name}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* ── Required Specialty picker ── */}
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginBottom: 0, marginTop: 0 }]}>Required Employee Specialty</Text>
              <Text style={{ fontSize: 12, color: colors.mutedForeground, fontStyle: "italic" }}>Optional</Text>
            </View>
            <Text style={{ fontSize: 12, color: colors.mutedForeground, marginTop: 4, marginBottom: 8, lineHeight: 15 }}>
              Limit booking capacity for this service to employees with the chosen specialty. Leave on "Any employee" to allow your whole team.
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
              <TouchableOpacity
                style={[styles.categoryChip, { backgroundColor: formRequiredSpecialty === null ? "#5C6BC0" : colors.card, borderColor: formRequiredSpecialty === null ? "#5C6BC0" : colors.border, flexDirection: "row", alignItems: "center", gap: 4 }]}
                onPress={() => setFormRequiredSpecialty(null)}
              >
                <Feather name="users" size={12} color={formRequiredSpecialty === null ? "#fff" : colors.mutedForeground} />
                <Text style={[styles.categoryChipText, { color: formRequiredSpecialty === null ? "#fff" : colors.foreground }]}>Any employee</Text>
              </TouchableOpacity>
              {formSpecialtyChoices.map((spec) => {
                const active = formRequiredSpecialty === spec;
                return (
                  <TouchableOpacity
                    key={spec}
                    style={[styles.categoryChip, { backgroundColor: active ? "#5C6BC0" : colors.card, borderColor: active ? "#5C6BC0" : colors.border, flexDirection: "row", alignItems: "center", gap: 4 }]}
                    onPress={() => setFormRequiredSpecialty(spec)}
                  >
                    <Feather name="award" size={12} color={active ? "#fff" : colors.mutedForeground} />
                    <Text style={[styles.categoryChipText, { color: active ? "#fff" : colors.foreground }]}>{spec}</Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            {formRequiredSpecialty && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6, paddingHorizontal: 4 }}>
                <Feather name={matchingEmpCountForForm > 0 ? "check-circle" : "alert-circle"} size={13} color={matchingEmpCountForForm > 0 ? "#B39DDB" : "#E53935"} />
                <Text style={{ fontSize: 12, color: matchingEmpCountForForm > 0 ? "#B39DDB" : "#E53935", fontWeight: "600" }}>
                  {matchingEmpCountForForm > 0
                    ? `${matchingEmpCountForForm} of your ${myEmployees.length} employees can perform this`
                    : `No employee currently has "${formRequiredSpecialty}" specialty — add one in Account first`}
                </Text>
              </View>
            )}

            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14, marginBottom: 8 }}>
              <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginBottom: 0, marginTop: 0 }]}>Pricing Options *</Text>
              <TouchableOpacity onPress={() => setFormOptions([...formOptions, emptyOption()])}><Text style={{ color: "#5C6BC0", fontSize: 15, fontWeight: "700" }}>+ Add Option</Text></TouchableOpacity>
            </View>
            {formOptions.map((opt, idx) => (
              <View key={idx} style={[styles.optionBlock, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <Text style={[styles.optionBlockTitle, { color: colors.foreground }]}>Option {idx + 1}</Text>
                  {formOptions.length > 1 && <TouchableOpacity onPress={() => setFormOptions(formOptions.filter((_, i) => i !== idx))}><Feather name="trash-2" size={15} color={colors.destructive} /></TouchableOpacity>}
                </View>
                <TextInput style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]} placeholder="Option name" placeholderTextColor={colors.mutedForeground} value={opt.name} onChangeText={(v) => updateOption(idx, "name", v)} />
                <TextInput style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]} placeholder="Short description (optional)" placeholderTextColor={colors.mutedForeground} value={opt.description} onChangeText={(v) => updateOption(idx, "description", v)} />
                <View style={{ flexDirection: "row", gap: 12 }}>
                  <View style={{ flex: 1 }}><TextInput style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]} placeholder="Price ($)" placeholderTextColor={colors.mutedForeground} value={opt.price} onChangeText={(v) => updateOption(idx, "price", v)} keyboardType="decimal-pad" /></View>
                  <View style={{ flex: 1 }}><TextInput style={[styles.optionInput, { borderColor: colors.border, color: colors.foreground }]} placeholder="Duration (e.g. 2 hrs, Full Day)" placeholderTextColor={colors.mutedForeground} value={opt.duration} onChangeText={(v) => updateOption(idx, "duration", v)} /></View>
                </View>

                {/* Long-duration (8h+) services need a single fixed start time so
                    customers can't book overlapping windows. We default to 8 AM
                    and let the SP tap a different preset. */}
                {isLongDuration(opt.duration) && (
                  <View style={styles.startTimeBlock}>
                    <View style={styles.startTimeHeader}>
                      <Feather name="clock" size={13} color="#5C6BC0" />
                      <Text style={[styles.startTimeLabel, { color: colors.foreground }]}>
                        Default start time
                      </Text>
                      <Text style={[styles.startTimeHint, { color: colors.mutedForeground }]}>
                        Customers see only this slot
                      </Text>
                    </View>
                    <View style={styles.startTimeRow}>
                      {START_TIME_PRESETS.map((preset) => {
                        const selected = (opt.defaultStartTime || DEFAULT_LONG_DURATION_START) === preset;
                        return (
                          <TouchableOpacity
                            key={preset}
                            onPress={() => {
                              updateOption(idx, "defaultStartTime", preset);
                              Haptics.selectionAsync();
                            }}
                            style={[
                              styles.startTimeChip,
                              {
                                backgroundColor: selected ? "#5C6BC0" : "transparent",
                                borderColor: selected ? "#5C6BC0" : colors.border,
                              },
                            ]}
                          >
                            <Text
                              style={[
                                styles.startTimeChipText,
                                { color: selected ? "#fff" : colors.foreground },
                              ]}
                            >
                              {minutesToTimeLabel(timeStrToMinutes(preset))}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </View>
                )}
              </View>
            ))}
            <View style={{ height: 40 }} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 20, paddingBottom: 20, gap: 6 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  headerTitle: { color: "#fff", fontSize: 22, fontWeight: "700", flex: 1 },
  planBadge: { alignSelf: "flex-start", paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  planBadgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  kebabBackdrop: { flex: 1 },
  kebabDropdown: {
    position: "absolute",
    right: 12,
    backgroundColor: "#fff",
    borderRadius: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.18,
    shadowRadius: 12,
    elevation: 10,
    minWidth: 150,
    overflow: "hidden",
  },
  kebabItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  kebabItemLabel: { fontSize: 15, fontWeight: "600" },
  statsRow: { flexDirection: "row", gap: 10, padding: 16 },
  section: { paddingHorizontal: 16, marginBottom: 8 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  sectionTitle: { fontSize: 18, fontWeight: "800", marginBottom: 12 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 10 },
  addBtnText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  emptyServices: { borderRadius: 16, borderWidth: 1.5, borderStyle: "dashed", padding: 32, alignItems: "center", gap: 10 },
  emptyServicesTitle: { fontSize: 15, fontWeight: "700" },
  emptyServicesDesc: { fontSize: 12, textAlign: "center", lineHeight: 19 },
  serviceCard: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 10, gap: 8 },
  serviceRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  serviceIcon: { width: 40, height: 40, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  serviceTitle: { fontSize: 15, fontWeight: "700" },
  serviceMeta: { fontSize: 12, marginTop: 2 },
  serviceActions: { flexDirection: "row", gap: 8 },
  actionBtn: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  optionPill: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, alignSelf: "flex-start" },
  optionPillText: { fontSize: 12 },
  bookingCard: { borderRadius: 14, borderWidth: 1, padding: 14, marginBottom: 8 },
  bookingRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  bookingTitle: { fontSize: 15, fontWeight: "700" },
  bookingMeta: { fontSize: 12, marginTop: 2 },
  bookingPrice: { fontSize: 15, fontWeight: "700" },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusText: { fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  emptyCenter: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12 },
  emptyIcon: { width: 80, height: 80, borderRadius: 24, alignItems: "center", justifyContent: "center" },
  emptyTitle: { fontSize: 22, fontWeight: "800" },
  emptyDesc: { fontSize: 15, textAlign: "center", lineHeight: 21 },
  setupBtn: { paddingHorizontal: 28, paddingVertical: 14, borderRadius: 14, marginTop: 8 },
  setupBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  portalBtn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 14, borderWidth: 1 },
  portalBtnText: { fontSize: 15, fontWeight: "700" },
  modalContainer: { flex: 1 },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 16, borderBottomWidth: 1 },
  modalTitle: { fontSize: 18, fontWeight: "800" },
  modalSave: { fontSize: 15, fontWeight: "700" },
  modalBody: { flex: 1, padding: 16 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6, marginTop: 14 },
  fieldInput: { borderRadius: 12, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15 },
  textArea: { height: 80, textAlignVertical: "top" },
  categoryChip: { borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8 },
  categoryChipText: { fontSize: 12, fontWeight: "600" },
  optionBlock: { borderRadius: 12, borderWidth: 1, padding: 12, marginBottom: 10, gap: 8 },
  optionBlockTitle: { fontSize: 12, fontWeight: "700" },
  optionInput: { borderBottomWidth: 1, paddingVertical: 8, fontSize: 15 },
  startTimeBlock: { marginTop: 6, gap: 8 },
  startTimeHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  startTimeLabel: { fontSize: 12, fontWeight: "700" },
  startTimeHint: { fontSize: 12, fontStyle: "italic", marginLeft: "auto" },
  startTimeRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  startTimeChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  startTimeChipText: { fontSize: 12, fontWeight: "600" },
  planCard: { marginHorizontal: 16, marginBottom: 12, borderRadius: 14, borderWidth: 1, padding: 14, gap: 8 },
  meetingCard: { marginHorizontal: 16, marginBottom: 12, borderRadius: 14, borderWidth: 1.5, padding: 14, gap: 8 },
  meetingHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  meetingIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  meetingTitle: { fontSize: 15, fontWeight: "800" },
  meetingTime: { fontSize: 14, fontWeight: "600" },
  meetingLocRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  meetingLoc: { fontSize: 13, flex: 1 },
  planCardHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  planCardDot: { width: 10, height: 10, borderRadius: 5 },
  planCardName: { fontSize: 15, fontWeight: "800", flex: 1 },
  planCardChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  planCardChipText: { fontSize: 12, fontWeight: "800", textTransform: "uppercase" },
  planCardUsage: { fontSize: 12, fontWeight: "600" },
  planCardBarTrack: { height: 6, borderRadius: 3, overflow: "hidden" },
  planCardBarFill: { height: "100%", borderRadius: 3 },
  planCardCta: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 10, borderRadius: 10, marginTop: 4 },
  planCardCtaText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  planCardCtaGhost: { paddingVertical: 8, borderRadius: 10, borderWidth: 1, alignItems: "center", marginTop: 4 },
  planCardCtaGhostText: { fontSize: 12, fontWeight: "700" },
});
