import { Router, type IRouter } from "express";
import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import {
  db,
  bookingsTable,
  businessesTable,
  messagesTable,
} from "@workspace/db";
import { SendBookingMessageBody } from "@workspace/api-zod";
import { requireUser } from "../middlewares/auth";
import { genId } from "../lib/ids";
import { createNotification } from "../lib/notifications";

const router: IRouter = Router();

const MAX_MESSAGE_LEN = 2000;

/**
 * Resolve the booking + the auth-checked "side" the caller is on. Returns
 * `{ booking, role }` if the caller is authorised to read/write the thread,
 * otherwise sends the appropriate response and returns null.
 *
 *  - customer  → must equal booking.customerId
 *  - business  → must equal booking.businessId AND own that business
 *  - admin     → may read but is not a participant; we deny so that admins
 *                don't accidentally appear as either side. (No current
 *                product need to allow admin chat.)
 */
async function resolveParticipant(
  bookingId: string,
  auth: { role: string; userId: string; businessId?: string | null },
): Promise<
  | { ok: true; booking: typeof bookingsTable.$inferSelect; role: "customer" | "business" }
  | { ok: false; status: number; error: string }
> {
  const [booking] = await db
    .select()
    .from(bookingsTable)
    .where(eq(bookingsTable.id, bookingId));
  if (!booking) return { ok: false, status: 404, error: "Booking not found" };

  if (auth.role === "customer") {
    if (booking.customerId !== auth.userId) {
      return { ok: false, status: 403, error: "Not your booking" };
    }
    return { ok: true, booking, role: "customer" };
  }
  if (auth.role === "business") {
    if (!auth.businessId || auth.businessId !== booking.businessId) {
      return { ok: false, status: 403, error: "Not your booking" };
    }
    return { ok: true, booking, role: "business" };
  }
  // Admin or anything else: not a participant.
  return { ok: false, status: 403, error: "Only the booking's customer or service provider can use this thread" };
}

/**
 * GET /bookings/:id/messages — list the full thread oldest-first.
 *
 * Query: `?after=<ISO timestamp>` — when present, returns only messages
 * created strictly after that timestamp (used by the mobile client for
 * incremental polling without re-downloading the whole thread). Invalid
 * `after` values are silently ignored (treated as "no filter").
 */
router.get("/bookings/:id/messages", requireUser, async (req, res) => {
  const id = String(req.params.id);
  const part = await resolveParticipant(id, req.auth!);
  if (!part.ok) {
    res.status(part.status).json({ error: part.error });
    return;
  }

  const filters = [eq(messagesTable.bookingId, id)];
  const afterRaw = typeof req.query.after === "string" ? req.query.after : undefined;
  if (afterRaw) {
    const t = new Date(afterRaw);
    if (!Number.isNaN(t.getTime())) filters.push(gt(messagesTable.createdAt, t));
  }

  const rows = await db
    .select()
    .from(messagesTable)
    .where(and(...filters))
    .orderBy(asc(messagesTable.createdAt));

  res.json(rows);
});

/**
 * POST /bookings/:id/messages — append a message to the thread. Notifies the
 * other participant (in-app + push) on success.
 */
router.post("/bookings/:id/messages", requireUser, async (req, res) => {
  const id = String(req.params.id);
  const parsed = SendBookingMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "body must be a non-empty string" });
    return;
  }
  const body = parsed.data.body.trim();
  if (!body) {
    res.status(400).json({ error: "body is empty after trim" });
    return;
  }
  if (body.length > MAX_MESSAGE_LEN) {
    res.status(400).json({ error: `body exceeds ${MAX_MESSAGE_LEN} characters` });
    return;
  }

  const part = await resolveParticipant(id, req.auth!);
  if (!part.ok) {
    res.status(part.status).json({ error: part.error });
    return;
  }
  // Cancelled bookings: read-only thread. Existing history stays visible
  // (handled by GET) but no new messages may be appended. Mirrors the
  // mobile UI which hides the compose button for cancelled bookings.
  if (part.booking.status === "cancelled") {
    res.status(409).json({ error: "Cannot message on a cancelled booking" });
    return;
  }
  const auth = req.auth!;

  const messageId = genId("msg");
  const [inserted] = await db
    .insert(messagesTable)
    .values({
      id: messageId,
      bookingId: id,
      senderUserId: auth.userId,
      senderRole: part.role,
      body,
      readAt: null,
    })
    .returning();

  // Resolve the OTHER participant's userId for the notification:
  //  - if sender is customer → notify the SP's owner (businesses.ownerId)
  //  - if sender is business → notify the booking's customerId
  let recipientUserId: string | null = null;
  let recipientLabel = "";
  if (part.role === "customer") {
    const [biz] = await db
      .select({ ownerId: businessesTable.ownerId })
      .from(businessesTable)
      .where(eq(businessesTable.id, part.booking.businessId));
    recipientUserId = biz?.ownerId ?? null;
    recipientLabel = part.booking.customerName;
  } else {
    recipientUserId = part.booking.customerId;
    recipientLabel = part.booking.businessName;
  }

  if (recipientUserId) {
    const preview = body.length > 80 ? body.slice(0, 77) + "…" : body;
    // Fire-and-forget — don't make the sender wait for push delivery.
    void createNotification(
      {
        userId: recipientUserId,
        kind: "message_received",
        title: `New message from ${recipientLabel}`,
        body: preview,
        bookingId: id,
      },
      req.log,
    ).catch((err) => req.log.warn({ err }, "message.notify_failed"));
  } else {
    req.log.warn({ bookingId: id, senderRole: part.role }, "message.no_recipient");
  }

  res.status(201).json(inserted);
});

