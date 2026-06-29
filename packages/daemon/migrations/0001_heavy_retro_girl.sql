CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`task_id` text,
	`gate_id` text,
	`type` text NOT NULL,
	`payload_json` text,
	`seq` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_events_ticket_seq_idx` ON `task_events` (`ticket_id`,`seq`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text,
	`provider` text NOT NULL,
	`requested_provider` text,
	`prompt` text,
	`output` text,
	`changed_files_json` text,
	`error_signature` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`duration_ms` integer,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_runs`("id", "task_id", "agent_id", "provider", "requested_provider", "prompt", "output", "changed_files_json", "input_tokens", "output_tokens", "cost_usd", "duration_ms", "status", "started_at") SELECT "id", "task_id", "agent_id", "provider", "requested_provider", "prompt", "output", "changed_files_json", "input_tokens", "output_tokens", "cost_usd", "duration_ms", "status", "started_at" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `runs_task_started_idx` ON `runs` (`task_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`kind` text DEFAULT 'stage' NOT NULL,
	`agent_id` text,
	`depends_on_json` text,
	`worktree_path` text,
	`branch` text,
	`state` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`last_error_signature` text,
	`started_at` integer,
	`ended_at` integer,
	`updated_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "ticket_id", "stage_id", "agent_id", "depends_on_json", "worktree_path", "branch", "state", "retry_count", "created_at") SELECT "id", "ticket_id", "stage_id", "agent_id", "depends_on_json", "worktree_path", "branch", "state", "retry_count", "created_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `tasks_ticket_state_idx` ON `tasks` (`ticket_id`,`state`);--> statement-breakpoint
ALTER TABLE `gates` ADD `title` text;--> statement-breakpoint
ALTER TABLE `gates` ADD `prompt` text;--> statement-breakpoint
ALTER TABLE `gates` ADD `artifact_ref_id` text;--> statement-breakpoint
ALTER TABLE `gates` ADD `decision` text;--> statement-breakpoint
ALTER TABLE `gates` ADD `comment` text;--> statement-breakpoint
ALTER TABLE `gates` ADD `created_at` integer;--> statement-breakpoint
CREATE INDEX `tickets_status_idx` ON `tickets` (`status`);