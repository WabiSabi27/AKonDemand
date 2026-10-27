/**
 * Task 15 — approval/rejection (and accepted) emails must not silently break.
 *
 * These emails are fire-and-forget from route handlers and the Stripe
 * webhook: a regression (renamed field, missed enqueue) would fail silently.
 * These tests lock the contract that each status transition enqueues a row
 * in `email_outbox` with the right kind and recipient:
 *
 *   - POST /biz-accounts/:id/approve        → kind "meeting:approved"
 *   - POST /biz-accounts/:id/reject         → kind "meeting:rejected" (± reason)
 *   - POST /biz-accounts/:id/accept         → kind "meeting:accepted"
 *   - onboarding-payment webhook approval   → kind "meeting:approved"
 *   - PATCH /biz-accounts/:id meetingAt      → scheduled/rescheduled/cancelled
 *     with a calendar invite, stable UID, and increasing SEQUENCE
 *
 * No real sending: delivery is explicitly mocked to fail fast, so the row
 * stays `pending` in the outbox while enqueueing and calendar generation run.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  db,
  bizAccountsTable,
  businessesTable,
  usersTable,
  emailOutboxTable,
  stripeWebhookDeadLetterTable,
} from "@workspace/db";
import { replayDeadLetterRow } from "../src/webhookHandlers";
import * as meetingEmail from "../src/lib/meetingEmail";
import { api, createAdminUser, getAnyCategoryId, TEST_PREFIX, type TestUser } from "./helpers";

const rand = () => Math.random().toString(36).slice(2, 8);

async function createBizAccount(
  status: "pending" | "accepted",
): Promise<{ id: string; email: string }> {
  const ownerId = `${TEST_PREFIX}_sem_owner_${rand()}`;
  const id = `${TEST_PREFIX}_sem_ba_${rand()}`;
  const email = `${id}@test.local`;
  await db.insert(usersTable).values({ id: ownerId, email, name: "Sem Owner", role: "business" });
  await db.insert(bizAccountsTable).values({
    id,
    businessName: `${TEST_PREFIX} Sem Biz`,
    ownerName: "Sem Owner",
    email,
    passwordHash: "x",
    businessType: "home-based",
    status,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ownerId,
  });
  return { id, email };
}

/**
 * The enqueue is fire-and-forget (`void sendMeetingEmail(...)`) so the HTTP
 * response can return before the outbox insert commits. Poll briefly.
 */
