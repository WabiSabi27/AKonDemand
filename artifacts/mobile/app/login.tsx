import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useState } from "react";
import {
  Alert,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";

import { ApiError, createBizAccount, getGetApplicationFeesQueryKey, useGetApplicationFees } from "@workspace/api-client-react";

import FireweedDecor from "@/components/FireweedDecor";
import { ServiceEntry, UserRole, useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { formatFee } from "@/utils/fees";

type Step = "role" | "login" | "reg1" | "reg2" | "reg3" | "payment" | "pending" | "rejected";

const ROLES: { role: UserRole; title: string; subtitle: string; icon: string; color: string }[] = [
  { role: "customer", title: "Find a Service", subtitle: "Find and book local services", icon: "search", color: "#AB47BC" },
  { role: "business", title: "Service Provider", subtitle: "Manage your services and bookings", icon: "briefcase", color: "#5C6BC0" },
  { role: "admin", title: "Marketplace Admin", subtitle: "Platform management and oversight", icon: "shield", color: "#FFB300" },
];
/**
 * Phase 2 #7: single AsyncStorage key holding ONLY the server-issued
 * `biz_account.id`. The DB row is now the single source of truth — no more
 * client-side wizard payload sitting in AsyncStorage waiting for a webhook
 * race. We persist this so a cold-start after Stripe Checkout can route the
 * user back to /payment-return for status polling.
 */
const APP_ID_KEY = "akodd_application_id";
/**
 * Business location options shown on the registration form. The server's
 * `businessType` enum still only accepts `home-based | brick-and-mortar`,
 * so on submit we map the new "commercial-owned" UI choice → "brick-and-mortar"
 * (both are commercial premises). The exact UI selection is preserved
 * client-side for the summary row and any future server-side broadening.
 */
type BizLocation = "home-based" | "commercial-tenant" | "commercial-owned";

const BIZ_LOCATION_LABELS: Record<BizLocation, string> = {
  "home-based": "Home-Based Business",
  "commercial-tenant": "Commercial Tenant",
  "commercial-owned": "Commercial Property Owned",
};

const BIZ_LOCATION_ICONS: Record<BizLocation, string> = {
  "home-based": "home",
  "commercial-tenant": "briefcase",
  "commercial-owned": "key",
};

const BIZ_LOCATION_ORDER: readonly BizLocation[] = [
  "home-based",
  "commercial-tenant",
  "commercial-owned",
];

/**
 * Cross-platform alert. React Native's `Alert.alert` is a silent no-op on
 * Expo Web (which is the surface the canvas iframe and the published web
 * preview both render through), so validation failures looked like a dead
 * Continue button. Fall back to `window.alert` on web; native uses the real
 * RN modal so behavior on iOS/Android is unchanged.
 */
function notify(title: string, message?: string) {
  if (Platform.OS === "web" && typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  Alert.alert(title, message);
}

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { loginCustomer, loginBusiness, loginAdmin, bizAccounts, categories } = useApp();

  const [step, setStep] = useState<Step>("role");
  const fees = useGetApplicationFees({ query: {
    queryKey: getGetApplicationFeesQueryKey(),
    enabled: step === "payment",
  } });
  const applicationFee = fees.data && !fees.isError
    ? formatFee(fees.data.applicationFeeCents, fees.data.currency)
    : null;
  const [selectedRole, setSelectedRole] = useState<UserRole | null>(null);

  // Customer
  const [custName, setCustName] = useState("");
  const [custEmail, setCustEmail] = useState("");

  // Business login
  const [bizEmail, setBizEmail] = useState("");
  const [bizPassword, setBizPassword] = useState("");
  const [bizPasswordVisible, setBizPasswordVisible] = useState(false);

  // Admin
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [adminPasswordVisible, setAdminPasswordVisible] = useState(false);
  const [adminTotp, setAdminTotp] = useState("");

  // === Registration Step 1 — Credentials ===
  const [regBusinessName, setRegBusinessName] = useState("");
  const [regOwnerName, setRegOwnerName] = useState("");
  const [regPhone, setRegPhone] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirm, setRegConfirm] = useState("");
  const [regPasswordVisible, setRegPasswordVisible] = useState(false);
  const [regConfirmVisible, setRegConfirmVisible] = useState(false);

  // === Registration Step 2 — Business Details ===
  const [bizType, setBizType] = useState<BizLocation | null>(null);
  const [isNewBusiness, setIsNewBusiness] = useState(false);
  const [yearsInBusiness, setYearsInBusiness] = useState("");
  const [alaskaLicense, setAlaskaLicense] = useState("");
  const [bizDescription, setBizDescription] = useState("");
  // Up to 3 service categories: the first is required, the other two are
  // optional. We keep them as separate slots (rather than a multi-select
  // chip grid) to honor the user's "dropdown" UX request and to make the
  // primary-vs-secondary distinction explicit on the form.
  const [serviceCategoryId, setServiceCategoryId] = useState<string | null>(null);
  const [serviceCategoryId2, setServiceCategoryId2] = useState<string | null>(null);
  const [serviceCategoryId3, setServiceCategoryId3] = useState<string | null>(null);
  // Which slot's picker is currently open (null = closed). Single picker
  // modal serves all three triggers.
  const [categoryPickerSlot, setCategoryPickerSlot] = useState<1 | 2 | 3 | null>(null);

  // === Registration Step 3 — Services ===
  const [services, setServices] = useState<ServiceEntry[]>([
    { id: "s_1", name: "", description: "", cost: "" },
  ]);

  // Pending state
  const [pendingName, setPendingName] = useState("");
  const [pendingExpiry, setPendingExpiry] = useState<Date | null>(null);

  const [loading, setLoading] = useState(false);

  function selectRole(role: UserRole) {
    setSelectedRole(role);
    setStep("login");
    Haptics.selectionAsync();
  }

  function goBackToRole() {
    setStep("role");
    setBizEmail(""); setBizPassword("");
    setRegBusinessName(""); setRegOwnerName(""); setRegPhone(""); setRegEmail("");
    setRegPassword(""); setRegConfirm("");
    setBizType(null); setIsNewBusiness(false); setYearsInBusiness("");
    setAlaskaLicense(""); setBizDescription("");
    setServiceCategoryId(null); setServiceCategoryId2(null); setServiceCategoryId3(null);
    setServices([{ id: "s_1", name: "", description: "", cost: "" }]);
    setCustName(""); setCustEmail("");
    setAdminEmail(""); setAdminPassword(""); setAdminTotp("");
  }

  // ─── Customer Login ───────────────────────────────────────────────
  // Email is required by the API (it's the primary key for the users row), so
  // we now enforce it client-side too. Empty name → server still accepts;
  // we keep the local "name required" check for nicer UX.
  async function handleCustomerLogin() {
    if (!custName.trim()) { notify("Required", "Please enter your name."); return; }
    if (!custEmail.trim()) { notify("Required", "Please enter your email so we can save your bookings."); return; }
    setLoading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await loginCustomer(custEmail.trim(), custName.trim());
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const msg = e instanceof ApiError ? (e.data as { error?: string } | null)?.error ?? e.message : "Could not sign in. Please try again.";
      notify("Sign In Failed", msg);
    } finally {
      setLoading(false);
    }
  }

  // ─── Business Login ───────────────────────────────────────────────
  // Server is the source of truth for credentials AND application status. We
  // map its discriminated result to the right UI step. Note: pending/rejected
  // screens no longer show the business name or expiry date because the server
  // does not return those when the login fails — the legacy local lookup that
  // surfaced them will be removed entirely in T006d.
  async function handleBusinessLogin() {
    if (!bizEmail.trim() || !bizPassword.trim()) {
      notify("Required", "Please enter your email and password."); return;
    }
    setLoading(true);
    try {
      const result = await loginBusiness(bizEmail.trim(), bizPassword);
      if (result.ok) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        return;
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (result.reason === "invalid") {
        notify("Sign In Failed", "Incorrect email or password. Please try again or create an account.");
      } else if (result.reason === "accepted") {
        // Accepted post-interview — resume the $2 onboarding payment flow.
        // payment-return falls back to the stored application id when none is passed.
        if (result.bizAccountId) {
          router.replace({ pathname: "/payment-return", params: { id: result.bizAccountId } });
        } else {
          router.replace("/payment-return");
        }
      } else if (result.reason === "awaiting_payment") {
        // Paid nothing yet (abandoned the $1 checkout) — resume application payment.
        if (result.bizAccountId) {
          router.replace({ pathname: "/payment-return", params: { id: result.bizAccountId } });
        } else {
          router.replace("/payment-return");
        }
      } else if (result.reason === "pending") {
        setPendingName(""); setPendingExpiry(null);
        setStep("pending");
      } else if (result.reason === "rejected") {
        setStep("rejected");
      }
    } catch {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      notify("Sign In Failed", "Could not reach the server. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ─── Admin Login ──────────────────────────────────────────────────
  async function handleAdminLogin() {
    if (!adminEmail.trim()) {
      notify("Required", "Please enter your admin email."); return;
    }
    if (!adminPassword) {
      notify("Required", "Please enter your password."); return;
    }
    setLoading(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await loginAdmin({
        email: adminEmail,
        password: adminPassword,
        totpCode: adminTotp || undefined,
      });
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      if (e instanceof ApiError && e.status === 423) {
        // Server returns { error, retryAfterSeconds } on lockout.
        const data = e.data as { retryAfterSeconds?: number } | null;
        const mins = data?.retryAfterSeconds ? Math.ceil(data.retryAfterSeconds / 60) : 15;
        notify(
          "Account Locked",
          `Too many failed attempts. Try again in about ${mins} minute${mins === 1 ? "" : "s"}.`,
        );
      } else if (e instanceof ApiError && e.status === 401) {
        notify("Access Denied", "Invalid email, password, or authenticator code.");
      } else {
        notify("Sign In Failed", "Could not reach the server. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  }

  // ─── Reg Step 1 ───────────────────────────────────────────────────
  function handleReg1Next() {
    if (!regBusinessName.trim()) { notify("Required", "Please enter your business name."); return; }
    if (!regOwnerName.trim()) { notify("Required", "Please enter the owner's name."); return; }
    if (!regPhone.trim()) { notify("Required", "Please enter a phone number."); return; }
    if (!regEmail.trim()) { notify("Required", "Please enter your email address."); return; }
    if (regPassword.length < 8) { notify("Weak Password", "Password must be at least 8 characters."); return; }
    if (regPassword !== regConfirm) { notify("Mismatch", "Passwords do not match."); return; }
    const existing = bizAccounts.find((a) => a.email.toLowerCase() === regEmail.trim().toLowerCase());
    if (existing) { notify("Account Exists", "An account with this email already exists. Please sign in."); return; }
    Haptics.selectionAsync();
    setStep("reg2");
  }

  // ─── Reg Step 2 ───────────────────────────────────────────────────
  function handleReg2Next() {
    if (!bizType) { notify("Required", "Please select a business location."); return; }
    if (!isNewBusiness && !yearsInBusiness.trim()) { notify("Required", "Please enter years in business or mark as New Business."); return; }
    if (!alaskaLicense.trim()) { notify("Required", "Please enter your Alaska Business License number."); return; }
    if (!serviceCategoryId) { notify("Required", "Please select a service category."); return; }
    if (!bizDescription.trim()) { notify("Required", "Please provide a description of your business."); return; }
    Haptics.selectionAsync();
    setStep("reg3");
  }

  // ─── Reg Step 3 ───────────────────────────────────────────────────
  function addService() {
    setServices((prev) => [...prev, { id: `s_${Date.now()}`, name: "", description: "", cost: "" }]);
  }

  function updateService(id: string, field: keyof ServiceEntry, value: string) {
    setServices((prev) => prev.map((s) => s.id === id ? { ...s, [field]: value } : s));
  }

  function removeService(id: string) {
    if (services.length <= 1) { notify("Required", "At least one service is required."); return; }
    setServices((prev) => prev.filter((s) => s.id !== id));
  }

  function handleReg3Next() {
    for (const svc of services) {
      if (!svc.name.trim()) { notify("Required", "Please enter a name for each service."); return; }
      if (!svc.cost.trim()) { notify("Required", `Please enter a cost for "${svc.name || "your service"}".`); return; }
      const costNum = parseFloat(svc.cost);
      if (isNaN(costNum) || costNum < 0) { notify("Invalid Cost", `Please enter a valid cost for "${svc.name}".`); return; }
    }
    Haptics.selectionAsync();
    setStep("payment");
  }

  // ─── Payment ──────────────────────────────────────────────────────
  // Phase 2 #7 flow: POST the wizard payload to /biz-accounts which (a) creates
  // the biz_account + users row in `awaiting_payment` status, and (b) returns
  // a Stripe Checkout Session URL for the $1 application fee. We persist the returned
  // server-assigned id and open the URL in the in-app browser. When the user
  // returns we route them to /payment-return which polls status until the
  // Stripe webhook lands.
  async function handlePayNow() {
    if (!fees.data || !applicationFee || fees.isFetching || loading) return;
    setLoading(true);
    try {
      const result = await createBizAccount({
        expectedApplicationFeeCents: fees.data.applicationFeeCents,
        businessName: regBusinessName.trim(),
        ownerName: regOwnerName.trim(),
        phone: regPhone.trim(),
        email: regEmail.trim().toLowerCase(),
        password: regPassword,
        // Server enum is currently {home-based, brick-and-mortar}. Both new
        // commercial options collapse to "brick-and-mortar" until the schema
        // is broadened; UI choice is preserved in local state.
        businessType: bizType === "home-based" ? "home-based" : "brick-and-mortar",
        yearsInBusiness: isNewBusiness ? "New Business" : yearsInBusiness.trim(),
        alaskaLicenseNumber: alaskaLicense.trim(),
        businessDescription: bizDescription.trim(),
        // Note: the wizard collects intended services for context but the
        // server biz_accounts row doesn't store them — the SP creates real
        // service rows post-approval from the Account tab. The wizard data is
        // intentionally discarded after submit.
      });
      const applicationId = result.bizAccount.id;
      await AsyncStorage.setItem(APP_ID_KEY, applicationId);

      if (Platform.OS === "web") {
        // The mobile app may be loaded inside an iframe (Replit canvas) or as a
        // standalone tab. Stripe Checkout sets X-Frame-Options=DENY, so a same-
        // window navigation inside an iframe paints a blank page. Open in a new
        // top-level tab — this works in both contexts — and immediately route
        // this view to the polling screen so the user sees status when they
        // return (the webhook will have flipped awaiting_payment → pending).
        const opened = (window as any).open(result.checkoutUrl, "_blank", "noopener,noreferrer");
        if (!opened) {
          // Pop-up blocked. Fall back to a same-window nav (works in standalone
          // tabs; in an iframe the user will still see Stripe's frame-deny page
          // but at least the URL is correct and they can copy it).
          (window as any).location.href = result.checkoutUrl;
          return;
        }
        setLoading(false);
        router.replace({ pathname: "/payment-return", params: { id: applicationId } });
        return;
      }

      // Native: openAuthSessionAsync gives us a deterministic dismiss signal
      // (the session resolves when the user closes the SFSafariViewController /
      // CustomTabs sheet), unlike Linking.openURL which fires-and-forgets.
      // Stripe's success_url will deep-link back to our payment-return route,
      // but even if the user just closes the sheet we route there to poll.
      await WebBrowser.openAuthSessionAsync(result.checkoutUrl, null);
      setLoading(false);
      router.replace({ pathname: "/payment-return", params: { id: applicationId } });
    } catch (e: any) {
      setLoading(false);
      if (e instanceof ApiError && e.status === 409) void fees.refetch();
      const msg =
        e instanceof ApiError
          ? (e.data as { error?: string } | null)?.error ?? e.message
          : e?.message || "Could not start payment. Please try again.";
      notify("Payment Error", msg);
    }
  }

  const roleConfig = ROLES.find((r) => r.role === selectedRole);
  const topInset = Platform.OS === "web" ? 0 : insets.top;
  const bottomInset = Platform.OS === "web" ? 0 : Math.max(insets.bottom, 48);
  const expiryLabel = pendingExpiry
    ? pendingExpiry.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : null;

  // Progress for registration steps
  const regProgress: Record<Step, number> = { role: 0, login: 0, reg1: 1, reg2: 2, reg3: 3, payment: 4, pending: 0, rejected: 0 };
  const REG_TOTAL = 3;

  function ProgressBar({ current }: { current: number }) {
    if (current === 0) return null;
    return (
      <View style={styles.progressWrap}>
        {[1, 2, 3].map((n) => (
          <View key={n} style={[styles.progressDot, { backgroundColor: n <= current ? "#5C6BC0" : "rgba(255,255,255,0.15)" }]} />
        ))}
        <Text style={styles.progressLabel}>Step {current} of {REG_TOTAL}</Text>
      </View>
    );
  }

  const { width: winWidth } = useWindowDimensions();

  return (
    <View style={[styles.outer, { backgroundColor: colors.primary, paddingBottom: bottomInset }]}>
    <StatusBar style="light" />
    {step === "role" && (
      <View pointerEvents="none" style={styles.fireweedLayer}>
        <FireweedDecor width={winWidth} height={1020} />
      </View>
    )}
    <KeyboardAwareScrollView
      style={styles.fill}
      contentContainerStyle={[styles.scroll, { paddingTop: topInset + 24, paddingBottom: 24 }]}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={true}
      bottomOffset={24}
      scrollEnabled
    >
        {/* Logo */}
        <View style={styles.brand}>
          <Image source={require("../assets/images/logo_transparent.png")} style={styles.logoImage} resizeMode="contain" />
          <Text style={styles.tagline}>Juneau's local services</Text>
          <Text style={[styles.tagline, styles.taglineLine2]}>one tap away...</Text>
        </View>

        <Animated.View key={step} entering={FadeIn.duration(180)}>
        {/* ── ROLE SELECTION ── */}
        {step === "role" && (
          <>
            {/* ── Prominent Find a Service hero button ── */}
            <TouchableOpacity
              style={styles.findServiceBtn}
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); router.replace("/(tabs)"); }}
              activeOpacity={0.85}
            >
              <View style={styles.findServiceIconWrap}>
                <Feather name="search" size={26} color="#fff" />
              </View>
              <Text style={styles.findServiceTitle}>Find a Service</Text>
              <Text style={styles.findServiceSubtitle}>Browse and book local services in Juneau</Text>
            </TouchableOpacity>

            {/* ── Service Provider cards ── */}
            <View style={styles.roleCards}>
              <TouchableOpacity
                style={[styles.roleCard, { backgroundColor: "#1A1F2E", borderColor: "#5C6BC0" }]}
                onPress={() => { Haptics.selectionAsync(); selectRole("business"); }}
                activeOpacity={0.82}
              >
                <View style={[styles.roleIcon, { width: 56, height: 56, borderRadius: 28, backgroundColor: "#5C6BC022" }]}>
                  <Feather name="log-in" size={26} color="#5C6BC0" />
                </View>
                <View style={styles.roleText}>
                  <Text style={[styles.roleTitle, { fontSize: 18 }]}>Service Provider Login</Text>
                  <Text style={styles.roleSubtitle}>Sign in to your provider account</Text>
                </View>
                <Feather name="chevron-right" size={20} color="rgba(255,255,255,0.5)" />
              </TouchableOpacity>

            </View>

            <TouchableOpacity
              style={styles.applyCard}
              onPress={() => { Haptics.selectionAsync(); setSelectedRole("business"); setStep("reg1"); }}
              activeOpacity={0.82}
            >
              <View style={styles.applyIconWrap}>
                <Feather name="plus" size={20} color="#5C6BC0" />
              </View>
              <View style={styles.roleText}>
                <Text style={styles.applyCardTitle}>New Service Provider?</Text>
                <Text style={styles.applyCardSubtitle}>Apply to list your business in Juneau</Text>
              </View>
              <Feather name="arrow-right" size={18} color="#5C6BC0" />
            </TouchableOpacity>
          </>
        )}

        {/* ── LOGIN FORM ── */}
        {step === "login" && (
          <>
            <TouchableOpacity style={styles.backRow} onPress={goBackToRole}>
              <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <View style={[styles.formCard, { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.14)" }]}>
              <View style={styles.formHeader}>
                <View style={[styles.roleIcon, { backgroundColor: (roleConfig?.color ?? "#fff") + "22" }]}>
                  <Feather name={roleConfig?.icon as any ?? "user"} size={20} color={roleConfig?.color ?? "#fff"} />
                </View>
                <View>
                  <Text style={styles.formTitle}>{roleConfig?.title}</Text>
                  <Text style={styles.formSubtitle}>Sign in to your account</Text>
                </View>
              </View>

              {selectedRole === "customer" && (
                <>
                  <Text style={styles.fieldLabel}>Your Name</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="user" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="Full name" placeholderTextColor="rgba(255,255,255,0.35)" value={custName} onChangeText={setCustName} autoFocus />
                  </View>
                  <Text style={styles.fieldLabel}>Email (optional)</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="mail" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="your@email.com" placeholderTextColor="rgba(255,255,255,0.35)" value={custEmail} onChangeText={setCustEmail} keyboardType="email-address" autoCapitalize="none" />
                  </View>
                </>
              )}

              {selectedRole === "business" && (
                <>
                  <Text style={styles.fieldLabel}>Email Address</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="mail" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="your@business.com" placeholderTextColor="rgba(255,255,255,0.35)" value={bizEmail} onChangeText={setBizEmail} keyboardType="email-address" autoCapitalize="none" autoFocus />
                  </View>
                  <Text style={styles.fieldLabel}>Password</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="lock" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="••••••••" placeholderTextColor="rgba(255,255,255,0.35)" value={bizPassword} onChangeText={setBizPassword} secureTextEntry={!bizPasswordVisible} />
                    <TouchableOpacity onPress={() => setBizPasswordVisible(!bizPasswordVisible)}>
                      <Feather name={bizPasswordVisible ? "eye-off" : "eye"} size={16} color="rgba(255,255,255,0.4)" />
                    </TouchableOpacity>
                  </View>
                  <TouchableOpacity style={styles.forgotRow} onPress={() => { Haptics.selectionAsync(); router.push("/forgot-password"); }}>
                    <Text style={styles.forgotText}>Forgot password?</Text>
                  </TouchableOpacity>
                </>
              )}

              {selectedRole === "admin" && (
                <>
                  <Text style={styles.fieldLabel}>Email Address</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="mail" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="admin@akodd.com" placeholderTextColor="rgba(255,255,255,0.35)" value={adminEmail} onChangeText={setAdminEmail} keyboardType="email-address" autoCapitalize="none" autoFocus />
                  </View>
                  <Text style={styles.fieldLabel}>Password</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="lock" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="••••••••" placeholderTextColor="rgba(255,255,255,0.35)" value={adminPassword} onChangeText={setAdminPassword} secureTextEntry={!adminPasswordVisible} />
                    <TouchableOpacity onPress={() => setAdminPasswordVisible(!adminPasswordVisible)}>
                      <Feather name={adminPasswordVisible ? "eye-off" : "eye"} size={16} color="rgba(255,255,255,0.4)" />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.fieldLabel}>Authenticator Code <Text style={{ opacity: 0.6 }}>(if enabled)</Text></Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="shield" size={16} color="rgba(255,255,255,0.5)" />
                    <TextInput style={styles.input} placeholder="6-digit code" placeholderTextColor="rgba(255,255,255,0.35)" value={adminTotp} onChangeText={(v) => setAdminTotp(v.replace(/\D/g, ""))} keyboardType="number-pad" maxLength={6} />
                  </View>
                  <Text style={styles.hint}>Contact the platform operator if you need help accessing the admin console.</Text>
                </>
              )}
            </View>

            <TouchableOpacity
              style={[styles.continueBtn, { backgroundColor: roleConfig?.color ?? "#FFB300", opacity: loading ? 0.7 : 1 }]}
              onPress={selectedRole === "customer" ? handleCustomerLogin : selectedRole === "business" ? handleBusinessLogin : handleAdminLogin}
              activeOpacity={0.85} disabled={loading}
            >
              <Text style={styles.continueBtnText}>{loading ? "Signing in…" : "Sign In"}</Text>
              {!loading && <Feather name="arrow-right" size={18} color="#fff" />}
            </TouchableOpacity>

            {selectedRole === "business" && (
              <View style={styles.createAccountRow}>
                <Text style={styles.createAccountText}>Don't have an account?</Text>
                <TouchableOpacity onPress={() => { setStep("reg1"); Haptics.selectionAsync(); }}>
                  <Text style={[styles.createAccountLink, { color: "#5C6BC0" }]}>  Apply as a Provider</Text>
                </TouchableOpacity>
              </View>
            )}
          </>
        )}

        {/* ── REG STEP 1: Account & Contact ── */}
        {step === "reg1" && (
          <>
            <TouchableOpacity style={styles.backRow} onPress={() => setStep("login")}>
              <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <ProgressBar current={1} />

            <View style={[styles.formCard, { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.14)" }]}>
              <View style={styles.formHeader}>
                <View style={[styles.roleIcon, { backgroundColor: "#5C6BC022" }]}>
                  <Feather name="briefcase" size={20} color="#5C6BC0" />
                </View>
                <View>
                  <Text style={styles.formTitle}>Business Information</Text>
                  <Text style={styles.formSubtitle}>Tell us about you and your business</Text>
                </View>
              </View>

              <Field label="Business Name *" icon="briefcase">
                <TextInput style={styles.input} placeholder="Your business name" placeholderTextColor="rgba(255,255,255,0.35)" value={regBusinessName} onChangeText={setRegBusinessName} autoFocus />
              </Field>

              <Field label="Owner Name *" icon="user">
                <TextInput style={styles.input} placeholder="Full legal name" placeholderTextColor="rgba(255,255,255,0.35)" value={regOwnerName} onChangeText={setRegOwnerName} />
              </Field>

              <Field label="Phone Number *" icon="phone">
                <TextInput style={styles.input} placeholder="e.g. 907-555-1234" placeholderTextColor="rgba(255,255,255,0.35)" value={regPhone} onChangeText={setRegPhone} keyboardType="phone-pad" />
              </Field>

              <Field label="Email Address *" icon="mail">
                <TextInput style={styles.input} placeholder="your@business.com" placeholderTextColor="rgba(255,255,255,0.35)" value={regEmail} onChangeText={setRegEmail} keyboardType="email-address" autoCapitalize="none" />
              </Field>

              <Field label="Password * (8 characters)" icon="lock">
                <TextInput style={styles.input} placeholder="Min 8 characters" placeholderTextColor="rgba(255,255,255,0.35)" value={regPassword} onChangeText={setRegPassword} secureTextEntry={!regPasswordVisible} />
                <TouchableOpacity onPress={() => setRegPasswordVisible(!regPasswordVisible)}>
                  <Feather name={regPasswordVisible ? "eye-off" : "eye"} size={16} color="rgba(255,255,255,0.4)" />
                </TouchableOpacity>
              </Field>

              <Field label="Confirm Password *" icon="lock">
                <TextInput style={styles.input} placeholder="Re-enter password" placeholderTextColor="rgba(255,255,255,0.35)" value={regConfirm} onChangeText={setRegConfirm} secureTextEntry={!regConfirmVisible} />
                <TouchableOpacity onPress={() => setRegConfirmVisible(!regConfirmVisible)}>
                  <Feather name={regConfirmVisible ? "eye-off" : "eye"} size={16} color="rgba(255,255,255,0.4)" />
                </TouchableOpacity>
              </Field>
            </View>

            <TouchableOpacity style={[styles.continueBtn, { backgroundColor: "#5C6BC0" }]} onPress={handleReg1Next} activeOpacity={0.85}>
              <Text style={styles.continueBtnText}>Continue</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </TouchableOpacity>
          </>
        )}

        {/* ── REG STEP 2: Business Details ── */}
        {step === "reg2" && (
          <>
            <TouchableOpacity style={styles.backRow} onPress={() => setStep("reg1")}>
              <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <ProgressBar current={2} />

            <View style={[styles.formCard, { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.14)" }]}>
              <View style={styles.formHeader}>
                <View style={[styles.roleIcon, { backgroundColor: "#5C6BC022" }]}>
                  <Feather name="file-text" size={20} color="#5C6BC0" />
                </View>
                <View>
                  <Text style={styles.formTitle}>Business Details</Text>
                  <Text style={styles.formSubtitle}>Licensing and business classification</Text>
                </View>
              </View>

              {/* Business Location */}
              <Text style={styles.fieldLabel}>Business Location *</Text>
              <View style={styles.typeRow}>
                {BIZ_LOCATION_ORDER.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[
                      styles.typeOption,
                      { borderColor: bizType === t ? "#5C6BC0" : "rgba(255,255,255,0.2)", backgroundColor: bizType === t ? "#5C6BC020" : "transparent" },
                    ]}
                    onPress={() => { setBizType(t); Haptics.selectionAsync(); }}
                    activeOpacity={0.8}
                  >
                    <Feather name={BIZ_LOCATION_ICONS[t] as any} size={18} color={bizType === t ? "#5C6BC0" : "rgba(255,255,255,0.5)"} />
                    <Text style={[styles.typeLabel, { color: bizType === t ? "#fff" : "rgba(255,255,255,0.6)" }]}>{BIZ_LOCATION_LABELS[t]}</Text>
                    {bizType === t && <Feather name="check-circle" size={16} color="#5C6BC0" style={{ marginLeft: "auto" }} />}
                  </TouchableOpacity>
                ))}
              </View>

              {/* Years in Business */}
              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Years in Business *</Text>
              <View style={styles.yearsRow}>
                <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)", flex: 1, opacity: isNewBusiness ? 0.35 : 1 }]}>
                  <Feather name="calendar" size={16} color="rgba(255,255,255,0.5)" />
                  <TextInput
                    style={styles.input}
                    placeholder="e.g. 5"
                    placeholderTextColor="rgba(255,255,255,0.35)"
                    value={isNewBusiness ? "" : yearsInBusiness}
                    onChangeText={setYearsInBusiness}
                    keyboardType="number-pad"
                    editable={!isNewBusiness}
                  />
                </View>
                <TouchableOpacity
                  style={[styles.newBizBtn, { borderColor: isNewBusiness ? "#5C6BC0" : "rgba(255,255,255,0.2)", backgroundColor: isNewBusiness ? "#5C6BC020" : "transparent" }]}
                  onPress={() => { setIsNewBusiness(!isNewBusiness); if (!isNewBusiness) setYearsInBusiness(""); Haptics.selectionAsync(); }}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.newBizBtnText, { color: isNewBusiness ? "#5C6BC0" : "rgba(255,255,255,0.5)" }]}>New Business</Text>
                </TouchableOpacity>
              </View>

              {/* Alaska License */}
              <Field label="Alaska Business License Number *" icon="award">
                <TextInput style={styles.input} placeholder="e.g. AK-123456" placeholderTextColor="rgba(255,255,255,0.35)" value={alaskaLicense} onChangeText={setAlaskaLicense} autoCapitalize="characters" />
              </Field>

              {/* Service Categories — primary required, two optional */}
              {([
                { slot: 1 as const, label: "Service Category *", value: serviceCategoryId, placeholder: "Select a service category…" },
                { slot: 2 as const, label: "Additional Service Category (optional)", value: serviceCategoryId2, placeholder: "Select another category…" },
                { slot: 3 as const, label: "Additional Service Category (optional)", value: serviceCategoryId3, placeholder: "Select another category…" },
              ]).map(({ slot, label, value, placeholder }) => {
                const selectedName = value ? categories.find((c) => c.id === value)?.name : null;
                const clear = () => {
                  if (slot === 2) setServiceCategoryId2(null);
                  if (slot === 3) setServiceCategoryId3(null);
                };
                return (
                  <View key={slot}>
                    <Text style={[styles.fieldLabel, { marginTop: 16 }]}>{label}</Text>
                    <TouchableOpacity
                      style={[styles.dropdownTrigger, { borderColor: "rgba(255,255,255,0.2)" }]}
                      onPress={() => { setCategoryPickerSlot(slot); Haptics.selectionAsync(); }}
                      activeOpacity={0.85}
                    >
                      <Feather name="grid" size={16} color="rgba(255,255,255,0.5)" />
                      <Text
                        style={[
                          styles.dropdownTriggerText,
                          { color: value ? "#fff" : "rgba(255,255,255,0.35)" },
                        ]}
                        numberOfLines={1}
                      >
                        {selectedName ?? placeholder}
                      </Text>
                      {/* Optional slots get a clear button when populated. */}
                      {slot !== 1 && value ? (
                        <TouchableOpacity onPress={clear} hitSlop={8}>
                          <Feather name="x" size={16} color="rgba(255,255,255,0.55)" />
                        </TouchableOpacity>
                      ) : (
                        <Feather name="chevron-down" size={18} color="rgba(255,255,255,0.5)" />
                      )}
                    </TouchableOpacity>
                  </View>
                );
              })}

              {/* Description */}
              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Business Description *</Text>
              <View style={[styles.textAreaWrap, { borderColor: "rgba(255,255,255,0.2)" }]}>
                <TextInput
                  style={[styles.input, styles.textArea]}
                  placeholder="Briefly describe your business, services offered, and service area..."
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={bizDescription}
                  onChangeText={setBizDescription}
                  multiline
                  numberOfLines={4}
                  textAlignVertical="top"
                />
              </View>
            </View>

            <TouchableOpacity style={[styles.continueBtn, { backgroundColor: "#5C6BC0" }]} onPress={handleReg2Next} activeOpacity={0.85}>
              <Text style={styles.continueBtnText}>Continue</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </TouchableOpacity>
          </>
        )}

        {/* ── REG STEP 3: Services ── */}
        {step === "reg3" && (
          <>
            <TouchableOpacity style={styles.backRow} onPress={() => setStep("reg2")}>
              <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>
            <ProgressBar current={3} />

            <View style={[styles.formCard, { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.14)" }]}>
              <View style={styles.formHeader}>
                <View style={[styles.roleIcon, { backgroundColor: "#5C6BC022" }]}>
                  <Feather name="list" size={20} color="#5C6BC0" />
                </View>
                <View>
                  <Text style={styles.formTitle}>Services Offered</Text>
                  <Text style={styles.formSubtitle}>Add at least one service with its cost</Text>
                </View>
              </View>

              {services.map((svc, idx) => (
                <View key={svc.id} style={[styles.serviceCard, { borderColor: "rgba(92,107,192,0.3)", backgroundColor: "rgba(92,107,192,0.06)" }]}>
                  <View style={styles.serviceCardHeader}>
                    <Text style={styles.serviceCardTitle}>Service {idx + 1}</Text>
                    <TouchableOpacity
                      style={styles.serviceDeleteBtn}
                      onPress={() => removeService(svc.id)}
                      activeOpacity={0.7}
                    >
                      <Feather name="trash-2" size={14} color="#F44336" />
                      <Text style={styles.serviceDeleteText}>Delete</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={styles.fieldLabel}>Service Name *</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="tag" size={14} color="rgba(255,255,255,0.4)" />
                    <TextInput style={styles.input} placeholder="e.g. House Cleaning" placeholderTextColor="rgba(255,255,255,0.35)" value={svc.name} onChangeText={(v) => updateService(svc.id, "name", v)} />
                  </View>

                  <Text style={styles.fieldLabel}>Description (optional)</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Feather name="align-left" size={14} color="rgba(255,255,255,0.4)" />
                    <TextInput style={styles.input} placeholder="Brief description of this service" placeholderTextColor="rgba(255,255,255,0.35)" value={svc.description || ""} onChangeText={(v) => updateService(svc.id, "description", v)} />
                  </View>

                  <Text style={styles.fieldLabel}>Cost / Starting Price *</Text>
                  <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
                    <Text style={styles.dollarSign}>$</Text>
                    <TextInput style={styles.input} placeholder="0.00" placeholderTextColor="rgba(255,255,255,0.35)" value={svc.cost} onChangeText={(v) => updateService(svc.id, "cost", v)} keyboardType="decimal-pad" />
                  </View>
                </View>
              ))}

              <TouchableOpacity
                style={[styles.addServiceBtn, { borderColor: "rgba(92,107,192,0.5)", backgroundColor: "rgba(92,107,192,0.08)" }]}
                onPress={addService} activeOpacity={0.8}
              >
                <Feather name="plus-circle" size={17} color="#5C6BC0" />
                <Text style={[styles.addServiceText, { color: "#5C6BC0" }]}>Add Another Service</Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity style={[styles.continueBtn, { backgroundColor: "#5C6BC0" }]} onPress={handleReg3Next} activeOpacity={0.85}>
              <Text style={styles.continueBtnText}>Continue to Payment</Text>
              <Feather name="arrow-right" size={18} color="#fff" />
            </TouchableOpacity>
          </>
        )}

        {/* ── PAYMENT STEP ── */}
        {step === "payment" && (
          <>
            <TouchableOpacity style={styles.backRow} onPress={() => setStep("reg3")}>
              <Feather name="arrow-left" size={18} color="rgba(255,255,255,0.7)" />
              <Text style={styles.backText}>Back</Text>
            </TouchableOpacity>

            <View style={[styles.formCard, { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.14)" }]}>
              <View style={styles.formHeader}>
                <View style={[styles.roleIcon, { backgroundColor: "#FFB30022" }]}>
                  <Feather name="credit-card" size={20} color="#FFB300" />
                </View>
                <View>
                  <Text style={styles.formTitle}>Application Fee</Text>
                  <Text style={styles.formSubtitle}>Secure payment via Stripe</Text>
                </View>
              </View>

              <View style={[styles.feeBox, { backgroundColor: "rgba(0,191,166,0.08)", borderColor: "rgba(0,191,166,0.25)" }]}>
                <View style={styles.feeRow}>
                  <Text style={styles.feeLabel}>Service Provider Application</Text>
                  <Text style={styles.feeAmount}>{applicationFee ?? "—"}</Text>
                </View>
                <View style={[styles.feeDivider, { backgroundColor: "rgba(255,255,255,0.1)" }]} />
                <View style={styles.feeRow}>
                  <Text style={[styles.feeLabel, { fontWeight: "800", color: "#fff" }]}>Total Due</Text>
                  <Text style={[styles.feeAmount, { color: "#FFB300", fontSize: 22, fontWeight: "700" }]}>{applicationFee ?? "—"}</Text>
                </View>
              </View>

              {/* Application Summary */}
              <Text style={[styles.fieldLabel, { marginTop: 16 }]}>Application Summary</Text>
              <View style={[styles.summaryBox, { backgroundColor: "rgba(255,255,255,0.04)", borderColor: "rgba(255,255,255,0.1)" }]}>
                <SummaryRow icon="briefcase" label="Business" value={regBusinessName} />
                <SummaryRow icon="user" label="Owner" value={regOwnerName} />
                <SummaryRow icon="mail" label="Email" value={regEmail} />
                <SummaryRow icon="home" label="Location" value={bizType ? BIZ_LOCATION_LABELS[bizType] : "—"} />
                <SummaryRow icon="list" label="Services" value={`${services.length} service${services.length !== 1 ? "s" : ""} listed`} />
              </View>

              {[
                { icon: "check-circle", text: "Application reviewed by Marketplace Admin" },
                { icon: "check-circle", text: "30-day application validity window" },
                { icon: "check-circle", text: "Full platform access upon approval" },
              ].map((item, i) => (
                <View key={i} style={styles.includeRow}>
                  <Feather name={item.icon as any} size={15} color="#FFB300" />
                  <Text style={styles.includeText}>{item.text}</Text>
                </View>
              ))}

              <View style={[styles.noticeBox, { backgroundColor: "rgba(255,179,0,0.08)", borderColor: "rgba(255,179,0,0.25)" }]}>
                <Feather name="alert-circle" size={14} color="#FFB300" />
                <Text style={styles.noticeText}>{applicationFee ? `The ${applicationFee} application fee is non-refundable.` : "The application fee is non-refundable."}</Text>
              </View>
            </View>

            {fees.isError && (
              <TouchableOpacity onPress={() => void fees.refetch()}>
                <Text style={styles.noticeText}>Could not load the application fee. Tap to retry.</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={[styles.continueBtn, { backgroundColor: "#FFB300", opacity: loading || !applicationFee || fees.isFetching ? 0.7 : 1 }]}
              onPress={handlePayNow} activeOpacity={0.85} disabled={loading || !applicationFee || fees.isFetching}
            >
              <Feather name="lock" size={18} color="#fff" />
              <Text style={styles.continueBtnText}>{loading ? "Opening payment…" : applicationFee ? `Pay ${applicationFee} Application Fee` : fees.isError ? "Payment unavailable" : "Loading application fee…"}</Text>
            </TouchableOpacity>

            <Text style={styles.secureText}>Payments powered by Stripe. Your card details are never stored on our servers.</Text>
          </>
        )}

        {/* ── PENDING APPROVAL ── */}
        {step === "pending" && (
          <View style={styles.statusCard}>
            <View style={[styles.statusIconCircle, { backgroundColor: "#FFB30020" }]}>
              <Feather name="clock" size={40} color="#FFB300" />
            </View>
            <Text style={styles.statusTitle}>Application Under Review</Text>
            <Text style={styles.statusDesc}>
              Hi {pendingName ? pendingName.split(" ")[0] : "there"}! Your application is awaiting review by the Marketplace Admin. You'll be notified once approved.
            </Text>
            {expiryLabel && (
              <View style={[styles.statusInfoBox, { backgroundColor: "rgba(255,179,0,0.08)", borderColor: "rgba(255,179,0,0.25)" }]}>
                <Feather name="calendar" size={15} color="#FFB300" />
                <Text style={styles.statusInfoText}>Application valid until <Text style={{ color: "#FFB300", fontWeight: "700" }}>{expiryLabel}</Text></Text>
              </View>
            )}
            <View style={[styles.statusInfoBox, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.12)" }]}>
              <Feather name="mail" size={15} color="rgba(255,255,255,0.5)" />
              <Text style={styles.statusInfoText}>Questions? Email support@akodd.com</Text>
            </View>
            <TouchableOpacity style={[styles.continueBtn, { backgroundColor: "rgba(255,255,255,0.12)", marginTop: 8 }]} onPress={goBackToRole} activeOpacity={0.85}>
              <Feather name="arrow-left" size={18} color="#fff" />
              <Text style={styles.continueBtnText}>Back to Login</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── REJECTED ── */}
        {step === "rejected" && (
          <View style={styles.statusCard}>
            <View style={[styles.statusIconCircle, { backgroundColor: "#F4433620" }]}>
              <Feather name="x-circle" size={40} color="#F44336" />
            </View>
            <Text style={styles.statusTitle}>Application Not Approved</Text>
            <Text style={styles.statusDesc}>
              Unfortunately your application was not approved at this time. Please contact us if you believe this is an error.
            </Text>
            <View style={[styles.statusInfoBox, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.12)" }]}>
              <Feather name="mail" size={15} color="#F44336" />
              <Text style={styles.statusInfoText}>Contact us at support@akodd.com</Text>
            </View>
            <TouchableOpacity style={[styles.continueBtn, { backgroundColor: "rgba(255,255,255,0.12)", marginTop: 8 }]} onPress={goBackToRole} activeOpacity={0.85}>
              <Feather name="arrow-left" size={18} color="#fff" />
              <Text style={styles.continueBtnText}>Back to Login</Text>
            </TouchableOpacity>
          </View>
        )}
        </Animated.View>

        <View style={styles.footerRow}>
          {step === "role" ? (
            <TouchableOpacity
              style={styles.footerAdminBtn}
              onPress={() => { Haptics.selectionAsync(); selectRole("admin"); }}
              activeOpacity={0.6}
              hitSlop={12}
            >
              <Feather name="shield" size={14} color="rgba(255,255,255,0.4)" />
            </TouchableOpacity>
          ) : (
            <View style={styles.footerAdminBtn} />
          )}
          <Text style={styles.footer}>AK On Demand LLC · All rights reserved</Text>
          <View style={styles.footerAdminBtn} />
        </View>
    </KeyboardAwareScrollView>

    {/* ── Service Category Picker Modal (shared across all 3 slots) ── */}
    <Modal
      visible={categoryPickerSlot !== null}
      transparent
      animationType="fade"
      onRequestClose={() => setCategoryPickerSlot(null)}
    >
      <Pressable style={styles.pickerBackdrop} onPress={() => setCategoryPickerSlot(null)}>
        <Pressable style={styles.pickerSheet} onPress={(e) => e.stopPropagation()}>
          <Text style={styles.pickerTitle}>
            {categoryPickerSlot === 1 ? "Select Service Category" : "Select Additional Category"}
          </Text>
          <ScrollView
            style={styles.pickerScroll}
            contentContainerStyle={styles.pickerList}
            showsVerticalScrollIndicator
            nestedScrollEnabled
          >
            {categories.map((c) => {
              const currentForSlot =
                categoryPickerSlot === 1 ? serviceCategoryId :
                categoryPickerSlot === 2 ? serviceCategoryId2 :
                categoryPickerSlot === 3 ? serviceCategoryId3 : null;
              const active = currentForSlot === c.id;
              // Disable categories already chosen in another slot to prevent duplicates.
              const takenElsewhere =
                (categoryPickerSlot !== 1 && serviceCategoryId === c.id) ||
                (categoryPickerSlot !== 2 && serviceCategoryId2 === c.id) ||
                (categoryPickerSlot !== 3 && serviceCategoryId3 === c.id);
              return (
                <TouchableOpacity
                  key={c.id}
                  disabled={takenElsewhere}
                  style={[
                    styles.pickerOption,
                    {
                      borderColor: active ? "#5C6BC0" : "rgba(255,255,255,0.12)",
                      backgroundColor: active ? "#5C6BC020" : "transparent",
                      opacity: takenElsewhere ? 0.35 : 1,
                    },
                  ]}
                  onPress={() => {
                    if (categoryPickerSlot === 1) setServiceCategoryId(c.id);
                    if (categoryPickerSlot === 2) setServiceCategoryId2(c.id);
                    if (categoryPickerSlot === 3) setServiceCategoryId3(c.id);
                    setCategoryPickerSlot(null);
                    Haptics.selectionAsync();
                  }}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.pickerOptionText, { color: active ? "#fff" : "rgba(255,255,255,0.85)" }]}>
                    {c.name}
                    {takenElsewhere ? "  (already selected)" : ""}
                  </Text>
                  {active && <Feather name="check" size={18} color="#5C6BC0" />}
                </TouchableOpacity>
              );
            })}
            {categories.length === 0 && (
              <Text style={styles.pickerEmpty}>No categories available yet.</Text>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>

    </View>
  );
}

// ─── Helper Components ────────────────────────────────────────────────────────

function Field({ label, icon, children }: { label: string; icon: string; children: React.ReactNode }) {
  return (
    <>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={[styles.inputRow, { borderColor: "rgba(255,255,255,0.2)" }]}>
        <Feather name={icon as any} size={16} color="rgba(255,255,255,0.5)" />
        {children}
      </View>
    </>
  );
}

function SummaryRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <View style={styles.summaryRow}>
      <Feather name={icon as any} size={13} color="rgba(255,255,255,0.4)" />
      <Text style={styles.summaryLabel}>{label}:</Text>
      <Text style={styles.summaryValue} numberOfLines={1}>{value}</Text>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  outer: { flex: 1 },
  fill: { flex: 1 },
  fireweedLayer: { position: "absolute", left: 0, right: 0, bottom: 0, opacity: 0.55, zIndex: 0, elevation: 0 },
  container: { flex: 1 },
  scroll: { paddingHorizontal: 24 },
  brand: { alignItems: "center", paddingTop: 0, marginTop: -16, marginBottom: 32 },
  logoImage: { width: 480, height: 360, marginBottom: -48, shadowColor: "#FFB300", shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.35, shadowRadius: 32, elevation: 12 },
  tagline: { color: "rgba(255,255,255,0.75)", fontSize: 16, marginTop: 0, fontWeight: "500", letterSpacing: 0.2, textAlign: "center" },
  taglineLine2: { paddingLeft: 80, marginTop: 4, fontStyle: "italic", color: "rgba(255,255,255,0.6)" },
  sectionLabel: { color: "rgba(255,255,255,0.6)", fontSize: 12, fontWeight: "600", marginBottom: 16, letterSpacing: 0.3 },
  homePageLabel: { color: "#fff", fontSize: 12, fontWeight: "700", letterSpacing: 3, textAlign: "center", marginBottom: 8, opacity: 0.5 },
  findServiceBtn: { backgroundColor: "#AB47BC", borderRadius: 20, paddingVertical: 16, paddingHorizontal: 24, alignItems: "center", gap: 8, marginBottom: 16, shadowColor: "#AB47BC", shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  findServiceIconWrap: { width: 56, height: 56, borderRadius: 28, backgroundColor: "rgba(255,255,255,0.2)", alignItems: "center", justifyContent: "center", marginBottom: 4 },
  findServiceTitle: { color: "#fff", fontSize: 22, fontWeight: "700" },
  findServiceSubtitle: { color: "rgba(255,255,255,0.75)", fontSize: 15, textAlign: "center" },
  adminFloatBtn: { position: "absolute", right: 24, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: "rgba(255,255,255,0.18)", backgroundColor: "#0F1B2D", zIndex: 10, elevation: 10 },
  adminFloatText: { color: "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: "600" },
  roleCards: { gap: 8 },
  applyLinkRow: { alignItems: "center", paddingVertical: 16, marginTop: 4 },
  applyLinkText: { color: "rgba(255,255,255,0.55)", fontSize: 12, fontWeight: "500" },
  applyLinkAccent: { color: "#5C6BC0", fontWeight: "700" },
  roleCard: { flexDirection: "row", alignItems: "center", padding: 20, borderRadius: 16, borderWidth: 1, gap: 16 },
  applyCard: { flexDirection: "row", alignItems: "center", padding: 20, borderRadius: 16, borderWidth: 1.5, borderColor: "#5C6BC0", borderStyle: "dashed", backgroundColor: "transparent", gap: 16, marginTop: 16 },
  applyIconWrap: { width: 44, height: 44, borderRadius: 22, backgroundColor: "#5C6BC022", alignItems: "center", justifyContent: "center" },
  applyCardTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  applyCardSubtitle: { color: "rgba(255,255,255,0.55)", fontSize: 12, marginTop: 4 },
  roleIcon: { width: 44, height: 44, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  roleText: { flex: 1 },
  roleTitle: { color: "#fff", fontSize: 15, fontWeight: "700" },
  roleSubtitle: { color: "rgba(255,255,255,0.55)", fontSize: 12, marginTop: 4 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  backText: { color: "rgba(255,255,255,0.7)", fontSize: 15 },
  progressWrap: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 16 },
  progressDot: { width: 28, height: 4, borderRadius: 2 },
  progressLabel: { color: "rgba(255,255,255,0.4)", fontSize: 12, marginLeft: 8 },
  formCard: { borderRadius: 18, borderWidth: 1, padding: 20, gap: 4, marginBottom: 16 },
  formHeader: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  formTitle: { color: "#fff", fontSize: 18, fontWeight: "800" },
  formSubtitle: { color: "rgba(255,255,255,0.5)", fontSize: 12, marginTop: 4 },
  fieldLabel: { color: "rgba(255,255,255,0.6)", fontSize: 12, fontWeight: "600", marginTop: 8, marginBottom: 8 },
  inputRow: { flexDirection: "row", alignItems: "center", gap: 8, borderBottomWidth: 1, paddingBottom: 10 },
  input: { flex: 1, color: "#fff", fontSize: 15, padding: 0 },
  hint: { color: "rgba(255,255,255,0.4)", fontSize: 12, marginTop: 16, lineHeight: 18 },
  forgotRow: { alignItems: "flex-end", marginTop: 8 },
  forgotText: { color: "rgba(255,255,255,0.5)", fontSize: 12 },
  continueBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 16, borderRadius: 16, marginTop: 4 },
  continueBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  createAccountRow: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginTop: 16, flexWrap: "wrap" },
  createAccountText: { color: "rgba(255,255,255,0.5)", fontSize: 15 },
  createAccountLink: { fontSize: 15, fontWeight: "700" },
  typeRow: { gap: 8 },
  typeOption: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12 },
  typeLabel: { fontSize: 15, fontWeight: "600" },
  yearsRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  newBizBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  newBizBtnText: { fontSize: 12, fontWeight: "700" },
  textAreaWrap: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  dropdownTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  dropdownTriggerText: { flex: 1, fontSize: 15 },
  pickerBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    alignItems: "center",
    padding: 20,
  },
  pickerSheet: {
    width: "100%",
    maxWidth: 420,
    maxHeight: "80%",
    backgroundColor: "#1A1F2E",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    padding: 20,
  },
  pickerTitle: { color: "#fff", fontSize: 15, fontWeight: "800", marginBottom: 16 },
  // Approx. 5 rows visible: each option is ~48px (12+12 padding + ~17 text + 1.5*2 border)
  // plus 8px gap. 5 * 48 + 4 * 8 ≈ 272. We round to 280 for breathing room.
  pickerScroll: { maxHeight: 280 },
  pickerList: { gap: 8, paddingBottom: 4 },
  pickerOption: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1.5,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  pickerOptionText: { fontSize: 15, fontWeight: "600" },
  pickerEmpty: { color: "rgba(255,255,255,0.5)", fontSize: 12, textAlign: "center", paddingVertical: 12 },
  textArea: { minHeight: 80, lineHeight: 20 },
  dollarSign: { color: "rgba(255,255,255,0.6)", fontSize: 15, fontWeight: "700" },
  serviceCard: { borderRadius: 12, borderWidth: 1, padding: 16, gap: 4, marginTop: 12 },
  serviceCardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  serviceCardTitle: { color: "rgba(255,255,255,0.7)", fontSize: 12, fontWeight: "700", letterSpacing: 0.5 },
  serviceDeleteBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: "rgba(244,67,54,0.12)", borderWidth: 1, borderColor: "rgba(244,67,54,0.3)" },
  serviceDeleteText: { color: "#F44336", fontSize: 12, fontWeight: "700" },
  addServiceBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1.5, borderStyle: "dashed" as any, borderRadius: 12, paddingVertical: 12, marginTop: 12 },
  addServiceText: { fontSize: 15, fontWeight: "700" },
  feeBox: { borderRadius: 14, borderWidth: 1, padding: 16, gap: 8, marginTop: 8 },
  feeRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  feeLabel: { color: "rgba(255,255,255,0.7)", fontSize: 15 },
  feeAmount: { color: "#fff", fontSize: 15, fontWeight: "700" },
  feeDivider: { height: 1 },
  summaryBox: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8, marginBottom: 12 },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  summaryLabel: { color: "rgba(255,255,255,0.45)", fontSize: 12, width: 52 },
  summaryValue: { color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: "600", flex: 1 },
  includeRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  includeText: { color: "rgba(255,255,255,0.65)", fontSize: 12, flex: 1 },
  noticeBox: { borderRadius: 12, borderWidth: 1, padding: 12, flexDirection: "row", gap: 8, marginTop: 16, alignItems: "flex-start" },
  noticeText: { color: "rgba(255,255,255,0.55)", fontSize: 12, flex: 1, lineHeight: 18 },
  secureText: { color: "rgba(255,255,255,0.35)", fontSize: 12, textAlign: "center", marginTop: 12, lineHeight: 18 },
  statusCard: { alignItems: "center", gap: 16, paddingVertical: 8 },
  statusIconCircle: { width: 88, height: 88, borderRadius: 44, alignItems: "center", justifyContent: "center", marginBottom: 4 },
  statusTitle: { color: "#fff", fontSize: 22, fontWeight: "700", textAlign: "center" },
  statusDesc: { color: "rgba(255,255,255,0.6)", fontSize: 15, lineHeight: 22, textAlign: "center" },
  statusInfoBox: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 14, padding: 16, width: "100%" },
  statusInfoText: { color: "rgba(255,255,255,0.55)", fontSize: 12, lineHeight: 20, flex: 1 },
  footerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 32, paddingVertical: 8, zIndex: 10 },
  footer: { color: "rgba(255,255,255,0.5)", fontSize: 12, textAlign: "center", flex: 1 },
  footerAdminBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
});
