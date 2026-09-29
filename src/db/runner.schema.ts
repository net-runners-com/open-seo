import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { rankCheckRuns, rankTrackingConfigs } from "./app.schema";

// Pull queue for provider="runner" configs: one row per keyword × device.
// Results land in rank_snapshots; job rows only track claim/retry state.
export const rankCheckJobs = sqliteTable(
  "rank_check_jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => rankCheckRuns.id, { onDelete: "cascade" }),
    configId: text("config_id")
      .notNull()
      .references(() => rankTrackingConfigs.id, { onDelete: "cascade" }),
    trackingKeywordId: text("tracking_keyword_id").notNull(),
    keyword: text("keyword").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    includeLocalPack: integer("include_local_pack", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status", {
      enum: ["pending", "claimed", "done", "failed"],
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    claimedAt: text("claimed_at"),
    lastError: text("last_error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    index("rank_check_jobs_claim_idx").on(table.status, table.createdAt),
    index("rank_check_jobs_run_idx").on(table.runId, table.status),
  ],
);

// Last-seen state per runner ("selfhost" = RUNNER_TOKEN-authenticated).
export const runnerHeartbeats = sqliteTable("runner_heartbeats", {
  organizationId: text("organization_id").primaryKey(),
  status: text("status", { enum: ["idle", "scraping", "cooldown"] }).notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
});

