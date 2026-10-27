/**
 * /me/calendar — SP-self-service calendar sync (Phase 3 #8).
 *
 * Outbound:  the SP fetches their feed URL, copies it into Google/Apple
 *   Calendar's "Add by URL" field, and watches their bookings appear.
 *   `regenerate` mints a fresh token, invalidating the old URL.
 *
 * Inbound:  the SP saves an external iCal URL (their personal Google
 *   Calendar's "secret address in iCal format"). `sync` fetches + parses
 *   the feed and projects busy events into `blocked_slots` rows with
 *   `source = 'imported_ical'`. The sync replaces all prior imports — there
 *   is no diff/merge — which keeps the implementation tiny and deterministic.
 */

import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  businessesTable,
  blockedSlotsTable,
  type InsertBlockedSlot,
} from "@workspace/db";
import { requireRole } from "../middlewares/auth";
import { genId } from "../lib/ids";
import { fetchAndParseBusy } from "../lib/ical";

/**
 * Convert an absolute Date into Juneau wall-clock components. We use
 * `Intl.DateTimeFormat` with the `America/Juneau` zone so DST is handled
 * correctly — getting this wrong was the bug the architect flagged: a
 * Google event saved as 9:00 AM Juneau time arrives as a Date whose UTC
 * value is 17:00 (or 18:00 outside DST), and writing those UTC numerals
 * directly into `blocked_slots.startTime` would block the wrong hours of
 * the SP's day.
 */
const JUNEAU_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Juneau",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
function juneauWallParts(d: Date): { date: string; time: string } {
  const parts = Object.fromEntries(
    JUNEAU_PARTS.formatToParts(d).map((p) => [p.type, p.value]),
  );
  // Intl returns "24" for midnight under hour12:false; normalise to "00".
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${hour}:${parts.minute}`,
  };
}

const router: IRouter = Router();

/** Build the public feed URL from the request's host header. */
function buildFeedUrl(req: { protocol: string; get(name: string): string | undefined }, token: string): string {
  // Use REPLIT_DOMAINS in production (the request host can be anything when
  // proxied); fall back to req host header for dev.
  const prodDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  const host = prodDomain ?? req.get("host") ?? "localhost";
  const proto = prodDomain ? "https" : (req.protocol ?? "http");
  return `${proto}://${host}/api/ical/sp/${token}.ics`;
}

router.get("/me/calendar", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const [biz] = await db
    .select({
      icalToken: businessesTable.icalToken,
      externalCalendarUrl: businessesTable.externalCalendarUrl,
      externalCalendarLastSyncAt: businessesTable.externalCalendarLastSyncAt,
      externalCalendarLastError: businessesTable.externalCalendarLastError,
    })
    .from(businessesTable)
    .where(eq(businessesTable.id, auth.businessId));
  if (!biz) {
    res.status(404).json({ error: "Business not found" });
    return;
  }

  res.json({
    feedUrl: biz.icalToken ? buildFeedUrl(req, biz.icalToken) : null,
    externalCalendarUrl: biz.externalCalendarUrl,
    lastSyncAt: biz.externalCalendarLastSyncAt?.toISOString() ?? null,
    lastError: biz.externalCalendarLastError,
  });
});

/** Mint a fresh token; invalidates any prior feed URL. */
router.post("/me/calendar/regenerate", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  // 24 random bytes → 32 base64url chars = 192 bits of entropy.
  const token = randomBytes(24).toString("base64url");
  await db
    .update(businessesTable)
    .set({ icalToken: token })
    .where(eq(businessesTable.id, auth.businessId));

  req.log.info({ businessId: auth.businessId }, "calendar.tokenRegenerated");
  res.json({ feedUrl: buildFeedUrl(req, token) });
});

/** Save the inbound iCal URL the SP wants pulled into AKODD. */
router.put("/me/calendar/external", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    res.status(400).json({ error: "url is not a valid URL" });
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "webcal:") {
    res.status(400).json({ error: "url must use https:// or webcal://" });
    return;
  }

  await db
    .update(businessesTable)
    .set({
      externalCalendarUrl: url,
      // Reset error/sync stamps — caller can hit /sync next.
      externalCalendarLastError: null,
    })
    .where(eq(businessesTable.id, auth.businessId));

  req.log.info({ businessId: auth.businessId }, "calendar.externalUrlSet");
  res.status(204).send();
});

