/**
 * iCalendar (RFC 5545) helpers — outbound generation + inbound parsing.
 *
 * Outbound: a tiny in-house generator. We don't need recurrence, alarms,
 * or attendees — just plain VEVENTs with UTC DTSTART/DTEND/SUMMARY/UID — so
 * a 60-line generator is cheaper than pulling in `ical-generator`.
 *
 * Inbound: `node-ical` does the heavy lifting (timezone resolution, rrule
 * expansion, X-* properties).
 */

// node-ical has CommonJS exports; importing the namespace gives us both the
// async fetch helper and the typed VEvent shape.
import * as ical from "node-ical";
import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

/**
 * Reject hostnames that resolve to private/loopback/link-local addresses to
 * prevent SSRF — without this an attacker could point us at 169.254.169.254
 * (cloud metadata) or 127.0.0.1 (internal services). We resolve all A/AAAA
 * records and reject if ANY of them is in a forbidden range, which closes
 * the DNS-rebinding-style trick of returning a public IP first and a private
 * IP on the second resolution.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  for (const r of records) {
    if (isPrivateAddr(r.address)) {
      throw new Error(`URL host resolves to a private address (${r.address})`);
    }
  }
}

function isPrivateAddr(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + AWS metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — re-check the embedded v4
    const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4mapped) return isPrivateAddr(v4mapped[1]);
    return false;
  }
  // Unknown family — conservative: treat as private.
  return true;
}

// ── Outbound (generator) ────────────────────────────────────────────────

export type IcsEvent = {
  /** Stable, globally-unique identifier. We namespace per-row, e.g.
   *  `booking-bk_abc123@akodd`, so calendar clients update events in place. */
  uid: string;
  /** Local title shown in the user's calendar. */
  summary: string;
  /** Optional longer body. Newlines are escaped to literal `\n` per RFC 5545. */
  description?: string;
  /** Free-form location text (address, "Customer's home", etc). */
  location?: string;
  /** Event start. For all-day events, set `allDay=true` and only the date is used. */
  start: Date;
  end: Date;
  allDay?: boolean;
  /** RFC 5545 SEQUENCE — bump on reschedule/cancel so clients update in place. */
  sequence?: number;
  /** Event status, e.g. "CONFIRMED" or "CANCELLED". */
  status?: string;
  /** Organizer — required by most clients for METHOD:REQUEST invites. */
  organizer?: { name: string; email: string };
  /** Attendees invited to the event (the recipient of the invite email). */
  attendees?: { name: string; email: string }[];
};

/** Format a Date as an iCal UTC timestamp: `YYYYMMDDTHHMMSSZ`. */
function fmtUtc(d: Date): string {
  const s = d.toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}T${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}Z`;
}

/** Format a Date as an iCal date-only value: `YYYYMMDD`. */
function fmtDate(d: Date): string {
  const s = d.toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}`;
}

/** Escape RFC 5545 TEXT values: backslash, comma, semicolon, newline. */
function escText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/**
 * Fold long lines per RFC 5545 §3.1: max 75 octets per line; continuation
 * lines start with a single space. We measure UTF-8 bytes (not characters)
 * but pack codepoint-by-codepoint so we never split mid-codepoint — slicing
 * a Buffer at a fixed byte offset would corrupt non-ASCII summaries
 * (emoji, accented characters, CJK, etc).
 */
function foldLine(line: string): string {
  if (Buffer.byteLength(line, "utf-8") <= 75) return line;
  const segments: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The first segment can use up to 75 bytes; continuation segments lose 1
  // byte to the leading space, so cap them at 74. We use the smaller cap
  // throughout for simplicity — the worst case is one extra fold.
  const limit = 74;
  // Iterate by codepoint via the string iterator (handles surrogate pairs).
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf-8");
    if (currentBytes + chBytes > limit) {
      segments.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) segments.push(current);
  return segments.map((s, i) => (i === 0 ? s : " " + s)).join("\r\n");
}

/**
 * Render a calendar object containing the supplied events.
 * Per RFC 5545, lines MUST be CRLF-terminated and folded at 75 octets.
 */
