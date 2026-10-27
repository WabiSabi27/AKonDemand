import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useEffect, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AvailabilityCalendar, PLAN_BOOKING_HORIZON_MONTHS } from "@/components/AvailabilityCalendar";
import type { BlockedSlot, BusinessHours } from "@/context/AppContext";
import { useApp } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_LABELS_SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const DEFAULT_HOURS: BusinessHours = { workDays: [1, 2, 3, 4, 5], startHour: 8, endHour: 18 };

type BlockType = "allDay" | "morning" | "evening" | "holiday" | "custom";

function pad(n: number) { return String(n).padStart(2, "0"); }
function hourLabel(h: number) {
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${ampm}`;
}
function formatTime(t: string) {
  if (!t) return "";
  const [hStr, mStr] = t.split(":");
  const h = parseInt(hStr, 10);
  const m = mStr ?? "00";
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${ampm}`;
}
function formatDateLabel(ds: string) {
  if (!ds) return "";
  const [y, m, d] = ds.split("-");
  return `${MONTH_NAMES[parseInt(m, 10) - 1]} ${parseInt(d, 10)}, ${y}`;
}

function datesInRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;
  const cur = new Date(lo + "T12:00:00");
  const last = new Date(hi + "T12:00:00");
  while (cur <= last) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, "0");
    const d = String(cur.getDate()).padStart(2, "0");
    dates.push(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export default function CalendarTab() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, businesses, blockedSlots, addBlockedSlot, addBlockedSlots, removeBlockedSlot, updateBusiness } = useApp();
  const isWeb = Platform.OS === "web";

  const myBusiness = businesses.find((b) => b.ownerId === user?.id);
  const savedHours = myBusiness?.hours ?? DEFAULT_HOURS;

  const topInset = isWeb ? 67 : insets.top;

  // ─── Business Hours state ────────────────────────────────────────────────
  const [showHours, setShowHours] = useState(false);
  const [workDays, setWorkDays] = useState<number[]>(savedHours.workDays);
  const [startHour, setStartHour] = useState(savedHours.startHour);
  const [endHour, setEndHour] = useState(savedHours.endHour);
  const [hoursDirty, setHoursDirty] = useState(false);
  const [hoursSaving, setHoursSaving] = useState(false);

  // Keep local hours in sync if business loads after mount
  useEffect(() => {
    const h = myBusiness?.hours ?? DEFAULT_HOURS;
    setWorkDays(h.workDays);
    setStartHour(h.startHour);
    setEndHour(h.endHour);
  }, [myBusiness?.id]);

  function toggleWorkDay(d: number) {
    setWorkDays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()
    );
    setHoursDirty(true);
  }
  function changeStartHour(delta: number) {
    setStartHour((h) => {
      const next = Math.max(0, Math.min(h + delta, endHour - 1));
      return next;
    });
    setHoursDirty(true);
  }
  function changeEndHour(delta: number) {
    setEndHour((h) => {
      const next = Math.max(startHour + 1, Math.min(h + delta, 23));
      return next;
    });
    setHoursDirty(true);
  }
  async function saveHours() {
    if (!myBusiness) return;
    setHoursSaving(true);
    await updateBusiness(myBusiness.id, { hours: { workDays, startHour, endHour } });
    setHoursDirty(false);
    setHoursSaving(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }

  // ─── Vacation Mode (Phase 3 #3) ─────────────────────────────────────────
  // Pair of YYYY-MM-DD inputs + optional message. Stored on the business row
  // and enforced server-side both in availability (returns no slots) and in
  // POST /bookings (409 with the SP's custom message).
  const [showVacation, setShowVacation] = useState(false);
  const [vacFrom, setVacFrom] = useState(myBusiness?.vacationFrom ?? "");
  const [vacUntil, setVacUntil] = useState(myBusiness?.vacationUntil ?? "");
  const [vacMessage, setVacMessage] = useState(myBusiness?.vacationMessage ?? "");
  const [vacSaving, setVacSaving] = useState(false);
  useEffect(() => {
    setVacFrom(myBusiness?.vacationFrom ?? "");
    setVacUntil(myBusiness?.vacationUntil ?? "");
    setVacMessage(myBusiness?.vacationMessage ?? "");
  }, [myBusiness?.id, myBusiness?.vacationFrom, myBusiness?.vacationUntil, myBusiness?.vacationMessage]);

  const vacationActive = !!(myBusiness?.vacationFrom && myBusiness?.vacationUntil);
  const ymdValid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s.trim());

  async function saveVacation() {
    if (!myBusiness) return;
    const from = vacFrom.trim();
    const until = vacUntil.trim();
    if (!ymdValid(from) || !ymdValid(until)) {
      Alert.alert("Invalid Dates", "Please enter both dates in YYYY-MM-DD format.");
      return;
    }
    if (from > until) {
      Alert.alert("Invalid Range", "End date must be on or after start date.");
      return;
    }
    setVacSaving(true);
    try {
      await updateBusiness(myBusiness.id, {
        vacationFrom: from,
        vacationUntil: until,
        vacationMessage: vacMessage.trim() || undefined,
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      Alert.alert("Save Failed", e instanceof Error ? e.message : "Could not save vacation window.");
    } finally {
      setVacSaving(false);
    }
  }

  async function clearVacation() {
    if (!myBusiness) return;
    setVacSaving(true);
    try {
      await updateBusiness(myBusiness.id, {
        vacationFrom: undefined,
        vacationUntil: undefined,
        vacationMessage: undefined,
      });
      setVacFrom("");
      setVacUntil("");
      setVacMessage("");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      Alert.alert("Clear Failed", e instanceof Error ? e.message : "Could not clear vacation window.");
    } finally {
      setVacSaving(false);
    }
  }

  // ─── Range mode ─────────────────────────────────────────────────────────
  const [rangeMode, setRangeMode] = useState(false);
  const [rangeStart, setRangeStart] = useState<string | null>(null);
  const [rangeEnd, setRangeEnd] = useState<string | null>(null);

  function resetRange() {
    setRangeStart(null);
    setRangeEnd(null);
  }

  // ─── Block modal state ───────────────────────────────────────────────────
  const [modalVisible, setModalVisible] = useState(false);
  const [modalStart, setModalStart] = useState<string>("");
  const [modalEnd, setModalEnd] = useState<string>("");
  const [slotsForDay, setSlotsForDay] = useState<BlockedSlot[]>([]);
  const [blockType, setBlockType] = useState<BlockType>("allDay");
  const [customStart, setCustomStart] = useState("09:00");
  const [customEnd, setCustomEnd] = useState("17:00");
  const [blockLabel, setBlockLabel] = useState("");

  const morningEnd = Math.min(startHour + 4, endHour);
  const eveningStart = morningEnd;

  function blockTypeStartTime(): string | undefined {
    if (blockType === "allDay" || blockType === "holiday") return undefined;
    if (blockType === "morning") return `${pad(startHour)}:00`;
    if (blockType === "evening") return `${pad(eveningStart)}:00`;
    return customStart;
  }
  function blockTypeEndTime(): string | undefined {
    if (blockType === "allDay" || blockType === "holiday") return undefined;
    if (blockType === "morning") return `${pad(morningEnd)}:00`;
    if (blockType === "evening") return `${pad(endHour)}:00`;
    return customEnd;
  }

  function openModal(start: string, end: string, existing: BlockedSlot[]) {
    setModalStart(start);
    setModalEnd(end);
    setSlotsForDay(existing);
    setBlockType("allDay");
    setCustomStart(`${pad(startHour)}:00`);
    setCustomEnd(`${pad(endHour)}:00`);
    setBlockLabel("");
    setModalVisible(true);
  }

  function closeModal() {
    setModalVisible(false);
    resetRange();
  }

  // ─── Calendar day press ─────────────────────────────────────────────────
  function handleDayPress(date: string, existing: BlockedSlot[]) {
    Haptics.selectionAsync();

    if (!rangeMode) {
      openModal(date, date, existing);
      return;
    }

    if (!rangeStart) {
      setRangeStart(date);
      return;
    }

    if (date === rangeStart) {
      resetRange();
      return;
    }

    const lo = date < rangeStart ? date : rangeStart;
    const hi = date < rangeStart ? rangeStart : date;
    setRangeEnd(hi);
    openModal(lo, hi, []);
  }

  // ─── Block save ─────────────────────────────────────────────────────────
  async function handleAddBlock() {
    if (!myBusiness) return;

    if (blockType === "custom") {
      const timeValid = /^\d{2}:\d{2}$/.test(customStart) && /^\d{2}:\d{2}$/.test(customEnd);
      if (!timeValid) {
        Alert.alert("Invalid Time", "Please enter times in HH:MM format (e.g. 09:00).");
        return;
      }
      if (customStart >= customEnd) {
        Alert.alert("Invalid Range", "End time must be after start time.");
        return;
      }
    }

    if (blockType === "evening" && eveningStart >= endHour) {
      Alert.alert("No Evening Block", "Your business hours don't have enough time after morning for an evening block.");
      return;
    }

    const dates = datesInRange(modalStart, modalEnd);
    const now = Date.now();

    // "holiday" is a labeled all-day block — server only persists allDay +
    // start/end + label, so the preset just stamps "Holiday" as the label.
    const isAllDayBlock = blockType === "allDay" || blockType === "holiday";
    const effectiveLabel =
      blockLabel.trim()
      || (blockType === "holiday" ? "Holiday" : undefined);
    const slots: BlockedSlot[] = dates.map((d, i) => ({
      id: `slot_${now}_${i}`,
      businessId: myBusiness.id,
      date: d,
      allDay: isAllDayBlock,
      startTime: blockTypeStartTime(),
      endTime: blockTypeEndTime(),
      label: effectiveLabel,
    }));

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    if (slots.length === 1) {
      await addBlockedSlot(slots[0]);
    } else {
      await addBlockedSlots(slots);
    }

    closeModal();
  }

  async function handleRemoveSlot(slotId: string) {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    await removeBlockedSlot(slotId);
    setSlotsForDay((prev) => prev.filter((s) => s.id !== slotId));
  }

  if (!myBusiness) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: topInset }]}>
        <Feather name="alert-circle" size={40} color={colors.mutedForeground} />
        <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>No business profile found.</Text>
      </View>
    );
  }

  const mySlots = blockedSlots.filter((s) => s.businessId === myBusiness.id);
  const isRange = modalStart && modalEnd && modalStart !== modalEnd;
  const rangeCount = isRange ? datesInRange(modalStart, modalEnd).length : 1;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.pageHeader, { paddingTop: topInset + 8, backgroundColor: colors.card, borderBottomColor: colors.border }]}>
        <Feather name="calendar" size={20} color="#5C6BC0" />
        <Text style={[styles.pageTitle, { color: colors.foreground }]}>Availability Calendar</Text>
      </View>

      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 100 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* ── Business Hours card ───────────────────────────────────── */}
        <TouchableOpacity
          style={[styles.card, styles.hoursHeader, { backgroundColor: colors.card, borderColor: colors.border }]}
          onPress={() => setShowHours((v) => !v)}
          activeOpacity={0.8}
        >
          <View style={styles.hoursHeaderLeft}>
            <Feather name="clock" size={16} color="#5C6BC0" />
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Business Hours & Work Days</Text>
          </View>
          <Feather name={showHours ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />
        </TouchableOpacity>

        {showHours && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {/* Work days */}
            <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>Work Days</Text>
            <View style={styles.dayPills}>
              {DAY_LABELS_SHORT.map((label, idx) => {
                const active = workDays.includes(idx);
                return (
                  <TouchableOpacity
                    key={idx}
                    onPress={() => toggleWorkDay(idx)}
                    style={[
                      styles.dayPill,
                      {
                        backgroundColor: active ? "#5C6BC0" : colors.secondary,
                        borderColor: active ? "#5C6BC0" : colors.border,
                      },
                    ]}
                    activeOpacity={0.8}
                  >
                    <Text style={[styles.dayPillText, { color: active ? "#fff" : colors.mutedForeground }]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* Hours */}
            <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>Booking Hours</Text>
            <View style={styles.hoursRow}>
              <View style={styles.hourField}>
                <Text style={[styles.hourFieldLabel, { color: colors.mutedForeground }]}>Opens</Text>
                <View style={[styles.stepper, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                  <TouchableOpacity onPress={() => changeStartHour(-1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Feather name="minus" size={16} color={colors.foreground} />
                  </TouchableOpacity>
                  <Text style={[styles.stepperValue, { color: colors.foreground }]}>{hourLabel(startHour)}</Text>
                  <TouchableOpacity onPress={() => changeStartHour(1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Feather name="plus" size={16} color={colors.foreground} />
                  </TouchableOpacity>
                </View>
              </View>
              <Feather name="arrow-right" size={16} color={colors.mutedForeground} style={{ marginTop: 28 }} />
              <View style={styles.hourField}>
                <Text style={[styles.hourFieldLabel, { color: colors.mutedForeground }]}>Closes</Text>
                <View style={[styles.stepper, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
                  <TouchableOpacity onPress={() => changeEndHour(-1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Feather name="minus" size={16} color={colors.foreground} />
                  </TouchableOpacity>
                  <Text style={[styles.stepperValue, { color: colors.foreground }]}>{hourLabel(endHour)}</Text>
                  <TouchableOpacity onPress={() => changeEndHour(1)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                    <Feather name="plus" size={16} color={colors.foreground} />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            <Text style={[styles.hoursNote, { color: colors.mutedForeground }]}>
              Morning block: {hourLabel(startHour)} – {hourLabel(morningEnd)} · Evening: {hourLabel(eveningStart)} – {hourLabel(endHour)}
            </Text>

            {hoursDirty && (
              <TouchableOpacity
                style={[styles.saveBtn, { backgroundColor: "#5C6BC0" }]}
                onPress={saveHours}
                activeOpacity={0.85}
                disabled={hoursSaving}
              >
                <Feather name="save" size={16} color="#fff" />
                <Text style={styles.saveBtnText}>{hoursSaving ? "Saving…" : "Save Hours"}</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Vacation Mode card (Phase 3 #3) ───────────────────────── */}
        <TouchableOpacity
          style={[styles.card, styles.hoursHeader, { backgroundColor: colors.card, borderColor: vacationActive ? colors.destructive : colors.border, borderWidth: vacationActive ? 1.5 : 1 }]}
          onPress={() => setShowVacation((v) => !v)}
          activeOpacity={0.8}
        >
          <View style={styles.hoursHeaderLeft}>
            <Feather name="umbrella" size={16} color={vacationActive ? colors.destructive : "#5C6BC0"} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Vacation Mode</Text>
              {vacationActive && (
                <Text style={[styles.slotMeta, { color: colors.destructive }]}>
                  Active · {formatDateLabel(myBusiness?.vacationFrom ?? "")} – {formatDateLabel(myBusiness?.vacationUntil ?? "")}
                </Text>
              )}
            </View>
          </View>
          <Feather name={showVacation ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />
        </TouchableOpacity>

        {showVacation && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
              Pause new bookings during a vacation or leave window. Customers will see your message instead of booking.
            </Text>
            <View style={styles.hoursRow}>
              <View style={styles.hourField}>
                <Text style={[styles.hourFieldLabel, { color: colors.mutedForeground }]}>From (YYYY-MM-DD)</Text>
                <TextInput
                  style={[styles.timeInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
                  value={vacFrom}
                  onChangeText={setVacFrom}
                  placeholder="2026-06-01"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={10}
                />
              </View>
              <View style={styles.hourField}>
                <Text style={[styles.hourFieldLabel, { color: colors.mutedForeground }]}>Until (YYYY-MM-DD)</Text>
                <TextInput
                  style={[styles.timeInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
                  value={vacUntil}
                  onChangeText={setVacUntil}
                  placeholder="2026-06-14"
                  placeholderTextColor={colors.mutedForeground}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={10}
                />
              </View>
            </View>
            <View style={styles.labelField}>
              <Text style={[styles.timeFieldLabel, { color: colors.mutedForeground }]}>Customer message (optional)</Text>
              <TextInput
                style={[styles.labelInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border, minHeight: 60 }]}
                value={vacMessage}
                onChangeText={setVacMessage}
                placeholder="Out of office until June 14. Back soon!"
                placeholderTextColor={colors.mutedForeground}
                multiline
                maxLength={200}
              />
            </View>
            <TouchableOpacity
              style={[styles.saveBtn, { backgroundColor: vacationActive ? colors.destructive : "#5C6BC0", opacity: vacSaving ? 0.6 : 1 }]}
              onPress={saveVacation}
              activeOpacity={0.85}
              disabled={vacSaving}
            >
              <Feather name="umbrella" size={16} color="#fff" />
              <Text style={styles.saveBtnText}>{vacSaving ? "Saving…" : vacationActive ? "Update Vacation" : "Enable Vacation Mode"}</Text>
            </TouchableOpacity>
            {vacationActive && (
              <TouchableOpacity style={styles.cancelBtn} onPress={clearVacation} disabled={vacSaving}>
                <Text style={[styles.cancelText, { color: colors.destructive }]}>Clear vacation window</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Calendar card ─────────────────────────────────────────── */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          {/* Mode toggle */}
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[styles.modeBtn, !rangeMode && { backgroundColor: "#5C6BC0" }]}
              onPress={() => { setRangeMode(false); resetRange(); }}
              activeOpacity={0.8}
            >
              <Feather name="calendar" size={13} color={!rangeMode ? "#fff" : colors.mutedForeground} />
              <Text style={[styles.modeBtnText, { color: !rangeMode ? "#fff" : colors.mutedForeground }]}>Single Day</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, rangeMode && { backgroundColor: "#5C6BC0" }]}
              onPress={() => { setRangeMode(true); resetRange(); }}
              activeOpacity={0.8}
            >
              <Feather name="git-commit" size={13} color={rangeMode ? "#fff" : colors.mutedForeground} />
              <Text style={[styles.modeBtnText, { color: rangeMode ? "#fff" : colors.mutedForeground }]}>Date Range</Text>
            </TouchableOpacity>
          </View>

          <Text style={[styles.hint, { color: colors.mutedForeground }]}>
            {rangeMode
              ? rangeStart
                ? "Now tap the end date to select your range."
                : "Tap the start date of the range you want to block."
              : "Tap a date to add or manage a block."}
          </Text>

          {rangeMode && rangeStart && (
            <View style={[styles.selectionBadge, { backgroundColor: "#5C6BC0" + "20", borderColor: "#5C6BC0" + "55" }]}>
              <Feather name="map-pin" size={13} color="#5C6BC0" />
              <Text style={[styles.selectionBadgeText, { color: "#5C6BC0" }]}>
                Start: {formatDateLabel(rangeStart)} — tap end date
              </Text>
              <TouchableOpacity onPress={resetRange} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Feather name="x" size={14} color="#5C6BC0" />
              </TouchableOpacity>
            </View>
          )}

          <AvailabilityCalendar
            businessId={myBusiness.id}
            blockedSlots={blockedSlots}
            onDayPress={handleDayPress}
            mode="edit"
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            workDays={workDays}
            maxMonthsAhead={PLAN_BOOKING_HORIZON_MONTHS[myBusiness.subscriptionPlan]}
          />
        </View>

        {/* ── Blocked dates list ────────────────────────────────────── */}
        {mySlots.length > 0 && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Blocked Dates ({mySlots.length})</Text>
            {mySlots
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((slot) => (
                <View key={slot.id} style={[styles.slotRow, { borderBottomColor: colors.border }]}>
                  <View style={styles.slotInfo}>
                    <View style={[styles.slotDot, { backgroundColor: slot.allDay ? colors.destructive : "#FF9800" }]} />
                    <View>
                      <Text style={[styles.slotDate, { color: colors.foreground }]}>{formatDateLabel(slot.date)}</Text>
                      <Text style={[styles.slotMeta, { color: colors.mutedForeground }]}>
                        {slot.allDay
                          ? "All day"
                          : `${formatTime(slot.startTime ?? "")} – ${formatTime(slot.endTime ?? "")}`}
                        {slot.label ? ` · ${slot.label}` : ""}
                      </Text>
                    </View>
                  </View>
                  <TouchableOpacity
                    onPress={() => handleRemoveSlot(slot.id)}
                    style={styles.removeBtn}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Feather name="trash-2" size={16} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              ))}
          </View>
        )}
      </ScrollView>

      {/* ── Block modal ───────────────────────────────────────────────── */}
      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent
        onRequestClose={closeModal}
      >
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={closeModal} />
        <View style={[styles.sheet, { backgroundColor: colors.card, paddingBottom: insets.bottom + 20 }]}>
          <View style={styles.sheetHandle} />

          {/* Header */}
          <View style={styles.sheetTitleRow}>
            <Feather name={isRange ? "git-commit" : "calendar"} size={18} color="#5C6BC0" />
            <Text style={[styles.sheetTitle, { color: colors.foreground }]}>
              {isRange
                ? `${formatDateLabel(modalStart)} – ${formatDateLabel(modalEnd)}`
                : formatDateLabel(modalStart)}
            </Text>
          </View>
          {isRange && (
            <Text style={[styles.rangeCount, { color: colors.mutedForeground }]}>
              {rangeCount} day{rangeCount !== 1 ? "s" : ""} selected
            </Text>
          )}

          {/* Existing blocks (single-day only) */}
          {!isRange && slotsForDay.length > 0 && (
            <View style={styles.existingBlocks}>
              <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>Existing blocks</Text>
              {slotsForDay.map((s) => (
                <View key={s.id} style={[styles.existingRow, { backgroundColor: colors.secondary }]}>
                  <Text style={[styles.existingText, { color: colors.foreground }]}>
                    {s.allDay ? "All day" : `${formatTime(s.startTime ?? "")} – ${formatTime(s.endTime ?? "")}`}
                    {s.label ? ` · ${s.label}` : ""}
                  </Text>
                  <TouchableOpacity onPress={() => handleRemoveSlot(s.id)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                    <Feather name="x" size={16} color={colors.destructive} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          <Text style={[styles.subLabel, { color: colors.mutedForeground }]}>Block type</Text>

          {/* Block type picker */}
          <View style={styles.blockTypeRow}>
            {(["allDay", "morning", "evening", "holiday", "custom"] as BlockType[]).map((t) => {
              const labels: Record<BlockType, string> = {
                allDay: "All Day",
                morning: `Morning\n${hourLabel(startHour)}–${hourLabel(morningEnd)}`,
                evening: `Evening\n${hourLabel(eveningStart)}–${hourLabel(endHour)}`,
                holiday: "Holiday\nAll day",
                custom: "Custom",
              };
              const active = blockType === t;
              return (
                <TouchableOpacity
                  key={t}
                  style={[
                    styles.blockTypeBtn,
                    {
                      backgroundColor: active ? "#5C6BC0" : colors.secondary,
                      borderColor: active ? "#5C6BC0" : colors.border,
                    },
                  ]}
                  onPress={() => setBlockType(t)}
                  activeOpacity={0.8}
                >
                  <Text style={[styles.blockTypeBtnText, { color: active ? "#fff" : colors.mutedForeground }]}>
                    {labels[t]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Custom time inputs */}
          {blockType === "custom" && (
            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <Text style={[styles.timeFieldLabel, { color: colors.mutedForeground }]}>Start (HH:MM)</Text>
                <TextInput
                  style={[styles.timeInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
                  value={customStart}
                  onChangeText={setCustomStart}
                  placeholder="08:00"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
              </View>
              <View style={styles.timeField}>
                <Text style={[styles.timeFieldLabel, { color: colors.mutedForeground }]}>End (HH:MM)</Text>
                <TextInput
                  style={[styles.timeInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
                  value={customEnd}
                  onChangeText={setCustomEnd}
                  placeholder="12:00"
                  placeholderTextColor={colors.mutedForeground}
                  keyboardType="numbers-and-punctuation"
                  maxLength={5}
                />
              </View>
            </View>
          )}

          {/* Label */}
          <View style={styles.labelField}>
            <Text style={[styles.timeFieldLabel, { color: colors.mutedForeground }]}>Label (optional)</Text>
            <TextInput
              style={[styles.labelInput, { backgroundColor: colors.secondary, color: colors.foreground, borderColor: colors.border }]}
              value={blockLabel}
              onChangeText={setBlockLabel}
              placeholder="e.g. Holiday, Vacation, Site visit…"
              placeholderTextColor={colors.mutedForeground}
            />
          </View>

          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: "#5C6BC0" }]}
            onPress={handleAddBlock}
            activeOpacity={0.85}
          >
            <Feather name="slash" size={16} color="#fff" />
            <Text style={styles.addBtnText}>Block Selection</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.cancelBtn} onPress={closeModal}>
            <Text style={[styles.cancelText, { color: colors.mutedForeground }]}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
  emptyText: { fontSize: 15 },
  pageHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 14,
    borderBottomWidth: 1,
  },
  pageTitle: { fontSize: 22, fontWeight: "800" },
  scroll: { padding: 16, gap: 12 },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  hoursHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 14,
  },
  hoursHeaderLeft: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  hint: { fontSize: 12, lineHeight: 19 },
  sectionTitle: { fontSize: 15, fontWeight: "700" },
  subLabel: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5 },

  // Work days
  dayPills: { flexDirection: "row", gap: 6 },
  dayPill: {
    borderRadius: 20,
    borderWidth: 1.5,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dayPillText: { fontSize: 12, fontWeight: "700" },

  // Hour steppers
  hoursRow: { flexDirection: "row", alignItems: "flex-end", gap: 10 },
  hourField: { flex: 1, gap: 4 },
  hourFieldLabel: { fontSize: 12, fontWeight: "500" },
  stepper: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  stepperValue: { fontSize: 12, fontWeight: "700", textAlign: "center" },
  hoursNote: { fontSize: 12, lineHeight: 16, fontStyle: "italic" },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 12,
  },
  saveBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },

  // Mode toggle
  modeRow: { flexDirection: "row", gap: 8 },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "transparent",
    borderWidth: 1,
    borderColor: "transparent",
  },
  modeBtnText: { fontSize: 12, fontWeight: "600" },

  // Selection badge
  selectionBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  selectionBadgeText: { flex: 1, fontSize: 12, fontWeight: "600" },

  // Slot list
  slotRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  slotInfo: { flexDirection: "row", alignItems: "center", gap: 10, flex: 1 },
  slotDot: { width: 10, height: 10, borderRadius: 5 },
  slotDate: { fontSize: 15, fontWeight: "600" },
  slotMeta: { fontSize: 12, marginTop: 2 },
  removeBtn: { padding: 4 },

  // Modal
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 20,
  },
  sheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#ccc",
    alignSelf: "center",
    marginBottom: 4,
  },
  sheetTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  sheetTitle: { fontSize: 15, fontWeight: "800", flex: 1 },
  rangeCount: { fontSize: 12, marginTop: -6 },
  existingBlocks: { gap: 6 },
  existingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
    borderRadius: 10,
  },
  existingText: { fontSize: 12, flex: 1 },

  // Block type picker
  blockTypeRow: { flexDirection: "row", gap: 8 },
  blockTypeBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  blockTypeBtnText: { fontSize: 12, fontWeight: "700", textAlign: "center", lineHeight: 16 },

  // Time inputs
  timeRow: { flexDirection: "row", gap: 12 },
  timeField: { flex: 1, gap: 4 },
  timeFieldLabel: { fontSize: 12, fontWeight: "500" },
  timeInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontWeight: "600",
  },
  labelField: { gap: 4 },
  labelInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  addBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
  },
  addBtnText: { color: "#fff", fontSize: 15, fontWeight: "700" },
  cancelBtn: { alignItems: "center", paddingVertical: 4 },
  cancelText: { fontSize: 15 },
});