/** Clear the inbound URL and remove any imported blocks. */
router.delete("/me/calendar/external", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(businessesTable)
      .set({
        externalCalendarUrl: null,
        externalCalendarLastSyncAt: null,
        externalCalendarLastError: null,
      })
      .where(eq(businessesTable.id, auth.businessId!));
    await tx
      .delete(blockedSlotsTable)
      .where(
        and(
          eq(blockedSlotsTable.businessId, auth.businessId!),
          eq(blockedSlotsTable.source, "imported_ical"),
        ),
      );
  });

  req.log.info({ businessId: auth.businessId }, "calendar.externalUrlCleared");
  res.status(204).send();
});

/** Sync the inbound URL: fetch, parse, replace all prior imported blocks. */
router.post("/me/calendar/external/sync", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const [biz] = await db
    .select()
    .from(businessesTable)
    .where(eq(businessesTable.id, auth.businessId));
  if (!biz) {
    res.status(404).json({ error: "Business not found" });
    return;
  }
  if (!biz.externalCalendarUrl) {
    res.status(400).json({ error: "No external calendar URL set" });
    return;
  }

  // Pull events from today through 365 days out — covers any reasonable
  // booking horizon without exploding on calendars with infinite recurrences.
  const now = new Date();
  const windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const windowEnd = new Date(windowStart.getTime() + 365 * 24 * 60 * 60 * 1000);

  let busyEvents;
  try {
    busyEvents = await fetchAndParseBusy(biz.externalCalendarUrl, windowStart, windowEnd);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown sync error";
    await db
      .update(businessesTable)
      .set({ externalCalendarLastError: message, externalCalendarLastSyncAt: new Date() })
      .where(eq(businessesTable.id, auth.businessId));
    req.log.warn({ businessId: auth.businessId, error: message }, "calendar.syncFailed");
    res.status(502).json({ error: `Failed to fetch external calendar: ${message}` });
    return;
  }

  // Project each busy event into 1+ blocked_slots rows (one per local day it spans).
  const newRows: InsertBlockedSlot[] = [];
  for (const ev of busyEvents) {
    if (ev.allDay) {
      // Walk each calendar day from start (inclusive) to end (exclusive per RFC 5545).
      const cursor = new Date(ev.start);
      while (cursor < ev.end) {
        newRows.push({
          id: genId("bs"),
          businessId: auth.businessId,
          date: cursor.toISOString().slice(0, 10),
          allDay: true,
          startTime: null,
          endTime: null,
          label: ev.summary,
          source: "imported_ical",
          externalUid: ev.uid,
        });
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }
    } else {
      // Time fields on `blocked_slots` are Juneau wall-clock strings — same
      // model used by `/availability` — so we project the absolute Date back
      // through the America/Juneau zone, NOT toISOString() which would write
      // UTC numerals.
      const startWall = juneauWallParts(ev.start);
      const endWall = juneauWallParts(ev.end);
      if (startWall.date === endWall.date) {
        newRows.push({
          id: genId("bs"),
          businessId: auth.businessId,
          date: startWall.date,
          allDay: false,
          startTime: startWall.time,
          endTime: endWall.time,
          label: ev.summary,
          source: "imported_ical",
          externalUid: ev.uid,
        });
      } else {
        // Multi-day timed event — collapse to all-day blocks for each Juneau
        // calendar day the event touches.
        const [sy, sm, sd] = startWall.date.split("-").map(Number);
        const [ey, em, ed] = endWall.date.split("-").map(Number);
        const cursor = new Date(Date.UTC(sy, sm - 1, sd));
        const last = new Date(Date.UTC(ey, em - 1, ed));
        while (cursor <= last) {
          newRows.push({
            id: genId("bs"),
            businessId: auth.businessId,
            date: cursor.toISOString().slice(0, 10),
            allDay: true,
            startTime: null,
            endTime: null,
            label: ev.summary,
            source: "imported_ical",
            externalUid: ev.uid,
          });
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(blockedSlotsTable)
      .where(
        and(
          eq(blockedSlotsTable.businessId, auth.businessId!),
          eq(blockedSlotsTable.source, "imported_ical"),
        ),
      );
    if (newRows.length > 0) {
      await tx.insert(blockedSlotsTable).values(newRows);
    }
    await tx
      .update(businessesTable)
      .set({
        externalCalendarLastSyncAt: new Date(),
        externalCalendarLastError: null,
      })
      .where(eq(businessesTable.id, auth.businessId!));
  });

  req.log.info(
    { businessId: auth.businessId, importedRows: newRows.length, rawEvents: busyEvents.length },
    "calendar.synced",
  );
  res.json({
    importedBlocks: newRows.length,
    syncedAt: new Date().toISOString(),
  });
});

export default router;
