/**
 * GET /ical/sp/:token.ics — public iCal feed for an SP.
 *
 * The token IS the auth: it's a 192-bit random base64url string the SP gets
 * from `GET /me/calendar` and pastes into Google/Apple Calendar's "Add by URL"
 * field. There's no account UI for the customer to access this; revealing
 * it only exposes the SP's bookings to whoever holds the URL.
 *
 * If the SP suspects the URL leaked, they regenerate the token via
 * `POST /me/calendar/regenerate` and the old URL stops working immediately.
 *
 * The response includes:
 *   - confirmed + pending bookings   →  one VEVENT per booking
 *   - blocked slots (manual + imported)  →  one VEVENT per row
 *   - active vacation window         →  a single all-day VEVENT spanning the window
 */

import { Router, type IRouter } from "express";
import { and, eq, gte, inArray } from "drizzle-orm";
import {
  db,
  businessesTable,
  bookingsTable,
  blockedSlotsTable,
} from "@workspace/db";
import { renderIcs, type IcsEvent } from "../lib/ical";
import { timeToMinutes } from "../lib/time";

const router: IRouter = Router();

// Same juneau-local interpretation we use everywhere else: the scheduled
// date/time strings are wall-clock times in Juneau (Alaska Time, UTC-9 / -8).
// We don't do TZ-aware iCal output — instead we emit UTC times computed by
// treating the wall-clock as Alaska Time. Calendar clients render that fine.
const JUNEAU_TZ_OFFSET_HOURS = -9; // AKST; AKDT is -8 but the +/- 1h drift in
// wall-clock display is acceptable for the first cut. A future change can
// emit `DTSTART;TZID=America/Juneau` + a VTIMEZONE block if customers demand
// pixel-perfect DST behaviour.

function juneauWallToUtc(date: string, time: string | null, defaultTimeMin = 0): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const min = time ? timeToMinutes(time) : defaultTimeMin;
  const hours = Math.floor(min / 60);
  const minutes = min % 60;
  // Wall clock minus the offset = UTC. AK is behind UTC, so subtracting the
  // negative offset adds 9 hours.
  return new Date(Date.UTC(y, mo - 1, d, hours - JUNEAU_TZ_OFFSET_HOURS, minutes));
}

router.get("/ical/sp/:token.ics", async (req, res) => {
  const token = req.params.token;
  if (!token || token.length < 16) {
    res.status(404).send("Not found");
    return;
  }

  const [biz] = await db
    .select()
    .from(businessesTable)
    .where(eq(businessesTable.icalToken, token));
  if (!biz) {
    res.status(404).send("Not found");
    return;
  }

  // Pull bookings from today onwards — past bookings are uninteresting clutter
  // in the SP's calendar and bloat the feed for power users.
  const today = new Date().toISOString().slice(0, 10);
  const [bookings, blocks] = await Promise.all([
    db
      .select()
      .from(bookingsTable)
      .where(
        and(
          eq(bookingsTable.businessId, biz.id),
          gte(bookingsTable.scheduledDate, today),
          // Only export bookings the customer is committed to. Pending/declined
          // shouldn't show as committed time on the SP's personal calendar, and
          // cancelled is obvious. (`ne(status,"cancelled")` would over-export.)
          inArray(bookingsTable.status, ["confirmed", "completed"]),
        ),
      ),
    db
      .select()
      .from(blockedSlotsTable)
      .where(
        and(
          eq(blockedSlotsTable.businessId, biz.id),
          gte(blockedSlotsTable.date, today),
          // Skip imported_ical rows — those came FROM the SP's own calendar via
          // /me/calendar/external/sync, so re-exporting them creates a feedback
          // loop where the same event echoes back doubled-up.
          eq(blockedSlotsTable.source, "manual"),
        ),
      ),
  ]);

  const events: IcsEvent[] = [];

  for (const bk of bookings) {
    // No scheduled time means "contact provider" — model these as all-day so
    // the SP at least sees something on the right day.
    if (!bk.scheduledTime) {
      const startDate = new Date(`${bk.scheduledDate}T00:00:00Z`);
      const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      events.push({
        uid: `booking-${bk.id}@akodd`,
        summary: `${bk.serviceTitle} — ${bk.customerName}`,
        description: `${bk.optionName} · status: ${bk.status}\nBooking ${bk.id}`,
        start: startDate,
        end: endDate,
        allDay: true,
      });
      continue;
    }

    const start = juneauWallToUtc(bk.scheduledDate, bk.scheduledTime);
    const durationMin = bk.durationMinutes ?? 60;
    const end = new Date(start.getTime() + durationMin * 60 * 1000);
    events.push({
      uid: `booking-${bk.id}@akodd`,
      summary: `${bk.serviceTitle} — ${bk.customerName}`,
      description: `${bk.optionName} · status: ${bk.status}\nTotal: $${bk.total}\nBooking ${bk.id}`,
      start,
      end,
    });
  }

  for (const bs of blocks) {
    const summary = bs.label ?? "Blocked";
    if (bs.allDay || !bs.startTime || !bs.endTime) {
      const startDate = new Date(`${bs.date}T00:00:00Z`);
      const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
      events.push({
        uid: `block-${bs.id}@akodd`,
        summary,
        start: startDate,
        end: endDate,
        allDay: true,
      });
    } else {
      const start = juneauWallToUtc(bs.date, bs.startTime);
      const end = juneauWallToUtc(bs.date, bs.endTime);
      events.push({
        uid: `block-${bs.id}@akodd`,
        summary,
        start,
        end,
      });
    }
  }

  // Vacation window — emit a single multi-day all-day VEVENT.
  if (biz.vacationFrom && biz.vacationUntil && biz.vacationUntil >= today) {
    const startDate = new Date(`${biz.vacationFrom}T00:00:00Z`);
    // iCal all-day DTEND is exclusive — add a day to include the last vacation date.
    const lastDay = new Date(`${biz.vacationUntil}T00:00:00Z`);
    const endDate = new Date(lastDay.getTime() + 24 * 60 * 60 * 1000);
    events.push({
      uid: `vacation-${biz.id}@akodd`,
      summary: biz.vacationMessage ?? "Out of office",
      start: startDate,
      end: endDate,
      allDay: true,
    });
  }

  const body = renderIcs({
    prodId: "AK On Demand LLC",
    calendarName: `${biz.name} — AK On Demand`,
    events,
  });

  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", `inline; filename="akodd-${biz.id}.ics"`);
  // Calendar clients re-fetch every ~hour; keep the cache short so SP edits
  // show up promptly.
  res.setHeader("Cache-Control", "private, max-age=300");
  res.status(200).send(body);

  req.log.info(
    { businessId: biz.id, eventCount: events.length },
    "icalFeed.served",
  );
});

export default router;
