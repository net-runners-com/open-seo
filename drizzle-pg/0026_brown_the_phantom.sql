CREATE TABLE "rank_check_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"config_id" text NOT NULL,
	"tracking_keyword_id" text NOT NULL,
	"keyword" text NOT NULL,
	"device" text NOT NULL,
	"include_local_pack" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_at" text,
	"last_error" text,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runner_heartbeats" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"last_seen_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "local_pack_position" integer;--> statement-breakpoint
ALTER TABLE "rank_snapshots" ADD COLUMN "provider" text DEFAULT 'dataforseo' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_tracking_configs" ADD COLUMN "provider" text DEFAULT 'dataforseo' NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_tracking_configs" ADD COLUMN "track_local_pack" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rank_check_jobs" ADD CONSTRAINT "rank_check_jobs_run_id_rank_check_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."rank_check_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rank_check_jobs" ADD CONSTRAINT "rank_check_jobs_config_id_rank_tracking_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."rank_tracking_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rank_check_jobs_claim_idx" ON "rank_check_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "rank_check_jobs_run_idx" ON "rank_check_jobs" USING btree ("run_id","status");