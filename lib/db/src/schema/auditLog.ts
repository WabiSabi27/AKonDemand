import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const auditLogTable = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    actorRole: text("actor_role"),
    actorLabel: text("actor_label"),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    summary: text("summary").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown> | null>(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byEntity: index("audit_log_entity_idx").on(t.entityType, t.entityId, t.at),
    byAt: index("audit_log_at_idx").on(t.at),
  }),
);

export type AuditLogEntry = typeof auditLogTable.$inferSelect;
