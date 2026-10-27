import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  servicesTable,
  serviceOptionsTable,
  serviceReviewsTable,
  bookingReviewsTable,
  businessesTable,
} from "@workspace/db";
import {
  ListServicesQueryParams,
  ListServicesResponse,
  GetServiceParams,
  GetServiceResponse,
  CreateServiceBody,
  UpdateServiceParams,
  UpdateServiceBody,
  CreateServiceOptionParams,
  CreateServiceOptionBody,
  UpdateServiceOptionParams,
  UpdateServiceOptionBody,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import { genId } from "../lib/ids";
import { PLAN_DISPLAY_NAME, PLAN_SERVICE_LIMIT, DEFAULT_PLAN_TIER, parsePlanTier } from "../lib/plans";
import { recordAudit } from "../lib/audit";

const router: IRouter = Router();

/** Recompute services.startingPrice = MIN(options.price), or "0" if no options.
 *  Filters soft-deleted options so a removed pricing tier doesn't keep
 *  setting the displayed minimum. */
async function recomputeStartingPrice(serviceId: string): Promise<void> {
  const opts = await db
    .select({ price: serviceOptionsTable.price })
    .from(serviceOptionsTable)
    .where(and(
      eq(serviceOptionsTable.serviceId, serviceId),
      isNull(serviceOptionsTable.deletedAt),
    ));
  const prices = opts.map((o) => Number(o.price)).filter((n) => Number.isFinite(n));
  const min = prices.length ? Math.min(...prices) : 0;
  await db
    .update(servicesTable)
    .set({ startingPrice: min.toFixed(2) })
    .where(eq(servicesTable.id, serviceId));
}

router.get("/services", async (req, res) => {
  const q = ListServicesQueryParams.parse(req.query);

  // The generated `zod.coerce.boolean()` treats any non-empty string as `true`,
  // so `?featured=false` is misread. Parse the raw query value strictly here.
  const rawFeatured = req.query.featured;
  const featured =
    rawFeatured === "true" ? true :
    rawFeatured === "false" ? false :
    undefined;

  const filters: SQL[] = [
    // Phase 3 #10 — exclude soft-deleted services from the public catalog.
    isNull(servicesTable.deletedAt),
  ];
  if (q.businessId) filters.push(eq(servicesTable.businessId, q.businessId));
  if (q.categoryId) filters.push(eq(servicesTable.categoryId, q.categoryId));
  if (typeof featured === "boolean") filters.push(eq(servicesTable.featured, featured));

  // Free-text search: case-insensitive match against title, denormalised
  // businessName, OR any element of the tags[] array. The tags clause uses
  // `EXISTS(SELECT 1 FROM unnest(tags) t WHERE t ILIKE ?)` so a partial tag
  // hit ("plumb" → "plumbing") also matches. Wrapping `q.q` in `%…%` once here
  // keeps the SQL parameterised — never interpolate user input directly.
  if (q.q && q.q.trim()) {
    const needle = `%${q.q.trim()}%`;
    const textClause = or(
      sql`${servicesTable.title} ILIKE ${needle}`,
      sql`${servicesTable.businessName} ILIKE ${needle}`,
      sql`EXISTS (SELECT 1 FROM unnest(${servicesTable.tags}) AS t WHERE t ILIKE ${needle})`,
    );
    if (textClause) filters.push(textClause);
  }
  if (typeof q.minRating === "number") {
    filters.push(gte(servicesTable.rating, q.minRating.toString()));
  }
  if (typeof q.minPrice === "number") {
    filters.push(gte(servicesTable.startingPrice, q.minPrice.toString()));
  }
  if (typeof q.maxPrice === "number") {
    filters.push(lte(servicesTable.startingPrice, q.maxPrice.toString()));
  }

  // Sort. Default `relevance` puts featured listings first then orders by
  // rating desc — matches what the customer-facing home/category screens
  // already imply with the "Featured" badge.
  const sortKey = q.sort ?? "relevance";
  const orderBy = sortKey === "rating"
    ? [desc(servicesTable.rating), desc(servicesTable.reviewCount)]
    : sortKey === "price_asc"
      ? [asc(servicesTable.startingPrice)]
      : sortKey === "price_desc"
        ? [desc(servicesTable.startingPrice)]
        : [desc(servicesTable.featured), desc(servicesTable.rating)];

  const baseQuery = db.select().from(servicesTable);
  const rows = await baseQuery.where(and(...filters)).orderBy(...orderBy);

  // Eager-load options in a single batched query, then group by serviceId.
  // Avoids N+1 fetches on the client (mobile SP screens render an option
  // preview inline; customer pages also need the cheapest option for capacity
  // math), and means the response shape matches `useGetService` modulo `reviews`.
  const ids = rows.map((s) => s.id);
  const allOptions = ids.length
    ? await db.select().from(serviceOptionsTable).where(and(
        inArray(serviceOptionsTable.serviceId, ids),
        isNull(serviceOptionsTable.deletedAt),
      ))
    : [];
  const optionsByService = new Map<string, typeof allOptions>();
  for (const opt of allOptions) {
    const bucket = optionsByService.get(opt.serviceId);
    if (bucket) bucket.push(opt);
    else optionsByService.set(opt.serviceId, [opt]);
  }
  const result = rows.map((s) => ({ ...s, options: optionsByService.get(s.id) ?? [] }));

  req.log.info({ count: rows.length, businessId: q.businessId, categoryId: q.categoryId, featured, q: q.q, minRating: q.minRating, minPrice: q.minPrice, maxPrice: q.maxPrice, sort: q.sort }, "listServices");
  res.json(ListServicesResponse.parse(result));
});

router.get("/services/:id", async (req, res) => {
  const { id } = GetServiceParams.parse(req.params);
  const [svc] = await db.select().from(servicesTable).where(and(
    eq(servicesTable.id, id),
    isNull(servicesTable.deletedAt),
  ));
  if (!svc) {
    req.log.warn({ id }, "service not found");
    res.status(404).json({ error: "Service not found" });
    return;
  }

  const [options, legacyReviews, bookingReviews] = await Promise.all([
    db.select().from(serviceOptionsTable).where(and(
      eq(serviceOptionsTable.serviceId, id),
      isNull(serviceOptionsTable.deletedAt),
    )),
    db.select().from(serviceReviewsTable).where(eq(serviceReviewsTable.serviceId, id)),
    db.select().from(bookingReviewsTable).where(eq(bookingReviewsTable.serviceId, id)),
  ]);

  // Merge legacy seeded reviews with verified-purchase booking reviews into a
  // single `ServiceReview`-shaped list (id/serviceId/authorName/rating/comment/date).
  // Sorted newest-first; booking review timestamps are formatted YYYY-MM-DD so
  // they slot in alongside the legacy `date` strings.
  const reviews = [
    ...legacyReviews,
    ...bookingReviews.map((r) => ({
      id: r.id,
      serviceId: r.serviceId,
      authorName: r.customerName,
      rating: r.rating,
      comment: r.comment,
      date: r.createdAt.toISOString().slice(0, 10),
    })),
  ].sort((a, b) => (a.date < b.date ? 1 : -1));

  // `options` is on the base Service schema; `reviews` is the detail-only addition.
  res.json(GetServiceResponse.parse({ ...svc, options, reviews }));
});

/** POST /services — SP creates a service for their own business. Optionally
 *  inserts an inline list of pricing options in the same transaction. */
router.post("/services", requireRole("business"), async (req, res) => {
  const body = CreateServiceBody.parse(req.body);
  const auth = req.auth!;
  if (!auth.businessId) {
    res.status(403).json({ error: "Token has no businessId" });
    return;
  }

  const [biz] = await db.select().from(businessesTable).where(eq(businessesTable.id, auth.businessId));
  if (!biz) {
    res.status(403).json({ error: "Your business no longer exists" });
    return;
  }

  // ── Subscription paywall (Phase 1 #5) ──────────────────────────────────
  // POST /services is the only mutating route gated by plan tier. PATCH and
  // DELETE intentionally are NOT gated so an SP whose card lapses can still
  // edit / clean up existing listings. The cap is enforced on creation only;
  // pre-existing services stay visible even if the SP downgrades below their
  // current count (we hide the "Add Service" CTA in the UI instead).
  const plan = parsePlanTier(biz.subscriptionPlan) ?? DEFAULT_PLAN_TIER;
  const servicesLimit = PLAN_SERVICE_LIMIT[plan];
  if (!biz.subscriptionActive) {
    req.log.warn(
      { businessId: biz.id, plan, serviceCount: biz.serviceCount },
      "service.create.blocked.subscription_inactive",
    );
    res.status(402).json({
      error: "Your subscription is not active. Please update your billing to add new services.",
      plan,
      servicesUsed: biz.serviceCount,
      servicesLimit,
      upgradeRequired: true,
      reason: "subscription_inactive",
    });
    return;
  }
  if (servicesLimit !== null && biz.serviceCount >= servicesLimit) {
    req.log.warn(
      { businessId: biz.id, plan, serviceCount: biz.serviceCount, servicesLimit },
      "service.create.blocked.over_limit",
    );
    res.status(402).json({
      error: `Your ${PLAN_DISPLAY_NAME[plan]} plan allows up to ${servicesLimit} services. Upgrade to add more.`,
      plan,
      servicesUsed: biz.serviceCount,
      servicesLimit,
      upgradeRequired: true,
      reason: "over_limit",
    });
    return;
  }

  // Validate prices for any inline options up-front so we don't roll back mid-tx.
  const inlineOptions = body.options ?? [];
  const optionRows = inlineOptions.map((o) => {
    const price = Number(o.price);
    if (!Number.isFinite(price) || price < 0) {
      throw Object.assign(new Error("price must be a non-negative number"), { httpStatus: 400 });
    }
    return {
      id: genId("opt"),
      name: o.name,
      description: o.description ?? "",
      price: price.toFixed(2),
      duration: o.duration,
      defaultStartTime: o.defaultStartTime ?? null,
    };
  });

  const id = genId("svc");
  const startingPrice = optionRows.length
    ? Math.min(...optionRows.map((r) => Number(r.price))).toFixed(2)
    : "0";

  try {
    await db.transaction(async (tx) => {
      // Re-check the cap inside the tx with a row-level lock so two concurrent
      // POSTs at limit-1 can't both pass the outer gate and end up over the
      // cap. The first wins; the second sees the freshly-incremented count
      // and gets the same 402 the outer check would have returned.
      const [locked] = await tx
        .select({
          serviceCount: businessesTable.serviceCount,
          subscriptionActive: businessesTable.subscriptionActive,
          subscriptionPlan: businessesTable.subscriptionPlan,
        })
        .from(businessesTable)
        .where(eq(businessesTable.id, biz.id))
        .for("update");
      if (!locked) {
        throw Object.assign(new Error("Your business no longer exists"), { httpStatus: 403 });
      }
      const lockedPlan = parsePlanTier(locked.subscriptionPlan) ?? DEFAULT_PLAN_TIER;
      const lockedLimit = PLAN_SERVICE_LIMIT[lockedPlan];
      if (!locked.subscriptionActive) {
        throw Object.assign(new Error("Your subscription is not active. Please update your billing to add new services."), {
          httpStatus: 402,
          payload: { plan: lockedPlan, servicesUsed: locked.serviceCount, servicesLimit: lockedLimit, upgradeRequired: true, reason: "subscription_inactive" },
        });
      }
      if (lockedLimit !== null && locked.serviceCount >= lockedLimit) {
        throw Object.assign(
          new Error(`Your ${PLAN_DISPLAY_NAME[lockedPlan]} plan allows up to ${lockedLimit} services. Upgrade to add more.`),
          {
            httpStatus: 402,
            payload: { plan: lockedPlan, servicesUsed: locked.serviceCount, servicesLimit: lockedLimit, upgradeRequired: true, reason: "over_limit" },
          },
        );
      }

      await tx.insert(servicesTable).values({
        id,
        businessId: biz.id,
        businessName: biz.name,
        categoryId: body.categoryId,
        title: body.title,
        description: body.description ?? "",
        tags: body.tags ?? [],
        requiredSpecialty: body.requiredSpecialty ?? null,
        featured: body.featured ?? false,
        startingPrice,
      });
      if (optionRows.length > 0) {
        await tx.insert(serviceOptionsTable).values(
          optionRows.map((r) => ({ ...r, serviceId: id })),
        );
      }
      await tx
        .update(businessesTable)
        .set({ serviceCount: sql`${businessesTable.serviceCount} + 1` })
        .where(eq(businessesTable.id, biz.id));
    });
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus ?? 500;
    const payload = (err as { payload?: Record<string, unknown> }).payload;
    if (status === 402 && payload) {
      req.log.warn({ businessId: biz.id, ...payload }, "service.create.blocked.in_tx");
      res.status(402).json({ error: (err as Error).message, ...payload });
      return;
    }
    res.status(status).json({ error: (err as Error).message });
    return;
  }

  // Re-read the canonical row so the response shape matches GET.
  const [inserted] = await db.select().from(servicesTable).where(eq(servicesTable.id, id));

  req.log.info({ serviceId: id, businessId: biz.id, optionCount: optionRows.length }, "service.created");
  recordAudit(req, {
    entityType: "service",
    entityId: id,
    action: "create",
    summary: `Created service "${body.title}"`,
    metadata: { businessId: biz.id, categoryId: body.categoryId, optionCount: optionRows.length },
  });
  res.status(201).json(inserted);
});

/** PATCH /services/:id — SP edits one of their services. */
router.patch("/services/:id", requireRole("business", "admin"), async (req, res) => {
  const { id } = UpdateServiceParams.parse(req.params);
  const body = UpdateServiceBody.parse(req.body);
  const auth = req.auth!;

  const [existing] = await db.select().from(servicesTable).where(eq(servicesTable.id, id));
  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Service not found" });
    return;
  }
  if (auth.role !== "admin" && existing.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your service" });
    return;
  }

  // Build patch from only the provided fields.
  const patch: Record<string, unknown> = {};
  if (body.categoryId !== undefined && body.categoryId !== null) patch.categoryId = body.categoryId;
  if (body.title !== undefined && body.title !== null) patch.title = body.title;
  if (body.description !== undefined && body.description !== null) patch.description = body.description;
  if (body.tags !== undefined && body.tags !== null) patch.tags = body.tags;
  if (body.requiredSpecialty !== undefined) patch.requiredSpecialty = body.requiredSpecialty;
  if (body.featured !== undefined && body.featured !== null) patch.featured = body.featured;

  // Optional full-replace of pricing options. When the client sends `options`
  // (even an empty array), we wipe + re-insert atomically and recompute
  // startingPrice so the list reflects the new minimum.
  const replaceOptions = body.options !== undefined && body.options !== null;
  let optionRows: Array<{
    id: string; name: string; description: string;
    price: string; duration: string; defaultStartTime: string | null;
  }> = [];
  if (replaceOptions) {
    optionRows = (body.options ?? []).map((o) => {
      const price = Number(o.price);
      if (!Number.isFinite(price) || price < 0) {
        throw Object.assign(new Error("option price must be a non-negative number"), { httpStatus: 400 });
      }
      return {
        id: genId("opt"),
        name: o.name,
        description: o.description ?? "",
        price: price.toFixed(2),
        duration: o.duration,
        defaultStartTime: o.defaultStartTime ?? null,
      };
    });
    patch.startingPrice = optionRows.length
      ? Math.min(...optionRows.map((r) => Number(r.price))).toFixed(2)
      : "0";
  }

  if (Object.keys(patch).length === 0) {
    res.json(existing);
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.update(servicesTable).set(patch).where(eq(servicesTable.id, id));
      if (replaceOptions) {
        // Hard-delete here is intentional: this is the existing "replace pricing
        // tiers" flow. The new option rows have fresh ids; the old ones become
        // unreachable. Soft-deleting them would clutter recomputeStartingPrice
        // results without preserving anything useful (no booking references the
        // option id directly — bookings denormalise option name+price).
        await tx.delete(serviceOptionsTable).where(eq(serviceOptionsTable.serviceId, id));
        if (optionRows.length > 0) {
          await tx.insert(serviceOptionsTable).values(
            optionRows.map((r) => ({ ...r, serviceId: id })),
          );
        }
      }
    });
  } catch (err) {
    const status = (err as { httpStatus?: number }).httpStatus ?? 500;
    res.status(status).json({ error: (err as Error).message });
    return;
  }

  const [updated] = await db.select().from(servicesTable).where(eq(servicesTable.id, id));
  req.log.info(
    { serviceId: id, fields: Object.keys(patch), replacedOptions: replaceOptions ? optionRows.length : null },
    "service.updated",
  );
  recordAudit(req, {
    entityType: "service",
    entityId: id,
    action: "update",
    summary: `Updated service "${updated?.title ?? existing.title}"`,
    metadata: {
      businessId: existing.businessId,
      fields: Object.keys(patch),
      replacedOptions: replaceOptions ? optionRows.length : null,
    },
  });
  res.json(updated);
});

