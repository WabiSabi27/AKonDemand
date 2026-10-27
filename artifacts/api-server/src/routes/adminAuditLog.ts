/**
 * GET /admin/audit-log — Phase 3 #10 admin-facing audit feed.
 *
 * Returns the most recent rows from `audit_log`, newest first. Filterable by
 * `entityType` and/or `entityId` so deep-linking from a booking/service detail
 * page can show only that entity's history. The `actorLabel` column is left
 * untouched here (recordAudit doesn't fill it); we hydrate display labels from
 * `users` in a single batched lookup so the UI never has to fan out per row.
 */

import { Router, type IRouter } from "express";
import { desc, eq, and, inArray } from "drizzle-orm";
import { db, auditLogTable, usersTable } from "@workspace/db";
import { z } from "zod/v4";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

const ListAuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  entityType: z.enum(["service", "service_option", "booking", "biz_account", "business"]).optional(),
  entityId: z.string().min(1).max(64).optional(),
});

router.get("/admin/audit-log", requireRole("admin"), async (req, res) => {
  const q = ListAuditLogQuery.parse(req.query);
  const limit = q.limit ?? 50;

  const filters = [];
  if (q.entityType) filters.push(eq(auditLogTable.entityType, q.entityType));
  if (q.entityId) filters.push(eq(auditLogTable.entityId, q.entityId));

  const baseSel = db.select().from(auditLogTable);
  const rows = filters.length
    ? await baseSel.where(and(...filters)).orderBy(desc(auditLogTable.at)).limit(limit)
    : await baseSel.orderBy(desc(auditLogTable.at)).limit(limit);

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
  const actors = actorIds.length
    ? await db
        .select({ id: usersTable.id, name: usersTable.name, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, actorIds))
    : [];
  const actorById = new Map(actors.map((a) => [a.id, a]));

  res.json({
    entries: rows.map((r) => {
      const actor = r.actorId ? actorById.get(r.actorId) : undefined;
      return {
        id: r.id,
        at: r.at instanceof Date ? r.at.toISOString() : new Date(r.at).toISOString(),
        actorId: r.actorId,
        actorRole: r.actorRole,
        actorLabel: actor?.name ?? actor?.email ?? r.actorLabel,
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
        summary: r.summary,
        metadata: r.metadata,
      };
    }),
  });
});

export default router;
