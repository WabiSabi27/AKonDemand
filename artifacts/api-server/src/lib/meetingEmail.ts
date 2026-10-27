import { ReplitConnectors } from "@replit/connectors-sdk";
import nodemailer from "nodemailer";
import type { Logger } from "pino";
import { enqueueAndSendEmail } from "./emailOutbox";
import { renderIcs } from "./ical";

const DEFAULT_MEETING_DURATION_MINUTES = 60; // interviews default to 1 hour

/**
 * Build the .ics calendar invite for a meeting email. Stable UID per biz
 * account (`meeting-<bizAccountId>@akondemand`) + a bumped SEQUENCE means
 * reschedules and cancellations update the SAME event in the provider's
 * calendar rather than piling up duplicates. Times are emitted as UTC
 * (`...Z`), so calendar clients render them correctly in any timezone,
 * including America/Anchorage.
 */
function buildMeetingInvite(opts: {
  bizAccountId: string;
  kind: "scheduled" | "rescheduled" | "cancelled";
  meetingAt: Date;
  businessName: string;
  ownerName: string;
  toEmail: string;
  sequence: number;
  /** Free-form meeting place (address or notes); empty string = not set. */
  location: string;
  /** Meeting length in minutes; falls back to 60 when not positive. */
  durationMinutes: number;
}): { content: string; method: "REQUEST" | "CANCEL" } {
  const method = opts.kind === "cancelled" ? "CANCEL" : "REQUEST";
  const organizerEmail = process.env["SMTP_USER"] ?? "no-reply@akondemand.local";
  const durationMinutes =
    opts.durationMinutes > 0 ? opts.durationMinutes : DEFAULT_MEETING_DURATION_MINUTES;
  const content = renderIcs({
    prodId: "AK On Demand//Interview Scheduler",
    calendarName: "AK On Demand",
    method,
    events: [
      {
        uid: `meeting-${opts.bizAccountId}@akondemand`,
        summary: `AK On Demand interview — ${opts.businessName}`,
        description:
          method === "CANCEL"
            ? "This interview has been cancelled. An AK On Demand admin will be in touch to reschedule."
            : "In-person interview for your AK On Demand service provider application. If you need to reschedule, reply to the email or contact the AK On Demand team.",
        location: opts.location || undefined,
        start: opts.meetingAt,
        end: new Date(opts.meetingAt.getTime() + durationMinutes * 60_000),
        sequence: opts.sequence,
        status: method === "CANCEL" ? "CANCELLED" : "CONFIRMED",
        organizer: { name: "AK On Demand", email: organizerEmail },
        attendees: [{ name: opts.ownerName, email: opts.toEmail }],
      },
    ],
  });
  return { content, method };
}

/**
 * Format a Date as a human-readable string in US/Alaska time so the provider
 * sees the meeting time in the timezone most relevant to them.
 */
