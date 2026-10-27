import type { Logger } from "pino";
import { enqueueAndSendEmail } from "./emailOutbox";

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Base URL for the mobile web app, mirroring buildReturnUrls in
 * routes/bizAccounts.ts: Expo dev server host in dev, `/mobile` base path
 * behind the shared proxy in production.
 */
export function mobileWebBaseUrl(): string {
  const expoDomain = process.env.REPLIT_EXPO_DEV_DOMAIN?.trim();
  const prodDomain = process.env.REPLIT_DOMAINS?.split(",")[0]?.trim();
  if (process.env.NODE_ENV !== "production" && expoDomain) return `https://${expoDomain}`;
  if (prodDomain) return `https://${prodDomain}/mobile`;
  return "http://localhost/mobile";
}

/** Compose and enqueue the single-use password-reset email for an SP. */
export async function sendPasswordResetEmail(
  opts: { toEmail: string; ownerName: string; businessName: string; token: string; expiresMinutes: number },
  log: Logger,
): Promise<void> {
  const resetUrl = `${mobileWebBaseUrl()}/reset-password?token=${encodeURIComponent(opts.token)}`;
  const subject = "Reset your AK On Demand password";
  const greeting = `Hi ${escapeHtml(opts.ownerName)},`;
  const html = `
    <p>${greeting}</p>
    <p>We received a request to reset the password for the AK On Demand provider
    account for <strong>${escapeHtml(opts.businessName)}</strong>.</p>
    <p><a href="${resetUrl}">Click here to choose a new password</a>.</p>
    <p>This link works once and expires in ${opts.expiresMinutes} minutes.
    If you didn't request this, you can safely ignore this email — your
    password won't change.</p>
    <p>— AK On Demand</p>
  `.trim();
  const text = [
    `Hi ${opts.ownerName},`,
    "",
    `We received a request to reset the password for the AK On Demand provider account for ${opts.businessName}.`,
    "",
    `Choose a new password here: ${resetUrl}`,
    "",
    `This link works once and expires in ${opts.expiresMinutes} minutes. If you didn't request this, you can safely ignore this email — your password won't change.`,
    "",
    "— AK On Demand",
  ].join("\n");

  try {
    await enqueueAndSendEmail({ toEmail: opts.toEmail, subject, html, text, kind: "password_reset" }, log);
  } catch (err) {
    // enqueueAndSendEmail persists to the outbox before attempting delivery,
    // so a transport failure here still retries in the background.
    log.warn({ err, toEmail: opts.toEmail }, "passwordResetEmail.threw");
  }
}
