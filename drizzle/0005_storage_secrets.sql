CREATE TABLE "storage_secrets" (
	"id" text PRIMARY KEY NOT NULL,
	"access_key_ciphertext" text NOT NULL,
	"access_key_hint" text NOT NULL,
	"access_key_key_version" integer NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"secret_hint" text NOT NULL,
	"secret_key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "storage_secrets_id_check" CHECK ("storage_secrets"."id" = 's3'),
	CONSTRAINT "storage_secrets_access_key_version_check" CHECK ("storage_secrets"."access_key_key_version" > 0),
	CONSTRAINT "storage_secrets_secret_key_version_check" CHECK ("storage_secrets"."secret_key_version" > 0),
	CONSTRAINT "storage_secrets_ciphertext_check" CHECK (length("storage_secrets"."access_key_ciphertext") > 0 and length("storage_secrets"."secret_ciphertext") > 0),
	CONSTRAINT "storage_secrets_hint_check" CHECK (length("storage_secrets"."access_key_hint") > 0 and length("storage_secrets"."secret_hint") > 0)
);
--> statement-breakpoint
ALTER TABLE "storage_secrets" ADD CONSTRAINT "storage_secrets_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;