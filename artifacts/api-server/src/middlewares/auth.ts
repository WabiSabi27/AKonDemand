import type { Request, Response, NextFunction, RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { verifyToken, type AuthPayload, type AuthRole } from "../lib/auth";

/**
 * For admin tokens only: verify the embedded `tv` claim matches the user's
 * current `tokenVersion`. Returns true iff the token is still valid. A
 * password change bumps `tokenVersion`, invalidating prior tokens. Non-admin
 * roles are not subject to this check (they have no password-change flow).
 */
async function isAdminTokenCurrent(payload: AuthPayload): Promise<boolean> {
  const [row] = await db
    .select({ tokenVersion: usersTable.tokenVersion })
    .from(usersTable)
    .where(eq(usersTable.id, payload.userId));
  if (!row) return false;
  return (payload.tv ?? -1) === row.tokenVersion;
}

// Augment Express's Request to carry the verified auth payload. Express 5 here
// re-exports its types via @types/express; augmenting via the global Express
// namespace works regardless of whether express-serve-static-core is installed.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") return null;
  // Match "Bearer <token>" — case-insensitive scheme, exactly one space, non-empty token.
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() || null : null;
}

/**
 * Best-effort: attaches `req.auth` if a valid token is present, but never rejects.
 * Use for endpoints that personalise responses but tolerate anonymous callers.
 */
export const attachUser: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    const payload = verifyToken(token);
    if (payload) req.auth = payload;
  }
  next();
};

export const requireUser: RequestHandler = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }
  if (payload.role === "admin" && !(await isAdminTokenCurrent(payload))) {
    res.status(401).json({ error: "Session expired; please sign in again" });
    return;
  }
  req.auth = payload;
  next();
};

export function requireRole(...allowed: AuthRole[]): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req);
    const payload = token ? verifyToken(token) : null;
    if (!payload) {
      res.status(401).json({ error: "Missing or invalid token" });
      return;
    }
    if (!allowed.includes(payload.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    if (payload.role === "admin" && !(await isAdminTokenCurrent(payload))) {
      res.status(401).json({ error: "Session expired; please sign in again" });
      return;
    }
    req.auth = payload;
    next();
  };
}
