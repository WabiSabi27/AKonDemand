import type { Request } from "express";
import { db, auditLogTable } from "@workspace/db";
import { genId } from "./ids";

export type AuditEntityType =
  | "service"
  | "service_option"
  | "booking"
  | "biz_account"
  | "business";

export interface RecordAuditInput {
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  summary?: string;
  metadata?: Record<string, unknown> | null;
}

/**
 * Phase 3 #10 — Append a row to `audit_log`. Fire-and-forget: we never throw
 * out of the helper, since the caller's primary mutation has already succeeded
 * by the time we record. A failed audit write is logged but not surfaced.
 *
 * Actor identity is pulled from `req.auth` when present; for public routes
 * (e.g. unauthenticated bizAccount apply) the caller can pass `null` for `req`
 * and the row is recorded with no actor.
 */
export function recordAudit(
  req: Request | null,
  input: RecordAuditInput,
): void {
  const auth = req?.auth ?? null;
  void db
    .insert(auditLogTable)
    .values({
      id: genId("aud"),
      actorId: auth?.userId ?? null,
      actorRole: auth?.role ?? null,
      actorLabel: null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary: input.summary ?? "",
      metadata: input.metadata ?? null,
    })
    .catch((err: unknown) => {
      // Log but never propagate — the primary mutation already committed.
      const log = req?.log;
      if (log) {
        log.warn(
          {
            err,
            entityType: input.entityType,
            entityId: input.entityId,
            action: input.action,
          },
          "audit.record_failed",
        );
      } else {
        // eslint-disable-next-line no-console
        console.warn("audit.record_failed", err);
      }
    });
}
