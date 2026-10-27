import { db, notificationsTable, usersTable } from "@workspace/db";
import type { InsertNotification } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { genId } from "./ids";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TOKEN_RE = /^ExponentPushToken\[[^\]]+\]$/;

export interface CreateNotificationInput {
  userId: string;
  kind: InsertNotification["kind"];
  title: string;
  body: string;
  bookingId?: string | null;
}

/**
 * Persist an in-app notification AND best-effort send an Expo push if the
 * recipient has registered a push token. Failures are swallowed (logged) so
 * a flaky push provider can't break the booking flow that triggered the
 * notification.
 */
export async function createNotification(
  input: CreateNotificationInput,
  log: Logger,
): Promise<void> {
  const id = genId("ntf");
  await db.insert(notificationsTable).values({
    id,
    userId: input.userId,
    kind: input.kind,
    title: input.title,
    body: input.body,
    bookingId: input.bookingId ?? null,
  });

  // Lookup the recipient's push token; skip silently when absent or malformed.
  const [u] = await db.select({ pushToken: usersTable.pushToken })
    .from(usersTable)
    .where(eq(usersTable.id, input.userId));
  const token = u?.pushToken;
  if (!token || !EXPO_TOKEN_RE.test(token)) {
    log.debug({ notificationId: id, userId: input.userId, hasToken: !!token }, "notification.created_no_push");
    return;
  }

  // Hard 1.5s timeout via AbortController so a slow/hanging Expo endpoint
  // can never delay the booking response. The notification row is already
  // committed; an undelivered push only loses the OS banner, not the in-app
  // feed entry.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
      },
      body: JSON.stringify({
        to: token,
        sound: "default",
        title: input.title,
        body: input.body,
        data: {
          notificationId: id,
          bookingId: input.bookingId ?? null,
          kind: input.kind,
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      log.warn({ notificationId: id, status: res.status }, "expo.push_failed");
    } else {
      log.debug({ notificationId: id, userId: input.userId }, "expo.push_sent");
    }
  } catch (err) {
    log.warn({ notificationId: id, err }, "expo.push_threw");
  } finally {
    clearTimeout(timer);
  }
}