async function waitForOutboxRow(
  toEmail: string,
  kind: string,
  timeoutMs = 5000,
): Promise<typeof emailOutboxTable.$inferSelect> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await db
      .select()
      .from(emailOutboxTable)
      .where(and(eq(emailOutboxTable.toEmail, toEmail), eq(emailOutboxTable.kind, kind)));
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error(`No email_outbox row with kind="${kind}" for ${toEmail} within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("status-transition emails land in email_outbox", () => {
  let admin: TestUser;
  let categoryId: string;

  beforeAll(async () => {
    // Removing env vars is insufficient: the SDK can still find its connector.
    // Mock only the delivery boundary, preserving the real route/outbox logic.
    vi.spyOn(meetingEmail, "deliverEmail").mockRejectedValue(new Error("Email delivery disabled in route tests"));
    admin = await createAdminUser();
    categoryId = await getAnyCategoryId();
  });

  afterAll(async () => {
    // Businesses created by approve/webhook use genId ids — delete by owner prefix.
    await db.delete(businessesTable).where(like(businessesTable.ownerId, `${TEST_PREFIX}_sem_%`));
    await db.delete(emailOutboxTable).where(like(emailOutboxTable.toEmail, `${TEST_PREFIX}_sem_%`));
    await db
      .delete(stripeWebhookDeadLetterTable)
      .where(like(stripeWebhookDeadLetterTable.id, `${TEST_PREFIX}_sem_%`));
    await db.delete(bizAccountsTable).where(like(bizAccountsTable.id, `${TEST_PREFIX}_sem_%`));
    await db.delete(usersTable).where(like(usersTable.id, `${TEST_PREFIX}_sem_%`));
    vi.restoreAllMocks();
  });

  it("approve route enqueues an 'approved' email to the applicant", async () => {
    const { id, email } = await createBizAccount("accepted");
    const res = await api()
      .post(`/api/biz-accounts/${id}/approve`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ categoryId });
    expect(res.status).toBe(200);

    const row = await waitForOutboxRow(email, "meeting:approved");
    expect(row.toEmail).toBe(email);
    expect(row.kind).toBe("meeting:approved");
    expect(row.subject).toMatch(/approved/i);
  });

  it("reject route (with reason) enqueues a 'rejected' email including the reason", async () => {
    const { id, email } = await createBizAccount("pending");
    const reason = "Missing Alaska business license";
    const res = await api()
      .post(`/api/biz-accounts/${id}/reject`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ reason });
    expect(res.status).toBe(200);

    const row = await waitForOutboxRow(email, "meeting:rejected");
    expect(row.toEmail).toBe(email);
    expect(row.text).toContain(`Reason: ${reason}`);
    expect(row.html).toContain(reason);
  });

  it("reject route (without reason) enqueues a 'rejected' email with no reason block", async () => {
    const { id, email } = await createBizAccount("pending");
    const res = await api()
      .post(`/api/biz-accounts/${id}/reject`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({});
    expect(res.status).toBe(200);

    const row = await waitForOutboxRow(email, "meeting:rejected");
    expect(row.toEmail).toBe(email);
    expect(row.text).not.toContain("Reason:");
    expect(row.html).not.toContain("Reason:");
  });

  it("accept route enqueues an 'accepted' email to the applicant", async () => {
    const { id, email } = await createBizAccount("pending");
    const res = await api()
      .post(`/api/biz-accounts/${id}/accept`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({});
    expect(res.status).toBe(200);

    const row = await waitForOutboxRow(email, "meeting:accepted");
    expect(row.toEmail).toBe(email);
    expect(row.subject).toMatch(/accepted/i);
  });

  it.each(["scheduled", "rescheduled", "cancelled"] as const)(
    "admin meeting PATCH enqueues a '%s' email with the correct calendar revision",
    async (targetKind) => {
      // Each case starts with its own application and drives real PATCHes,
      // rather than seeding a revision that the route may never produce.
      const { id, email } = await createBizAccount("pending");
      const location = "Test meeting room";
      const revisions = [
        {
          kind: "scheduled",
          meetingAt: "2027-01-12T19:00:00.000Z",
          start: "20270112T190000Z",
          end: "20270112T194500Z",
          method: "REQUEST",
        },
        {
          kind: "rescheduled",
          meetingAt: "2027-01-13T20:00:00.000Z",
          start: "20270113T200000Z",
          end: "20270113T204500Z",
          method: "REQUEST",
        },
        {
          kind: "cancelled",
          meetingAt: null,
          // Cancellation must reference the most recent event, not null or
          // the original time, even though PATCH clears the stored details.
          start: "20270113T200000Z",
          end: "20270113T204500Z",
          method: "CANCEL",
        },
      ] as const;

      for (const [sequence, revision] of revisions.entries()) {
        const res = await api()
          .patch(`/api/biz-accounts/${id}`)
          .set("Authorization", `Bearer ${admin.token}`)
          .send({
            meetingAt: revision.meetingAt,
            ...(sequence === 0 ? { meetingLocation: location, meetingDurationMinutes: 45 } : {}),
          });
        expect(res.status).toBe(200);
        expect(res.body.meetingAt).toBe(revision.meetingAt);
        expect(res.body.meetingIcalSequence).toBe(sequence);

        const row = await waitForOutboxRow(email, `meeting:${revision.kind}`);
        expect(row.toEmail).toBe(email);
        expect(row.kind).toBe(`meeting:${revision.kind}`);
        expect(row.subject).toContain(`interview has been ${revision.kind}`);
        expect(row.icalMethod).toBe(revision.method);
        expect(row.icalContent).toBeTruthy();
        // Unfold RFC 5545 continuation lines before checking properties.
        const lines = row.icalContent!.replace(/\r\n[ \t]/g, "").split("\r\n");
        expect(lines).toEqual(expect.arrayContaining([
          "BEGIN:VCALENDAR",
          "BEGIN:VEVENT",
          `METHOD:${revision.method}`,
          `UID:meeting-${id}@akondemand`,
          `SEQUENCE:${sequence}`,
          `DTSTART:${revision.start}`,
          `DTEND:${revision.end}`,
          `LOCATION:${location}`,
          `STATUS:${revision.kind === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
          "END:VEVENT",
          "END:VCALENDAR",
        ]));
        expect(lines.filter((line) => line.startsWith("UID:"))).toHaveLength(1);
        expect(lines.find((line) => line.startsWith("ATTENDEE;"))).toContain(`mailto:${email}`);

        if (revision.kind === targetKind) break;
      }
    },
  );

  it("onboarding-payment webhook approval enqueues an 'approved' email", async () => {
    const { id, email } = await createBizAccount("accepted");

    // Drive the real dispatch path (runHandler → markBizAccountPaid) via the
    // exported replay entry point — same code the live webhook runs, without
    // needing a Stripe signature. The replay claims a pending dead-letter
    // row, so seed one carrying a synthetic checkout.session.completed event.
    const dlId = `${TEST_PREFIX}_sem_dl_${rand()}`;
    const event = {
      id: `evt_${dlId}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${dlId}`,
          mode: "payment",
          payment_status: "paid",
          metadata: { bizAccountId: id, feeType: "onboarding" },
        },
      },
    };
    await db.insert(stripeWebhookDeadLetterTable).values({
      id: dlId,
      eventId: event.id,
      eventType: event.type,
      handlerName: "biz_account_paid",
      payload: event,
      status: "pending",
      attempts: 1,
      lastError: "synthetic (task 15 test)",
      lastAttemptAt: new Date(),
    });

    const result = await replayDeadLetterRow({
      id: dlId,
      handlerName: "biz_account_paid",
      payload: event,
    });
    expect(result.ok).toBe(true);

    // The webhook path must have flipped the application to approved…
    const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, id));
    expect(acct?.status).toBe("approved");

    // …and enqueued the approval email.
    const row = await waitForOutboxRow(email, "meeting:approved");
    expect(row.toEmail).toBe(email);
    expect(row.subject).toMatch(/approved/i);
  });

  it("public status hides location and duration after cancellation, even with leftover stored details", async () => {
    const { id, email } = await createBizAccount("pending");
    const scheduled = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        meetingAt: "2027-01-12T19:00:00.000Z",
        meetingLocation: "Private interview room",
        meetingDurationMinutes: 45,
      });
    expect(scheduled.status).toBe(200);
    const before = await api().get(`/api/biz-accounts/${id}/status`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      meetingLocation: "Private interview room",
      meetingDurationMinutes: 45,
    });

    const cancelled = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({ meetingAt: null });
    expect(cancelled.status).toBe(200);
    // Model legacy rows where clearing the meeting left details behind.
    await db.update(bizAccountsTable).set({
      meetingLocation: "Private interview room",
      meetingDurationMinutes: 45,
    }).where(eq(bizAccountsTable.id, id));
    const after = await api().get(`/api/biz-accounts/${id}/status`);
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      meetingAt: null,
      meetingLocation: null,
      meetingDurationMinutes: null,
    });
    await waitForOutboxRow(email, "meeting:cancelled");
  });

  it.each([
    { patch: { meetingLocation: "New interview room" }, location: "New interview room", end: "20270112T194500Z" },
    { patch: { meetingDurationMinutes: 90 }, location: "Original interview room", end: "20270112T203000Z" },
  ])("a details-only PATCH $patch sends a revision of the same calendar event", async ({ patch, location, end }) => {
    const { id, email } = await createBizAccount("pending");
    const scheduled = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send({
        meetingAt: "2027-01-12T19:00:00.000Z",
        meetingLocation: "Original interview room",
        meetingDurationMinutes: 45,
      });
    expect(scheduled.status).toBe(200);
    const original = await waitForOutboxRow(email, "meeting:scheduled");
    const updated = await api()
      .patch(`/api/biz-accounts/${id}`)
      .set("Authorization", `Bearer ${admin.token}`)
      .send(patch); // Deliberately omit meetingAt.
    expect(updated.status).toBe(200);
    expect(updated.body.meetingAt).toBe(scheduled.body.meetingAt);
    expect(updated.body.meetingIcalSequence).toBe(scheduled.body.meetingIcalSequence + 1);
    const revision = await waitForOutboxRow(email, "meeting:rescheduled");
    expect(revision.icalMethod).toBe("REQUEST");
    const unfold = (content: string) => content.replace(/\r\n[ \t]/g, "").split("\r\n");
    const previous = unfold(original.icalContent!);
    const lines = unfold(revision.icalContent!);
    for (const prefix of ["UID:", "DTSTART:"]) {
      expect(lines.find(line => line.startsWith(prefix))).toBe(previous.find(line => line.startsWith(prefix)));
    }
    expect(lines).toEqual(expect.arrayContaining([
      `UID:meeting-${id}@akondemand`,
      "DTSTART:20270112T190000Z",
      "SEQUENCE:1",
      `LOCATION:${location}`,
      `DTEND:${end}`,
    ]));
  });
});
