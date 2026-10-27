import { pgTable, text, integer, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { businessesTable } from "./businesses";
import { categoriesTable } from "./categories";

export const servicesTable = pgTable("services", {
  id: text("id").primaryKey(),
  businessId: text("business_id").notNull().references(() => businessesTable.id, { onDelete: "cascade" }),
  // Denormalised — kept in sync at write time. Read endpoints rely on this so
  // we don't need to JOIN businesses on every list request.
  businessName: text("business_name").notNull(),
  categoryId: text("category_id").notNull().references(() => categoriesTable.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  // Retain the existing column; removing it makes schema sync propose a drop.
  imageUrl: text("image_url"),
  rating: numeric("rating", { precision: 3, scale: 2 }).notNull().default("0"),
  reviewCount: integer("review_count").notNull().default(0),
  startingPrice: numeric("starting_price", { precision: 10, scale: 2 }).notNull().default("0"),
  tags: text("tags").array().notNull().default([]),
  featured: boolean("featured").notNull().default(false),
  requiredSpecialty: text("required_specialty"),
  // Phase 3 #10 — soft-delete. NULL = live; non-null = hidden from catalog
  // reads but preserved so existing bookings keep their snapshot integrity
  // and the audit trail still resolves the entity.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const serviceOptionsTable = pgTable("service_options", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull().references(() => servicesTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  duration: text("duration").notNull(),
  // For long-duration options (full-day / 8h+) the SP can pin the single start time
  // customers are allowed to book at. Stored as 24-hour HH:MM. Null = no override
  // (customers see the regular 30-minute slot grid instead).
  defaultStartTime: text("default_start_time"),
  // Phase 3 #10 — soft-delete. See servicesTable.deletedAt.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const serviceReviewsTable = pgTable("service_reviews", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull().references(() => servicesTable.id, { onDelete: "cascade" }),
  authorName: text("author_name").notNull(),
  rating: integer("rating").notNull(),
  comment: text("comment").notNull().default(""),
  date: text("date").notNull(),
});

export const insertServiceSchema = createInsertSchema(servicesTable);
export type InsertService = z.infer<typeof insertServiceSchema>;
export type Service = typeof servicesTable.$inferSelect;

export const insertServiceOptionSchema = createInsertSchema(serviceOptionsTable);
export type InsertServiceOption = z.infer<typeof insertServiceOptionSchema>;
export type ServiceOption = typeof serviceOptionsTable.$inferSelect;

export const insertServiceReviewSchema = createInsertSchema(serviceReviewsTable);
export type InsertServiceReview = z.infer<typeof insertServiceReviewSchema>;
export type ServiceReview = typeof serviceReviewsTable.$inferSelect;
