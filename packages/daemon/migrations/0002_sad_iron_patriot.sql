ALTER TABLE `tasks` ADD `lane_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `seam_paths_json` text;--> statement-breakpoint
CREATE INDEX `tasks_ticket_lane_idx` ON `tasks` (`ticket_id`,`lane_id`);