function formatMeetingDate(date: Date): string {
  return date.toLocaleString("en-US", {
    timeZone: "America/Anchorage",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

type MeetingEmailKind =
  | "application_received"
  | "scheduled"
  | "rescheduled"
  | "cancelled"
  | "accepted"
  | "approved"
  | "rejected";

const RESEND_CONNECTION_ID = "conn_resend_01KYZTWYEXEAAGXG1RA56H4586";

/**
 * Read the verified sender address configured on the Resend connection.
 * Resend rejects senders from unverified domains, so we must use the address
 * the user configured rather than a hardcoded one. Cached for 5 minutes.
 */
let cachedFrom: { value: string; at: number } | null = null;
async function getFromEmail(): Promise<string | null> {
  if (cachedFrom && Date.now() - cachedFrom.at < 5 * 60_000) return cachedFrom.value;
  const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
  const token = process.env["REPL_IDENTITY"]
    ? "repl " + process.env["REPL_IDENTITY"]
    : process.env["WEB_REPL_RENEWAL"]
      ? "depl " + process.env["WEB_REPL_RENEWAL"]
      : null;
  if (!hostname || !token) return null;
  const url = new URL(`https://${hostname}/api/v2/connection/${RESEND_CONNECTION_ID}`);
  const res = await fetch(url, { headers: { Accept: "application/json", "X-Replit-Token": token } });
  if (!res.ok) return null;
  const data = (await res.json()) as { settings?: { from_email?: string } };
  const from = data.settings?.from_email ?? null;
  if (from) cachedFrom = { value: from, at: Date.now() };
  return from;
}

/** Escape user-supplied text before interpolating it into HTML email bodies. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildEmailContent(
  kind: MeetingEmailKind,
  ownerName: string,
  rawBusinessName: string,
  meetingAt: Date | null,
  rejectedReason?: string | null,
  meetingLocation?: string,
): { subject: string; html: string; text: string } {
  // HTML variants are escaped; plain-text variants stay raw.
  const greetingText = `Hi ${ownerName},`;
  const greeting = `Hi ${escapeHtml(ownerName)},`;
  const businessName = escapeHtml(rawBusinessName);
  const businessNameText = rawBusinessName;

  if (kind === "application_received") {
    const subject = "We received your AK On Demand application";
    const body = `Thank you for applying to AK On Demand with <strong>${businessName}</strong> — your application fee payment has been received.<br><br><strong>What happens next:</strong><br>1. Our team will review your application.<br>2. If it looks good, we'll email you to schedule an in-person interview.<br>3. After the interview, you'll get a decision by email.<br><br>If you have any questions in the meantime, just reply to this email.`;
    const bodyText = `Thank you for applying to AK On Demand with ${businessNameText} — your application fee payment has been received.\n\nWhat happens next:\n1. Our team will review your application.\n2. If it looks good, we'll email you to schedule an in-person interview.\n3. After the interview, you'll get a decision by email.\n\nIf you have any questions in the meantime, just reply to this email.`;
    return {
      subject,
      html: buildHtml(greeting, body),
      text: `${greetingText}\n\n${bodyText}\n\nThe AK On Demand Team`,
    };
  }

  if (kind === "accepted") {
    const subject = "Your AK On Demand application has been accepted!";
    const body = `Great news — your application for <strong>${businessName}</strong> has been accepted after your interview!<br><br><strong>Next steps:</strong><br>1. Log in to AK On Demand with the email and password you chose when you applied.<br>2. Pay the one-time onboarding fee shown after you log in.<br>3. Once paid, your business goes live and you can start taking bookings.<br><br>If you have any questions, just reply to this email.`;
    const bodyText = `Great news — your application for ${businessNameText} has been accepted after your interview!\n\nNext steps:\n1. Log in to AK On Demand with the email and password you chose when you applied.\n2. Pay the one-time onboarding fee shown after you log in.\n3. Once paid, your business goes live and you can start taking bookings.\n\nIf you have any questions, just reply to this email.`;
    return {
      subject,
      html: buildHtml(greeting, body),
      text: `${greetingText}\n\n${bodyText}\n\nThe AK On Demand Team`,
    };
  }

  if (kind === "approved") {
    const subject = "Your AK On Demand application has been approved!";
    const body = `Congratulations — your application for <strong>${businessName}</strong> has been approved!<br><br>Your business is now live on the AK On Demand marketplace. Log in with the email and password you chose when you applied to manage your profile and start taking bookings.<br><br>If you have any questions, just reply to this email.`;
    const bodyText = `Congratulations — your application for ${businessNameText} has been approved!\n\nYour business is now live on the AK On Demand marketplace. Log in with the email and password you chose when you applied to manage your profile and start taking bookings.\n\nIf you have any questions, just reply to this email.`;
    return {
      subject,
      html: buildHtml(greeting, body),
      text: `${greetingText}\n\n${bodyText}\n\nThe AK On Demand Team`,
    };
  }

  if (kind === "rejected") {
    const subject = "An update on your AK On Demand application";
    const reasonHtml = rejectedReason
      ? `<br><br><strong>Reason:</strong> ${escapeHtml(rejectedReason)}`
      : "";
    const reasonText = rejectedReason ? `\n\nReason: ${rejectedReason}` : "";
    const body = `Thank you for applying to AK On Demand with <strong>${businessName}</strong>. After careful review, we're unable to approve your application at this time.${reasonHtml}<br><br>If you believe this was a mistake or have questions, reply to this email and our team will get back to you.`;
    const bodyText = `Thank you for applying to AK On Demand with ${businessNameText}. After careful review, we're unable to approve your application at this time.${reasonText}\n\nIf you believe this was a mistake or have questions, reply to this email and our team will get back to you.`;
    return {
      subject,
      html: buildHtml(greeting, body),
      text: `${greetingText}\n\n${bodyText}\n\nThe AK On Demand Team`,
    };
  }

  if (kind === "cancelled") {
    const subject = "Your AK On Demand interview has been cancelled";
    const body = `Your in-person interview for <strong>${businessName}</strong> has been cancelled. An AK On Demand admin will be in touch to reschedule.`;
    const bodyText = `Your in-person interview for ${businessNameText} has been cancelled. An AK On Demand admin will be in touch to reschedule.`;
    return {
      subject,
      html: buildHtml(greeting, body),
      text: `${greetingText}\n\n${bodyText}\n\nThe AK On Demand Team`,
    };
  }

  const formattedDate = formatMeetingDate(meetingAt!);
  const action = kind === "scheduled" ? "scheduled" : "rescheduled";
  const subject =
    kind === "scheduled"
      ? "Your AK On Demand interview has been scheduled"
      : "Your AK On Demand interview has been rescheduled";

  const locationHtml = meetingLocation
    ? `<br><strong>Location:</strong> ${escapeHtml(meetingLocation)}`
    : "";
  const locationText = meetingLocation ? `\nLocation: ${meetingLocation}` : "";
  const body = `Your in-person interview for <strong>${businessName}</strong> has been ${action}.<br><br><strong>Date &amp; Time:</strong> ${formattedDate}${locationHtml}<br><br>Please make sure to arrive on time. If you have any questions or need to reschedule, reply to this email or contact the AK On Demand team.`;
  const bodyText = `Your in-person interview for ${businessNameText} has been ${action}.\n\nDate & Time: ${formattedDate}${locationText}\n\nPlease make sure to arrive on time. If you have any questions or need to reschedule, reply to this email or contact the AK On Demand team.`;

  return {
    subject,
    html: buildHtml(greeting, body),
    text: `${greetingText}\n\n${bodyText}\n\nThe AK On Demand Team`,
  };
}

function buildHtml(greeting: string, body: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:Arial,sans-serif;background:#f5f5f5;margin:0;padding:0">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:32px 0">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;padding:40px;max-width:600px">
        <tr><td>
          <h2 style="color:#0f172a;margin-top:0">AK On Demand</h2>
          <p style="color:#334155;font-size:15px;line-height:1.6">${greeting}</p>
          <p style="color:#334155;font-size:15px;line-height:1.6">${body}</p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
          <p style="color:#94a3b8;font-size:13px;margin:0">The AK On Demand Team</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Deliver an already-built email through the configured transport (SMTP
 * preferred, then RESEND_API_KEY, then the Replit Resend connector).
 * THROWS on any failure so callers (the outbox) can record it and retry.
 */
export type EmailTransport = "smtp" | "resend-api" | "resend-connector";

export async function deliverEmail(msg: {
  toEmail: string;
  subject: string;
  html: string;
  text: string;
  icalContent?: string | null;
  icalMethod?: string | null;
}): Promise<EmailTransport> {
  const ical =
    msg.icalContent && msg.icalMethod
      ? { content: msg.icalContent, method: msg.icalMethod }
      : null;
  // Preferred: send via the business's own SMTP mailbox (PrivateEmail).
  const smtpUser = process.env["SMTP_USER"];
  const smtpPassword = process.env["SMTP_PASSWORD"];
  if (smtpUser && smtpPassword) {
    const transporter = nodemailer.createTransport({
      host: process.env["SMTP_HOST"] ?? "mail.privateemail.com",
      port: Number(process.env["SMTP_PORT"] ?? 465),
      secure: true,
      auth: { user: smtpUser, pass: smtpPassword },
    });
    await transporter.sendMail({
      from: `AK On Demand <${smtpUser}>`,
      to: msg.toEmail,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      // Attach the calendar invite as a first-class iTIP part so Gmail /
      // Outlook / Apple Mail render "Add to calendar" natively.
      ...(ical ? { icalEvent: { method: ical.method, content: ical.content } } : {}),
    });
    return "smtp";
  }

  // Fallbacks: a RESEND_API_KEY secret, then the Replit Resend connector.
  const fromEmail = (await getFromEmail()) ?? "onboarding@resend.dev";

  const payload = JSON.stringify({
    from: `AK On Demand <${fromEmail}>`,
    to: [msg.toEmail],
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    // Resend supports attachments with base64 content; mail clients still
    // recognize a .ics attachment even without the inline text/calendar part.
    ...(ical
      ? {
          attachments: [
            {
              filename: ical.method === "CANCEL" ? "cancel.ics" : "invite.ics",
              content: Buffer.from(ical.content, "utf-8").toString("base64"),
              content_type: `text/calendar; method=${ical.method}; charset=UTF-8`,
            },
          ],
        }
      : {}),
  });

  const apiKey = process.env["RESEND_API_KEY"];
  let via: EmailTransport;
  let response: Response;
  if (apiKey) {
    via = "resend-api";
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: payload,
    });
  } else {
    via = "resend-connector";
    const connectors = new ReplitConnectors();
    response = await connectors.proxy("resend", "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    });
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "(unreadable)");
    throw new Error(`Email send failed (HTTP ${response.status}): ${errText.slice(0, 500)}`);
  }
  return via;
}

/**
 * Send a meeting notification email to the provider via the persistent
 * outbox: the email is written to `email_outbox` BEFORE the first send
 * attempt, so a transient transport outage can never lose it. Errors are
 * caught and logged rather than thrown — a failed email must not break the
 * PATCH response; the background worker will retry it.
 */
export async function sendMeetingEmail(
  opts: {
    toEmail: string;
    ownerName: string;
    businessName: string;
    kind: MeetingEmailKind;
    meetingAt: Date | null;
    rejectedReason?: string | null;
    /** When set (with `icalSequence`), scheduled/rescheduled emails get a
     *  METHOD:REQUEST .ics invite and cancelled emails a METHOD:CANCEL one.
     *  For cancellations, `meetingAt` must be the OLD meeting time. */
    bizAccountId?: string;
    icalSequence?: number;
    /** Meeting place (address or notes) — .ics LOCATION + email body. */
    meetingLocation?: string;
    /** Meeting length in minutes; defaults to 60 when unset/invalid. */
    meetingDurationMinutes?: number;
  },
  log: Logger,
): Promise<void> {
  try {
    const isMeetingKind =
      opts.kind === "scheduled" || opts.kind === "rescheduled" || opts.kind === "cancelled";
    const emailMeetingAt = opts.kind === "cancelled" ? null : opts.meetingAt;
    const { subject, html, text } = buildEmailContent(
      opts.kind,
      opts.ownerName,
      opts.businessName,
      emailMeetingAt,
      opts.rejectedReason ?? null,
      opts.kind === "cancelled" ? undefined : opts.meetingLocation,
    );
    const ical =
      isMeetingKind && opts.bizAccountId && opts.meetingAt
        ? buildMeetingInvite({
            bizAccountId: opts.bizAccountId,
            kind: opts.kind as "scheduled" | "rescheduled" | "cancelled",
            meetingAt: opts.meetingAt,
            businessName: opts.businessName,
            ownerName: opts.ownerName,
            toEmail: opts.toEmail,
            sequence: opts.icalSequence ?? 0,
            location: opts.meetingLocation ?? "",
            durationMinutes: opts.meetingDurationMinutes ?? DEFAULT_MEETING_DURATION_MINUTES,
          })
        : undefined;
    await enqueueAndSendEmail(
      { toEmail: opts.toEmail, subject, html, text, kind: `meeting:${opts.kind}`, ical },
      log,
    );
  } catch (err) {
    log.warn({ err, toEmail: opts.toEmail, kind: opts.kind }, "meetingEmail.threw");
  }
}
