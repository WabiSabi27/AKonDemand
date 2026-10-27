import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
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

import * as Clipboard from "expo-clipboard";
import {
  useGetMyStripeConnectAccount,
  useCreateMyStripeConnectAccount,
  useCreateMyStripeConnectOnboardingLink,
  getGetMyStripeConnectAccountQueryKey,
  useGetMyCalendar,
  useRegenerateMyCalendarToken,
  useSetMyExternalCalendar,
  useDeleteMyExternalCalendar,
  useSyncMyExternalCalendar,
  getGetMyCalendarQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { getSpecialtiesForCategory } from "@/utils/specialties";
import { describePolicy, policyFromBusiness } from "@/utils/cancellationPolicy";

const PLAN_LABELS: Record<string, { label: string; color: string; price: string }> = {
  starter_gigger: { label: "Starter Gigger", color: "#5C6BC0", price: "$29/mo" },
  pro_business: { label: "Pro Business", color: "#FFB300", price: "$79/mo" },
};

type Employee = { specialty?: string };

export default function BusinessAccountTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, businesses, logout, updateBusiness } = useApp();
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const [menuOpen, setMenuOpen]     = useState(false);
  const [editOpen, setEditOpen]     = useState(false);
  const [employees, setEmployees]   = useState<Employee[]>([]);
  // which employee index is having its specialty picked; -1 = none
  const [pickingFor, setPickingFor] = useState<number>(-1);

  // Phase 3 #7 — cancellation policy editor (separate sheet from employees).
  const [policyOpen, setPolicyOpen]   = useState(false);
  const [policyFullH, setPolicyFullH] = useState("");
  const [policyPartH, setPolicyPartH] = useState("");
  const [policyPct, setPolicyPct]     = useState("");
  const [policySaving, setPolicySaving] = useState(false);

  const myBusiness = businesses.find((b) => b.ownerId === user?.id);
  const plan       = myBusiness ? PLAN_LABELS[myBusiness.subscriptionPlan] : null;

  const specialtyOptions = getSpecialtiesForCategory(myBusiness?.categoryId);

  // ── Handlers ─────────────────────────────────────────────────────────────

  function openEdit() {
    setEmployees(myBusiness?.employees ? myBusiness.employees.map((e) => ({ ...e })) : []);
    setEditOpen(true);
  }

  function addEmployee() {
    setEmployees((prev) => [...prev, {}]);
  }

  function removeEmployee(i: number) {
    setEmployees((prev) => prev.filter((_, idx) => idx !== i));
  }

  function pickSpecialty(empIndex: number, value: string | undefined) {
    setEmployees((prev) =>
      prev.map((e, idx) => idx === empIndex ? { ...e, specialty: value } : e)
    );
    setPickingFor(-1);
  }

  async function saveProfile() {
    if (!myBusiness) return;
    await updateBusiness(myBusiness.id, { employees });
    setEditOpen(false);
  }

  // ── Cancellation policy handlers ────────────────────────────────────────
  function openPolicyEditor() {
    if (!myBusiness) return;
    setPolicyFullH(String(myBusiness.cancellationFullRefundHours));
    setPolicyPartH(String(myBusiness.cancellationPartialRefundHours));
    setPolicyPct(String(myBusiness.cancellationPartialRefundPercent));
    setPolicyOpen(true);
  }

  async function savePolicy() {
    if (!myBusiness) return;
    const fullH = parseInt(policyFullH, 10);
    const partH = parseInt(policyPartH, 10);
    const pct   = parseInt(policyPct, 10);
    // Match server-side validation so the user gets immediate feedback.
    if (!Number.isInteger(fullH) || fullH < 0 || fullH > 720) {
      Alert.alert("Invalid value", "Full-refund hours must be 0–720 (up to 30 days).");
      return;
    }
    if (!Number.isInteger(partH) || partH < 0 || partH > 720) {
      Alert.alert("Invalid value", "Partial-refund hours must be 0–720 (up to 30 days).");
      return;
    }
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      Alert.alert("Invalid value", "Partial-refund percentage must be 0–100.");
      return;
    }
    if (partH > fullH) {
      Alert.alert(
        "Invalid policy",
        "The partial-refund window must be inside the full-refund window. Set partial hours less than or equal to full hours.",
      );
      return;
    }
    setPolicySaving(true);
    try {
      await updateBusiness(myBusiness.id, {
        cancellationFullRefundHours: fullH,
        cancellationPartialRefundHours: partH,
        cancellationPartialRefundPercent: pct,
      });
      setPolicyOpen(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not save policy.";
      Alert.alert("Save failed", msg);
    } finally {
      setPolicySaving(false);
    }
  }

  function handleHome() {
    setMenuOpen(false);
    router.replace("/login");
  }
  function handleLogout() {
    setMenuOpen(false);
    logout();
  }

  const empList  = myBusiness?.employees ?? [];
  const empCount = empList.length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <ScrollView
        style={[styles.container, { backgroundColor: colors.background }]}
        contentContainerStyle={{ paddingBottom: bottomInset + 90 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={[styles.hero, { paddingTop: topInset + 16, backgroundColor: "#5C6BC0" }]}>
          <TouchableOpacity
            style={[styles.kebabBtn, { top: topInset + 12 }]}
            onPress={() => setMenuOpen(true)}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <Feather name="more-vertical" size={22} color="rgba(255,255,255,0.9)" />
          </TouchableOpacity>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>
              {myBusiness?.name.charAt(0) ?? user?.name?.charAt(0) ?? "B"}
            </Text>
          </View>
          <Text style={styles.heroName}>{myBusiness?.name ?? user?.name ?? "Business"}</Text>
          <Text style={styles.heroEmail}>{user?.email ?? ""}</Text>
          {plan && (
            <View style={[styles.planBadge, { backgroundColor: plan.color }]}>
              <Text style={styles.planBadgeText}>{plan.label} Plan · {plan.price}</Text>
            </View>
          )}
        </View>

        {/* Business Info */}
        {myBusiness && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>BUSINESS INFO</Text>
              <TouchableOpacity onPress={openEdit} activeOpacity={0.7} style={styles.editBtn}>
                <Feather name="edit-2" size={13} color="#5C6BC0" />
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>

            <InfoRow icon="map-pin" colors={colors}>
              <Text style={[styles.infoText, { color: colors.foreground }]}>{myBusiness.location || "Location not set"}</Text>
            </InfoRow>
            <InfoRow icon="phone" colors={colors}>
              <Text style={[styles.infoText, { color: colors.foreground }]}>{myBusiness.phone || "Phone not set"}</Text>
            </InfoRow>
            <InfoRow icon="calendar" colors={colors}>
              <Text style={[styles.infoText, { color: colors.foreground }]}>Member since {myBusiness.joinedDate}</Text>
            </InfoRow>

            {/* Employees */}
            <InfoRow icon="users" colors={colors}>
              {empCount === 0 ? (
                <Text style={[styles.infoText, { color: colors.mutedForeground }]}>No employees added</Text>
              ) : (
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={[styles.infoText, { color: colors.foreground }]}>
                    {empCount} {empCount === 1 ? "employee" : "employees"} available for booking
                  </Text>
                  {empList.map((e, i) => (
                    <View key={i} style={styles.empDisplayRow}>
                      <View style={[styles.empNumBadge, { backgroundColor: "#5C6BC018" }]}>
                        <Text style={[styles.empNumText, { color: "#5C6BC0" }]}>{i + 1}</Text>
                      </View>
                      {e.specialty ? (
                        <View style={[styles.chip, { backgroundColor: "#5C6BC014", borderColor: "#5C6BC033" }]}>
                          <Text style={[styles.chipText, { color: "#5C6BC0" }]}>{e.specialty}</Text>
                        </View>
                      ) : (
                        <Text style={[styles.noSpecText, { color: colors.mutedForeground }]}>No specialty</Text>
                      )}
                    </View>
                  ))}
                </View>
              )}
            </InfoRow>

            {myBusiness.description ? (
              <InfoRow icon="info" colors={colors}>
                <Text style={[styles.infoText, { color: colors.foreground }]}>{myBusiness.description}</Text>
              </InfoRow>
            ) : null}
          </View>
        )}

        {/* Subscription */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }]}>SUBSCRIPTION</Text>
          <TouchableOpacity style={[styles.menuItem, { borderBottomColor: colors.border }]} onPress={() => router.push("/business-portal")} activeOpacity={0.8}>
            <View style={[styles.menuIcon, { backgroundColor: "#5C6BC018" }]}><Feather name="star" size={17} color="#5C6BC0" /></View>
            <Text style={[styles.menuLabel, { color: colors.foreground }]}>Manage Subscription</Text>
            <Text style={[styles.menuValue, { color: colors.mutedForeground }]}>{plan?.label ?? "No plan"}</Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.menuItem, { borderBottomColor: "transparent" }]}
            onPress={() => router.push("/business-earnings")}
            activeOpacity={0.8}
          >
            <View style={[styles.menuIcon, { backgroundColor: "#26A69A18" }]}><Feather name="trending-up" size={17} color="#26A69A" /></View>
            <Text style={[styles.menuLabel, { color: colors.foreground }]}>Earnings</Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {/* Payouts (Phase 2 #6 — Stripe Connect) */}
        <PayoutsCard colors={colors} />

        {/* Calendar Sync (Phase 3 #8) */}
        <CalendarSyncCard colors={colors} />

        {/* Cancellation policy (Phase 3 #7) */}
        {myBusiness && (
          <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>CANCELLATION POLICY</Text>
              <TouchableOpacity onPress={openPolicyEditor} activeOpacity={0.7} style={styles.editBtn}>
                <Feather name="edit-2" size={13} color="#5C6BC0" />
                <Text style={styles.editBtnText}>Edit</Text>
              </TouchableOpacity>
            </View>
            <InfoRow icon="rotate-ccw" colors={colors}>
              <Text style={[styles.infoText, { color: colors.foreground }]}>
                {describePolicy(policyFromBusiness(myBusiness))}
              </Text>
            </InfoRow>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, lineHeight: 16, paddingHorizontal: 16, paddingBottom: 12 }}>
              Applies to new bookings only. Existing bookings keep the policy that was in effect when they were created.
            </Text>
          </View>
        )}

        {/* Support */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionLabel, { color: colors.mutedForeground, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }]}>SUPPORT</Text>
          <TouchableOpacity style={[styles.menuItem, { borderBottomColor: colors.border }]} onPress={() => {}} activeOpacity={0.8}>
            <View style={[styles.menuIcon, { backgroundColor: colors.secondary }]}><Feather name="help-circle" size={17} color={colors.foreground} /></View>
            <Text style={[styles.menuLabel, { color: colors.foreground }]}>Help Center</Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity style={[styles.menuItem, { borderBottomColor: "transparent" }]} onPress={() => {}} activeOpacity={0.8}>
            <View style={[styles.menuIcon, { backgroundColor: colors.secondary }]}><Feather name="shield" size={17} color={colors.foreground} /></View>
            <Text style={[styles.menuLabel, { color: colors.foreground }]}>Privacy Policy</Text>
            <Feather name="chevron-right" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {/* Sign out */}
        <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TouchableOpacity style={[styles.menuItem, { borderBottomColor: "transparent" }]} onPress={logout} activeOpacity={0.8}>
            <View style={[styles.menuIcon, { backgroundColor: colors.destructive + "18" }]}><Feather name="log-out" size={17} color={colors.destructive} /></View>
            <Text style={[styles.menuLabel, { color: colors.destructive }]}>Sign Out</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* ── Kebab dropdown ── */}
      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setMenuOpen(false)}>
          <View style={[styles.dropdown, { top: topInset + 44 }]}>
            <TouchableOpacity style={styles.dropdownItem} onPress={handleHome} activeOpacity={0.8}>
              <Feather name="home" size={17} color="#0F1B2D" />
              <Text style={styles.dropdownLabel}>Home</Text>
            </TouchableOpacity>
            <View style={styles.dropdownDivider} />
            <TouchableOpacity style={styles.dropdownItem} onPress={handleLogout} activeOpacity={0.8}>
              <Feather name="log-out" size={17} color="#E53935" />
              <Text style={[styles.dropdownLabel, { color: "#E53935" }]}>Logout</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Modal>

      {/* ── Edit Employees sheet ── */}
      <Modal visible={editOpen} transparent animationType="slide" onRequestClose={() => setEditOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.modalBackdrop} onPress={() => setEditOpen(false)} />
          <View style={[styles.editSheet, { backgroundColor: colors.card, paddingBottom: bottomInset + 16 }]}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            <View style={styles.sheetTitleRow}>
              <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Employees for Booking</Text>
              <Text style={[styles.sheetSubtitle, { color: colors.mutedForeground }]}>
                {employees.length} {employees.length === 1 ? "employee" : "employees"}
              </Text>
            </View>

            <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
              {employees.length === 0 && (
                <Text style={[styles.emptyHint, { color: colors.mutedForeground }]}>
                  Tap "Add Employee" to get started.
                </Text>
              )}

              {employees.map((emp, i) => (
                <View key={i} style={[styles.empRow, { borderColor: colors.border, backgroundColor: colors.secondary }]}>
                  {/* Number badge */}
                  <View style={[styles.empNumBadgeLg, { backgroundColor: "#5C6BC018" }]}>
                    <Text style={[styles.empNumTextLg, { color: "#5C6BC0" }]}>{i + 1}</Text>
                  </View>

                  {/* Specialty selector */}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginBottom: 5 }]}>SPECIALTY</Text>
                    <TouchableOpacity
                      onPress={() => setPickingFor(i)}
                      activeOpacity={0.75}
                      style={[
                        styles.specSelector,
                        {
                          borderColor: emp.specialty ? "#5C6BC066" : colors.border,
                          backgroundColor: emp.specialty ? "#5C6BC010" : colors.card,
                        },
                      ]}
                    >
                      <Text style={[
                        styles.specSelectorText,
                        { color: emp.specialty ? "#5C6BC0" : colors.mutedForeground },
                      ]}>
                        {emp.specialty ?? "None"}
                      </Text>
                      <Feather name="chevron-down" size={15} color={emp.specialty ? "#5C6BC0" : colors.mutedForeground} />
                    </TouchableOpacity>
                  </View>

                  {/* Remove */}
                  <TouchableOpacity
                    onPress={() => removeEmployee(i)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={[styles.removeBtn, { backgroundColor: colors.destructive + "18" }]}
                  >
                    <Feather name="trash-2" size={15} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              ))}
            </ScrollView>

            <TouchableOpacity
              style={[styles.addEmpBtn, { borderColor: "#5C6BC0", backgroundColor: "#5C6BC010" }]}
              onPress={addEmployee}
              activeOpacity={0.75}
            >
              <Feather name="plus" size={16} color="#5C6BC0" />
              <Text style={[styles.addEmpText, { color: "#5C6BC0" }]}>Add Employee</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: "#5C6BC0", marginTop: 12 }]}
              onPress={saveProfile}
              activeOpacity={0.85}
            >
              <Text style={styles.saveBtnText}>Save Changes</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Cancellation Policy editor ── */}
      <Modal visible={policyOpen} transparent animationType="slide" onRequestClose={() => setPolicyOpen(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <Pressable style={styles.modalBackdrop} onPress={() => setPolicyOpen(false)} />
          <View style={[styles.editSheet, { backgroundColor: colors.card, paddingBottom: bottomInset + 16 }]}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
            <View style={styles.sheetTitleRow}>
              <Text style={[styles.sheetTitle, { color: colors.foreground }]}>Cancellation Policy</Text>
            </View>

            <Text style={{ color: colors.mutedForeground, fontSize: 12, lineHeight: 17, marginBottom: 16 }}>
              When a customer cancels their own booking, we'll refund them automatically based on these rules. Times are measured in whole hours before the scheduled start.
            </Text>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginBottom: 6 }]}>FULL REFUND IF CANCELLED THIS MANY HOURS BEFORE</Text>
            <TextInput
              style={[
                styles.policyInput,
                { borderColor: colors.border, backgroundColor: colors.secondary, color: colors.foreground },
              ]}
              keyboardType="number-pad"
              value={policyFullH}
              onChangeText={setPolicyFullH}
              placeholder="24"
              placeholderTextColor={colors.mutedForeground}
              maxLength={3}
            />

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 14, marginBottom: 6 }]}>PARTIAL REFUND CUT-OFF (HOURS BEFORE)</Text>
            <TextInput
              style={[
                styles.policyInput,
                { borderColor: colors.border, backgroundColor: colors.secondary, color: colors.foreground },
              ]}
              keyboardType="number-pad"
              value={policyPartH}
              onChangeText={setPolicyPartH}
              placeholder="2"
              placeholderTextColor={colors.mutedForeground}
              maxLength={3}
            />
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 4 }}>
              Inside this window, the customer gets no refund. Must be ≤ full-refund hours.
            </Text>

            <Text style={[styles.fieldLabel, { color: colors.mutedForeground, marginTop: 14, marginBottom: 6 }]}>PARTIAL REFUND PERCENT (%)</Text>
            <TextInput
              style={[
                styles.policyInput,
                { borderColor: colors.border, backgroundColor: colors.secondary, color: colors.foreground },
              ]}
              keyboardType="number-pad"
              value={policyPct}
              onChangeText={setPolicyPct}
              placeholder="50"
              placeholderTextColor={colors.mutedForeground}
              maxLength={3}
            />

            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: "#5C6BC0", marginTop: 20, opacity: policySaving ? 0.6 : 1 }]}
              onPress={savePolicy}
              disabled={policySaving}
              activeOpacity={0.85}
            >
              <Text style={styles.saveBtnText}>{policySaving ? "Saving…" : "Save Policy"}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Specialty picker ── */}
      <Modal
        visible={pickingFor >= 0}
        transparent
        animationType="slide"
        onRequestClose={() => setPickingFor(-1)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPickingFor(-1)} />
        <View style={[styles.pickerSheet, { backgroundColor: colors.card, paddingBottom: bottomInset + 16 }]}>
          <View style={[styles.sheetHandle, { backgroundColor: colors.border }]} />
          <Text style={[styles.pickerTitle, { color: colors.foreground }]}>Select Specialty</Text>
          <Text style={[styles.pickerSub, { color: colors.mutedForeground }]}>
            Employee {pickingFor + 1}
          </Text>

          <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 380 }}>
            {/* None option */}
            <TouchableOpacity
              onPress={() => pickSpecialty(pickingFor, undefined)}
              activeOpacity={0.75}
              style={[
                styles.pickerOption,
                {
                  borderColor: colors.border,
                  backgroundColor:
                    pickingFor >= 0 && !employees[pickingFor]?.specialty
                      ? "#5C6BC018"
                      : colors.secondary,
                },
              ]}
            >
              <Feather
                name="slash"
                size={16}
                color={pickingFor >= 0 && !employees[pickingFor]?.specialty ? "#5C6BC0" : colors.mutedForeground}
              />
              <Text style={[
                styles.pickerOptionText,
                { color: pickingFor >= 0 && !employees[pickingFor]?.specialty ? "#5C6BC0" : colors.foreground, fontWeight: "600" },
              ]}>
                None
              </Text>
              {pickingFor >= 0 && !employees[pickingFor]?.specialty && (
                <Feather name="check" size={16} color="#5C6BC0" style={{ marginLeft: "auto" }} />
              )}
            </TouchableOpacity>

            {/* Category specialties */}
            {specialtyOptions.map((opt) => {
              const selected = pickingFor >= 0 && employees[pickingFor]?.specialty === opt;
              return (
                <TouchableOpacity
                  key={opt}
                  onPress={() => pickSpecialty(pickingFor, opt)}
                  activeOpacity={0.75}
                  style={[
                    styles.pickerOption,
                    {
                      borderColor: selected ? "#5C6BC066" : colors.border,
                      backgroundColor: selected ? "#5C6BC018" : colors.secondary,
                    },
                  ]}
                >
                  <Feather name="award" size={16} color={selected ? "#5C6BC0" : colors.mutedForeground} />
                  <Text style={[styles.pickerOptionText, { color: selected ? "#5C6BC0" : colors.foreground }]}>
                    {opt}
                  </Text>
                  {selected && (
                    <Feather name="check" size={16} color="#5C6BC0" style={{ marginLeft: "auto" }} />
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

/**
 * Stripe Connect Payouts card. Shows the SP's onboarding state and lets
 * them open the Stripe-hosted onboarding form in a system browser. We
 * refetch the status when the browser closes so the card reflects the
 * latest Connect state without requiring a manual reload.
 */
function PayoutsCard({ colors }: { colors: ReturnType<typeof useColors> }) {
  const queryClient = useQueryClient();
  const acctQ = useGetMyStripeConnectAccount();
  const createAccount = useCreateMyStripeConnectAccount();
  const createLink = useCreateMyStripeConnectOnboardingLink();
  const busy = createAccount.isPending || createLink.isPending;

  const status = acctQ.data?.status ?? "none";
  const payoutsEnabled = !!acctQ.data?.payoutsEnabled;
  const chargesEnabled = !!acctQ.data?.chargesEnabled;

  // Map the four Connect states → presentation. We keep the labels short
  // and action-oriented so an SP knows what to do next at a glance.
  const presentation = (() => {
    if (status === "active" && payoutsEnabled && chargesEnabled) {
      return { color: "#7E57C2", label: "Payouts active", icon: "check-circle" as const, sub: "You're getting paid for every booking." };
    }
    if (status === "restricted") {
      return { color: "#E53935", label: "Action required", icon: "alert-triangle" as const, sub: "Stripe needs more info before you can be paid." };
    }
    if (status === "pending") {
      return { color: "#FFB300", label: "Onboarding in progress", icon: "clock" as const, sub: "Finish your Stripe setup to start accepting bookings." };
    }
    return { color: "#78909C", label: "Not set up", icon: "credit-card" as const, sub: "Set up Stripe to start receiving customer payments." };
  })();

  async function handleOpen() {
    try {
      // First call ensures the account row exists; idempotent if already created.
      if (status === "none" || !acctQ.data?.accountId) {
        await createAccount.mutateAsync();
      }
      const link = await createLink.mutateAsync();
      const result = await WebBrowser.openBrowserAsync(link.url);
      // Always refetch — Stripe webhooks usually arrive within seconds, but
      // we don't want to rely solely on them.
      if (result.type === "cancel" || result.type === "dismiss" || result.type === "opened") {
        await queryClient.invalidateQueries({ queryKey: getGetMyStripeConnectAccountQueryKey() });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not open Stripe onboarding.";
      Alert.alert("Stripe error", msg);
    }
  }

  const ctaLabel = status === "active" && payoutsEnabled
    ? "Manage on Stripe"
    : status === "none"
      ? "Set up payouts"
      : "Continue setup";

  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }]}>
        PAYOUTS
      </Text>

      {acctQ.isLoading ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 16, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>Checking Stripe status…</Text>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14, gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <View style={{ width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: presentation.color + "20" }}>
              <Feather name={presentation.icon} size={17} color={presentation.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700" }}>
                {presentation.label}
              </Text>
              <Text style={{ color: colors.mutedForeground, fontSize: 12, marginTop: 2 }}>
                {presentation.sub}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              paddingVertical: 12,
              borderRadius: 12,
              backgroundColor: presentation.color,
              opacity: busy ? 0.6 : 1,
            }}
            onPress={handleOpen}
            disabled={busy}
            activeOpacity={0.85}
          >
            {busy && <ActivityIndicator size="small" color="#fff" />}
            <Feather name="external-link" size={15} color="#fff" />
            <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700" }}>{ctaLabel}</Text>
          </TouchableOpacity>

          <Text style={{ color: colors.mutedForeground, fontSize: 12, lineHeight: 16 }}>
            Customers pay through Stripe. We take 8% per booking; the rest is paid out to you on Stripe's standard schedule.
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Calendar Sync card (Phase 3 #8). Two halves:
 *   - Outbound: copy the SP's private iCal feed URL into Google/Apple Calendar
 *     so their bookings + blocked time + vacation appear in their personal cal.
 *     "Regenerate" mints a fresh token, killing the old URL — useful if the
 *     SP shared the link by accident.
 *   - Inbound: paste the "secret address in iCal format" from a personal Google
 *     Calendar, then tap "Sync now" to project busy events into AKODD as
 *     `imported_ical` blocked slots so customers can't double-book.
 */
function CalendarSyncCard({ colors }: { colors: ReturnType<typeof useColors> }) {
  const queryClient = useQueryClient();
  const calQ = useGetMyCalendar();
  const regenerate = useRegenerateMyCalendarToken();
  const setExternal = useSetMyExternalCalendar();
  const deleteExternal = useDeleteMyExternalCalendar();
  const sync = useSyncMyExternalCalendar();

  const [externalUrl, setExternalUrl] = useState("");
  const [editing, setEditing] = useState(false);

  // Hydrate the input when the server data arrives — but ONLY when the SP
  // isn't actively editing, otherwise their keystrokes get clobbered on
  // refetch.
  React.useEffect(() => {
    if (!editing && calQ.data) {
      setExternalUrl(calQ.data.externalCalendarUrl ?? "");
    }
  }, [editing, calQ.data]);

  const feedUrl = calQ.data?.feedUrl ?? null;
  const lastSyncAt = calQ.data?.lastSyncAt ?? null;
  const lastError = calQ.data?.lastError ?? null;
  const hasExternal = !!calQ.data?.externalCalendarUrl;

  async function handleCopyFeed() {
    if (!feedUrl) {
      // Mint a token first if none exists.
      try {
        const r = await regenerate.mutateAsync();
        await Clipboard.setStringAsync(r.feedUrl);
        await queryClient.invalidateQueries({ queryKey: getGetMyCalendarQueryKey() });
        Alert.alert("Feed URL copied", "Paste this into Google or Apple Calendar's “Add by URL” field.");
      } catch (err) {
        Alert.alert("Couldn't create feed URL", err instanceof Error ? err.message : String(err));
      }
      return;
    }
    await Clipboard.setStringAsync(feedUrl);
    Alert.alert("Feed URL copied", "Paste this into Google or Apple Calendar's “Add by URL” field.");
  }

  function handleRegenerate() {
    Alert.alert(
      "Regenerate feed URL?",
      "Your old URL will stop working immediately. Anyone using it will need the new one.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Regenerate",
          style: "destructive",
          onPress: async () => {
            try {
              await regenerate.mutateAsync();
              await queryClient.invalidateQueries({ queryKey: getGetMyCalendarQueryKey() });
              Alert.alert("New feed URL ready", "Tap Copy to grab the new link.");
            } catch (err) {
              Alert.alert("Couldn't regenerate", err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );
  }

  async function handleSaveExternal() {
    const trimmed = externalUrl.trim();
    if (!trimmed) {
      Alert.alert("Enter a URL", "Paste the iCal URL from Google/Apple Calendar.");
      return;
    }
    try {
      await setExternal.mutateAsync({ data: { url: trimmed } });
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: getGetMyCalendarQueryKey() });
    } catch (err) {
      Alert.alert("Couldn't save URL", err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSyncNow() {
    try {
      const r = await sync.mutateAsync();
      await queryClient.invalidateQueries({ queryKey: getGetMyCalendarQueryKey() });
      Alert.alert(
        "Sync complete",
        `${r.importedBlocks} busy event${r.importedBlocks === 1 ? "" : "s"} imported as blocked time.`,
      );
    } catch (err) {
      // Server returns 502 with a useful message on parse/fetch failures —
      // surface it verbatim so the SP can fix their URL.
      const msg = err instanceof Error ? err.message : "Sync failed";
      Alert.alert("Sync failed", msg);
      await queryClient.invalidateQueries({ queryKey: getGetMyCalendarQueryKey() });
    }
  }

  function handleClearExternal() {
    Alert.alert(
      "Disconnect external calendar?",
      "Imported busy events will be removed from your blocked time.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteExternal.mutateAsync();
              setExternalUrl("");
              setEditing(false);
              await queryClient.invalidateQueries({ queryKey: getGetMyCalendarQueryKey() });
            } catch (err) {
              Alert.alert("Couldn't disconnect", err instanceof Error ? err.message : String(err));
            }
          },
        },
      ],
    );
  }

  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionLabel, { color: colors.mutedForeground, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }]}>
        CALENDAR SYNC
      </Text>

      {calQ.isLoading ? (
        <View style={{ paddingHorizontal: 16, paddingVertical: 16, flexDirection: "row", alignItems: "center", gap: 10 }}>
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>Loading…</Text>
        </View>
      ) : (
        <View style={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14, gap: 14 }}>
          {/* Outbound feed */}
          <View>
            <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700", marginBottom: 4 }}>
              Export to your calendar
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 8 }}>
              Subscribe to a private feed so your bookings show up in Google or Apple Calendar.
            </Text>
            {feedUrl ? (
              <View style={{
                borderWidth: 1, borderColor: colors.border, borderRadius: 10,
                paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.background,
                marginBottom: 8,
              }}>
                <Text style={{ color: colors.mutedForeground, fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" }} numberOfLines={1}>
                  {feedUrl}
                </Text>
              </View>
            ) : (
              <Text style={{ color: colors.mutedForeground, fontSize: 12, fontStyle: "italic", marginBottom: 8 }}>
                No feed URL yet — tap Copy to create one.
              </Text>
            )}
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 12, backgroundColor: colors.accent, opacity: regenerate.isPending ? 0.6 : 1 }}
                onPress={handleCopyFeed}
                disabled={regenerate.isPending}
                activeOpacity={0.85}
              >
                <Feather name="copy" size={14} color="#fff" />
                <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>{feedUrl ? "Copy URL" : "Create & copy"}</Text>
              </TouchableOpacity>
              {feedUrl && (
                <TouchableOpacity
                  style={{ paddingVertical: 11, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.border, opacity: regenerate.isPending ? 0.6 : 1 }}
                  onPress={handleRegenerate}
                  disabled={regenerate.isPending}
                  activeOpacity={0.85}
                >
                  <Feather name="refresh-ccw" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          {/* Inbound external calendar */}
          <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>
            <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "700", marginBottom: 4 }}>
              Import from your calendar
            </Text>
            <Text style={{ color: colors.mutedForeground, fontSize: 12, marginBottom: 8 }}>
              Paste the “secret iCal address” from your personal calendar. Busy events will block out your AK On Demand availability.
            </Text>
            <TextInput
              style={{
                borderWidth: 1, borderColor: colors.border, borderRadius: 10,
                paddingHorizontal: 12, paddingVertical: 10, color: colors.foreground,
                fontSize: 12, marginBottom: 8,
              }}
              placeholder="https://calendar.google.com/calendar/ical/.../basic.ics"
              placeholderTextColor={colors.mutedForeground}
              value={externalUrl}
              onChangeText={(t) => { setExternalUrl(t); setEditing(true); }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TouchableOpacity
                style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 12, backgroundColor: "#5C6BC0", opacity: setExternal.isPending ? 0.6 : 1 }}
                onPress={handleSaveExternal}
                disabled={setExternal.isPending}
                activeOpacity={0.85}
              >
                <Feather name="save" size={14} color="#fff" />
                <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Save URL</Text>
              </TouchableOpacity>
              {hasExternal && (
                <>
                  <TouchableOpacity
                    // Disabled while Save is in flight too — otherwise the SP
                    // can tap Sync against the previous server-side URL while
                    // their new URL is mid-PUT, producing a confusing result.
                    style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 11, borderRadius: 12, backgroundColor: "#26A69A", opacity: (sync.isPending || setExternal.isPending) ? 0.6 : 1 }}
                    onPress={handleSyncNow}
                    disabled={sync.isPending || setExternal.isPending}
                    activeOpacity={0.85}
                  >
                    {sync.isPending && <ActivityIndicator size="small" color="#fff" />}
                    <Feather name="refresh-cw" size={14} color="#fff" />
                    <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>Sync now</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={{ paddingVertical: 11, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1, borderColor: colors.destructive, opacity: deleteExternal.isPending ? 0.6 : 1 }}
                    onPress={handleClearExternal}
                    disabled={deleteExternal.isPending}
                    activeOpacity={0.85}
                  >
                    <Feather name="trash-2" size={14} color={colors.destructive} />
                  </TouchableOpacity>
                </>
              )}
            </View>
            {(lastSyncAt || lastError) && (
              <View style={{ marginTop: 8 }}>
                {lastError ? (
                  <Text style={{ color: colors.destructive, fontSize: 12, lineHeight: 15 }}>
                    Last sync error: {lastError}
                  </Text>
                ) : lastSyncAt ? (
                  <Text style={{ color: colors.mutedForeground, fontSize: 12 }}>
                    Last synced {new Date(lastSyncAt).toLocaleString()}
                  </Text>
                ) : null}
              </View>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

function InfoRow({
  icon,
  colors,
  children,
}: {
  icon: React.ComponentProps<typeof Feather>["name"];
  colors: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.infoRow}>
      <Feather name={icon} size={15} color={colors.mutedForeground} style={{ marginTop: 2 }} />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hero: { alignItems: "center", paddingBottom: 28, paddingHorizontal: 20 },
  kebabBtn: { position: "absolute", right: 16, zIndex: 10, padding: 4 },
  avatarCircle: { width: 72, height: 72, borderRadius: 36, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 12 },
  avatarText: { color: "#fff", fontSize: 28, fontWeight: "800" },
  heroName: { color: "#fff", fontSize: 22, fontWeight: "800", marginBottom: 3 },
  heroEmail: { color: "rgba(255,255,255,0.65)", fontSize: 12, marginBottom: 12 },
  planBadge: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10 },
  planBadgeText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  section: { marginHorizontal: 16, marginTop: 16, borderRadius: 16, borderWidth: 1, overflow: "hidden" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 },
  sectionLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.8 },
  editBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 3, paddingHorizontal: 8, borderRadius: 8, backgroundColor: "#5C6BC018" },
  editBtnText: { fontSize: 12, fontWeight: "700", color: "#5C6BC0" },
  infoRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: "transparent" },
  infoText: { flex: 1, fontSize: 15 },
  empDisplayRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  empNumBadge: { width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center" },
  empNumText: { fontSize: 12, fontWeight: "800" },
  chip: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 7, borderWidth: 1 },
  chipText: { fontSize: 12, fontWeight: "600" },
  noSpecText: { fontSize: 12, fontStyle: "italic" },
  menuItem: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, gap: 12, borderBottomWidth: 1 },
  menuIcon: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  menuLabel: { flex: 1, fontSize: 15, fontWeight: "600" },
  menuValue: { fontSize: 12, marginRight: 4 },
  modalBackdrop: { flex: 1 },
  dropdown: {
    position: "absolute", right: 12, backgroundColor: "#fff", borderRadius: 12,
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 12,
    elevation: 10, minWidth: 160, overflow: "hidden",
  },
  dropdownItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  dropdownDivider: { height: 1, backgroundColor: "#F0F0F0", marginHorizontal: 12 },
  dropdownLabel: { fontSize: 15, fontWeight: "600", color: "#0F1B2D" },

  // Edit sheet
  editSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 12,
    shadowColor: "#000", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 20,
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, alignSelf: "center", marginBottom: 16 },
  sheetTitleRow: { flexDirection: "row", alignItems: "baseline", gap: 8, marginBottom: 16 },
  sheetTitle: { fontSize: 18, fontWeight: "800" },
  sheetSubtitle: { fontSize: 12 },
  emptyHint: { fontSize: 12, fontStyle: "italic", textAlign: "center", paddingVertical: 20 },
  empRow: { flexDirection: "row", alignItems: "flex-end", gap: 10, borderWidth: 1, borderRadius: 14, padding: 12, marginBottom: 10 },
  empNumBadgeLg: { width: 32, height: 32, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  empNumTextLg: { fontSize: 15, fontWeight: "800" },
  fieldLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.8 },
  specSelector: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10,
  },
  specSelectorText: { fontSize: 15, fontWeight: "600" },
  removeBtn: { width: 34, height: 34, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 2 },
  addEmpBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderWidth: 1.5, borderRadius: 12, paddingVertical: 11, marginTop: 4 },
  addEmpText: { fontSize: 15, fontWeight: "700" },
  saveBtn: { borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  // Specialty picker sheet
  pickerSheet: {
    borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingHorizontal: 20, paddingTop: 12,
    shadowColor: "#000", shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.12, shadowRadius: 16, elevation: 24,
  },
  pickerTitle: { fontSize: 18, fontWeight: "800", marginBottom: 2 },
  pickerSub: { fontSize: 12, marginBottom: 14 },
  pickerOption: {
    flexDirection: "row", alignItems: "center", gap: 12,
    borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, marginBottom: 8,
  },
  pickerOptionText: { fontSize: 15 },
  policyInput: {
    borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12,
    fontSize: 15, fontWeight: "600",
  },
});