/** DELETE /services/:id — SP soft-deletes one of their services.
 *  Phase 3 #10: stamps `deleted_at` instead of removing the row. We also
 *  soft-delete the service's options (so re-listing the service later
 *  doesn't surface stale pricing) and decrement the business `serviceCount`
 *  so plan-tier limits behave the same as before. The hard-delete path is
 *  retired because `bookings.service_id` is `ON DELETE RESTRICT` — any
 *  service with prior bookings would have failed the old DELETE outright. */
router.delete("/services/:id", requireRole("business", "admin"), async (req, res) => {
  const { id } = UpdateServiceParams.parse(req.params);
  const auth = req.auth!;

  const [existing] = await db.select().from(servicesTable).where(eq(servicesTable.id, id));
  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Service not found" });
    return;
  }
  if (auth.role !== "admin" && existing.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your service" });
    return;
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(servicesTable)
      .set({ deletedAt: now })
      .where(and(eq(servicesTable.id, id), isNull(servicesTable.deletedAt)));
    await tx
      .update(serviceOptionsTable)
      .set({ deletedAt: now })
      .where(and(eq(serviceOptionsTable.serviceId, id), isNull(serviceOptionsTable.deletedAt)));
    await tx
      .update(businessesTable)
      .set({ serviceCount: sql`GREATEST(${businessesTable.serviceCount} - 1, 0)` })
      .where(eq(businessesTable.id, existing.businessId));
  });

  req.log.info({ serviceId: id, businessId: existing.businessId }, "service.soft_deleted");
  recordAudit(req, {
    entityType: "service",
    entityId: id,
    action: "soft_delete",
    summary: `Removed service "${existing.title}"`,
    metadata: { businessId: existing.businessId, title: existing.title },
  });
  res.status(204).send();
});

