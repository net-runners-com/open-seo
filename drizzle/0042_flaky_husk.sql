CREATE TABLE `rank_check_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`config_id` text NOT NULL,
	`tracking_keyword_id` text NOT NULL,
	`keyword` text NOT NULL,
	`device` text NOT NULL,
	`include_local_pack` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` text,
	`last_error` text,
	`created_at` text DEFAULT (current_timestamp) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `rank_check_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`config_id`) REFERENCES `rank_tracking_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `rank_check_jobs_claim_idx` ON `rank_check_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `rank_check_jobs_run_idx` ON `rank_check_jobs` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `runner_heartbeats` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `local_pack_position` integer;--> statement-breakpoint
ALTER TABLE `rank_snapshots` ADD `provider` text DEFAULT 'dataforseo' NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_tracking_configs` ADD `provider` text DEFAULT 'dataforseo' NOT NULL;--> statement-breakpoint
ALTER TABLE `rank_tracking_configs` ADD `track_local_pack` integer DEFAULT false NOT NULL;