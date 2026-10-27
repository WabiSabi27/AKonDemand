import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { businessesTable } from "./businesses";

export const blockedSlotsTable = pgTable("blocked_slots", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  date: text("date").notNull(),       // YYYY-MM-DD
  allDay: boolean("all_day").notNull().default(false),
  startTime: text("start_time"),      // HH:MM (24h)
  endTime: text("end_time"),          // HH:MM (24h)
  label: text("label"),
  // Phase 3 #8 — provenance for calendar sync. `manual` = SP-created via the
  // calendar UI (only these are user-editable). `imported_ical` = projected
  // from the SP's external iCal URL by POST /me/calendar/external/sync; the
  // sync deletes all prior `imported_ical` rows for the business and re-inserts
  // them, so they're effectively read-only from the SP's perspective.
  source: text("source", { enum: ["manual", "imported_ical"] }).notNull().default("manual"),
  // VEVENT UID from the imported feed — lets us debug provenance if needed.
  // Not unique because a single all-day multi-day VEVENT becomes N daily rows.
  externalUid: text("external_uid"),
}, (t) => ({
  byBusinessDate: index("blocked_slots_business_date_idx").on(t.businessId, t.date),
}));

export const insertBlockedSlotSchema = createInsertSchema(blockedSlotsTable);
export type InsertBlockedSlot = z.infer<typeof insertBlockedSlotSchema>;
export type BlockedSlot = typeof blockedSlotsTable.$inferSelect;
