CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`name` text NOT NULL,
	`provider` text NOT NULL,
	`model` text,
	`system_prompt` text NOT NULL,
	`authority` text NOT NULL,
	`access_json` text NOT NULL,
	`restricted_commands_json` text NOT NULL,
	`status` text NOT NULL,
	`concurrency` integer,
	`retry_cap` integer DEFAULT 3,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`summary` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `collab_peers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`connection` text,
	`endpoint` text,
	`shared_providers_json` text,
	`status` text NOT NULL,
	`joined_at` integer
);
--> statement-breakpoint
CREATE TABLE `gates` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`task_id` text,
	`kind` text NOT NULL,
	`checks_json` text,
	`status` text NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`ticket_id` text,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`github_url` text,
	`origin` text NOT NULL,
	`phase` text NOT NULL,
	`orchestrator_provider` text NOT NULL,
	`routing_policy_json` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`installed` integer,
	`authenticated` integer,
	`version` text,
	`peer_id` text,
	`last_checked` integer
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`provider` text NOT NULL,
	`requested_provider` text,
	`prompt` text,
	`output` text,
	`changed_files_json` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`duration_ms` integer,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`agent_id` text,
	`depends_on_json` text,
	`worktree_path` text,
	`branch` text,
	`state` text NOT NULL,
	`retry_count` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`task_type` text,
	`mutating` integer,
	`blast_radius_json` text,
	`workflow_id` text,
	`status` text NOT NULL,
	`mode` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
