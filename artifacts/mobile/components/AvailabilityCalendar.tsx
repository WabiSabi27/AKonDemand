import { Feather } from "@expo/vector-icons";
import React, { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";

import type { PlanTier } from "@workspace/api-client-react";

import type { BlockedSlot } from "@/context/AppContext";
import { useColors } from "@/hooks/useColors";

/**
 * How far ahead (whole months) customers may book an SP, per plan tier. Mirrors
 * the server's PLAN_BOOKING_HORIZON_MONTHS (lib/plans.ts) — the server is the
 * hard enforcer; this only clamps the customer calendar's month navigation so
 * we never surface days the server would reject.
 */
export const PLAN_BOOKING_HORIZON_MONTHS: Record<PlanTier, number> = {
  starter_gigger: 3,
  pro_business: 6,
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate();
}
function getFirstDayOfMonth(year: number, month: number) {
  return new Date(year, month, 1).getDay();
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function dateStr(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface Props {
  businessId: string;
  blockedSlots: BlockedSlot[];
  onDayPress?: (date: string, existing: BlockedSlot[]) => void;
  mode?: "view" | "edit";
  initialYear?: number;
  initialMonth?: number;
  rangeStart?: string | null;
  rangeEnd?: string | null;
  workDays?: number[];
  serviceDurationMin?: number;
  businessStartHour?: number;
  businessEndHour?: number;
  /** Clamp forward month navigation to this many months ahead (per SP plan). Defaults to 6 (max tier). */
  maxMonthsAhead?: number;
}

function tToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + (m || 0);
}

function hasSufficientWindow(
  durationMin: number,
  daySlots: BlockedSlot[],
  dayStartMin: number,
  dayEndMin: number,
): boolean {
  if (daySlots.some((s) => s.allDay)) return false;
  if (dayEndMin - dayStartMin < durationMin) return false;

  const blocks: [number, number][] = daySlots
    .filter((s) => !s.allDay && s.startTime && s.endTime)
    .map((s): [number, number] => [tToMin(s.startTime!), tToMin(s.endTime!)])
    .filter(([, e]) => e > dayStartMin)
    .filter(([s]) => s < dayEndMin);

  blocks.sort((a, b) => a[0] - b[0]);

  let freeStart = dayStartMin;
  for (const [bStart, bEnd] of blocks) {
    const windowEnd = Math.min(bStart, dayEndMin);
    if (windowEnd - freeStart >= durationMin) return true;
    freeStart = Math.max(freeStart, Math.min(bEnd, dayEndMin));
  }
  return dayEndMin - freeStart >= durationMin;
}

function getWindow(maxMonthsAhead: number) {
  const now = new Date();
  const minYear = now.getFullYear();
  const minMonth = now.getMonth();
  const maxDate = new Date(now.getFullYear(), now.getMonth() + maxMonthsAhead, 1);
  const maxYear = maxDate.getFullYear();
  const maxMonth = maxDate.getMonth();
  return { minYear, minMonth, maxYear, maxMonth };
}

export function AvailabilityCalendar({
  businessId,
  blockedSlots,
  onDayPress,
  mode = "view",
  initialYear,
  initialMonth,
  rangeStart,
  rangeEnd,
  workDays,
  serviceDurationMin,
  businessStartHour = 7,
  businessEndHour = 20,
  maxMonthsAhead = 6,
}: Props) {
  const bizStartMin = businessStartHour * 60;
  const bizEndMin = businessEndHour * 60;
  const colors = useColors();
  const { minYear, minMonth, maxYear, maxMonth } = getWindow(maxMonthsAhead);

  const defaultYear = initialYear ?? 2026;
  const defaultMonth = initialMonth ?? 4;

  const [viewYear, setViewYear] = useState(defaultYear);
  const [viewMonth, setViewMonth] = useState(defaultMonth);

  const today = todayStr();
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);

  const mySlots = blockedSlots.filter((s) => s.businessId === businessId);

  function slotsForDate(d: string) {
    return mySlots.filter((s) => s.date === d);
  }

  function inRange(ds: string) {
    if (!rangeStart) return false;
    if (!rangeEnd) return ds === rangeStart;
    const lo = rangeStart < rangeEnd ? rangeStart : rangeEnd;
    const hi = rangeStart < rangeEnd ? rangeEnd : rangeStart;
    return ds >= lo && ds <= hi;
  }

  const atMin = viewYear === minYear && viewMonth === minMonth;
  const atMax = viewYear === maxYear && viewMonth === maxMonth;

  function prevMonth() {
    if (atMin) return;
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  }
  function nextMonth() {
    if (atMax) return;
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  }

  const cells: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const rows: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));

  return (
    <View>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={prevMonth}
          style={[styles.navBtn, atMin && styles.navBtnDisabled]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          disabled={atMin}
        >
          <Feather name="chevron-left" size={22} color={atMin ? colors.mutedForeground : colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.monthLabel, { color: colors.foreground }]}>
          {MONTH_NAMES[viewMonth]} {viewYear}
        </Text>
        <TouchableOpacity
          onPress={nextMonth}
          style={[styles.navBtn, atMax && styles.navBtnDisabled]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          disabled={atMax}
        >
          <Feather name="chevron-right" size={22} color={atMax ? colors.mutedForeground : colors.foreground} />
        </TouchableOpacity>
      </View>

      <View style={styles.dayLabels}>
        {DAY_LABELS.map((l, idx) => {
          const isOff = workDays !== undefined && !workDays.includes(idx);
          return (
            <Text
              key={l}
              style={[
                styles.dayLabel,
                { color: isOff ? colors.mutedForeground + "66" : colors.mutedForeground },
              ]}
            >
              {l}
            </Text>
          );
        })}
      </View>

      {rows.map((row, ri) => (
        <View key={ri} style={styles.week}>
          {Array.from({ length: 7 }).map((_, ci) => {
            const day = row[ci] ?? null;
            if (day === null) return <View key={ci} style={styles.cell} />;

            const ds = dateStr(viewYear, viewMonth, day);
            const slots = slotsForDate(ds);
            const allDayBlocked = slots.some((s) => s.allDay);
            const hasTimeBlock = slots.some((s) => !s.allDay);
            const isToday = ds === today;
            const isPast = ds < today;
            const dayOfWeek = new Date(viewYear, viewMonth, day).getDay();
            const isOffDay = workDays !== undefined && !workDays.includes(dayOfWeek);
            const isRangeSelected = inRange(ds);
            const isRangeEndpoint = ds === rangeStart || ds === rangeEnd;

            // Duration-aware availability: day only counts as available if
            // there is a contiguous free window >= serviceDurationMin
            const isAvailable = mode === "view" && !isPast && (
              serviceDurationMin !== undefined
                ? hasSufficientWindow(serviceDurationMin, slots, bizStartMin, bizEndMin)
                : !allDayBlocked
            );

            let bgColor: string = "transparent";
            let textColor = isOffDay ? colors.mutedForeground + "55" : colors.foreground;
            let borderColor = "transparent";

            if (isRangeSelected) {
              bgColor = "#5C6BC0" + "30";
              borderColor = isRangeEndpoint ? "#5C6BC0" : "#5C6BC0" + "55";
            } else if (!isAvailable && mode === "view" && !isPast && serviceDurationMin !== undefined) {
              bgColor = colors.destructive + "22";
              borderColor = colors.destructive + "66";
              textColor = colors.mutedForeground;
            } else if (allDayBlocked) {
              bgColor = colors.destructive + "22";
              borderColor = colors.destructive + "66";
              textColor = mode === "view" ? colors.mutedForeground : colors.foreground;
            } else if (hasTimeBlock) {
              bgColor = "#FF9800" + "18";
              borderColor = "#FF9800" + "88";
            } else if (isToday) {
              borderColor = colors.accent;
            }

            if (isPast && mode === "view") {
              textColor = colors.mutedForeground;
            }

            return (
              <TouchableOpacity
                key={ci}
                style={[
                  styles.cell,
                  {
                    backgroundColor: isAvailable ? colors.accent + "12" : bgColor,
                    borderWidth: (isToday || allDayBlocked || hasTimeBlock || isAvailable || isRangeSelected) ? 1.5 : 0,
                    borderColor: isAvailable ? colors.accent + "55" : borderColor,
                    borderRadius: 8,
                    opacity: isOffDay && !isRangeSelected && mode === "edit" ? 0.45 : 1,
                  },
                ]}
                onPress={() => onDayPress?.(ds, slots)}
                disabled={!onDayPress || (mode === "view" && !isAvailable && !isPast && serviceDurationMin !== undefined)}
                activeOpacity={0.7}
              >
                <Text style={[
                  styles.dayNum,
                  {
                    color: isRangeEndpoint ? "#5C6BC0" : isToday ? colors.accent : textColor,
                    fontWeight: isToday || isRangeEndpoint ? "800" : "400",
                  },
                ]}>
                  {day}
                </Text>
                {allDayBlocked && !isRangeSelected && (
                  <View style={[styles.dot, { backgroundColor: colors.destructive }]} />
                )}
                {hasTimeBlock && !allDayBlocked && !isRangeSelected && (
                  <View style={[styles.dot, { backgroundColor: "#FF9800" }]} />
                )}
                {isAvailable && !allDayBlocked && !hasTimeBlock && !isRangeSelected && (
                  <View style={[styles.dot, { backgroundColor: colors.accent }]} />
                )}
                {isRangeSelected && (
                  <View style={[styles.dot, { backgroundColor: "#5C6BC0" }]} />
                )}
              </TouchableOpacity>
            );
          })}
        </View>
      ))}

      <View style={styles.legend}>
        {mode === "edit" ? (
          <>
            <LegendItem color={colors.destructive} label="Blocked (full day)" />
            <LegendItem color="#FF9800" label="Partial block" />
            <LegendItem color="#5C6BC0" label="Selected" />
          </>
        ) : (
          <>
            <LegendItem color={colors.accent} label={serviceDurationMin !== undefined ? "Time slot fits" : "Available"} />
            <LegendItem color={colors.destructive} label={serviceDurationMin !== undefined ? "No slot available" : "Unavailable"} />
          </>
        )}
        <LegendItem color={colors.accent} label="Today" outline />
      </View>
    </View>
  );
}

function LegendItem({ color, label, outline }: { color: string; label: string; outline?: boolean }) {
  const colors = useColors();
  return (
    <View style={styles.legendItem}>
      <View style={[
        styles.legendDot,
        outline
          ? { borderWidth: 2, borderColor: color, backgroundColor: "transparent" }
          : { backgroundColor: color },
      ]} />
      <Text style={[styles.legendLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  navBtn: { padding: 4 },
  navBtnDisabled: { opacity: 0.3 },
  monthLabel: { fontSize: 18, fontWeight: "700" },
  dayLabels: {
    flexDirection: "row",
    marginBottom: 4,
  },
  dayLabel: {
    flex: 1,
    textAlign: "center",
    fontSize: 12,
    fontWeight: "600",
  },
  week: {
    flexDirection: "row",
    marginBottom: 4,
  },
  cell: {
    flex: 1,
    aspectRatio: 1,
    alignItems: "center",
    justifyContent: "center",
    margin: 1,
  },
  dayNum: { fontSize: 12 },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginTop: 2,
  },
  legend: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginTop: 12,
    justifyContent: "center",
  },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendLabel: { fontSize: 12 },
});
