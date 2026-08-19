CREATE TABLE `pipelines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`options` text NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `pipelines_enabled_priority_idx` ON `pipelines` (`enabled`,`priority`);--> statement-breakpoint
CREATE INDEX `pipelines_name_idx` ON `pipelines` (`name`);--> statement-breakpoint
CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`page` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_events_job_idx` ON `job_events` (`job_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_outputs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`format` text NOT NULL,
	`path` text NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_outputs_job_idx` ON `job_outputs` (`job_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`pipeline_id` text NOT NULL,
	`source_path` text NOT NULL,
	`file_name` text NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`content_hash` text,
	`state` text NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text,
	`page_count` integer,
	`pages_done` integer DEFAULT 0 NOT NULL,
	`device_used` text,
	`device_fallback_reason` text,
	`error_code` text,
	`error_message` text,
	`discovered_at` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`duration_ms` integer,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobs_state_priority_idx` ON `jobs` (`state`,`priority`,`discovered_at`);--> statement-breakpoint
CREATE INDEX `jobs_pipeline_state_idx` ON `jobs` (`pipeline_id`,`state`);--> statement-breakpoint
CREATE INDEX `jobs_finished_idx` ON `jobs` (`finished_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_pipeline_source_idx` ON `jobs` (`pipeline_id`,`source_path`);--> statement-breakpoint
CREATE TABLE `processed_hashes` (
	`pipeline_id` text NOT NULL,
	`content_hash` text NOT NULL,
	`first_seen_at` text NOT NULL,
	FOREIGN KEY (`pipeline_id`) REFERENCES `pipelines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `processed_hashes_idx` ON `processed_hashes` (`pipeline_id`,`content_hash`);--> statement-breakpoint
CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
