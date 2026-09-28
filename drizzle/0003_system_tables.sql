DROP TABLE IF EXISTS "webhook_events" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "webhooks" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "activities" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "subscriptions" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "search_documents" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "analytics" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "meta_presets" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "poll_vote_options" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "poll_votes" CASCADE;--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event" text NOT NULL,
	"actor_id" text,
	"ref_type" text,
	"ref_id" uuid,
	"payload" jsonb,
	CONSTRAINT "activities_event_check" CHECK ("activities"."event" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
	CONSTRAINT "activities_ref_type_check" CHECK ("activities"."ref_type" is null or "activities"."ref_type" in ('post','note','page','comment','link','project','photo','file','settings','ai','user','member','job','schedule')),
	CONSTRAINT "activities_ref_pair_check" CHECK (("activities"."ref_type" is null) = ("activities"."ref_id" is null))
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"source" text,
	"token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	CONSTRAINT "subscriptions_status_check" CHECK ("subscriptions"."status" in ('pending', 'subscribed', 'unsubscribed')),
	CONSTRAINT "subscriptions_lang_check" CHECK ("subscriptions"."lang" in ('en', 'zh-cn', 'ja')),
	CONSTRAINT "subscriptions_verified_at_check" CHECK (("subscriptions"."status" = 'subscribed') = ("subscriptions"."verified_at" is not null)),
	CONSTRAINT "subscriptions_unsubscribed_at_check" CHECK (("subscriptions"."status" = 'unsubscribed') = ("subscriptions"."unsubscribed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"response_code" text,
	"error" text,
	"delivered_at" timestamp with time zone,
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."status" in ('queued', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"payload_url" text NOT NULL,
	"events" text[] NOT NULL,
	"secret" text NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "webhooks_payload_url_check" CHECK ("webhooks"."payload_url" ~ '^https?://')
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activities_created_at_idx" ON "activities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activities_event_created_idx" ON "activities" USING btree ("event","created_at");--> statement-breakpoint
CREATE INDEX "activities_ref_created_idx" ON "activities" USING btree ("ref_type","ref_id","created_at") WHERE "activities"."ref_id" is not null;--> statement-breakpoint
CREATE INDEX "activities_actor_idx" ON "activities" USING btree ("actor_id") WHERE "activities"."actor_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_email_uniq" ON "subscriptions" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_token_uniq" ON "subscriptions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_created_at_idx" ON "webhook_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_webhook_id_created_at_idx" ON "webhook_deliveries" USING btree ("webhook_id","created_at");--> statement-breakpoint
CREATE INDEX "webhooks_is_enabled_idx" ON "webhooks" USING btree ("is_enabled");
