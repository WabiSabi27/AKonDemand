import bcrypt from "bcryptjs";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { logger } from "./logger";

const BCRYPT_COST = 10;

/**
 * One-shot bootstrap of the admin password from `ADMIN_BOOTSTRAP_PASSWORD`.
 *
 * If the env var is set AND the seeded admin user has no `passwordHash`, we
 * hash the env value and persist it. Operators are expected to unset the env
 * var on the next deploy so the secret is not retained in the runtime
 * environment longer than necessary.
 *
 * If the admin user has no password AND the env var is not set, we log a
 * critical warning — admin login is effectively disabled until the operator
 * provides one.
 */
export async function bootstrapAdminPassword(): Promise<void> {
  const [admin] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.role, "admin"))
    .limit(1);

  if (!admin) {
    logger.warn("admin-bootstrap: no admin user seeded; admin login disabled");
    return;
  }

  const envPw = process.env.ADMIN_BOOTSTRAP_PASSWORD;

  if (admin.passwordHash) {
    if (!envPw) return;
    if (envPw.length < 8) {
      logger.error(
        "admin-bootstrap: ADMIN_BOOTSTRAP_PASSWORD must be at least 8 characters; refusing to sync",
      );
      return;
    }
    // While the secret is set, it is the source of truth for the admin
    // password: if the stored hash no longer matches, reset it and clear any
    // login lockout so the operator can always recover access by updating the
    // secret and redeploying. Unset the secret to freeze the current password
    // (e.g. after changing it in-app).
    const matches = await bcrypt.compare(envPw, admin.passwordHash);
    if (matches) return;
    const hash = await bcrypt.hash(envPw, BCRYPT_COST);
    // Conditional on the hash we compared against, so a concurrent in-app
    // password change (or another boot's reset) is never clobbered — if the
    // row changed under us, we skip; the next boot re-evaluates. tokenVersion
    // increments atomically in SQL to revoke previously issued admin JWTs.
    // The lockout is cleared only here (i.e. only when the password actually
    // changes), not on every boot, so restarts don't erode lockout protection.
    const updated = await db
      .update(usersTable)
      .set({
        passwordHash: hash,
        failedLoginAttempts: 0,
        lockedUntil: null,
        tokenVersion: sql`${usersTable.tokenVersion} + 1`,
      })
      .where(
        and(
          eq(usersTable.id, admin.id),
          eq(usersTable.passwordHash, admin.passwordHash),
        ),
      )
      .returning({ id: usersTable.id });
    if (updated.length > 0) {
      logger.warn(
        { userId: admin.id, email: admin.email },
        "admin-bootstrap: admin password reset from ADMIN_BOOTSTRAP_PASSWORD and lockout cleared — unset the secret to stop syncing",
      );
    } else {
      logger.info(
        { userId: admin.id },
        "admin-bootstrap: admin password changed concurrently; skipping reset",
      );
    }
    return;
  }

  if (!envPw) {
    logger.warn(
      { userId: admin.id, email: admin.email },
      "admin-bootstrap: admin has no password and ADMIN_BOOTSTRAP_PASSWORD is unset — admin login is DISABLED until you set it",
    );
    return;
  }

  if (envPw.length < 8) {
    logger.error(
      "admin-bootstrap: ADMIN_BOOTSTRAP_PASSWORD must be at least 8 characters; refusing to set",
    );
    return;
  }

  const hash = await bcrypt.hash(envPw, BCRYPT_COST);
  // Conditional update guards against a race where two boots try to set it
  // concurrently — only the first one (where passwordHash is still NULL) wins.
  const updated = await db
    .update(usersTable)
    .set({ passwordHash: hash })
    .where(and(eq(usersTable.id, admin.id), isNull(usersTable.passwordHash)))
    .returning({ id: usersTable.id });

  if (updated.length > 0) {
    logger.warn(
      { userId: admin.id, email: admin.email },
      "admin-bootstrap: initial admin password set from ADMIN_BOOTSTRAP_PASSWORD — unset the env var on the next deploy",
    );
  }
}
