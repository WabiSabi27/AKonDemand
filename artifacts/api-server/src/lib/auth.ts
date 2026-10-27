import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

export type AuthRole = "customer" | "business" | "admin";

export interface AuthPayload {
  userId: string;
  role: AuthRole;
  businessId?: string;
  /** Token version. Embedded only in admin tokens; verified against
   * `users.tokenVersion` on every admin request so a password change
   * invalidates all previously-issued admin tokens. */
  tv?: number;
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required for auth (set via Replit secrets).");
}

const SECRET: string = SESSION_SECRET;
const TOKEN_TTL = "30d";

export function signToken(payload: AuthPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    const decoded = jwt.verify(token, SECRET);
    if (typeof decoded === "string") return null;
    const { userId, role, businessId, tv } = decoded as jwt.JwtPayload & Partial<AuthPayload>;
    if (typeof userId !== "string" || (role !== "customer" && role !== "business" && role !== "admin")) {
      return null;
    }
    return {
      userId,
      role,
      businessId: typeof businessId === "string" ? businessId : undefined,
      tv: typeof tv === "number" ? tv : undefined,
    };
  } catch {
    return null;
  }
}

export async function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
