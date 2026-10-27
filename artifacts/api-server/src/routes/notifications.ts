import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, notificationsTable, usersTable } from "@workspace/db";
import { MarkNotificationReadParams, RegisterPushTokenBody } from "@workspace/api-zod";
import { requireUser } from "../middlewares/auth";

const router: IRouter = Router();

/** GET /notifications — list this user's notifications, newest first. */
router.get("/notifications", requireUser, async (req, res) => {
  const auth = req.auth!;
  const rows = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.userId, auth.userId))
    .orderBy(desc(notificationsTable.createdAt));
  res.json(rows);
});

/** PATCH /notifications/:id/read — mark a single notification as read. */
router.patch("/notifications/:id/read", requireUser, async (req, res) => {
  const auth = req.auth!;
  const { id } = MarkNotificationReadParams.parse(req.params);
  const [existing] = await db
    .select()
    .from(notificationsTable)
    .where(eq(notificationsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Notification not found" });
    return;
  }
  if (existing.userId !== auth.userId) {
    res.status(403).json({ error: "Forbidden: not your notification" });
    return;
  }
  if (existing.readAt) {
    // Idempotent — already read.
    res.json(existing);
    return;
  }
  const [updated] = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(eq(notificationsTable.id, id))
    .returning();
  res.json(updated);
});

/** PATCH /notifications/read-all — mark every unread notification for this user. */
router.patch("/notifications/read-all", requireUser, async (req, res) => {
  const auth = req.auth!;
  const updated = await db
    .update(notificationsTable)
    .set({ readAt: new Date() })
    .where(
      and(eq(notificationsTable.userId, auth.userId), isNull(notificationsTable.readAt)),
    )
    .returning({ id: notificationsTable.id });
  res.json({ updated: updated.length });
});

/** PUT /me/push-token — store or clear the caller's Expo push token. */
router.put("/me/push-token", requireUser, async (req, res) => {
  const auth = req.auth!;
  const parsed = RegisterPushTokenBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "pushToken must be a string or null" });
    return;
  }
  const raw = parsed.data.pushToken;
  const token = raw === null || raw === undefined ? null : raw.trim() || null;
  await db
    .update(usersTable)
    .set({ pushToken: token })
    .where(eq(usersTable.id, auth.userId));
  req.log.info({ userId: auth.userId, hasToken: !!token }, "push_token.updated");
  res.status(204).end();
});

export default router;
