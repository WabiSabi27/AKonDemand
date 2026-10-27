/**
 * /me/business — authenticated SP self-service for editing their own business
 * profile (hours, contact info, vacation mode). Phase 3 #3.
 *
 * Why a dedicated route vs a generic PATCH /businesses/:id: keeps authz
 * trivial — the SP can only ever edit `auth.businessId`, never another row
 * even by guessing IDs. Admins don't need this; they have read access via
 * GET /businesses and can intervene at the DB level for support cases.
 */

import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, businessesTable, businessEmployeesTable } from "@workspace/db";
import {
  UpdateMyBusinessBody,
  UpdateMyBusinessResponse,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.patch("/me/business", requireRole("business"), async (req, res) => {
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const body = UpdateMyBusinessBody.parse(req.body);

  // Validate hours shape if present.
  if (body.hours !== undefined && body.hours !== null) {
    const { workDays, startHour, endHour } = body.hours;
    if (!Array.isArray(workDays) || workDays.some((d) => d < 0 || d > 6)) {
      res.status(400).json({ error: "hours.workDays must be array of 0-6" });
      return;
    }
    if (startHour < 0 || startHour > 23 || endHour < 1 || endHour > 23 || endHour <= startHour) {
      res.status(400).json({ error: "hours.startHour and endHour must be 0-23 with end > start" });
      return;
    }
  }

  // Vacation date validation. Both must be present together (or both null to
  // clear). Each must be YYYY-MM-DD and from <= until.
  const vfRaw = body.vacationFrom;
  const vuRaw = body.vacationUntil;
  const clearingVacation = vfRaw === null && vuRaw === null;
  const settingVacation = typeof vfRaw === "string" && typeof vuRaw === "string";
  if (vfRaw !== undefined || vuRaw !== undefined) {
    if (!clearingVacation && !settingVacation) {
      res.status(400).json({
        error: "vacationFrom and vacationUntil must both be set together (or both null to clear)",
      });
      return;
    }
    if (settingVacation) {
      if (!DATE_RE.test(vfRaw) || !DATE_RE.test(vuRaw)) {
        res.status(400).json({ error: "vacation dates must be YYYY-MM-DD" });
        return;
      }
      if (vfRaw > vuRaw) {
        res.status(400).json({ error: "vacationFrom must be on or before vacationUntil" });
        return;
      }
    }
  }

  // Build the update set — omit any field the client didn't send so we only
  // touch what they explicitly asked for. `null` is a meaningful value for
  // vacation fields (= clear OOO).
  const updates: Partial<typeof businessesTable.$inferInsert> = {};
  if (body.hours !== undefined) updates.hours = body.hours;
  if (body.phone !== undefined) updates.phone = body.phone ?? "";
  if (body.location !== undefined) updates.location = body.location ?? "";
  if (body.description !== undefined) updates.description = body.description ?? "";
  if (vfRaw !== undefined) updates.vacationFrom = vfRaw;
  if (vuRaw !== undefined) updates.vacationUntil = vuRaw;
  if (body.vacationMessage !== undefined) updates.vacationMessage = body.vacationMessage;

  // Phase 3 #7 — Cancellation policy. Each field is independently optional;
  // we validate the combined invariant only when at least one is being set.
  if (
    body.cancellationFullRefundHours !== undefined ||
    body.cancellationPartialRefundHours !== undefined ||
    body.cancellationPartialRefundPercent !== undefined
  ) {
    const [current] = await db.select().from(businessesTable).where(eq(businessesTable.id, auth.businessId));
    if (!current) {
      res.status(404).json({ error: "Your business no longer exists" });
      return;
    }
    const fullH = body.cancellationFullRefundHours ?? current.cancellationFullRefundHours;
    const partH = body.cancellationPartialRefundHours ?? current.cancellationPartialRefundHours;
    const partPct = body.cancellationPartialRefundPercent ?? current.cancellationPartialRefundPercent;
    if (!Number.isInteger(fullH) || fullH < 0 || fullH > 720) {
      res.status(400).json({ error: "cancellationFullRefundHours must be an integer 0–720 (≤ 30 days)" });
      return;
    }
    if (!Number.isInteger(partH) || partH < 0 || partH > 720) {
      res.status(400).json({ error: "cancellationPartialRefundHours must be an integer 0–720 (≤ 30 days)" });
      return;
    }
    if (!Number.isInteger(partPct) || partPct < 0 || partPct > 100) {
      res.status(400).json({ error: "cancellationPartialRefundPercent must be 0–100" });
      return;
    }
    if (partH > fullH) {
      res.status(400).json({ error: "Partial-refund window must be inside the full-refund window (partial hours ≤ full hours)" });
      return;
    }
    if (body.cancellationFullRefundHours !== undefined) updates.cancellationFullRefundHours = body.cancellationFullRefundHours;
    if (body.cancellationPartialRefundHours !== undefined) updates.cancellationPartialRefundHours = body.cancellationPartialRefundHours;
    if (body.cancellationPartialRefundPercent !== undefined) updates.cancellationPartialRefundPercent = body.cancellationPartialRefundPercent;
  }

  let updated: typeof businessesTable.$inferSelect | undefined;
  if (Object.keys(updates).length === 0) {
    // Nothing to update — return current row as a no-op rather than 400.
    [updated] = await db.select().from(businessesTable).where(eq(businessesTable.id, auth.businessId));
  } else {
    [updated] = await db
      .update(businessesTable)
      .set(updates)
      .where(eq(businessesTable.id, auth.businessId))
      .returning();
  }

  if (!updated) {
    res.status(404).json({ error: "Your business no longer exists" });
    return;
  }

  // Mirror GET /businesses/:id — Business response schema requires the
  // joined `employees` array (drives capacity on customer-facing screens).
  const employees = await db
    .select()
    .from(businessEmployeesTable)
    .where(eq(businessEmployeesTable.businessId, auth.businessId));

  req.log.info(
    {
      businessId: auth.businessId,
      fields: Object.keys(updates),
      vacation: settingVacation ? { from: vfRaw, until: vuRaw } : clearingVacation ? "cleared" : undefined,
    },
    "meBusiness.updated",
  );

  res.json(UpdateMyBusinessResponse.parse({ ...updated, employees }));
});

export default router;