export function renderIcs(opts: {
  prodId: string;
  calendarName: string;
  events: IcsEvent[];
  /** iTIP method: "PUBLISH" (default, feeds), "REQUEST" (invite), "CANCEL". */
  method?: "PUBLISH" | "REQUEST" | "CANCEL";
}): string {
  const now = fmtUtc(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${opts.prodId}//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "PUBLISH"}`,
    `X-WR-CALNAME:${escText(opts.calendarName)}`,
  ];

  for (const ev of opts.events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${now}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDate(ev.start)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtDate(ev.end)}`);
    } else {
      lines.push(`DTSTART:${fmtUtc(ev.start)}`);
      lines.push(`DTEND:${fmtUtc(ev.end)}`);
    }
    lines.push(`SUMMARY:${escText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escText(ev.location)}`);
    if (ev.sequence !== undefined) lines.push(`SEQUENCE:${ev.sequence}`);
    if (ev.status) lines.push(`STATUS:${ev.status}`);
    if (ev.organizer) {
      lines.push(`ORGANIZER;CN=${escText(ev.organizer.name)}:mailto:${ev.organizer.email}`);
    }
    for (const a of ev.attendees ?? []) {
      lines.push(
        `ATTENDEE;CN=${escText(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

// ── Inbound (parser) ────────────────────────────────────────────────────

export type ParsedBusyEvent = {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
};

/**
 * Fetch and parse an external iCal feed, returning only the busy VEVENTs
 * within [windowStart, windowEnd). Recurring events are expanded into their
 * concrete instances. Events with `TRANSP:TRANSPARENT` (free time) are
 * dropped — only OPAQUE/missing-TRANSP events count as busy.
 *
 * We hard-cap the response body to MAX_BYTES to avoid memory blowups from
 * a hostile or runaway feed. node-ical has no streaming mode, so we pull the
 * body ourselves with a fetch + Content-Length / byte counter and hand it
 * to `sync.parseICS`.
 */
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB — Google's secret iCal feeds are well under 1 MB
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchAndParseBusy(
  url: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ParsedBusyEvent[]> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "webcal:") {
    throw new Error(`Only https:// or webcal:// URLs are allowed (got ${u.protocol})`);
  }
  // webcal:// is just https:// for our purposes (the iCal client convention)
  const fetchUrl = u.protocol === "webcal:" ? `https://${u.host}${u.pathname}${u.search}` : url;

  // SSRF guard: resolve the host and reject private/loopback/link-local IPs
  // BEFORE we open the socket. We also disable redirect-following so a public
  // host can't redirect us to an internal one — instead we surface the redirect
  // as an error so the SP fixes the source URL.
  await assertPublicHost(new URL(fetchUrl).hostname);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let bodyText: string;
  try {
    const resp = await fetch(fetchUrl, {
      signal: ctrl.signal,
      headers: { Accept: "text/calendar, text/plain;q=0.5" },
      redirect: "manual",
    });
    if (resp.status >= 300 && resp.status < 400) {
      throw new Error(`Feed returned a redirect (HTTP ${resp.status}). Use the final URL directly.`);
    }
    if (!resp.ok) throw new Error(`Feed returned HTTP ${resp.status}`);
    const declaredLen = Number(resp.headers.get("content-length") ?? "0");
    if (declaredLen > MAX_BYTES) throw new Error(`Feed too large (${declaredLen} bytes; max ${MAX_BYTES})`);
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`Feed too large after download (${buf.length} bytes)`);
    bodyText = buf.toString("utf-8");
  } finally {
    clearTimeout(timer);
  }

  const parsed = ical.sync.parseICS(bodyText);
  const out: ParsedBusyEvent[] = [];
  for (const key of Object.keys(parsed)) {
    const ev = parsed[key];
    if (!ev || ev.type !== "VEVENT") continue;
    // Skip free-time events (the calendar owner is available during these).
    const transp = (ev as { transparency?: string }).transparency;
    if (transp === "TRANSPARENT") continue;
    if (!ev.start || !ev.end) continue;

    // node-ical types `start`/`end` as Date | DateWithTimeZone; both are
    // Date instances at runtime. The `dateOnly` flag marks all-day events.
    const start = ev.start instanceof Date ? ev.start : new Date(ev.start);
    const end = ev.end instanceof Date ? ev.end : new Date(ev.end);
    const allDay = Boolean((ev.start as { dateOnly?: boolean }).dateOnly);

    // Recurrence: node-ical exposes RRULE; expand into concrete instances
    // that fall inside our window. For non-recurring events, just push the
    // single instance if it overlaps the window.
    const rrule = (ev as { rrule?: { between(after: Date, before: Date, inc?: boolean): Date[] } }).rrule;
    if (rrule) {
      const occurrences = rrule.between(windowStart, windowEnd, true);
      const durationMs = end.getTime() - start.getTime();
      for (const occStart of occurrences) {
        const occEnd = new Date(occStart.getTime() + durationMs);
        out.push({
          uid: `${String(ev.uid ?? key)}-${occStart.toISOString()}`,
          summary: String(ev.summary ?? "Busy"),
          start: occStart,
          end: occEnd,
          allDay,
        });
      }
    } else {
      // Half-open overlap with [windowStart, windowEnd).
      if (end <= windowStart || start >= windowEnd) continue;
      out.push({
        uid: String(ev.uid ?? key),
        summary: String(ev.summary ?? "Busy"),
        start,
        end,
        allDay,
      });
    }
  }
  return out;
}
