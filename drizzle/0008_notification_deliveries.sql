CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"event_type" text NOT NULL,
	"event_key" text NOT NULL,
	"channel" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response_code" integer,
	"error" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_channel_check" CHECK ("notification_deliveries"."channel" in ('email', 'bark')),
	CONSTRAINT "notification_deliveries_status_check" CHECK ("notification_deliveries"."status" in ('queued', 'sent', 'failed')),
	CONSTRAINT "notification_deliveries_attempts_check" CHECK ("notification_deliveries"."attempts" >= 0),
	CONSTRAINT "notification_deliveries_event_type_check" CHECK ("notification_deliveries"."event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
	CONSTRAINT "notification_deliveries_event_key_check" CHECK (length("notification_deliveries"."event_key") between 1 and 200 and "notification_deliveries"."event_key" !~ '\s')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_channel_uniq" ON "notification_deliveries" USING btree ("event_type","event_key","channel");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries" USING btree ("created_at");