/** POST /services/:id/options — SP adds a pricing option. Recomputes startingPrice. */
router.post("/services/:id/options", requireRole("business", "admin"), async (req, res) => {
  const { id: serviceId } = CreateServiceOptionParams.parse(req.params);
  const body = CreateServiceOptionBody.parse(req.body);
  const auth = req.auth!;

  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, serviceId));
  if (!svc || svc.deletedAt) {
    res.status(404).json({ error: "Service not found" });
    return;
  }
  if (auth.role !== "admin" && svc.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your service" });
    return;
  }

  const price = Number(body.price);
  if (!Number.isFinite(price) || price < 0) {
    res.status(400).json({ error: "price must be a non-negative number" });
    return;
  }

  const id = genId("opt");
  const [inserted] = await db
    .insert(serviceOptionsTable)
    .values({
      id,
      serviceId: svc.id,
      name: body.name,
      description: body.description ?? "",
      price: price.toFixed(2),
      duration: body.duration,
      defaultStartTime: body.defaultStartTime ?? null,
    })
    .returning();

  await recomputeStartingPrice(svc.id);
  req.log.info({ optionId: id, serviceId: svc.id, price: price.toFixed(2) }, "serviceOption.created");
  recordAudit(req, {
    entityType: "service_option",
    entityId: id,
    action: "create",
    summary: `Added pricing option "${body.name}" to "${svc.title}"`,
    metadata: { serviceId: svc.id, businessId: svc.businessId, price: price.toFixed(2) },
  });
  res.status(201).json(inserted);
});

