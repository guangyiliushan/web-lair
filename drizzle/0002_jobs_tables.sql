CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"source_hash" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"result" jsonb,
	"error" text,
	CONSTRAINT "job_runs_trigger_check" CHECK ("job_runs"."trigger" in ('schedule', 'manual', 'event', 'cli')),
	CONSTRAINT "job_runs_status_check" CHECK ("job_runs"."status" in ('queued', 'running', 'succeeded', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE TABLE "job_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"job" text NOT NULL,
	"cron_expr" text NOT NULL,
	"tz" text DEFAULT 'UTC' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"last_due_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "job_runs_job_started_at_idx" ON "job_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_status_created_at_idx" ON "job_runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_job_queued_uniq" ON "job_runs" USING btree ("job") WHERE "job_runs"."status" = 'queued';--> statement-breakpoint
CREATE UNIQUE INDEX "job_schedules_job_cron_expr_uniq" ON "job_schedules" USING btree ("job","cron_expr");--> statement-breakpoint
CREATE INDEX "job_schedules_enabled_idx" ON "job_schedules" USING btree ("is_enabled");