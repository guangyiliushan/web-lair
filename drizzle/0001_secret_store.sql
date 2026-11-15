CREATE TABLE "ai_provider_secrets" (
	"provider_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "ai_provider_secrets_key_version_check" CHECK ("ai_provider_secrets"."key_version" > 0),
	CONSTRAINT "ai_provider_secrets_ciphertext_check" CHECK (length("ai_provider_secrets"."ciphertext") > 0),
	CONSTRAINT "ai_provider_secrets_hint_check" CHECK (length("ai_provider_secrets"."hint") > 0)
);
--> statement-breakpoint
CREATE TABLE "webhook_secrets" (
	"webhook_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"hint" text NOT NULL,
	"key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"previous_ciphertext" text,
	"previous_key_version" integer,
	"previous_expires_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "webhook_secrets_key_version_check" CHECK ("webhook_secrets"."key_version" > 0),
	CONSTRAINT "webhook_secrets_ciphertext_check" CHECK (length("webhook_secrets"."ciphertext") > 0),
	CONSTRAINT "webhook_secrets_hint_check" CHECK (length("webhook_secrets"."hint") > 0),
	CONSTRAINT "webhook_secrets_previous_pair_check" CHECK (("webhook_secrets"."previous_ciphertext" is null) = ("webhook_secrets"."previous_expires_at" is null) and ("webhook_secrets"."previous_ciphertext" is null) = ("webhook_secrets"."previous_key_version" is null)),
	CONSTRAINT "webhook_secrets_previous_key_version_check" CHECK ("webhook_secrets"."previous_key_version" is null or "webhook_secrets"."previous_key_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_provider_secrets" ADD CONSTRAINT "ai_provider_secrets_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_provider_secrets" ADD CONSTRAINT "ai_provider_secrets_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_secrets" ADD CONSTRAINT "webhook_secrets_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;