/** PATCH /service-options/:id — SP edits one of their options. */
router.patch("/service-options/:id", requireRole("business", "admin"), async (req, res) => {
  const { id } = UpdateServiceOptionParams.parse(req.params);
  const body = UpdateServiceOptionBody.parse(req.body);
  const auth = req.auth!;

  const [existing] = await db
    .select()
    .from(serviceOptionsTable)
    .where(eq(serviceOptionsTable.id, id));
  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Option not found" });
    return;
  }

  // Ownership flows through the parent service.
  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, existing.serviceId));
  if (!svc || svc.deletedAt) {
    res.status(404).json({ error: "Parent service not found" });
    return;
  }
  if (auth.role !== "admin" && svc.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your option" });
    return;
  }

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined && body.name !== null) patch.name = body.name;
  if (body.description !== undefined && body.description !== null) patch.description = body.description;
  if (body.duration !== undefined && body.duration !== null) patch.duration = body.duration;
  // `defaultStartTime` is nullable: explicit `null` clears it, undefined leaves it alone.
  if (body.defaultStartTime !== undefined) patch.defaultStartTime = body.defaultStartTime;
  if (body.price !== undefined && body.price !== null) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) {
      res.status(400).json({ error: "price must be a non-negative number" });
      return;
    }
    patch.price = price.toFixed(2);
  }

  if (Object.keys(patch).length === 0) {
    res.json(existing);
    return;
  }

  const [updated] = await db
    .update(serviceOptionsTable)
    .set(patch)
    .where(eq(serviceOptionsTable.id, id))
    .returning();

  if ("price" in patch) await recomputeStartingPrice(svc.id);
  req.log.info({ optionId: id, fields: Object.keys(patch) }, "serviceOption.updated");
  recordAudit(req, {
    entityType: "service_option",
    entityId: id,
    action: "update",
    summary: `Updated option "${updated?.name ?? existing.name}" on "${svc.title}"`,
    metadata: { serviceId: svc.id, businessId: svc.businessId, fields: Object.keys(patch) },
  });
  res.json(updated);
});

