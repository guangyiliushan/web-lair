CREATE TABLE "home_hero" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"title" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subtitle_prefix" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"subtitle_highlight" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"description" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"welcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "home_hero_singleton_check" CHECK ("home_hero"."id" = 1),
	CONSTRAINT "home_hero_title_object_check" CHECK (jsonb_typeof("home_hero"."title") = 'object'),
	CONSTRAINT "home_hero_subtitle_prefix_object_check" CHECK (jsonb_typeof("home_hero"."subtitle_prefix") = 'object'),
	CONSTRAINT "home_hero_subtitle_highlight_object_check" CHECK (jsonb_typeof("home_hero"."subtitle_highlight") = 'object'),
	CONSTRAINT "home_hero_description_object_check" CHECK (jsonb_typeof("home_hero"."description") = 'object'),
	CONSTRAINT "home_hero_welcome_object_check" CHECK (jsonb_typeof("home_hero"."welcome") = 'object')
);
--> statement-breakpoint
CREATE TABLE "site_identity" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"owner_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "site_identity_singleton_check" CHECK ("site_identity"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ADD COLUMN "header_label" text;--> statement-breakpoint
ALTER TABLE "home_hero" ADD CONSTRAINT "home_hero_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_identity" ADD CONSTRAINT "site_identity_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_identity" ADD CONSTRAINT "site_identity_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_identity_owner_user_id_idx" ON "site_identity" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_header_label_check" CHECK ("user_profiles"."header_label" is null or (char_length("user_profiles"."header_label") between 1 and 24 and "user_profiles"."header_label" = btrim("user_profiles"."header_label")));