import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import React, { useState } from "react";
import {
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";

/**
 * High-risk trades that legally require an SP to carry liability insurance
 * and a surety bond before we'll approve their listing. Keep these slugs in
 * sync with the canonical category IDs served by GET /api/categories.
 */
const HIGH_RISK_CATEGORY_IDS = new Set<string>([
  "roof",        // Roof Repair
  "gutters",     // Gutters
  "moving",      // Moving (movers)
  "painting",    // Painting (painters)
  "landscaping", // Landscaping (landscapers)
]);

/**
 * AsyncStorage key for the insurance/bond payload collected during the
 * subscribe step. The Stripe checkout call doesn't currently accept these
 * fields, so we stash them locally and the post-payment approval flow (or a
 * follow-up backend wiring task) can read them back when persisting the
 * business row. Cleared once handed off to the server.
 */
const INSURANCE_DRAFT_KEY = "akodd_business_insurance_draft";

/**
 * Cross-platform alert. React Native's `Alert.alert` is a silent no-op on
 * Expo Web, which made required-field validation feel like a dead button on
 * the web preview. Fall back to `window.alert` on web; native unchanged.
 */
function notify(title: string, message?: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  notify(title, message);
}

const PLANS = [
  {
    id: "starter_gigger",
    name: "Starter Gigger",
    monthlyFee: 29,
    features: ["Up to 5 service listings", "9% per-booking commission", "Customers book up to 3 months out", "Standard placement", "Email support"],
    recommended: false,
  },
  {
    id: "pro_business",
    name: "Pro Business",
    monthlyFee: 79,
    features: ["Up to 20 service listings", "6.5% per-booking commission", "Customers book up to 6 months out", "Priority placement", "Full analytics", "Featured badges"],
    recommended: true,
  },
] as const;

export default function BusinessPortalScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { businesses, user, categories, openSubscriptionCheckout } = useApp();
  const [selectedPlan, setSelectedPlan] = useState<"starter_gigger" | "pro_business">("pro_business");
  const [step, setStep] = useState<"landing" | "plans" | "form">("landing");
  const [businessName, setBusinessName] = useState("");
  const [description, setDescription] = useState("");
  const [phone, setPhone] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [insuranceCompany, setInsuranceCompany] = useState("");
  const [policyNumber, setPolicyNumber] = useState("");
  const [suretyBondNumber, setSuretyBondNumber] = useState("");
  const [subscribing, setSubscribing] = useState(false);
  const requiresInsurance = !!selectedCategoryId && HIGH_RISK_CATEGORY_IDS.has(selectedCategoryId);
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  async function handleSubscribe() {
    if (!businessName.trim()) {
      notify("Required", "Please enter your business name");
      return;
    }
    if (!selectedCategoryId) {
      notify("Required", "Please select the trade you'll be offering.");
      return;
    }
    if (requiresInsurance) {
      if (!insuranceCompany.trim()) {
        notify("Required", "Insurance Company is required for this trade.");
        return;
      }
      if (!policyNumber.trim()) {
        notify("Required", "Policy # is required for this trade.");
        return;
      }
      if (!suretyBondNumber.trim()) {
        notify("Required", "Surety Bond # is required for this trade.");
        return;
      }
    }
    if (!user) {
      notify("Sign In Required", "Please sign in to subscribe.");
      return;
    }

    setSubscribing(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    try {
      // Stash insurance/bond credentials locally so the post-payment approval
      // flow can persist them with the new business row. (openSubscriptionCheckout
      // is a Stripe-only call today; server schema wiring is a follow-up.)
      await AsyncStorage.setItem(
        INSURANCE_DRAFT_KEY,
        JSON.stringify({
          categoryId: selectedCategoryId,
          insuranceCompany: requiresInsurance ? insuranceCompany.trim() : null,
          policyNumber: requiresInsurance ? policyNumber.trim() : null,
          suretyBondNumber: requiresInsurance ? suretyBondNumber.trim() : null,
        }),
      );

      // Server resolves the live Stripe price for the chosen plan tier; mobile
      // never has to know price IDs and we can't drift from the seed catalog.
      await openSubscriptionCheckout(selectedPlan);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      notify("Error", err?.message ?? "Could not start checkout. Please try again.");
    } finally {
      setSubscribing(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader variant="dark" title="Grow Your Business" backgroundColor={colors.primary} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: bottomInset + 24 }}
      >
        <View
          style={[
            styles.hero,
            { paddingTop: 16, backgroundColor: colors.primary },
          ]}
        >
          <View style={[styles.heroIcon, { backgroundColor: "rgba(255,255,255,0.15)" }]}>
            <Feather name="briefcase" size={36} color="#fff" />
          </View>
          <Text style={styles.heroTitle}>Grow Your Business</Text>
          <Text style={styles.heroSubtitle}>
            Reach thousands of customers in your area. Simple monthly subscription, plus we take a small percentage of every completed job.
          </Text>

          <View style={styles.heroStats}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatNum}>5,000+</Text>
              <Text style={styles.heroStatLabel}>Monthly users</Text>
            </View>
            <View style={[styles.heroStatDivider, { backgroundColor: "rgba(255,255,255,0.2)" }]} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatNum}>8%</Text>
              <Text style={styles.heroStatLabel}>Platform fee</Text>
            </View>
            <View style={[styles.heroStatDivider, { backgroundColor: "rgba(255,255,255,0.2)" }]} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatNum}>24hr</Text>
              <Text style={styles.heroStatLabel}>Approval</Text>
            </View>
          </View>
        </View>

        <View style={styles.body}>
          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>How It Works</Text>
          {[
            { icon: "check-circle", title: "Subscribe to a plan", desc: "Choose a monthly plan that fits your business size." },
            { icon: "list", title: "List your services", desc: "Add your services, descriptions, pricing, and availability." },
            { icon: "users", title: "Get booked", desc: "Customers find and book your services directly in the app." },
            { icon: "dollar-sign", title: "We handle payments", desc: "You receive payment minus our 8% platform fee per transaction." },
          ].map((step, i) => (
            <View key={i} style={styles.stepRow}>
              <View style={[styles.stepIcon, { backgroundColor: colors.accent + "18" }]}>
                <Feather name={step.icon as any} size={20} color={colors.accent} />
              </View>
              <View style={styles.stepContent}>
                <Text style={[styles.stepTitle, { color: colors.foreground }]}>{step.title}</Text>
                <Text style={[styles.stepDesc, { color: colors.mutedForeground }]}>{step.desc}</Text>
              </View>
            </View>
          ))}

          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Choose Your Plan</Text>
          {PLANS.map((plan) => (
            <TouchableOpacity
              key={plan.id}
              style={[
                styles.planCard,
                {
                  borderColor: selectedPlan === plan.id ? colors.accent : colors.border,
                  backgroundColor: selectedPlan === plan.id ? colors.accent + "08" : colors.card,
                },
              ]}
              onPress={() => {
                Haptics.selectionAsync();
                setSelectedPlan(plan.id);
              }}
              activeOpacity={0.85}
            >
              {plan.recommended && (
                <View style={[styles.recBadge, { backgroundColor: colors.accent }]}>
                  <Text style={styles.recText}>Most Popular</Text>
                </View>
              )}
              <View style={styles.planHeader}>
                <Text style={[styles.planName, { color: colors.foreground }]}>{plan.name}</Text>
                <View style={styles.planPricing}>
                  <Text style={[styles.planPrice, { color: colors.accent }]}>
                    ${plan.monthlyFee}
                  </Text>
                  <Text style={[styles.planPer, { color: colors.mutedForeground }]}>/mo</Text>
                </View>
              </View>
              {plan.features.map((f, i) => (
                <View key={i} style={styles.featureRow}>
                  <Feather name="check" size={13} color={colors.accent} />
                  <Text style={[styles.featureText, { color: colors.mutedForeground }]}>{f}</Text>
                </View>
              ))}
              {selectedPlan === plan.id && (
                <View style={[styles.selectedCheck, { backgroundColor: colors.accent }]}>
                  <Feather name="check" size={14} color="#fff" />
                </View>
              )}
            </TouchableOpacity>
          ))}

          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Business Details</Text>
          <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Business Name *</Text>
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="e.g. SparkClean Pro"
              placeholderTextColor={colors.mutedForeground}
              value={businessName}
              onChangeText={setBusinessName}
            />
          </View>
          <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Description</Text>
            <TextInput
              style={[styles.input, styles.textarea, { color: colors.foreground }]}
              placeholder="Tell customers what makes your business special…"
              placeholderTextColor={colors.mutedForeground}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={3}
            />
          </View>
          <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Phone Number</Text>
            <TextInput
              style={[styles.input, { color: colors.foreground }]}
              placeholder="+1 555-0100"
              placeholderTextColor={colors.mutedForeground}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
            />
          </View>

          <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
            <Text style={[styles.label, { color: colors.mutedForeground }]}>Trade *</Text>
            <View style={styles.tradeGrid}>
              {categories.map((c) => {
                const active = selectedCategoryId === c.id;
                return (
                  <TouchableOpacity
                    key={c.id}
                    onPress={() => {
                      Haptics.selectionAsync();
                      setSelectedCategoryId(c.id);
                    }}
                    style={[
                      styles.tradeChip,
                      {
                        borderColor: active ? colors.accent : colors.border,
                        backgroundColor: active ? colors.accent + "18" : "transparent",
                      },
                    ]}
                    activeOpacity={0.85}
                  >
                    <Text
                      style={[
                        styles.tradeChipText,
                        { color: active ? colors.accent : colors.foreground },
                      ]}
                    >
                      {c.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>

          {requiresInsurance && (
            <>
              <View style={[styles.insuranceBanner, { backgroundColor: colors.accent + "12", borderColor: colors.accent + "55" }]}>
                <Feather name="shield" size={15} color={colors.accent} />
                <Text style={[styles.insuranceBannerText, { color: colors.foreground }]}>
                  This trade requires proof of liability insurance and a surety bond before approval.
                </Text>
              </View>
              <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>Insurance Company *</Text>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="e.g. State Farm"
                  placeholderTextColor={colors.mutedForeground}
                  value={insuranceCompany}
                  onChangeText={setInsuranceCompany}
                />
              </View>
              <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>Policy # *</Text>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="e.g. SF-1234567"
                  placeholderTextColor={colors.mutedForeground}
                  value={policyNumber}
                  onChangeText={setPolicyNumber}
                  autoCapitalize="characters"
                />
              </View>
              <View style={[styles.formGroup, { borderColor: colors.border, backgroundColor: colors.card }]}>
                <Text style={[styles.label, { color: colors.mutedForeground }]}>Surety Bond # *</Text>
                <TextInput
                  style={[styles.input, { color: colors.foreground }]}
                  placeholder="e.g. AK-BOND-998877"
                  placeholderTextColor={colors.mutedForeground}
                  value={suretyBondNumber}
                  onChangeText={setSuretyBondNumber}
                  autoCapitalize="characters"
                />
              </View>
            </>
          )}

          <View style={[styles.feeNote, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Feather name="info" size={15} color={colors.mutedForeground} />
            <Text style={[styles.feeNoteText, { color: colors.mutedForeground }]}>
              An 8% platform fee is applied to every completed transaction. This covers payment processing, customer support, and platform maintenance.
            </Text>
          </View>
        </View>
      </ScrollView>

      <View
        style={[
          styles.footer,
          { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: bottomInset + 12 },
        ]}
      >
        <TouchableOpacity
          style={[styles.subscribeBtn, { backgroundColor: subscribing ? colors.primary + "99" : colors.primary }]}
          onPress={handleSubscribe}
          activeOpacity={0.85}
          disabled={subscribing}
        >
          <Text style={[styles.subscribeBtnText, { color: colors.primaryForeground }]}>
            {subscribing
              ? "Opening Checkout..."
              : `Subscribe to ${PLANS.find(p => p.id === selectedPlan)?.name ?? "plan"} — $${PLANS.find(p => p.id === selectedPlan)?.monthlyFee}/mo`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  hero: {
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
  },
  heroTitle: {
    color: "#fff",
    fontSize: 28,
    fontWeight: "800",
    marginBottom: 10,
  },
  heroSubtitle: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 15,
    lineHeight: 22,
    marginBottom: 20,
  },
  heroStats: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  heroStat: { flex: 1, alignItems: "center" },
  heroStatNum: { color: "#fff", fontSize: 22, fontWeight: "800" },
  heroStatLabel: { color: "rgba(255,255,255,0.6)", fontSize: 12, marginTop: 2 },
  heroStatDivider: { width: 1, height: 30 },
  body: { padding: 20, gap: 0 },
  sectionTitle: { fontSize: 18, fontWeight: "800", marginTop: 8, marginBottom: 14 },
  stepRow: { flexDirection: "row", gap: 14, marginBottom: 16 },
  stepIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  stepContent: { flex: 1, justifyContent: "center" },
  stepTitle: { fontSize: 15, fontWeight: "700" },
  stepDesc: { fontSize: 12, lineHeight: 18, marginTop: 2 },
  planCard: {
    borderRadius: 16,
    borderWidth: 1.5,
    padding: 16,
    marginBottom: 12,
    position: "relative",
  },
  recBadge: {
    position: "absolute",
    top: -1,
    right: 16,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderBottomLeftRadius: 8,
    borderBottomRightRadius: 8,
  },
  recText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  planHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  planName: { fontSize: 18, fontWeight: "800" },
  planPricing: { flexDirection: "row", alignItems: "baseline", gap: 2 },
  planPrice: { fontSize: 22, fontWeight: "800" },
  planPer: { fontSize: 15 },
  featureRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 5 },
  featureText: { fontSize: 12 },
  selectedCheck: {
    position: "absolute",
    top: 16,
    right: 16,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  formGroup: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  label: { fontSize: 12, fontWeight: "600", marginBottom: 6 },
  input: { fontSize: 15 },
  textarea: { height: 70, textAlignVertical: "top" },
  tradeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 4,
  },
  tradeChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  tradeChipText: {
    fontSize: 12,
    fontWeight: "600",
  },
  insuranceBanner: {
    flexDirection: "row",
    gap: 10,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
    alignItems: "flex-start",
  },
  insuranceBannerText: {
    flex: 1,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: "500",
  },
  feeNote: {
    flexDirection: "row",
    gap: 10,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 8,
    alignItems: "flex-start",
  },
  feeNoteText: { flex: 1, fontSize: 12, lineHeight: 19 },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopWidth: 1,
  },
  subscribeBtn: {
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
  },
  subscribeBtnText: {
    fontSize: 15,
    fontWeight: "800",
  },
});