/** DELETE /service-options/:id — SP soft-deletes one of their options.
 *  Phase 3 #10. Same rationale as service soft-delete; bookings carry their
 *  own snapshot so removing the live option doesn't break history. */
router.delete("/service-options/:id", requireRole("business", "admin"), async (req, res) => {
  const { id } = UpdateServiceOptionParams.parse(req.params);
  const auth = req.auth!;

  const [existing] = await db
    .select()
    .from(serviceOptionsTable)
    .where(eq(serviceOptionsTable.id, id));
  if (!existing || existing.deletedAt) {
    res.status(404).json({ error: "Option not found" });
    return;
  }

  const [svc] = await db.select().from(servicesTable).where(eq(servicesTable.id, existing.serviceId));
  if (!svc) {
    res.status(404).json({ error: "Parent service not found" });
    return;
  }
  if (auth.role !== "admin" && svc.businessId !== auth.businessId) {
    res.status(403).json({ error: "Forbidden: not your option" });
    return;
  }

  await db
    .update(serviceOptionsTable)
    .set({ deletedAt: new Date() })
    .where(and(eq(serviceOptionsTable.id, id), isNull(serviceOptionsTable.deletedAt)));
  await recomputeStartingPrice(svc.id);
  req.log.info({ optionId: id, serviceId: svc.id }, "serviceOption.soft_deleted");
  recordAudit(req, {
    entityType: "service_option",
    entityId: id,
    action: "soft_delete",
    summary: `Removed option "${existing.name}" from "${svc.title}"`,
    metadata: { serviceId: svc.id, businessId: svc.businessId, name: existing.name },
  });
  res.status(204).send();
});

export default router;
