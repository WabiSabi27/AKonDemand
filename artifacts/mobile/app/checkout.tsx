/**
 * Customer checkout — Stripe destination-charge flow (Phase 2 #6).
 *
 * Flow:
 *   1. POST /bookings/payment-intent → creates draft booking + PI on the
 *      platform with `transfer_data.destination` = SP's Connect account and
 *      `application_fee_amount` = 8% of subtotal.
 *   2. Initialize Stripe PaymentSheet with the returned client_secret.
 *   3. Present PaymentSheet → on success, refresh listBookings (the row is
 *      already there in `pending`) and route the user to their bookings tab.
 *   4. If the user cancels PaymentSheet, our webhook (payment_intent.canceled)
 *      drops the draft row a few seconds later — we just go back.
 *
 * Hard-blocks if `business.stripePayoutsEnabled` is false (provider hasn't
 * finished Connect onboarding) — Book Now button shows a "Setup pending"
 * disabled state instead of opening PaymentSheet, matching the server's 409.
 */

import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StripeProvider, useStripe } from "@/utils/stripeNative";
import { useQueryClient } from "@tanstack/react-query";

import {
  getGetAvailabilityQueryKey,
  getListBookingsQueryKey,
  useGetAvailability,
  useCreateBookingPaymentIntent,
} from "@workspace/api-client-react";

import { calculateFees, useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { BRAND } from "@/constants/colors";
import { describePolicy, policyFromBusiness } from "@/utils/cancellationPolicy";
import { apiGet } from "@/utils/api";
import {
  formatDateMMDDYY,
  minutesToTimeLabel,
  minutesToTimeStr,
  parseDurationMinutes,
  pickCustomerSlots,
  timeStrToMinutes,
} from "@/utils/specialties";

/** Local-time YMD ("YYYY-MM-DD"). Avoids `toISOString()` which would shift to
 *  UTC and roll the date over in negative-offset US timezones (Alaska). */
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Lazily fetch the platform publishable key once per session. We can't put
 *  StripeProvider at the root because we need the live key from /api/stripe/config
 *  (it differs across test/live environments). */
function usePublishableKey() {
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<{ publishableKey: string }>("/stripe/config")
      .then((r) => { if (!cancelled) setKey(r.publishableKey); })
      .catch((e) => { if (!cancelled) setError(e?.message ?? "Could not load Stripe config"); });
    return () => { cancelled = true; };
  }, []);
  return { key, error };
}

export default function CheckoutScreen() {
  const { key: publishableKey, error: pkError } = usePublishableKey();
  if (pkError) {
    return (
      <View style={styles.center}>
        <Text>Could not load payment config: {pkError}</Text>
      </View>
    );
  }
  if (!publishableKey) {
    return <View style={styles.center} />;
  }
  return (
    <StripeProvider publishableKey={publishableKey} merchantIdentifier="merchant.com.akondemand">
      <CheckoutScreenInner />
    </StripeProvider>
  );
}

