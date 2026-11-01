import AsyncStorage from "@react-native-async-storage/async-storage";
import { Feather } from "@expo/vector-icons";
import * as WebBrowser from "expo-web-browser";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useRef, useState } from "react";
import { Platform, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ApiError, createOnboardingCheckout, getBizAccountStatus, useGetApplicationFees, type BizAccountStatusResponse } from "@workspace/api-client-react";
import { formatFee } from "@/utils/fees";

const APP_ID_KEY = "akodd_application_id";

/** ms between status polls. */
const POLL_INTERVAL_MS = 2000;
/** total wall-clock budget before we give up and show "still processing". */
const POLL_BUDGET_MS = 30_000;

type Screen =
  | { kind: "polling"; attempt: number }
  | { kind: "pending"; meeting: MeetingInfo }  // paid $1 app fee — awaiting interview + admin accept
  | { kind: "accepted"; meeting: MeetingInfo } // admin accepted — applicant must pay $2 onboarding fee
  | { kind: "starting_onboarding" } // launching the onboarding Stripe Checkout
  | { kind: "approved" }           // onboarding paid + business created — can sign in now
  | { kind: "rejected"; reason: string | null }
  | { kind: "still_processing" }   // poll budget exhausted, still awaiting_payment
  | { kind: "onboarding_delayed"; statusUnavailable: boolean }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export default function PaymentReturnScreen() {
  const params = useLocalSearchParams<{ id?: string; cancelled?: string; success?: string; phase?: string }>();
  const initialPhase = params.cancelled === "true"
    ? "cancelled"
    : params.success === "true" && params.phase === "onboarding" ? "onboarding" : "application";
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const routeActive = useRef(false);
  const activePoll = useRef<AbortController | null>(null);
  const appIdRef = useRef<string | null>(null);
  const activeCheckout = useRef<object | null>(null);
  const statusCheckInFlight = useRef(false);

  const [screen, setScreen] = useState<Screen>({ kind: "polling", attempt: 0 });
  const [receipts, setReceipts] = useState<Pick<BizAccountStatusResponse, "applicationPayment" | "onboardingPayment">>({});
  const [onboardingNotice, setOnboardingNotice] = useState<string | null>(null);
  const fees = useGetApplicationFees();
  const onboardingFee = fees.data && !fees.isError
    ? formatFee(fees.data.onboardingFeeCents, fees.data.currency)
    : null;

  useFocusEffect(useCallback(() => {
    routeActive.current = true;
    appIdRef.current = null;
    void runPollLoop(initialPhase);
    return () => {
      routeActive.current = false;
      activePoll.current?.abort();
      activeCheckout.current = null;
    };
  }, [params.id, initialPhase]));

  /**
   * Phase 2 #7: the new payment-return is a pure status reflector.
   *
   * The server already created the biz_account row before Stripe Checkout
   * opened, so we don't need a temp payload from AsyncStorage anymore. All we
   * need is the application id (from the route param, falling back to the
   * single-key AsyncStorage so cold-start after Stripe redirect still works).
   *
   * The Stripe webhook flips `awaiting_payment → pending`. There's a race
   * between Stripe redirecting the user back and Stripe POSTing our webhook,
   * so we poll up to POLL_BUDGET_MS. Terminal states:
   *  - pending  → success ("Application under review")
   *  - approved → admin was fast! (very unlikely but handled)
   *  - rejected → terminal, ask user to contact support
   *  - still awaiting_payment after budget → "payment is processing — check back"
   */
  async function runPollLoop(phase: "application" | "onboarding" | "cancelled") {
    if (!routeActive.current) return;
    activePoll.current?.abort();
    const controller = new AbortController();
    activePoll.current = controller;
    const isCurrent = () => routeActive.current && !controller.signal.aborted;

    let id: string | null;
    try {
      id = params.id ?? (await AsyncStorage.getItem(APP_ID_KEY));
    } catch {
      // A failed read is not a missing application or a failed payment. Keep
      // the saved identifier intact and offer a status-only retry.
      if (!isCurrent()) return;
      setScreen({
        kind: "error",
        message: "Could not read your saved application. Your payment status has not been confirmed. Please check your application status again. Do not submit another payment.",
      });
      return;
    }
    if (!isCurrent()) return;
    if (!id) {
      setScreen({ kind: "error", message: "No application id found. Please start over from the sign-up flow." });
      return;
    }
    appIdRef.current = id;

    const startedAt = Date.now();
    let attempt = 0;
    let statusUnavailable = false;
    while (Date.now() - startedAt < POLL_BUDGET_MS) {
      attempt += 1;
      setScreen({ kind: "polling", attempt });
      try {
        const status = await readStatusWithinBudget(
          id, POLL_BUDGET_MS - (Date.now() - startedAt), controller.signal,
        );
        // Status requests may finish after navigation or a newer check. Never
        // let an obsolete response change receipts, screen, or the saved id.
        if (!isCurrent()) return;
        statusUnavailable = false;
        setReceipts({ applicationPayment: status.applicationPayment, onboardingPayment: status.onboardingPayment });
        if (status.status === "approved") {
          await AsyncStorage.removeItem(APP_ID_KEY);
          if (!isCurrent()) return;
          setScreen({ kind: "approved" });
          return;
        }
        if (status.status === "rejected") {
          await AsyncStorage.removeItem(APP_ID_KEY);
          if (!isCurrent()) return;
          setScreen({ kind: "rejected", reason: null });
          return;
        }
        if (phase !== "onboarding") {
          if (status.status === "pending") {
            await AsyncStorage.removeItem(APP_ID_KEY);
            if (!isCurrent()) return;
            setScreen({ kind: "pending", meeting: toMeetingInfo(status) });
            return;
          }
          if (status.status === "accepted") {
            // Keep the stored id — the applicant needs it to launch the
            // onboarding-fee checkout (they can't log in until approved).
            if (phase === "cancelled") {
              setOnboardingNotice("Onboarding checkout was closed. Your application is still accepted. When you're ready, use the payment button below to resume checkout.");
            }
            setScreen({ kind: "accepted", meeting: toMeetingInfo(status) });
            return;
          }
          if (phase === "cancelled" && status.status === "awaiting_payment") {
            setScreen({ kind: "cancelled" });
            return;
          }
        }
        // application phase: still awaiting_payment — keep polling.
        // onboarding phase: still accepted (webhook not landed) — keep polling.
      } catch (e: any) {
        if (!isCurrent()) return;
        statusUnavailable = true;
        if (phase === "cancelled") {
          // Do not guess the payment stage or offer payment on stale acceptance.
          setScreen({ kind: "error", message: "Could not refresh your application status. Your application has been kept. Check its status before continuing." });
          return;
        }
        // Transient network errors: keep polling rather than bail. We surface a
        // hard error only after the budget is exhausted.
      }
      const remaining = POLL_BUDGET_MS - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await sleep(Math.min(POLL_INTERVAL_MS, remaining), controller.signal);
      if (!isCurrent()) return;
    }
    // Acceptance is not proof that checkout is unpaid: the webhook may be late,
    // or status reads may have failed. Only offer a status check, never payment.
    setScreen(
      phase === "onboarding"
        ? { kind: "onboarding_delayed", statusUnavailable }
        : statusUnavailable
          ? { kind: "error", message: "Could not refresh your application status. Your application has been kept. Check its status before continuing." }
          : { kind: "still_processing" },
    );
  }

  async function handleCheckOnboardingStatus() {
    if (statusCheckInFlight.current) return;
    statusCheckInFlight.current = true;
    setScreen({ kind: "polling", attempt: 0 });
    try {
      // Preserve the onboarding phase even if the server still says accepted.
      // Checking status must not create or reopen a checkout.
      await runPollLoop("onboarding");
    } finally {
      statusCheckInFlight.current = false;
    }
  }

  /**
   * Launch the $2 onboarding-fee Stripe Checkout. Public endpoint — the
   * application id is the capability token (applicants can't log in until
   * approved). On completion the webhook flips accepted → approved + creates the
   * business row, which our resumed poll loop will observe.
   */
  async function handlePayOnboarding() {
    if (!routeActive.current || activeCheckout.current || !onboardingFee || !fees.data || fees.isFetching) return;
    // State updates are batched: lock synchronously before any work can yield.
    const owner = {};
    activeCheckout.current = owner;
    // Focus alone is insufficient if the applicant leaves and then returns.
    const isCurrent = () => routeActive.current && activeCheckout.current === owner;
    // Capture the offer from this render, before storage/network work can yield.
    // A later pricing refresh must never silently change the amount submitted.
    const expectedOnboardingFeeCents = fees.data.onboardingFeeCents;
    try {
      const id = appIdRef.current ?? params.id ?? (await AsyncStorage.getItem(APP_ID_KEY));
      if (!isCurrent()) return;
      if (!id) {
        setScreen({ kind: "error", message: "No application id found. Please start over from the sign-up flow." });
        return;
      }
      setScreen({ kind: "starting_onboarding" });
      setOnboardingNotice(null);
      const result = await createOnboardingCheckout(id, { expectedOnboardingFeeCents });
      if (!isCurrent()) return;
      if (Platform.OS === "web") {
        const opened = (window as any).open(result.checkoutUrl, "_blank", "noopener,noreferrer");
        if (!opened) {
          (window as any).location.href = result.checkoutUrl;
          return;
        }
      } else {
        const browserResult = await WebBrowser.openAuthSessionAsync(result.checkoutUrl, null);
        if (!isCurrent()) return;
        if (browserResult.type === "cancel" || browserResult.type === "dismiss") {
          await runPollLoop("cancelled");
          return;
        }
      }
      await runPollLoop("onboarding");
    } catch (e: any) {
      if (!isCurrent()) return;
      if (e instanceof ApiError && e.status === 409) {
        setOnboardingNotice("The fee or application status has changed. Review the updated details before paying.");
        await fees.refetch();
        if (!isCurrent()) return;
        await runPollLoop("application");
        return;
      }
      setScreen({ kind: "error", message: "Could not start the onboarding payment. Please try again." });
    } finally {
      if (activeCheckout.current === owner) activeCheckout.current = null;
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 32 }]}>
      {screen.kind === "polling" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#5C6BC020" }]}>
            <Feather name="loader" size={40} color="#5C6BC0" />
          </View>
          <Text style={styles.title}>Confirming your payment…</Text>
          <Text style={styles.desc}>
            Stripe is letting us know your payment was received. This usually takes just a few seconds.
          </Text>
          <Text style={[styles.desc, { fontSize: 12, opacity: 0.5 }]}>Check {screen.attempt}…</Text>
        </View>
      )}

      {screen.kind === "pending" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#B39DDB20" }]}>
            <Feather name="check-circle" size={44} color="#B39DDB" />
          </View>
          <Text style={styles.title}>Application received!</Text>
          <Text style={styles.desc}>
            Your application fee has been received. The next step is a short interview — we'll reach out to schedule it. Once you're accepted, you'll pay {onboardingFee ? `the ${onboardingFee} onboarding fee` : "the onboarding fee"} to activate your account.
          </Text>

          <MeetingBox meeting={screen.meeting} accent="#5C6BC0" bg="rgba(92,107,192,0.12)" border="rgba(92,107,192,0.4)" />

          <View style={[styles.infoBox, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.12)" }]}>
            <Feather name="mail" size={15} color="rgba(255,255,255,0.5)" />
            <Text style={styles.infoText}>Questions? Email us at{"\n"}support@akodd.com</Text>
          </View>

          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Feather name="log-in" size={18} color="#fff" />
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "accepted" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#FFB30020" }]}>
            <Feather name="award" size={44} color="#FFB300" />
          </View>
          <Text style={styles.title}>You're accepted!</Text>
          {onboardingNotice && <Text style={styles.desc}>{onboardingNotice}</Text>}
          <Text style={styles.desc}>
            Congratulations — your application was accepted after the interview. Pay {onboardingFee ? `the one-time ${onboardingFee} onboarding fee` : "the one-time onboarding fee"} to activate your provider account and go live on AK On Demand.
          </Text>

          <MeetingBox meeting={screen.meeting} accent="#FFB300" bg="rgba(255,179,0,0.1)" border="rgba(255,179,0,0.35)" />

          {fees.isError && (
            <TouchableOpacity onPress={() => void fees.refetch()}>
              <Text style={styles.desc}>Could not load fees. Tap to retry.</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#FFB300", opacity: !onboardingFee || fees.isFetching ? 0.7 : 1 }]} disabled={!onboardingFee || fees.isFetching} onPress={() => void handlePayOnboarding()} activeOpacity={0.85}>
            <Feather name="credit-card" size={18} color="#0F1B2D" />
            <Text style={[styles.btnText, { color: "#0F1B2D" }]}>{onboardingFee ? `Pay ${onboardingFee} onboarding fee` : "Loading onboarding fee…"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "rgba(255,255,255,0.08)", marginTop: 0 }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "starting_onboarding" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#FFB30020" }]}>
            <Feather name="loader" size={40} color="#FFB300" />
          </View>
          <Text style={styles.title}>Opening secure checkout…</Text>
          <Text style={styles.desc}>
            We're sending you to Stripe to pay the onboarding fee. Complete it in the browser, then return here.
          </Text>
        </View>
      )}

      {screen.kind === "approved" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#B39DDB20" }]}>
            <Feather name="check-circle" size={44} color="#B39DDB" />
          </View>
          <Text style={styles.title}>You're all set!</Text>
          <Text style={styles.desc}>
            Your onboarding fee has been received and your provider account is active. Sign in now to set up your business profile and create your listings.
          </Text>

          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Feather name="log-in" size={18} color="#fff" />
            <Text style={styles.btnText}>Sign in</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "onboarding_delayed" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#FFB30020" }]}>
            <Feather name="clock" size={44} color="#FFB300" />
          </View>
          <Text style={styles.title}>Onboarding payment confirmation is delayed</Text>
          <Text style={styles.desc}>
            {screen.statusUnavailable
              ? "We couldn't refresh your payment status. Check your connection and try checking again."
              : "We haven't received confirmation of your onboarding payment yet. It may still be processing."}
          </Text>
          <Text style={styles.desc}>
            Please don't pay again while we confirm your first payment. Wait a minute or two, then check its status below.
          </Text>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => void handleCheckOnboardingStatus()} activeOpacity={0.85}>
            <Feather name="refresh-cw" size={18} color="#fff" />
            <Text style={styles.btnText}>Check payment status</Text>
          </TouchableOpacity>
          <View style={[styles.infoBox, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.12)" }]}>
            <Feather name="mail" size={15} color="rgba(255,255,255,0.5)" />
            <Text style={styles.infoText}>Still waiting? Contact support at{"\n"}support@akodd.com</Text>
          </View>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "rgba(255,255,255,0.08)", marginTop: 0 }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "still_processing" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#FFB30020" }]}>
            <Feather name="clock" size={44} color="#FFB300" />
          </View>
          <Text style={styles.title}>Payment is still processing</Text>
          <Text style={styles.desc}>
            Stripe hasn't confirmed your payment yet. This is usually quick — please try signing in again in a minute or two. If your card was charged, your application is on its way.
          </Text>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Feather name="arrow-left" size={18} color="#fff" />
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "rejected" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#F4433620" }]}>
            <Feather name="x-circle" size={44} color="#F44336" />
          </View>
          <Text style={styles.title}>Application not approved</Text>
          <Text style={styles.desc}>
            Unfortunately your application was not approved. The application fee is non-refundable per our terms. Please contact support if you have questions.
          </Text>
          {screen.reason ? (
            <View style={[styles.infoBox, { backgroundColor: "rgba(244,67,54,0.08)", borderColor: "rgba(244,67,54,0.25)" }]}>
              <Feather name="info" size={15} color="#F44336" />
              <Text style={styles.infoText}>{screen.reason}</Text>
            </View>
          ) : null}
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Feather name="arrow-left" size={18} color="#fff" />
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "cancelled" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#FFB30020" }]}>
            <Feather name="x-circle" size={44} color="#FFB300" />
          </View>
          <Text style={styles.title}>Payment cancelled</Text>
          <Text style={styles.desc}>
            Application checkout was closed before payment was confirmed. You can return to the login screen to continue your application.
          </Text>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Feather name="arrow-left" size={18} color="#fff" />
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen.kind === "error" && (
        <View style={styles.content}>
          <View style={[styles.iconCircle, { backgroundColor: "#F4433620" }]}>
            <Feather name="alert-circle" size={44} color="#F44336" />
          </View>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.desc}>{screen.message}</Text>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => void runPollLoop(initialPhase)} activeOpacity={0.85}>
            <Text style={styles.btnText}>Check application status</Text>
          </TouchableOpacity>
          <View style={[styles.infoBox, { backgroundColor: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.12)" }]}>
            <Feather name="mail" size={15} color="#F44336" />
            <Text style={styles.infoText}>Contact support at{"\n"}support@akodd.com</Text>
          </View>
          <TouchableOpacity style={[styles.btn, { backgroundColor: "#5C6BC0" }]} onPress={() => router.replace("/login")} activeOpacity={0.85}>
            <Feather name="arrow-left" size={18} color="#fff" />
            <Text style={styles.btnText}>Back to Login</Text>
          </TouchableOpacity>
        </View>
      )}
      {["pending", "accepted", "approved", "rejected"].includes(screen.kind) && (
        <View>
          {receipts.applicationPayment && (
            <Text style={styles.desc}>
              Application fee paid: {formatFee(receipts.applicationPayment.amountCents, receipts.applicationPayment.currency)}
            </Text>
          )}
          {receipts.onboardingPayment && (
            <Text style={styles.desc}>
              Onboarding fee paid: {formatFee(receipts.onboardingPayment.amountCents, receipts.onboardingPayment.currency)}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

type MeetingInfo = {
  at: string | null;
  location: string | null;
  durationMinutes: number | null;
};

/** Pull the meeting details out of a status response. */
function toMeetingInfo(status: {
  meetingAt?: unknown;
  meetingLocation?: string | null;
  meetingDurationMinutes?: number | null;
}): MeetingInfo {
  return {
    at: toIso(status.meetingAt),
    location: status.meetingLocation ?? null,
    durationMinutes: status.meetingDurationMinutes ?? null,
  };
}

/** Interview time + where to go + how long it runs, when scheduled. */
function MeetingBox({
  meeting,
  accent,
  bg,
  border,
}: {
  meeting: MeetingInfo;
  accent: string;
  bg: string;
  border: string;
}) {
  if (!meeting.at) return null;
  return (
    <View style={[styles.infoBox, { backgroundColor: bg, borderColor: border, alignItems: "flex-start" }]}>
      <Feather name="calendar" size={15} color={accent} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={styles.infoText}>
          Your in-person meeting is scheduled for{"\n"}
          <Text style={{ color: "#fff", fontWeight: "700" }}>{fmtMeeting(meeting.at)}</Text>
          {meeting.durationMinutes ? ` (${fmtDuration(meeting.durationMinutes)})` : ""}
        </Text>
        {meeting.location ? (
          <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
            <Feather name="map-pin" size={13} color={accent} style={{ marginTop: 3 }} />
            <Text style={[styles.infoText, { color: "#fff", fontWeight: "600" }]}>{meeting.location}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** "1 hour", "90 minutes", "2 hours 15 minutes". */
function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} minutes`;
  const hours = `${h} ${h === 1 ? "hour" : "hours"}`;
  return m === 0 ? hours : `${hours} ${m} minutes`;
}

/** Normalize the API's meetingAt (Date | string | null) to an ISO string or null. */
function toIso(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  return null;
}

/** "Tuesday, Aug 4 at 2:30 PM" in the device's local timezone. */
function fmtMeeting(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return `${date} at ${time}`;
}

/** Bound the entire GET (including response parsing), even if abort is ignored. */
async function readStatusWithinBudget(id: string, remainingMs: number, signal: AbortSignal) {
  const request = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      reject(new Error("Payment status request cancelled"));
      request.abort();
    };
    signal.addEventListener("abort", cancel, { once: true });
    timer = setTimeout(() => {
      reject(new Error("Payment status polling budget exhausted"));
      request.abort();
    }, Math.max(0, remainingMs));
    if (signal.aborted) cancel();
  });
  try {
    // Promise.race consumes late results/rejections without letting them update
    // receipts, remove the saved application id, or overwrite a newer check.
    return await Promise.race([
      deadline,
      getBizAccountStatus(id, { signal: request.signal }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0F1B2D",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
  },
  content: { alignItems: "center", gap: 16, width: "100%" },
  iconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  title: { color: "#fff", fontSize: 22, fontWeight: "700", textAlign: "center" },
  desc: { color: "rgba(255,255,255,0.6)", fontSize: 15, lineHeight: 24, textAlign: "center" },
  infoBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    width: "100%",
  },
  infoText: { color: "rgba(255,255,255,0.55)", fontSize: 12, lineHeight: 20, flex: 1 },
  btn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 16,
    borderRadius: 16,
    width: "100%",
    marginTop: 8,
  },
  btnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
