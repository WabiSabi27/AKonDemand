import { Router, type IRouter } from "express";
import { and, eq, gte, lte, type SQL } from "drizzle-orm";
import { db, blockedSlotsTable } from "@workspace/db";
import {
  ListBlockedSlotsQueryParams,
  ListBlockedSlotsResponse,
  CreateBlockedSlotBody,
  DeleteBlockedSlotParams,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { genId } from "../lib/ids";

const router: IRouter = Router();

router.get("/blocked-slots", async (req, res) => {
  // `coerce.string()` from the generated Zod doesn't reject `undefined` cleanly,
  // so guard the required field explicitly first.
  if (typeof req.query.businessId !== "string" || req.query.businessId === "") {
    res.status(400).json({ error: "businessId is required" });
    return;
  }
  const q = ListBlockedSlotsQueryParams.parse(req.query);
  const filters: SQL[] = [eq(blockedSlotsTable.businessId, q.businessId)];
  if (q.from) filters.push(gte(blockedSlotsTable.date, q.from));
  if (q.to) filters.push(lte(blockedSlotsTable.date, q.to));

  const rows = await db.select().from(blockedSlotsTable).where(and(...filters));
  req.log.info({ count: rows.length, ...q }, "listBlockedSlots");
  res.json(ListBlockedSlotsResponse.parse(rows));
});

/**
 * POST /blocked-slots — SP blocks a date or time range on their own calendar.
 * `businessId` is taken from `auth.businessId` (admins must be a business owner
 * to use this — admins typically don't need to block calendar slots).
 */
router.post("/blocked-slots", requireRole("business"), async (req, res) => {
  const body = CreateBlockedSlotBody.parse(req.body);
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  // Validate time fields.
  if (!body.allDay) {
    if (!body.startTime || !body.endTime) {
      res.status(400).json({ error: "startTime and endTime are required when allDay=false" });
      return;
    }
    if (body.startTime >= body.endTime) {
      res.status(400).json({ error: "startTime must be before endTime" });
      return;
    }
  }

  const id = genId("bs");
  const [inserted] = await db
    .insert(blockedSlotsTable)
    .values({
      id,
      businessId: auth.businessId,
      date: body.date,
      allDay: body.allDay,
      startTime: body.allDay ? null : (body.startTime ?? null),
      endTime: body.allDay ? null : (body.endTime ?? null),
      label: body.label ?? null,
    })
    .returning();

  req.log.info({ blockedSlotId: id, businessId: auth.businessId, date: body.date }, "blockedSlot.created");
  res.status(201).json(inserted);
});

/** DELETE /blocked-slots/:id — SP removes one of their blocked slots. */
router.delete("/blocked-slots/:id", requireRole("business", "admin"), async (req, res) => {
  const { id } = DeleteBlockedSlotParams.parse(req.params);
  const auth = req.auth!;

  const [existing] = await db.select().from(blockedSlotsTable).where(eq(blockedSlotsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Blocked slot not found" });
    return;
  }
  if (auth.role !== "admin" && existing.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your business's blocked slot" });
    return;
  }

  await db.delete(blockedSlotsTable).where(eq(blockedSlotsTable.id, id));
  req.log.info({ blockedSlotId: id, businessId: existing.businessId }, "blockedSlot.deleted");
  res.status(204).send();
});

export default router;