function CheckoutScreenInner() {
  // `date` (YYYY-MM-DD) and `time` (HH:MM) are optional pre-selections handed
  // off from the service-detail screen when the customer taps a specific
  // time-slot's Book Now pill — they expect to land on checkout with that
  // exact slot already locked in, not have to re-pick.
  const { serviceId, optionId, date: dateParam, time: timeParam } =
    useLocalSearchParams<{ serviceId: string; optionId: string; date?: string; time?: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { services, businesses, user } = useApp();
  const queryClient = useQueryClient();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const createPI = useCreateBookingPaymentIntent();

  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  const service = services.find((s) => s.id === serviceId);
  const option = service?.options.find((o) => o.id === optionId) ?? service?.options[0] ?? null;
  const business = service ? businesses.find((b) => b.id === service.businessId) : null;

  // The date+time pickers were removed from this screen; both arrive only
  // via URL params from the service-detail handoff. We accept any valid
  // `YYYY-MM-DD` (NOT constrained to a rolling 7-day window) so a future
  // date the SP exposes on service-detail can't get silently rewritten to
  // today on this screen. Falls back to today only when no param was
  // supplied at all (e.g. deep link to an ongoing service).
  const selectedDateYmd = React.useMemo(() => {
    if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) return dateParam;
    return todayYmd();
  }, [dateParam]);
  const initialTimeMin = React.useMemo(() => {
    if (!timeParam || !/^\d{2}:\d{2}$/.test(timeParam)) return null;
    return timeStrToMinutes(timeParam);
  }, [timeParam]);
  const [selectedTimeMin, setSelectedTimeMin] = useState<number | null>(initialTimeMin);
  const [notes, setNotes] = useState("");
  const [paying, setPaying] = useState(false);

  // Server-computed availability (T006e).
  const availParams = { serviceId: serviceId ?? "", date: selectedDateYmd };
  const availQ = useGetAvailability(availParams, {
    query: { queryKey: getGetAvailabilityQueryKey(availParams), enabled: !!serviceId },
  });

  const slotInfo = useMemo(() => {
    if (!service || !option) {
      return {
        slots: [] as { startMin: number; remaining: number; blocked: boolean }[],
        capacity: 0,
        durationMin: null as number | null,
        requiredSpec: undefined as string | undefined,
        allDayBlocked: false,
        noStaff: false,
      };
    }
    const durationMin = parseDurationMinutes(option.duration);
    const requiredSpec = service.requiredSpecialty?.trim() || undefined;
    const capacity = availQ.data?.capacity ?? 0;
    const rawServerSlots = availQ.data?.slots ?? [];
    const noStaff = !!requiredSpec && capacity === 0;
    const optionPinnedStart =
      option.defaultStartTime?.trim() && /^\d{2}:\d{2}$/.test(option.defaultStartTime.trim())
        ? option.defaultStartTime.trim()
        : durationMin !== null && durationMin >= 8 * 60
          ? "08:00"
          : null;
    // For finite-duration sub-full-day options, this collapses the 30-min grid
    // down to one AM slot + one PM slot (see pickCustomerSlots docstring).
    const serverSlots = pickCustomerSlots(rawServerSlots, durationMin, optionPinnedStart);
    const slots = serverSlots.map((s) => ({
      startMin: timeStrToMinutes(s.time),
      remaining: s.remaining,
      blocked: s.reason === "blocked",
    }));
    const allDayBlocked =
      !availQ.isLoading
      && !availQ.isError
      && durationMin !== null
      && !noStaff
      && serverSlots.length === 0;
    return { slots, capacity, durationMin, requiredSpec, allDayBlocked, noStaff };
  }, [service, option, availQ.data, availQ.isLoading, availQ.isError]);

  // Validate (but never silently rewrite) the time the customer handed off
  // from service-detail. If the slot is no longer bookable — sold out,
  // blocked, or simply not in the live slot list anymore — we clear it so
  // `canBook` flips to false and the "Time slot unavailable" notice below
  // explains the situation. We deliberately do NOT auto-fall-back to first-
  // available: that would charge the customer for a different slot than
  // the one they tapped, which is exactly what the architect flagged.
  React.useEffect(() => {
    if (selectedTimeMin === null) return;
    if (availQ.isLoading || availQ.isError || slotInfo.slots.length === 0) return;
    const stillValid = slotInfo.slots.find(
      (s) => s.startMin === selectedTimeMin && s.remaining > 0 && !s.blocked,
    );
    if (!stillValid) setSelectedTimeMin(null);
  }, [slotInfo.slots, selectedTimeMin, availQ.isLoading, availQ.isError]);

  if (!service || !option) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.mutedForeground }}>Service not found.</Text>
      </View>
    );
  }

  const { platformFee, total } = calculateFees(option.price);
  // For finite-duration jobs surface the full window (start – end) so the
  // confirmation Alert and any inline copy show the customer exactly when
  // they're booking the provider for, not just when they arrive.
  const selectedTimeLabel = selectedTimeMin !== null
    ? slotInfo.durationMin !== null
      ? `${minutesToTimeLabel(selectedTimeMin)} – ${minutesToTimeLabel(selectedTimeMin + slotInfo.durationMin)}`
      : minutesToTimeLabel(selectedTimeMin)
    : "Contact provider";
  const isOngoing = slotInfo.durationMin === null;

  // Phase 2 #6 — hard-block when SP hasn't finished Stripe Connect onboarding.
  // The server returns 409 in this case anyway; we surface a clear UI so the
  // customer doesn't think they did something wrong.
  const providerPayable = !!business?.stripePayoutsEnabled;

  // Phase 3 #3 — vacation mode. Server returns no slots + a `vacation` block
  // on the date inside the window; mirror that here so the button is disabled
  // and we can show the SP's custom OOO message above the time picker.
  const vacationBlock = availQ.data?.vacation ?? null;

  // For finite services, require availability to have *successfully* loaded
  // before the customer can pay — that's what proves `selectedTimeMin` was
  // re-validated against the live slot list (the auto-clear effect only
  // runs once availQ resolves). Without this gate a fast tap on Pay during
  // the initial load could create a payment intent for a stale slot the
  // server might no longer accept. Ongoing services have no slot list, so
  // they don't need to wait.
  const availabilityReady = isOngoing || (!availQ.isLoading && !availQ.isError);
  const canBook =
    providerPayable
    && availabilityReady
    && !slotInfo.noStaff
    && !slotInfo.allDayBlocked
    && !vacationBlock
    && (isOngoing || selectedTimeMin !== null);

  /**
   * Footer-only commit point. The pill-as-button onPress shortcut from the
   * previous UX iteration is gone (no time pills on this screen anymore),
   * so the `slotStartMin` parameter that fed that fast-path was retired
   * with it — `selectedTimeMin` is the single source of truth.
   */
  async function handleConfirm() {
    if (!service || !option) return;
    const effectiveStartMin = selectedTimeMin;
    if (!user) {
      Alert.alert(
        "Sign In Required",
        "Create a free account or sign in to complete your booking.",
        [
          { text: "Cancel", style: "cancel" },
          { text: "Sign In", onPress: () => router.push("/login") },
        ]
      );
      return;
    }
    if (!providerPayable) {
      Alert.alert(
        "Provider Not Ready",
        "This provider hasn't finished setting up payouts yet. Please choose another provider or check back soon.",
      );
      return;
    }
    const haveStart = effectiveStartMin !== null || isOngoing;
    const otherwiseBlocked = slotInfo.noStaff || slotInfo.allDayBlocked || !!vacationBlock || !providerPayable;
    if (!haveStart || otherwiseBlocked) {
      Alert.alert("Unavailable", "Please pick an available time slot.");
      return;
    }
    // Defense in depth: even though `canBook` already gates the button, an
    // in-flight or errored availability query means we can't confirm the
    // seeded slot is still bookable — refuse to charge until it resolves.
    if (!isOngoing && (availQ.isLoading || availQ.isError)) {
      Alert.alert(
        availQ.isLoading ? "Still loading" : "Couldn't check availability",
        availQ.isLoading
          ? "Hang on a moment — we're double-checking that slot is still open."
          : "We couldn't verify that this slot is still available. Please try again.",
      );
      return;
    }

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setPaying(true);

    const scheduledTime24 = effectiveStartMin !== null ? minutesToTimeStr(effectiveStartMin) : null;

    try {
      // 1. Create the destination-charge PaymentIntent + draft booking.
      const intent = await createPI.mutateAsync({
        data: {
          serviceId: service.id,
          optionId: option.id,
          scheduledDate: selectedDateYmd,
          scheduledTime: scheduledTime24,
        },
      });

      // 2. Hand the client secret to Stripe PaymentSheet.
      const init = await initPaymentSheet({
        merchantDisplayName: "AK On Demand",
        paymentIntentClientSecret: intent.clientSecret,
        customerId: intent.customerId,
        allowsDelayedPaymentMethods: false,
        defaultBillingDetails: {
          email: user.email,
          name: user.name ?? undefined,
        },
        returnURL: "mobile://payment-return",
      });
      if (init.error) throw new Error(init.error.message);

      const { error } = await presentPaymentSheet();
      if (error) {
        // User cancelled or card declined. The webhook will clean up the draft
        // booking row server-side (payment_intent.canceled / failed handler).
        if (error.code !== "Canceled") {
          Alert.alert("Payment failed", error.message);
        }
        return;
      }

      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      // The booking row already exists in `pending` — refresh the list and
      // bounce to /bookings.
      await queryClient.invalidateQueries({ queryKey: getListBookingsQueryKey() });

      // Build the confirmation window from `effectiveStartMin` (the slot we
      // actually paid for) rather than `selectedTimeLabel` — the latter could
      // be a render behind when the user tapped a pill that wasn't the
      // currently-selected one.
      const confirmTimeLabel = effectiveStartMin !== null
        ? slotInfo.durationMin !== null
          ? `${minutesToTimeLabel(effectiveStartMin)} – ${minutesToTimeLabel(effectiveStartMin + slotInfo.durationMin)}`
          : minutesToTimeLabel(effectiveStartMin)
        : null;
      Alert.alert(
        "Payment received!",
        `Your booking for ${service.title} on ${formatDateMMDDYY(selectedDateYmd)}${confirmTimeLabel ? ` at ${confirmTimeLabel}` : ""} was sent to ${service.businessName}. You'll get a notification when they confirm.\n\nTotal: $${total.toFixed(2)}`,
        [
          { text: "View Bookings", onPress: () => router.replace("/(tabs)/bookings") },
          { text: "Done", onPress: () => router.replace("/") },
        ]
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong. Please try again.";
      Alert.alert("Booking failed", msg);
    } finally {
      setPaying(false);
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Checkout" />

      <KeyboardAwareScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, { paddingBottom: bottomInset + 200 }]}
        keyboardShouldPersistTaps="handled"
        enableOnAndroid
        enableAutomaticScroll
        extraScrollHeight={80}
        keyboardOpeningTime={0}
      >
        {/* Cart.
         *
         * Date + time selection used to live below this card as their own
         * pickers. Per UX update they're now picked entirely on the previous
         * screen (service detail's per-row Book Now pills) and arrive here as
         * `?date=…&time=…` URL params, so the cart shows them as a read-only
         * "When" row instead. If for any reason the screen was reached
         * without those params (deep link, ongoing service, etc.) the
         * fallbacks below still resolve to a sensible value. */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.cartHeader}>
            <Feather name="shopping-cart" size={16} color={BRAND.redViolet} />
            <Text style={[styles.cartLabel, { color: BRAND.redViolet }]}>Your Cart</Text>
          </View>
          <View style={styles.serviceRow}>
            <View style={[styles.serviceIconWrap, { backgroundColor: BRAND.redViolet + "18" }]}>
              <Feather name="briefcase" size={24} color={BRAND.redViolet} />
            </View>
            <View style={styles.serviceInfo}>
              <Text style={[styles.serviceTitle, { color: colors.foreground }]}>{service.title}</Text>
              <Text style={[styles.serviceBiz, { color: colors.mutedForeground }]}>{service.businessName}</Text>
            </View>
          </View>
          <View style={[styles.optionPill, { backgroundColor: BRAND.redViolet + "14", borderColor: BRAND.redViolet + "40" }]}>
            <Feather name="check-circle" size={14} color={BRAND.redViolet} />
            <Text style={[styles.optionPillText, { color: BRAND.redViolet }]}>{option.name}</Text>
            <Text style={[styles.optionDuration, { color: colors.mutedForeground }]}>· {option.duration}</Text>
          </View>
          {slotInfo.requiredSpec && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, marginTop: 10 }}>
              <Feather name="award" size={13} color="#5C6BC0" />
              <Text style={{ fontSize: 12, color: "#5C6BC0", fontWeight: "700" }}>
                Specialty required: {slotInfo.requiredSpec}
              </Text>
            </View>
          )}

          {/* Read-only When row */}
          <View style={[styles.whenRow, { borderTopColor: colors.border }]}>
            <Feather name="calendar" size={14} color={colors.mutedForeground} />
            <Text style={[styles.whenLabel, { color: colors.mutedForeground }]}>When</Text>
            <Text style={[styles.whenValue, { color: colors.foreground }]}>
              {formatDateMMDDYY(selectedDateYmd)} · {selectedTimeLabel}
            </Text>
          </View>
        </View>

        {/* Provider-not-ready banner (Phase 2 #6) */}
        {!providerPayable && (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 12 }]}>
            <Feather name="alert-triangle" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>
              This provider hasn't finished setting up payouts yet. Bookings are temporarily disabled.
            </Text>
          </View>
        )}

        {/* Status notices.
         *
         * The interactive date/time pickers are gone, but these contextual
         * banners are still useful: they tell the customer WHY the Pay button
         * is disabled when something's off (no qualified staff for the
         * specialty, vacation, all-day blocked, server error). For ongoing
         * services we surface the "provider will contact you" hint here too.
         */}
        {slotInfo.noStaff ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 12 }]}>
            <Feather name="user-x" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>
              No employee with the {slotInfo.requiredSpec} specialty is currently available.
            </Text>
          </View>
        ) : availQ.isError ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 12 }]}>
            <Feather name="alert-circle" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>Could not load availability. Please try again.</Text>
          </View>
        ) : vacationBlock ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 12 }]}>
            <Feather name="umbrella" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>
              {vacationBlock.message
                || `${business?.name ?? "Provider"} is on vacation through ${vacationBlock.until}. Please go back and pick a date after the window or check back later.`}
            </Text>
          </View>
        ) : isOngoing ? (
          <View style={[styles.notice, { backgroundColor: colors.secondary, marginTop: 12 }]}>
            <Feather name="info" size={15} color={colors.mutedForeground} />
            <Text style={[styles.noticeText, { color: colors.mutedForeground }]}>
              This is an ongoing service ({option.duration}). Provider will contact you to schedule.
            </Text>
          </View>
        ) : slotInfo.allDayBlocked ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 12 }]}>
            <Feather name="x-circle" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>
              Provider is unavailable on {formatDateMMDDYY(selectedDateYmd)}. Please go back and pick another date.
            </Text>
          </View>
        ) : (!isOngoing && selectedTimeMin === null && !availQ.isLoading) ? (
          <View style={[styles.notice, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 12 }]}>
            <Feather name="clock" size={15} color={colors.destructive} />
            <Text style={[styles.noticeText, { color: colors.destructive }]}>
              {timeParam
                ? "That time slot is no longer available. Please go back and pick another time."
                : "No time was selected. Please go back and tap a Book Now pill on the service screen."}
            </Text>
          </View>
        ) : null}

        {/* Notes */}
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Notes for Provider</Text>
        <View style={[styles.notesWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[styles.notesInput, { color: colors.foreground }]}
            placeholder="Any special instructions or details…"
            placeholderTextColor={colors.mutedForeground}
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
          />
        </View>

        {/* Price Breakdown */}
        <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Price Breakdown</Text>
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={styles.priceRow}>
            <Text style={[styles.priceLabel, { color: colors.mutedForeground }]}>Service ({option.name})</Text>
            <Text style={[styles.priceValue, { color: colors.foreground }]}>${option.price.toFixed(2)}</Text>
          </View>
          <View style={styles.priceRow}>
            <Text style={[styles.priceLabel, { color: colors.mutedForeground }]}>Platform fee (8%)</Text>
            <Text style={[styles.priceValue, { color: colors.mutedForeground }]}>${platformFee.toFixed(2)}</Text>
          </View>
          <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.totalLabel, { color: colors.foreground }]}>Total Due</Text>
            <Text style={[styles.totalValue, { color: BRAND.redViolet }]}>${total.toFixed(2)}</Text>
          </View>
        </View>

        {/* Phase 3 #7 — last chance to see the cancellation policy before paying. */}
        {business && (
          <View style={[
            styles.policyRow,
            { backgroundColor: colors.card, borderColor: colors.border },
          ]}>
            <Feather name="rotate-ccw" size={14} color={colors.mutedForeground} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.policyTitle, { color: colors.foreground }]}>Cancellation policy</Text>
              <Text style={[styles.policyText, { color: colors.mutedForeground }]}>
                {describePolicy(policyFromBusiness(business))}
              </Text>
            </View>
          </View>
        )}
      </KeyboardAwareScrollView>

      {/* Sticky Footer.
       *
       * Now the only commit point on the screen — date + time pickers and the
       * pill-as-button shortcut both got removed in favor of "pick on
       * service detail, pay here". The Pay CTA always renders (the previous
       * "Tap a time above" hint variant is gone since there's nothing above
       * to tap). `canBook` already covers the not-signed-in / provider-not-
       * payable / no-staff / vacation / all-day-blocked gates.
       */}
      <View style={[styles.footer, { backgroundColor: colors.card, borderTopColor: colors.border, paddingBottom: bottomInset + 12 }]}>
        <View style={styles.footerSummary}>
          <Text style={[styles.footerDate, { color: colors.mutedForeground }]}>
            {formatDateMMDDYY(selectedDateYmd)} · {selectedTimeLabel}
          </Text>
          <Text style={[styles.footerTotal, { color: BRAND.redViolet }]}>${total.toFixed(2)}</Text>
        </View>
        <TouchableOpacity
          style={[styles.confirmBtn, { backgroundColor: canBook ? BRAND.redViolet : colors.mutedForeground, opacity: paying ? 0.7 : 1 }]}
          onPress={() => { void handleConfirm(); }}
          disabled={paying || !canBook}
          activeOpacity={0.85}
        >
          <Feather name={user ? (providerPayable ? "credit-card" : "alert-triangle") : "log-in"} size={18} color="#fff" />
          <Text style={styles.confirmBtnText}>
            {paying
              ? "Processing…"
              : !providerPayable
                ? "Provider setup pending"
                : !user
                  ? "Sign In to Book"
                  : !canBook
                    ? "Unavailable"
                    : `Pay $${total.toFixed(2)}`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, textAlign: "center", fontSize: 18, fontWeight: "800" },
  headerSpacer: { width: 40 },
  scroll: { padding: 20, gap: 4 },
  card: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 4 },
  cartHeader: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 },
  cartLabel: { fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  serviceRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 12 },
  serviceIconWrap: { width: 48, height: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  serviceInfo: { flex: 1 },
  serviceTitle: { fontSize: 15, fontWeight: "800" },
  serviceBiz: { fontSize: 12, marginTop: 2 },
  optionPill: { flexDirection: "row", alignItems: "center", gap: 6, alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1 },
  optionPillText: { fontSize: 12, fontWeight: "700" },
  optionDuration: { fontSize: 12 },
  sectionTitle: { fontSize: 15, fontWeight: "800", marginTop: 16, marginBottom: 10 },
  whenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  whenLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", letterSpacing: 0.4 },
  whenValue: { flex: 1, fontSize: 12, fontWeight: "700", textAlign: "right" },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12, borderRadius: 12, borderWidth: 1 },
  noticeText: { flex: 1, fontSize: 12, fontWeight: "600", lineHeight: 18 },
  notesWrap: { borderRadius: 14, borderWidth: 1, padding: 14 },
  notesInput: { fontSize: 15, lineHeight: 22, minHeight: 72 },
  priceRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 6 },
  priceLabel: { fontSize: 15 },
  priceValue: { fontSize: 15, fontWeight: "600" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, paddingTop: 10, marginTop: 6 },
  totalLabel: { fontSize: 15, fontWeight: "800" },
  totalValue: { fontSize: 22, fontWeight: "700" },
  footer: { position: "absolute", bottom: 0, left: 0, right: 0, padding: 16, borderTopWidth: 1, gap: 12 },
  footerSummary: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  footerDate: { fontSize: 12 },
  footerTotal: { fontSize: 18, fontWeight: "700" },
  policyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 14,
  },
  policyTitle: { fontSize: 12, fontWeight: "700", marginBottom: 3 },
  policyText: { fontSize: 12, lineHeight: 17, fontWeight: "500" },
  confirmBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingVertical: 16, borderRadius: 14 },
  confirmBtnText: { color: "#fff", fontSize: 15, fontWeight: "800" },
});
