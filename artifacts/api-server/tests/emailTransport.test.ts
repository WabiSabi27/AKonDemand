import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import { ReplitConnectors } from "@replit/connectors-sdk";
import { deliverEmail } from "../src/lib/meetingEmail";

const sendMail = vi.fn();
const fetchMock = vi.fn();
const proxyMock = vi.fn();

beforeEach(() => {
  vi.stubEnv("SMTP_USER", "");
  vi.stubEnv("SMTP_PASSWORD", "");
  vi.stubEnv("RESEND_API_KEY", "");
  vi.stubEnv("REPLIT_CONNECTORS_HOSTNAME", "");
  sendMail.mockReset().mockResolvedValue({ messageId: "test-message" });
  fetchMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  proxyMock.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(nodemailer, "createTransport").mockReturnValue({ sendMail } as unknown as nodemailer.Transporter);
  vi.spyOn(ReplitConnectors.prototype, "proxy").mockImplementation(proxyMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe.each(["smtp", "resend-api", "resend-connector"] as const)("%s calendar delivery", transport => {
  it.each(["REQUEST", "CANCEL", null] as const)("preserves %s calendar content and omits absent attachments", async method => {
    if (transport === "smtp") {
      vi.stubEnv("SMTP_USER", "sender@example.test");
      vi.stubEnv("SMTP_PASSWORD", "synthetic-test-password");
    } else if (transport === "resend-api") {
      vi.stubEnv("RESEND_API_KEY", "synthetic-test-key");
    }
    const content = method ? [
      "BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`,
      "BEGIN:VEVENT", "UID:transport-test@akondemand", "SEQUENCE:2",
      "DTSTART:20270112T190000Z", "LOCATION:Juneau – meeting room",
      "END:VEVENT", "END:VCALENDAR", "",
    ].join("\r\n") : null;
    const message = {
      toEmail: "applicant@example.test", subject: "Interview update",
      html: "<p>Interview update</p>", text: "Interview update",
      icalContent: content, icalMethod: method,
    };
    expect(await deliverEmail(message)).toBe(transport);
    if (transport === "smtp") {
      expect(sendMail).toHaveBeenCalledOnce();
      const payload = sendMail.mock.calls[0][0];
      expect(payload).toMatchObject({ to: message.toEmail, subject: message.subject, html: message.html, text: message.text });
      if (method) expect(payload.icalEvent).toEqual({ method, content });
      else expect(payload).not.toHaveProperty("icalEvent");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(proxyMock).not.toHaveBeenCalled();
    } else {
      const call = transport === "resend-api" ? fetchMock.mock.calls[0] : proxyMock.mock.calls[0];
      const options = call[transport === "resend-api" ? 1 : 2];
      const payload = JSON.parse(options.body);
      expect(payload).toMatchObject({ to: [message.toEmail], subject: message.subject, html: message.html, text: message.text });
      if (method) {
        expect(payload.attachments).toHaveLength(1);
        const attachment = payload.attachments[0];
        expect(attachment.filename).toBe(method === "CANCEL" ? "cancel.ics" : "invite.ics");
        expect(attachment.content_type).toBe(`text/calendar; method=${method}; charset=UTF-8`);
        expect(Buffer.from(attachment.content, "base64").toString("utf-8")).toBe(content);
      } else expect(payload).not.toHaveProperty("attachments");
      expect(sendMail).not.toHaveBeenCalled();
      expect(transport === "resend-api" ? fetchMock : proxyMock).toHaveBeenCalledOnce();
      expect(transport === "resend-api" ? proxyMock : fetchMock).not.toHaveBeenCalled();
    }
  });
});