/**
 * POST /bookings/:id/messages/read — mark every message authored by the OTHER
 * party as read. Idempotent.
 */
router.post("/bookings/:id/messages/read", requireUser, async (req, res) => {
  const id = String(req.params.id);
  const part = await resolveParticipant(id, req.auth!);
  if (!part.ok) {
    res.status(part.status).json({ error: part.error });
    return;
  }

  const updated = await db
    .update(messagesTable)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(messagesTable.bookingId, id),
        ne(messagesTable.senderRole, part.role),
        isNull(messagesTable.readAt),
      ),
    )
    .returning({ id: messagesTable.id });

  res.json({ updated: updated.length });
});

/**
 * GET /me/conversations — list every booking the caller participates in that
 * has at least one message, with the last-message preview + unread count.
 * Used by the Inbox screen.
 */
router.get("/me/conversations", requireUser, async (req, res) => {
  const auth = req.auth!;

  // Build a raw column ref + value pair for the alias-aware CTE filter. We
  // can't use drizzle's eq() here because it would emit `"bookings"."col"`
  // which doesn't resolve inside the `bookings b` alias.
  let ownerCol: ReturnType<typeof sql>;
  let ownerVal: string;
  if (auth.role === "customer") {
    ownerCol = sql`b.customer_id`;
    ownerVal = auth.userId;
  } else if (auth.role === "business") {
    if (!auth.businessId) {
      res.status(403).json({ error: "Business token missing businessId" });
      return;
    }
    ownerCol = sql`b.business_id`;
    ownerVal = auth.businessId;
  } else {
    res.status(403).json({ error: "Conversations are customer/SP only" });
    return;
  }

  // One query: for each of the caller's bookings, the latest message and the
  // unread count (messages from the OTHER side with readAt IS NULL).
  const callerRole: "customer" | "business" = auth.role === "customer" ? "customer" : "business";

  const rows = await db.execute<{
    booking_id: string;
    business_name: string;
    customer_name: string;
    scheduled_date: string;
    last_body: string;
    last_at: string;
    last_sender_role: string;
    unread_count: string;
  }>(sql`
    WITH my_bookings AS (
      SELECT b.id, b.business_name, b.customer_name, b.scheduled_date
      FROM bookings b
      WHERE ${ownerCol} = ${ownerVal}
    ),
    last_msg AS (
      SELECT DISTINCT ON (m.booking_id)
        m.booking_id, m.body, m.created_at, m.sender_role
      FROM messages m
      INNER JOIN my_bookings mb ON mb.id = m.booking_id
      ORDER BY m.booking_id, m.created_at DESC
    ),
    unread AS (
      SELECT m.booking_id, COUNT(*)::text AS n
      FROM messages m
      INNER JOIN my_bookings mb ON mb.id = m.booking_id
      WHERE m.read_at IS NULL AND m.sender_role <> ${callerRole}
      GROUP BY m.booking_id
    )
    SELECT
      mb.id              AS booking_id,
      mb.business_name   AS business_name,
      mb.customer_name   AS customer_name,
      mb.scheduled_date  AS scheduled_date,
      lm.body            AS last_body,
      lm.created_at      AS last_at,
      lm.sender_role     AS last_sender_role,
      COALESCE(u.n, '0') AS unread_count
    FROM my_bookings mb
    INNER JOIN last_msg lm ON lm.booking_id = mb.id
    LEFT JOIN unread u ON u.booking_id = mb.id
    ORDER BY lm.created_at DESC
  `);

  const shaped = rows.rows.map((r) => ({
    bookingId: r.booking_id,
    counterpartyName: callerRole === "customer" ? r.business_name : r.customer_name,
    scheduledDate: r.scheduled_date,
    lastMessageBody: r.last_body,
    lastMessageAt: new Date(r.last_at).toISOString(),
    lastMessageFromMe: r.last_sender_role === callerRole,
    unreadCount: Number(r.unread_count) || 0,
  }));

  res.json(shaped);
});

export default router;
