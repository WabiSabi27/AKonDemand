import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import React, { useState } from "react";
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  getGetAvailabilityQueryKey,
  getGetServiceQueryKey,
  getListBlockedSlotsQueryKey,
  useGetAvailability,
  useGetService,
  useListBlockedSlots,
} from "@workspace/api-client-react";

import { AvailabilityCalendar, PLAN_BOOKING_HORIZON_MONTHS } from "@/components/AvailabilityCalendar";
import { RatingStars } from "@/components/RatingStars";
import { calculateFees, isOnVacation, mapBlockedSlot, mapService, useApp } from "@/context/AppContext";
import type { ServiceOption } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";
import { ScreenHeader } from "@/components/ScreenHeader";
import { BRAND } from "@/constants/colors";
import { formatDateMMDDYY, minutesToTimeLabel, minutesToTimeStr, pickCustomerSlots, timeStrToMinutes } from "@/utils/specialties";
import { describePolicy, policyFromBusiness } from "@/utils/cancellationPolicy";

export default function ServiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { businesses } = useApp();
  const [selectedOption, setSelectedOption] = useState<ServiceOption | null>(null);
  const [availabilityVisible, setAvailabilityVisible] = useState(false);
  const [selectedAvailDay, setSelectedAvailDay] = useState<string | null>(null);

  // Detail call gives us the full service plus reviews (which the list response
  // intentionally omits). Map server shape → mobile shape at the boundary.
  const detailId = id ?? "";
  const detailQ = useGetService(detailId, {
    query: {
      queryKey: getGetServiceQueryKey(detailId),
      enabled: !!id,
    },
  });
  const service = detailQ.data
    ? mapService(detailQ.data, detailQ.data.reviews.map((r) => ({
        id: r.id,
        authorName: r.authorName,
        rating: r.rating,
        comment: r.comment,
        date: r.date,
      })))
    : undefined;
  const business = service ? businesses.find((b) => b.id === service.businessId) : null;

  // Customer-facing month-view calendar needs blocked slots for the business
  // being viewed. AppContext.blockedSlots is SP-only (their own calendar), so
  // we fetch the per-business public list directly here.
  const calendarBizId = business?.id ?? "";
  const blockedSlotsQ = useListBlockedSlots(
    { businessId: calendarBizId },
    {
      query: {
        queryKey: getListBlockedSlotsQueryKey({ businessId: calendarBizId }),
        enabled: !!business?.id,
      },
    },
  );
  const blockedSlots = (blockedSlotsQ.data ?? []).map(mapBlockedSlot);

  // Server-computed availability for the day the customer taps in the calendar.
  // Slots/capacity already factor in employees, blocked slots, existing bookings,
  // and business hours — see artifacts/api-server/src/routes/availability.ts.
  const availDayParam = selectedAvailDay ?? "";
  const availQ = useGetAvailability(
    { serviceId: detailId, date: availDayParam },
    {
      query: {
        queryKey: getGetAvailabilityQueryKey({ serviceId: detailId, date: availDayParam }),
        enabled: !!detailId && !!selectedAvailDay,
      },
    },
  );
  const topInset = Platform.OS === "web" ? 67 : insets.top;
  const bottomInset = Platform.OS === "web" ? 34 : insets.bottom;

  if (!service) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={{ color: colors.mutedForeground }}>Service not found</Text>
      </View>
    );
  }

  const option = selectedOption ?? service.options[0];
  const { platformFee, total } = calculateFees(option.price);

  /**
   * `slotStartMin` lets a per-row "Book Now" pill hand the chosen time off to
   * the checkout screen so the customer doesn't have to pick AM/PM all over
   * again on the next page. Omitting it (e.g. ongoing services with no time
   * grid) just defers picking to checkout, same as before.
   */
  function handleGoToCheckout(slotStartMin?: number) {
    // Service is guaranteed by the early-return above, but TS doesn't preserve
    // narrowing across function declarations — re-check inside the closure.
    if (!service) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setAvailabilityVisible(false);
    const dateParam = selectedAvailDay ? `&date=${selectedAvailDay}` : "";
    const timeParam = slotStartMin !== undefined ? `&time=${minutesToTimeStr(slotStartMin)}` : "";
    router.push(`/checkout?serviceId=${service.id}&optionId=${option.id}${dateParam}${timeParam}`);
  }

  function closeAvailability() {
    setAvailabilityVisible(false);
    setSelectedAvailDay(null);
  }

  function parseDurationMinutes(d: string): number | null {
    const dur = d.toLowerCase().trim();
    if (dur.includes("full day")) return 480;
    if (dur.includes("half day")) return 240;
    if (dur.includes("monthly") || dur.includes("weekly") || dur.includes("seasonal")) return null;
    const rangeHr = dur.match(/^(\d+)-\d+\s*hr/);
    if (rangeHr) return parseInt(rangeHr[1], 10) * 60;
    const hrMatch = dur.match(/(\d+\.?\d*)\s*hr/);
    if (hrMatch) return Math.round(parseFloat(hrMatch[1]) * 60);
    const minMatch = dur.match(/(\d+)\s*min/);
    if (minMatch) return parseInt(minMatch[1], 10);
    return null;
  }

  function timeToMinutes(t: string): number {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m || 0);
  }

  function formatTimeSlot(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
  }

  // Kept (unused after T006e) only as documentation of the legacy local algorithm.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  function _legacyIsSlotFree(startMin: number, durMin: number, daySlots: { allDay: boolean; startTime?: string | null; endTime?: string | null }[]): boolean {
    const endMin = startMin + durMin;
    for (const s of daySlots) {
      if (s.allDay) return false;
      if (s.startTime && s.endTime) {
        const bs = timeToMinutes(s.startTime);
        const be = timeToMinutes(s.endTime);
        if (startMin < be && endMin > bs) return false;
      }
    }
    return true;
  }

  // App-wide date format is MM-DD-YY (see `formatDateMMDDYY` in
  // `utils/specialties.ts`). The full-month label was retired in the same
  // pass that removed the checkout date/time pickers.
  function formatDateLabel(ds: string): string {
    return formatDateMMDDYY(ds);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScreenHeader title="Service Details" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: bottomInset + 220 }}>
        <View style={[styles.imageArea, { backgroundColor: colors.secondary, paddingTop: 8 }]}>
          <Feather name="briefcase" size={60} color={BRAND.redViolet} style={{ alignSelf: "center", marginTop: 20 }} />
        </View>

        <View style={styles.body}>
          <Text style={[styles.businessName, { color: colors.mutedForeground }]}>
            {service.businessName}
          </Text>
          <Text style={[styles.title, { color: colors.foreground }]}>{service.title}</Text>

          <View style={styles.metaRow}>
            <RatingStars rating={service.rating} size={15} />
            <Text style={[styles.ratingNum, { color: colors.foreground }]}>
              {service.rating.toFixed(1)}
            </Text>
            <Text style={[styles.reviewCount, { color: colors.mutedForeground }]}>
              ({service.reviewCount} reviews)
            </Text>
          </View>

          <View style={styles.tagsRow}>
            {service.tags.map((tag) => (
              <View key={tag} style={[styles.tag, { backgroundColor: BRAND.redViolet + "18" }]}>
                <Text style={[styles.tagText, { color: BRAND.redViolet }]}>{tag}</Text>
              </View>
            ))}
          </View>

          {/* Phase 3 #3 — OOO banner. We only check the top-level vacation
              window (today inside it); per-date vacation messaging is shown
              on checkout. The "Select" button stays enabled because the SP
              may be back before the customer's chosen date. */}
          {isOnVacation(business) && (
            <View style={[styles.vacationBanner, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "55" }]}>
              <Feather name="umbrella" size={16} color={colors.destructive} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.vacationTitle, { color: colors.destructive }]}>
                  On vacation through {business?.vacationUntil}
                </Text>
                {business?.vacationMessage ? (
                  <Text style={[styles.vacationBody, { color: colors.foreground }]}>
                    {business.vacationMessage}
                  </Text>
                ) : (
                  <Text style={[styles.vacationBody, { color: colors.mutedForeground }]}>
                    This provider is currently out of office. You can still browse and book a date after the window.
                  </Text>
                )}
              </View>
            </View>
          )}

          <Text style={[styles.description, { color: colors.mutedForeground }]}>
            {service.description}
          </Text>

          {/* Phase 3 #7 — Cancellation policy summary so the customer
              knows the refund rules BEFORE they book. */}
          {business && (
            <View style={[
              styles.policyRow,
              { backgroundColor: colors.card, borderColor: colors.border },
            ]}>
              <Feather name="rotate-ccw" size={14} color={colors.mutedForeground} />
              <Text style={[styles.policyText, { color: colors.mutedForeground }]}>
                {describePolicy(policyFromBusiness(business))}
              </Text>
            </View>
          )}

          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Select Option</Text>
          {service.options.map((opt) => {
            const active = (selectedOption?.id ?? service.options[0].id) === opt.id;
            return (
              <TouchableOpacity
                key={opt.id}
                style={[
                  styles.optionCard,
                  {
                    borderColor: active ? BRAND.redViolet : colors.border,
                    backgroundColor: active ? BRAND.redViolet + "10" : colors.card,
                  },
                ]}
                onPress={() => {
                  Haptics.selectionAsync();
                  setSelectedOption(opt);
                }}
                activeOpacity={0.85}
              >
                <View style={styles.optionLeft}>
                  <Text style={[styles.optionName, { color: colors.foreground }]}>{opt.name}</Text>
                  <Text style={[styles.optionDesc, { color: colors.mutedForeground }]}>
                    {opt.description} · {opt.duration}
                    {opt.defaultStartTime ? ` · starts ${minutesToTimeLabel(timeStrToMinutes(opt.defaultStartTime))}` : ""}
                  </Text>
                </View>
                <Text style={[styles.optionPrice, { color: BRAND.redViolet }]}>
                  ${opt.price}
                </Text>
                {active && (
                  <View style={[styles.check, { backgroundColor: BRAND.redViolet }]}>
                    <Feather name="check" size={12} color="#fff" />
                  </View>
                )}
              </TouchableOpacity>
            );
          })}

          <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Reviews</Text>
          {service.reviews.map((review) => (
            <View
              key={review.id}
              style={[styles.reviewCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={styles.reviewHeader}>
                <View style={[styles.reviewAvatar, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.reviewInitial, { color: colors.foreground }]}>
                    {review.authorName[0]}
                  </Text>
                </View>
                <View style={styles.reviewMeta}>
                  <Text style={[styles.reviewAuthor, { color: colors.foreground }]}>
                    {review.authorName}
                  </Text>
                  <Text style={[styles.reviewDate, { color: colors.mutedForeground }]}>
                    {review.date}
                  </Text>
                </View>
                <RatingStars rating={review.rating} size={12} />
              </View>
              <Text style={[styles.reviewComment, { color: colors.mutedForeground }]}>
                {review.comment}
              </Text>
            </View>
          ))}
        </View>
      </ScrollView>

      <View
        style={[
          styles.footer,
          {
            backgroundColor: colors.card,
            borderTopColor: colors.border,
            paddingBottom: bottomInset + 12,
          },
        ]}
      >
        <View style={styles.priceBreakdown}>
          <View style={styles.priceRow}>
            <Text style={[styles.priceLabel, { color: colors.mutedForeground }]}>Service</Text>
            <Text style={[styles.priceValue, { color: colors.foreground }]}>${option.price.toFixed(2)}</Text>
          </View>
          <View style={styles.priceRow}>
            <Text style={[styles.priceLabel, { color: colors.mutedForeground }]}>Platform fee (8%)</Text>
            <Text style={[styles.priceValue, { color: colors.mutedForeground }]}>${platformFee.toFixed(2)}</Text>
          </View>
          <View style={[styles.totalRow, { borderTopColor: colors.border }]}>
            <Text style={[styles.totalLabel, { color: colors.foreground }]}>Total</Text>
            <Text style={[styles.totalValue, { color: BRAND.redViolet }]}>${total.toFixed(2)}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={[styles.availabilityBtn, { borderColor: BRAND.redViolet, backgroundColor: BRAND.redViolet + "12" }]}
          onPress={() => setAvailabilityVisible(true)}
          activeOpacity={0.85}
        >
          <Feather name="calendar" size={17} color={BRAND.redViolet} />
          <Text style={[styles.availabilityBtnText, { color: BRAND.redViolet }]}>Select</Text>
        </TouchableOpacity>
      </View>

      <Modal
        visible={availabilityVisible}
        animationType="slide"
        transparent
        onRequestClose={closeAvailability}
      >
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={closeAvailability} />
        <View style={[styles.modalSheet, { backgroundColor: colors.card, paddingBottom: bottomInset + 20 }]}>
          <View style={styles.modalHandle} />

          {/* ── Header ── */}
          <View style={styles.modalTitleRow}>
            {selectedAvailDay ? (
              <TouchableOpacity
                style={styles.backRowBtn}
                onPress={() => setSelectedAvailDay(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Feather name="arrow-left" size={18} color={BRAND.redViolet} />
                <View>
                  <Text style={[styles.modalTitle, { color: colors.foreground }]}>{formatDateLabel(selectedAvailDay)}</Text>
                  <Text style={[styles.modalSubtitle, { color: colors.mutedForeground }]}>{service.businessName}</Text>
                </View>
              </TouchableOpacity>
            ) : (
              <View>
                <Text style={[styles.modalTitle, { color: colors.foreground }]}>Availability</Text>
                <Text style={[styles.modalSubtitle, { color: colors.mutedForeground }]}>{service.businessName}</Text>
              </View>
            )}
            <TouchableOpacity onPress={closeAvailability} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          {/* ── Month calendar view ── */}
          {!selectedAvailDay && (
            business ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                <AvailabilityCalendar
                  businessId={business.id}
                  blockedSlots={blockedSlots}
                  mode="view"
                  serviceDurationMin={parseDurationMinutes(option.duration) ?? undefined}
                  businessStartHour={business.hours?.startHour ?? 7}
                  businessEndHour={business.hours?.endHour ?? 20}
                  workDays={business.hours?.workDays}
                  maxMonthsAhead={PLAN_BOOKING_HORIZON_MONTHS[business.subscriptionPlan]}
                  onDayPress={(date) => {
                    Haptics.selectionAsync();
                    setSelectedAvailDay(date);
                  }}
                />
                <View style={[styles.availNote, { backgroundColor: colors.secondary }]}>
                  <Feather name="info" size={14} color={colors.mutedForeground} />
                  <Text style={[styles.availNoteText, { color: colors.mutedForeground }]}>
                    Tap any date to check time-slot availability for this service.
                  </Text>
                </View>
              </ScrollView>
            ) : (
              <Text style={[styles.noAvail, { color: colors.mutedForeground }]}>Availability not set up yet.</Text>
            )
          )}

          {/* ── Day time-slot view ── */}
          {selectedAvailDay && business && (() => {
            const durationMin = parseDurationMinutes(option.duration);
            const requiredSpec = service.requiredSpecialty?.trim() || undefined;

            // Server already computed everything (capacity, employee filtering,
            // blocked-slot overlap, booking overlap, work-day check). We just
            // render. T006e: no more local capacity/availability math.
            //
            // Long-duration filter: when the customer picks an option that's
            // ≥ 8h ("Full day", "8 hrs", etc.), collapse the slot list to the
            // option's effective start (its `defaultStartTime`, or "08:00" by
            // default). The server returns the full grid because the SERVICE
            // may have shorter options too, but only THIS option is selected
            // — so the customer should see one start time, not eleven.
            const rawServerSlots = availQ.data?.slots ?? [];
            const optionPinnedStart =
              option.defaultStartTime?.trim() && /^\d{2}:\d{2}$/.test(option.defaultStartTime.trim())
                ? option.defaultStartTime.trim()
                : durationMin !== null && durationMin >= 8 * 60
                  ? "08:00"
                  : null;
            // For finite-duration sub-full-day options, this collapses to one
            // AM slot + one PM slot (see pickCustomerSlots docstring).
            const serverSlots = pickCustomerSlots(rawServerSlots, durationMin, optionPinnedStart);
            const capacity = availQ.data?.capacity ?? 0;
            const noQualifiedStaff = !!requiredSpec && capacity === 0;
            const isOngoing = durationMin === null;

            const slotState = serverSlots.map((s) => {
              const startMin = timeToMinutes(s.time);
              const endMin = startMin + (durationMin ?? 0);
              return {
                startMin,
                endMin,
                blockFree: s.reason !== "blocked",
                remaining: s.remaining,
                free: s.available,
              };
            });
            const anySlotFree = slotState.some((s) => s.free);
            // Server returns 0 slots when the day is fully blocked, the day is
            // off-hours, or the service is longer than the business window. We
            // can no longer distinguish without a richer response — show one
            // generic "unavailable" banner. noStaff is special-cased above.
            const noWindow = !availQ.isLoading
              && !availQ.isError
              && !isOngoing
              && !noQualifiedStaff
              && serverSlots.length === 0;
            const canShowBookBtn =
              !noQualifiedStaff
              && !noWindow
              && (isOngoing || anySlotFree);

            return (
              <ScrollView showsVerticalScrollIndicator={false} style={{ marginTop: 4 }}>
                {/* Duration pill */}
                <View style={[styles.durationPill, { backgroundColor: BRAND.redViolet + "18", borderColor: BRAND.redViolet + "44" }]}>
                  <Feather name="clock" size={14} color={BRAND.redViolet} />
                  <Text style={[styles.durationPillText, { color: BRAND.redViolet }]}>
                    This service requires: <Text style={{ fontWeight: "800" }}>{option.duration}</Text>
                  </Text>
                </View>

                {/* Specialty + capacity pill */}
                {requiredSpec && (
                  <View style={[
                    styles.durationPill,
                    {
                      marginTop: 6,
                      backgroundColor: noQualifiedStaff ? colors.destructive + "18" : "#5C6BC018",
                      borderColor: noQualifiedStaff ? colors.destructive + "44" : "#5C6BC044",
                    },
                  ]}>
                    <Feather name="award" size={14} color={noQualifiedStaff ? colors.destructive : "#5C6BC0"} />
                    <Text style={[styles.durationPillText, { color: noQualifiedStaff ? colors.destructive : "#5C6BC0" }]}>
                      Specialty: <Text style={{ fontWeight: "800" }}>{requiredSpec}</Text>
                      {" — "}
                      {noQualifiedStaff
                        ? "no employee available"
                        : `${capacity} ${capacity === 1 ? "employee" : "employees"} can perform this service`}
                    </Text>
                  </View>
                )}

                {/* No qualified staff banner */}
                {noQualifiedStaff && (
                  <View style={[styles.allDayBanner, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44" }]}>
                    <Feather name="user-x" size={16} color={colors.destructive} />
                    <Text style={[styles.allDayBannerText, { color: colors.destructive }]}>
                      No employee with the {requiredSpec} specialty is currently available. Please check back later or choose another service.
                    </Text>
                  </View>
                )}

                {/* Loading availability */}
                {availQ.isLoading && !noQualifiedStaff && (
                  <Text style={[styles.noAvail, { color: colors.mutedForeground }]}>
                    Loading availability…
                  </Text>
                )}

                {/* Error fetching availability */}
                {availQ.isError && !noQualifiedStaff && (
                  <View style={[styles.allDayBanner, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44" }]}>
                    <Feather name="alert-circle" size={16} color={colors.destructive} />
                    <Text style={[styles.allDayBannerText, { color: colors.destructive }]}>
                      Could not load availability. Please try again.
                    </Text>
                  </View>
                )}

                {/* No-window banner — covers all-day-blocked, off-day, or service-too-long */}
                {noWindow && (
                  <View style={[styles.allDayBanner, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44" }]}>
                    <Feather name="x-circle" size={16} color={colors.destructive} />
                    <Text style={[styles.allDayBannerText, { color: colors.destructive }]}>
                      Provider is unavailable on this day.
                    </Text>
                  </View>
                )}

                {/* Ongoing service fallback */}
                {isOngoing && !noQualifiedStaff && (
                  <View style={[styles.allDayBanner, { backgroundColor: colors.secondary }]}>
                    <Feather name="info" size={16} color={colors.mutedForeground} />
                    <Text style={[styles.allDayBannerText, { color: colors.mutedForeground }]}>
                      This is an ongoing service. Contact the provider to schedule.
                    </Text>
                  </View>
                )}

                {/* Time slots.
                 *
                 * Per UX update: each row's right-side badge is no longer the
                 * "X spots left" capacity readout — it's now a "Book Now" pill
                 * that turns the page to the checkout/cart with that specific
                 * time pre-selected. Capacity-exhausted/blocked rows still
                 * show a destructive badge with the reason word so the
                 * customer knows why it's not bookable.
                 */}
                {!noWindow && !noQualifiedStaff && !isOngoing && slotState.map(({ startMin, endMin, blockFree, remaining, free }) => {
                  const reason = !blockFree
                    ? "Blocked"
                    : remaining === 0
                      ? "Fully booked"
                      : null;
                  return (
                    <View
                      key={startMin}
                      style={[
                        styles.timeSlotRow,
                        {
                          backgroundColor: free ? colors.success + "12" : colors.destructive + "10",
                          borderColor: free ? colors.success + "55" : colors.destructive + "44",
                        },
                      ]}
                    >
                      <View style={[styles.timeSlotDot, { backgroundColor: free ? colors.success : colors.destructive }]} />
                      <View style={styles.timeSlotInfo}>
                        <Text style={[styles.timeSlotStart, { color: colors.foreground }]}>
                          {formatTimeSlot(startMin)}
                        </Text>
                        <Text style={[styles.timeSlotEnd, { color: colors.mutedForeground }]}>
                          → {formatTimeSlot(endMin)} ({option.duration})
                        </Text>
                      </View>
                      {free ? (
                        <TouchableOpacity
                          style={[styles.timeSlotBookPill, { backgroundColor: BRAND.redViolet }]}
                          onPress={() => handleGoToCheckout(startMin)}
                          activeOpacity={0.85}
                        >
                          <Feather name="shopping-cart" size={13} color="#fff" />
                          <Text style={styles.timeSlotBookPillText}>Book Now</Text>
                        </TouchableOpacity>
                      ) : (
                        <View style={[styles.timeSlotBadge, { backgroundColor: colors.destructive + "22" }]}>
                          <Text style={[styles.timeSlotBadgeText, { color: colors.destructive }]}>
                            {reason}
                          </Text>
                        </View>
                      )}
                    </View>
                  );
                })}

                {/* All slots full banner (capacity exhausted but the day isn't blocked) */}
                {!noWindow && !noQualifiedStaff && !isOngoing && serverSlots.length > 0 && !anySlotFree && (
                  <View style={[styles.allDayBanner, { backgroundColor: colors.destructive + "18", borderColor: colors.destructive + "44", marginTop: 8 }]}>
                    <Feather name="calendar" size={16} color={colors.destructive} />
                    <Text style={[styles.allDayBannerText, { color: colors.destructive }]}>
                      Every time on this date is fully booked or blocked. Pick another day.
                    </Text>
                  </View>
                )}

                {/* Bottom Book Now button.
                 *
                 * Hidden for finite-duration services because every available
                 * row now has its own per-slot Book Now pill — a second
                 * button at the bottom would just be noise.
                 *
                 * ONGOING services (weekly/monthly) have no time grid at all,
                 * so this stays as the only way to commit. Same `canShowBookBtn`
                 * gate applies (no-staff / no-window cases stay banner-only).
                 */}
                {canShowBookBtn && isOngoing && (
                  <TouchableOpacity
                    style={[styles.bookBtn, { backgroundColor: BRAND.redViolet, marginTop: 8 }]}
                    onPress={() => handleGoToCheckout()}
                    activeOpacity={0.85}
                  >
                    <Feather name="shopping-cart" size={17} color="#fff" />
                    <Text style={[styles.bookBtnText, { color: "#fff" }]}>Book Now</Text>
                  </TouchableOpacity>
                )}

                <View style={{ height: 16 }} />
              </ScrollView>
            );
          })()}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  imageArea: {
    height: 200,
    justifyContent: "flex-end",
    paddingBottom: 16,
    position: "relative",
  },
  backBtn: {
    position: "absolute",
    top: 54,
    left: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  body: { padding: 20, gap: 8 },
  businessName: { fontSize: 12, fontWeight: "500" },
  title: { fontSize: 22, fontWeight: "800", lineHeight: 30 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 5 },
  ratingNum: { fontSize: 15, fontWeight: "700" },
  reviewCount: { fontSize: 12 },
  tagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 },
  tag: { paddingHorizontal: 12, paddingVertical: 5, borderRadius: 20 },
  tagText: { fontSize: 12, fontWeight: "600" },
  description: { fontSize: 15, lineHeight: 22, marginTop: 4 },
  policyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 14,
  },
  policyText: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "500" },
  sectionTitle: { fontSize: 18, fontWeight: "800", marginTop: 12, marginBottom: 4 },
  optionCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    borderWidth: 1.5,
    marginBottom: 8,
    gap: 10,
  },
  optionLeft: { flex: 1 },
  optionName: { fontSize: 15, fontWeight: "700" },
  optionDesc: { fontSize: 12, marginTop: 2 },
  optionPrice: { fontSize: 15, fontWeight: "800" },
  check: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  reviewCard: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 14,
    marginBottom: 10,
  },
  reviewHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    marginBottom: 8,
  },
  reviewAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  reviewInitial: { fontSize: 15, fontWeight: "700" },
  reviewMeta: { flex: 1 },
  reviewAuthor: { fontSize: 15, fontWeight: "700" },
  reviewDate: { fontSize: 12, marginTop: 1 },
  reviewComment: { fontSize: 15, lineHeight: 20 },
  footer: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    padding: 16,
    borderTopWidth: 1,
  },
  priceBreakdown: { marginBottom: 12 },
  priceRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  priceLabel: { fontSize: 12 },
  priceValue: { fontSize: 12, fontWeight: "600" },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    paddingTop: 8,
    marginTop: 4,
  },
  totalLabel: { fontSize: 15, fontWeight: "700" },
  totalValue: { fontSize: 18, fontWeight: "800" },
  footerBtns: {
    flexDirection: "row",
    gap: 10,
    alignItems: "center",
  },
  availabilityBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1.5,
  },
  availabilityBtnText: {
    fontSize: 15,
    fontWeight: "700",
  },
  bookBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
  },
  bookBtnText: {
    fontSize: 15,
    fontWeight: "800",
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
  },
  modalSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    maxHeight: "80%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.15,
    shadowRadius: 20,
    elevation: 24,
  },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ccc",
    alignSelf: "center",
    marginBottom: 16,
  },
  modalTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  modalTitle: { fontSize: 22, fontWeight: "800" },
  modalSubtitle: { fontSize: 12, marginTop: 2 },
  availNote: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    padding: 12,
    borderRadius: 12,
    marginTop: 12,
    marginBottom: 8,
  },
  availNoteText: { fontSize: 12, lineHeight: 18, flex: 1 },
  noAvail: { fontSize: 15, textAlign: "center", paddingVertical: 24 },
  backRowBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flex: 1,
  },
  durationPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  durationPillText: { fontSize: 12 },
  allDayBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  allDayBannerText: { fontSize: 12, flex: 1, lineHeight: 18 },
  vacationBanner: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 14,
  },
  vacationTitle: { fontSize: 15, fontWeight: "700", marginBottom: 2 },
  vacationBody: { fontSize: 12, lineHeight: 18 },
  timeSlotRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 8,
  },
  timeSlotDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    flexShrink: 0,
  },
  timeSlotInfo: { flex: 1 },
  timeSlotStart: { fontSize: 15, fontWeight: "700" },
  timeSlotEnd: { fontSize: 12, marginTop: 2 },
  timeSlotBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  timeSlotBadgeText: { fontSize: 12, fontWeight: "700" },
  timeSlotBookPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
  },
  timeSlotBookPillText: { fontSize: 12, fontWeight: "800", color: "#fff", letterSpacing: 0.3 },
});
