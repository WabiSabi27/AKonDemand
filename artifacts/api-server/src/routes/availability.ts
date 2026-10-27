import { Router, type IRouter } from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  servicesTable,
  serviceOptionsTable,
  businessesTable,
  businessEmployeesTable,
  blockedSlotsTable,
  bookingsTable,
} from "@workspace/db";
import { GetAvailabilityQueryParams, GetAvailabilityResponse } from "@workspace/api-zod";
import { timeToMinutes, minutesToTime, parseDurationMinutes } from "../lib/time";
import { parsePlanTier, DEFAULT_PLAN_TIER, PLAN_BOOKING_HORIZON_MONTHS } from "../lib/plans";

const router: IRouter = Router();

const SLOT_STEP = 30;

/**
 * Add `months` whole months to a date and return the YYYY-MM-DD string. Used to
 * cap how far ahead a customer may book under the SP's plan. Mirrors bookings.ts.
 */
function addMonthsISO(from: Date, months: number): string {
  const d = new Date(from);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

router.get("/availability", async (req, res) => {
  // Guard required query params (see blockedSlots.ts for rationale).
  for (const key of ["serviceId", "date"] as const) {
    if (typeof req.query[key] !== "string" || req.query[key] === "") {
      res.status(400).json({ error: `${key} is required` });
      return;
    }
  }
  const { serviceId, date } = GetAvailabilityQueryParams.parse(req.query);

  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, serviceId));
  if (!svc || svc.deletedAt) {
    req.log.warn({ serviceId }, "availability: service not found");
    res.status(404).json({ error: "Service not found" });
    return;
  }

  const [biz] = await db.select().from(businessesTable).where(eq(businessesTable.id, svc.businessId));
  if (!biz) {
    req.log.warn({ businessId: svc.businessId }, "availability: business not found");
    res.status(404).json({ error: "Business not found" });
    return;
  }

  // Per-plan booking horizon: the SP's plan caps how far ahead a customer may
  // book. We never emit slots past that date so the customer calendar and the
  // booking-create guard (bookings.ts) stay consistent.
  const bookingPlan = parsePlanTier(biz.subscriptionPlan) ?? DEFAULT_PLAN_TIER;
  const maxBookingDate = addMonthsISO(new Date(), PLAN_BOOKING_HORIZON_MONTHS[bookingPlan]);
  const beyondHorizon = date > maxBookingDate;

  const [options, employees, daySlots, dayBookings] = await Promise.all([
    db.select().from(serviceOptionsTable).where(and(
      eq(serviceOptionsTable.serviceId, serviceId),
      isNull(serviceOptionsTable.deletedAt),
    )),
    db.select().from(businessEmployeesTable).where(eq(businessEmployeesTable.businessId, biz.id)),
    db.select().from(blockedSlotsTable).where(
      and(eq(blockedSlotsTable.businessId, biz.id), eq(blockedSlotsTable.date, date)),
    ),
    db.select().from(bookingsTable).where(
      and(
        eq(bookingsTable.businessId, biz.id),
        eq(bookingsTable.scheduledDate, date),
        or(eq(bookingsTable.status, "pending"), eq(bookingsTable.status, "confirmed")),
      ),
    ),
  ]);

  // Use the shortest available option duration as the planning unit (mirrors mobile).
  const optionDurations = options
    .map((o) => parseDurationMinutes(o.duration))
    .filter((n): n is number => n !== null);
  const durationMin = optionDurations.length > 0 ? Math.min(...optionDurations) : null;

  // SP-pinned start times: collapse the slot list to ONLY the SP's chosen
  // start time(s) when EVERY parseable option carries an effective start time.
  // We require unanimity because mixing short (multi-slot) and long (pinned)
  // options on the same service would otherwise force the short options into
  // the long-option's single window — which is not what either side wants.
  //
  // Long-duration options (≥ 8h, e.g. "Full day") are treated as implicitly
  // pinned to "08:00" when the SP didn't set one explicitly. Rationale: the
  // mobile SP form already auto-prefills 08:00 for new long-duration options,
  // but legacy/seed rows have NULL — without this normalization, customers
  // see a 30-minute grid (7:00, 7:30, …) for full-day services, which is
  // confusing and not what the SP intends. Explicit SP picks always win.
  const LONG_DURATION_MIN = 8 * 60;
  const DEFAULT_LONG_START = "08:00";
  const effectiveStart = (o: { defaultStartTime: string | null; duration: string }): string | null => {
    const raw = o.defaultStartTime?.trim();
    if (raw && /^\d{2}:\d{2}$/.test(raw)) return raw;
    const dur = parseDurationMinutes(o.duration);
    return dur !== null && dur >= LONG_DURATION_MIN ? DEFAULT_LONG_START : null;
  };
  const optionsWithDuration = options.filter(
    (o) => parseDurationMinutes(o.duration) !== null,
  );
  const allOptionsPinned =
    optionsWithDuration.length > 0 &&
    optionsWithDuration.every((o) => effectiveStart(o) !== null);
  const pinnedStarts = allOptionsPinned
    ? Array.from(
        new Set(optionsWithDuration.map((o) => effectiveStart(o)!)),
      )
        .map((t) => timeToMinutes(t))
        .sort((a, b) => a - b)
    : [];

  const requiredSpec = svc.requiredSpecialty?.trim() || undefined;
  const qualifiedEmployees = requiredSpec
    ? employees.filter((e) => e.specialty === requiredSpec)
    : employees;
  const capacity = requiredSpec
    ? qualifiedEmployees.length
    : Math.max(qualifiedEmployees.length, 1);

  const allDayBlocked = daySlots.some((s) => s.allDay);

  // Phase 3 #3 — vacation gate. If the SP set a vacation window and the
  // requested date falls inside it (inclusive), short-circuit to an empty
  // slot list and surface the window so the client can render an OOO banner.
  const onVacation =
    !!biz.vacationFrom &&
    !!biz.vacationUntil &&
    date >= biz.vacationFrom &&
    date <= biz.vacationUntil;
  const vacation = onVacation
    ? {
        active: true,
        from: biz.vacationFrom!,
        until: biz.vacationUntil!,
        message: biz.vacationMessage,
      }
    : null;

  // Honor business workDays if configured.
  const dow = new Date(`${date}T00:00:00`).getUTCDay();
  const workDays = biz.hours?.workDays;
  const isWorkDay = !workDays || workDays.includes(dow);

  const bizStart = (biz.hours?.startHour ?? 7) * 60;
  const bizEnd = (biz.hours?.endHour ?? 20) * 60;

  const slots: { time: string; available: boolean; remaining: number; reason: string | null }[] = [];

  if (durationMin !== null && isWorkDay && !allDayBlocked && capacity > 0 && !onVacation && !beyondHorizon) {
    const maxStart = bizEnd - durationMin;
    // When the SP pinned start times, walk only those (filtered to fit the day).
    // Otherwise fall back to the standard 30-minute grid.
    const startTimes: number[] = pinnedStarts.length > 0
      ? pinnedStarts.filter((t) => t >= bizStart && t <= maxStart)
      : (() => {
          const out: number[] = [];
          for (let t = bizStart; t <= maxStart; t += SLOT_STEP) out.push(t);
          return out;
        })();

    for (const t of startTimes) {
      const endMin = t + durationMin;

      let blocked = false;
      for (const s of daySlots) {
        if (s.startTime && s.endTime) {
          const bs = timeToMinutes(s.startTime);
          const be = timeToMinutes(s.endTime);
          if (t < be && endMin > bs) { blocked = true; break; }
        }
      }

      const overlapping = dayBookings.filter((b) => {
        if (!b.scheduledTime || !b.durationMinutes) return false;
        const bStart = timeToMinutes(b.scheduledTime);
        const bEnd = bStart + b.durationMinutes;
        return t < bEnd && endMin > bStart;
      }).length;

      const remaining = Math.max(0, capacity - overlapping);
      const available = !blocked && remaining > 0;
      // `remaining` is 0 whenever the slot is blocked OR fully booked, so the
      // mobile UI can render "1 spot left" / "Fully booked" / "Blocked" purely
      // from (available, remaining, reason) without re-running capacity math.
      slots.push({
        time: minutesToTime(t),
        available,
        remaining: blocked ? 0 : remaining,
        reason: blocked ? "blocked" : remaining === 0 ? "fully booked" : null,
      });
    }
  }

  req.log.info(
    { serviceId, date, capacity, slotCount: slots.length, allDayBlocked, isWorkDay, onVacation },
    "availability",
  );

  res.json(GetAvailabilityResponse.parse({ serviceId, date, slots, capacity, vacation }));
});

export default router;
