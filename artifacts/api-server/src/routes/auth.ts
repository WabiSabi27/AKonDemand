import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { sendPasswordResetEmail } from "../lib/passwordResetEmail";
import { Secret, TOTP } from "otpauth";
import { db, usersTable, bizAccountsTable } from "@workspace/db";
import {
  LoginCustomerBody,
  LoginBusinessBody,
  ForgotBusinessPasswordBody,
  ResetBusinessPasswordBody,
  LoginAdminBody,
  AdminChangePasswordBody,
  AdminTotpConfirmBody,
  AdminTotpDisableBody,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import { signToken, comparePassword, type AuthRole } from "../lib/auth";
import { requireUser, requireRole } from "../middlewares/auth";

const router: IRouter = Router();

const BCRYPT_COST = 10;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const TOTP_ISSUER = "AK On Demand";
// Dummy bcrypt hash used to keep timing constant when an account is missing
// or has no password configured. Never matches any real password.
const DUMMY_HASH = "$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";

function publicUser(row: {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
  businessId: string | null;
}) {
  return {
    id: row.id,
    name: row.name ?? "",
    email: row.email ?? "",
    role: (row.role ?? "customer") as AuthRole,
    businessId: row.businessId ?? null,
  };
}

function makeTotp(secret: string): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label: "Admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

/** POST /auth/customer — frictionless signup-or-login by email + name. */
router.post("/auth/customer", async (req, res) => {
  const body = LoginCustomerBody.parse(req.body);
  const email = body.email.trim().toLowerCase();
  const name = body.name.trim();

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  let row = existing;
  if (!row) {
    const id = `cust_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const [inserted] = await db
      .insert(usersTable)
      .values({ id, name, email, role: "customer" })
      .returning();
    row = inserted;
    req.log.info({ userId: id, email }, "auth.customer: created new user");
  } else if (row.role !== "customer") {
    res.status(403).json({ error: "This email is registered to a different account type" });
    return;
  } else if (name && row.name !== name) {
    await db.update(usersTable).set({ name }).where(eq(usersTable.id, row.id));
    row = { ...row, name };
  }

  const user = publicUser(row);
  const token = signToken({ userId: user.id, role: user.role });
  req.log.info({ userId: user.id }, "auth.customer: login ok");
  res.json({ token, user });
});

/** POST /auth/business/login — SP login against bcrypt hash on biz_accounts. */
router.post("/auth/business/login", async (req, res) => {
  const body = LoginBusinessBody.parse(req.body);
  const email = body.email.trim().toLowerCase();

  const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.email, email));
  const hashToCheck = acct?.passwordHash ?? DUMMY_HASH;
  const ok = await comparePassword(body.password, hashToCheck);
  if (!acct || !ok) {
    req.log.warn({ email }, "auth.business: bad credentials");
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  if (acct.status !== "approved") {
    // Include the account id so the client can resume the right funnel step
    // (e.g. an `accepted` applicant can re-open the $60 onboarding checkout).
    res.status(403).json({ error: `Account status: ${acct.status}`, bizAccountId: acct.id });
    return;
  }
  if (!acct.ownerId) {
    res.status(500).json({ error: "Account is missing owner; contact support" });
    return;
  }

  const [ownerUser] = await db.select().from(usersTable).where(eq(usersTable.id, acct.ownerId));
  if (!ownerUser) {
    res.status(500).json({ error: "Owner user not found; contact support" });
    return;
  }

  const user = publicUser({
    ...ownerUser,
    name: acct.businessName,
    email: acct.email,
    role: "business",
    businessId: acct.id,
  });
  const token = signToken({ userId: user.id, role: "business", businessId: acct.id });
  req.log.info({ userId: user.id, businessId: acct.id }, "auth.business: login ok");
  res.json({ token, user });
});

// ---------------------------------------------------------------------------
// SP forgot-password flow. The raw token only ever travels inside the email;
// we store its sha256 so a DB leak can't be replayed as a reset link.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
// Throttle windows for the public forgot-password trigger: without them an
// attacker could mail-bomb a provider and keep replacing their outstanding
// token (denial of recovery). In-memory is proportionate here (single
// process; a restart merely reopens the small window).
const FORGOT_PW_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_PW_MAX_PER_EMAIL = 3;
const FORGOT_PW_MAX_PER_IP = 10;
const forgotPwHits = new Map<string, number[]>();

function forgotPwAllowed(key: string, max: number): boolean {
  const now = Date.now();
  const hits = (forgotPwHits.get(key) ?? []).filter((t) => now - t < FORGOT_PW_WINDOW_MS);
  if (hits.length >= max) {
    forgotPwHits.set(key, hits);
    return false;
  }
  hits.push(now);
  forgotPwHits.set(key, hits);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (forgotPwHits.size > 5000) {
    for (const [k, v] of forgotPwHits) {
      if (v.every((t) => now - t >= FORGOT_PW_WINDOW_MS)) forgotPwHits.delete(k);
    }
  }
  return true;
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * POST /auth/business/forgot-password — always the same 200 body whether or
 * not the account exists (no enumeration). Token generation + email delivery
 * happen AFTER the response is sent, so response timing doesn't reveal
 * whether the email matched an account either.
 */
router.post("/auth/business/forgot-password", async (req, res) => {
  const body = ForgotBusinessPasswordBody.parse(req.body);
  const email = body.email.trim().toLowerCase();
  const ip = req.ip ?? "unknown";

  const allowed =
    forgotPwAllowed(`ip:${ip}`, FORGOT_PW_MAX_PER_IP) &&
    forgotPwAllowed(`email:${email}`, FORGOT_PW_MAX_PER_EMAIL);

  // Generic response first — identical body and (near-)identical timing for
  // known, unknown, and throttled requests alike.
  res.json({ ok: true });
  if (!allowed) {
    req.log.warn({ email }, "auth.business: forgot-password throttled");
    return;
  }

  setImmediate(async () => {
    try {
      const [acct] = await db
        .select()
        .from(bizAccountsTable)
        .where(eq(bizAccountsTable.email, email));
      if (!acct) {
        req.log.info({ email }, "auth.business: forgot-password for unknown email");
        return;
      }
      const token = randomBytes(32).toString("hex");
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
      await db
        .update(bizAccountsTable)
        .set({ passwordResetTokenHash: hashResetToken(token), passwordResetExpiresAt: expiresAt })
        .where(eq(bizAccountsTable.id, acct.id));
      await sendPasswordResetEmail(
        {
          toEmail: acct.email,
          ownerName: acct.ownerName,
          businessName: acct.businessName,
          token,
          expiresMinutes: RESET_TOKEN_TTL_MS / 60_000,
        },
        req.log,
      );
      req.log.info({ bizAccountId: acct.id }, "auth.business: password reset email queued");
    } catch (err) {
      req.log.error({ err, email }, "auth.business: forgot-password background work failed");
    }
  });
});

/** POST /auth/business/reset-password — single-use token, 1h expiry. */
router.post("/auth/business/reset-password", async (req, res) => {
  const body = ResetBusinessPasswordBody.parse(req.body);
  const tokenHash = hashResetToken(body.token);

  const [acct] = await db
    .select()
    .from(bizAccountsTable)
    .where(eq(bizAccountsTable.passwordResetTokenHash, tokenHash));
  if (
    !acct ||
    !acct.passwordResetExpiresAt ||
    acct.passwordResetExpiresAt.getTime() < Date.now()
  ) {
    res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
    return;
  }

  const hash = await bcrypt.hash(body.password, BCRYPT_COST);
  // Conditional on the token hash AND a still-unexpired timestamp, evaluated
  // at write time — the link is strictly single-use under concurrent
  // submissions, and a request that started before expiry can't complete
  // after it.
  const updated = await db
    .update(bizAccountsTable)
    .set({ passwordHash: hash, passwordResetTokenHash: null, passwordResetExpiresAt: null })
    .where(
      and(
        eq(bizAccountsTable.id, acct.id),
        eq(bizAccountsTable.passwordResetTokenHash, tokenHash),
        sql`${bizAccountsTable.passwordResetExpiresAt} > NOW()`,
      ),
    )
    .returning({ id: bizAccountsTable.id });
  if (updated.length === 0) {
    res.status(400).json({ error: "This reset link is invalid or has expired. Please request a new one." });
    return;
  }
  req.log.info({ bizAccountId: acct.id }, "auth.business: password reset ok");
  res.json({ ok: true });
});

/**
 * POST /auth/admin — admin login via email + bcrypt password (+ optional TOTP).
 *
 * Throttling:
 *   - If `lockedUntil > now`, returns 423 with `retryAfterSeconds`.
 *   - Each failed attempt increments `failedLoginAttempts`. At MAX_FAILED_ATTEMPTS
 *     we set `lockedUntil = now + LOCKOUT_MS` and reset the counter.
 *   - Any successful login clears both fields.
 *
 * TOTP:
 *   - Enforced iff `totpEnrolledAt` is non-null (a pending un-confirmed enrollment
 *     never locks the user out).
 *   - Wrong code is treated identically to a wrong password (counts toward lockout).
 */
router.post("/auth/admin", async (req, res) => {
  const body = LoginAdminBody.parse(req.body);
  const email = body.email.trim().toLowerCase();

  const [admin] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email));

  // Lockout check — performed BEFORE bcrypt so a locked account doesn't burn
  // CPU on a hopeless compare. Only enforce for an actual admin row.
  if (admin?.role === "admin" && admin.lockedUntil && admin.lockedUntil > new Date()) {
    const retryAfterSeconds = Math.ceil((admin.lockedUntil.getTime() - Date.now()) / 1000);
    req.log.warn({ userId: admin.id, retryAfterSeconds }, "auth.admin: locked");
    res.status(423).json({ error: "Account temporarily locked", retryAfterSeconds });
    return;
  }

  const hashToCheck = admin?.passwordHash ?? DUMMY_HASH;
  const passwordOk = await comparePassword(body.password, hashToCheck);
  const isAdmin = admin?.role === "admin" && !!admin.passwordHash;

  // Fail closed if state is inconsistent: enrolledAt set but secret missing
  // means TOTP was somehow half-disabled. Treat as auth failure rather than
  // silently bypassing 2FA.
  const totpStateInconsistent = isAdmin && !!admin.totpEnrolledAt && !admin.totpSecret;

  let totpOk = true;
  if (isAdmin && admin.totpEnrolledAt) {
    if (!admin.totpSecret) {
      totpOk = false;
    } else if (!body.totpCode) {
      totpOk = false;
    } else {
      const totp = makeTotp(admin.totpSecret);
      // `validate` returns the time-step delta if matched, else null. ±1 step
      // window absorbs minor clock drift between server and authenticator.
      const delta = totp.validate({ token: body.totpCode, window: 1 });
      totpOk = delta !== null;
    }
  }

  if (!isAdmin || !passwordOk || !totpOk) {
    if (admin?.role === "admin") {
      // Atomic increment + conditional lock — single SQL UPDATE so concurrent
      // failed attempts cannot lose increments via read-modify-write races.
      // Once `failed_login_attempts + 1 >= MAX`, the same statement resets the
      // counter to 0 and stamps `locked_until = now + LOCKOUT_MS`.
      const lockoutSeconds = Math.floor(LOCKOUT_MS / 1000);
      const updated = await db
        .update(usersTable)
        .set({
          failedLoginAttempts: sql`CASE WHEN ${usersTable.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} THEN 0 ELSE ${usersTable.failedLoginAttempts} + 1 END`,
          lockedUntil: sql`CASE WHEN ${usersTable.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} THEN NOW() + (${lockoutSeconds} * INTERVAL '1 second') ELSE ${usersTable.lockedUntil} END`,
        })
        .where(eq(usersTable.id, admin.id))
        .returning({
          failedLoginAttempts: usersTable.failedLoginAttempts,
          lockedUntil: usersTable.lockedUntil,
        });
      req.log.warn(
        {
          userId: admin.id,
          failedLoginAttempts: updated[0]?.failedLoginAttempts,
          locked: !!updated[0]?.lockedUntil && updated[0].lockedUntil > new Date(),
          totpRequired: !!admin.totpEnrolledAt,
          totpStateInconsistent,
        },
        "auth.admin: failed attempt",
      );
    } else {
      req.log.warn({ email }, "auth.admin: unknown account or no password");
    }
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }

  // Success — clear throttling state.
  if ((admin.failedLoginAttempts ?? 0) > 0 || admin.lockedUntil) {
    await db
      .update(usersTable)
      .set({ failedLoginAttempts: 0, lockedUntil: null })
      .where(eq(usersTable.id, admin.id));
  }

  const user = publicUser(admin);
  const token = signToken({ userId: user.id, role: "admin", tv: admin.tokenVersion });
  req.log.info({ userId: user.id, tv: admin.tokenVersion }, "auth.admin: login ok");
  res.json({ token, user });
});

/** POST /auth/admin/change-password — admin changes their own password. */
router.post("/auth/admin/change-password", requireRole("admin"), async (req, res) => {
  const body = AdminChangePasswordBody.parse(req.body);
  const auth = req.auth!;

  const [admin] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!admin || !admin.passwordHash) {
    res.status(401).json({ error: "Account not found" });
    return;
  }

  const ok = await comparePassword(body.currentPassword, admin.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  const newHash = await bcrypt.hash(body.newPassword, BCRYPT_COST);
  // Bump tokenVersion atomically so every previously-issued admin JWT is
  // rejected by `requireUser`/`requireRole` from the next request onward.
  await db
    .update(usersTable)
    .set({
      passwordHash: newHash,
      tokenVersion: sql`${usersTable.tokenVersion} + 1`,
    })
    .where(eq(usersTable.id, admin.id));
  req.log.info({ userId: admin.id }, "auth.admin: password changed (tokens revoked)");
  res.json({ ok: true });
});

/**
 * POST /auth/admin/totp/enroll — generate a fresh TOTP secret.
 *
 * The secret is persisted immediately as **pending** (`totpSecret` set,
 * `totpEnrolledAt` still NULL). Login does not enforce TOTP until the admin
 * proves possession of the secret via `/totp/confirm`. Re-enrolling overwrites
 * any previous pending secret; an already-confirmed enrollment must be
 * disabled first.
 */
router.post("/auth/admin/totp/enroll", requireRole("admin"), async (req, res) => {
  const auth = req.auth!;
  const [admin] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!admin) {
    res.status(401).json({ error: "Account not found" });
    return;
  }
  if (admin.totpEnrolledAt) {
    res.status(409).json({ error: "TOTP is already enrolled; disable it first to re-enroll" });
    return;
  }

  const secret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: TOTP_ISSUER,
    label: admin.email ?? admin.id,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  await db
    .update(usersTable)
    .set({ totpSecret: secret.base32, totpEnrolledAt: null })
    .where(eq(usersTable.id, admin.id));

  req.log.info({ userId: admin.id }, "auth.admin: totp enroll started");
  res.json({ secret: secret.base32, otpauthUrl: totp.toString() });
});

/** POST /auth/admin/totp/confirm — finish enrollment by submitting a valid code. */
router.post("/auth/admin/totp/confirm", requireRole("admin"), async (req, res) => {
  const body = AdminTotpConfirmBody.parse(req.body);
  const auth = req.auth!;
  const [admin] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!admin?.totpSecret) {
    res.status(409).json({ error: "No pending TOTP enrollment" });
    return;
  }
  if (admin.totpEnrolledAt) {
    res.status(409).json({ error: "TOTP is already confirmed" });
    return;
  }

  const totp = makeTotp(admin.totpSecret);
  const delta = totp.validate({ token: body.code, window: 1 });
  if (delta === null) {
    res.status(401).json({ error: "Invalid code" });
    return;
  }

  await db
    .update(usersTable)
    .set({ totpEnrolledAt: new Date() })
    .where(eq(usersTable.id, admin.id));
  req.log.info({ userId: admin.id }, "auth.admin: totp confirmed");
  res.json({ ok: true });
});

/** POST /auth/admin/totp/disable — disable TOTP after re-verifying password. */
router.post("/auth/admin/totp/disable", requireRole("admin"), async (req, res) => {
  const body = AdminTotpDisableBody.parse(req.body);
  const auth = req.auth!;
  const [admin] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!admin?.passwordHash) {
    res.status(401).json({ error: "Account not found" });
    return;
  }
  const ok = await comparePassword(body.password, admin.passwordHash);
  if (!ok) {
    res.status(401).json({ error: "Password is incorrect" });
    return;
  }
  await db
    .update(usersTable)
    .set({ totpSecret: null, totpEnrolledAt: null })
    .where(eq(usersTable.id, admin.id));
  req.log.info({ userId: admin.id }, "auth.admin: totp disabled");
  res.json({ ok: true });
});

/** GET /auth/me — returns the authenticated user. */
router.get("/auth/me", requireUser, async (req, res) => {
  const auth = req.auth!;
  const [row] = await db.select().from(usersTable).where(eq(usersTable.id, auth.userId));
  if (!row) {
    res.status(401).json({ error: "User no longer exists" });
    return;
  }

  if (auth.role === "business" && auth.businessId) {
    const [acct] = await db.select().from(bizAccountsTable).where(eq(bizAccountsTable.id, auth.businessId));
    if (acct) {
      const merged = { ...row, name: acct.businessName, email: acct.email, role: "business", businessId: acct.id };
      res.json(GetCurrentUserResponse.parse({ user: publicUser(merged) }));
      return;
    }
  }

  const merged = { ...row, businessId: auth.businessId ?? row.businessId };
  res.json(GetCurrentUserResponse.parse({ user: publicUser(merged) }));
});

export default router;
