CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"user_id" text,
	"reference_id" text,
	"config_id" text,
	"name" text,
	"key" text NOT NULL,
	"start" text,
	"prefix" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT false NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"refill_interval" integer,
	"refill_amount" integer,
	"expires_at" timestamp with time zone,
	"last_refill_at" timestamp with time zone,
	"last_request" timestamp with time zone,
	"permissions" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE "device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "owner_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text NOT NULL,
	"mail" text,
	"url" text,
	"introduce" text,
	"last_login_ip" text,
	"last_login_time" timestamp with time zone,
	"social_ids" jsonb
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"bio" text,
	"avatar_url" text,
	"email_notifications" boolean DEFAULT true NOT NULL,
	"public_profile" boolean DEFAULT false NOT NULL,
	"show_online_status" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "admin_account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_account_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "ai_agent_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"model" text,
	"provider_id" text,
	"title" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_insights" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ref_id" text NOT NULL,
	"lang" text NOT NULL,
	"hash" text NOT NULL,
	"content" text NOT NULL,
	"is_translation" boolean DEFAULT false NOT NULL,
	"source_insights_id" text,
	"source_lang" text,
	"model_info" jsonb
);
--> statement-breakpoint
CREATE TABLE "ai_summaries" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"summary" text NOT NULL,
	"ref_id" text NOT NULL,
	"lang" text
);
--> statement-breakpoint
CREATE TABLE "ai_translations" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"ref_id" text NOT NULL,
	"ref_type" text NOT NULL,
	"lang" text NOT NULL,
	"source_lang" text NOT NULL,
	"title" text NOT NULL,
	"text" text NOT NULL,
	"subtitle" text,
	"summary" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"source_modified_at" timestamp with time zone,
	"ai_model" text,
	"ai_provider" text,
	"content_format" text,
	"content" text,
	"source_block_snapshots" jsonb,
	"source_meta_hashes" jsonb
);
--> statement-breakpoint
CREATE TABLE "translation_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"key_path" text NOT NULL,
	"lang" text NOT NULL,
	"key_type" text NOT NULL,
	"lookup_key" text NOT NULL,
	"source_text" text NOT NULL,
	"translated_text" text NOT NULL,
	"source_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "meta_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"name" text NOT NULL,
	"content_type" text,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "options" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"type" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"author" text,
	"mail" text,
	"url" text,
	"text" text NOT NULL,
	"state" integer DEFAULT 0 NOT NULL,
	"parent_comment_id" text,
	"root_comment_id" text,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"latest_reply_at" timestamp with time zone,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp with time zone,
	"ip" text,
	"agent" text,
	"pin" boolean DEFAULT false NOT NULL,
	"location" text,
	"is_whisper" boolean DEFAULT false NOT NULL,
	"avatar" text,
	"auth_provider" text,
	"meta" text,
	"reader_id" text,
	"edited_at" timestamp with time zone,
	"anchor" jsonb,
	"is_owner_reply" boolean DEFAULT false NOT NULL,
	"country_code" text
);
--> statement-breakpoint
CREATE TABLE "draft_histories" (
	"id" text PRIMARY KEY NOT NULL,
	"draft_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"text" text,
	"content" text,
	"content_format" text NOT NULL,
	"type_specific_data" jsonb,
	"saved_at" timestamp with time zone NOT NULL,
	"is_full_snapshot" boolean NOT NULL,
	"ref_version" integer,
	"base_version" integer
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"ref_type" text NOT NULL,
	"ref_id" text,
	"title" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"content" text,
	"content_format" text NOT NULL,
	"images" jsonb,
	"meta" jsonb,
	"type_specific_data" jsonb,
	"history" jsonb,
	"version" integer DEFAULT 1 NOT NULL,
	"published_version" integer
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"avatar" text,
	"description" text,
	"type" integer,
	"state" integer,
	"email" text
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"nid" integer GENERATED BY DEFAULT AS IDENTITY (sequence name "notes_nid_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"title" text,
	"slug" text,
	"text" text,
	"content" text,
	"content_format" text NOT NULL,
	"images" jsonb,
	"meta" jsonb,
	"is_published" boolean DEFAULT true NOT NULL,
	"password" text,
	"public_at" timestamp with time zone,
	"mood" text,
	"weather" text,
	"bookmark" boolean DEFAULT false NOT NULL,
	"coordinates" jsonb,
	"location" text,
	"read_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"topic_id" text,
	"modified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"subtitle" text,
	"text" text,
	"content" text,
	"content_format" text NOT NULL,
	"images" jsonb,
	"meta" jsonb,
	"sort_order" integer DEFAULT 1 NOT NULL,
	"modified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "post_related_posts" (
	"post_id" text NOT NULL,
	"related_post_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"text" text,
	"content" text,
	"content_format" text NOT NULL,
	"summary" text,
	"images" jsonb,
	"meta" jsonb,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"modified_at" timestamp with time zone,
	"category_id" text NOT NULL,
	"copyright" boolean DEFAULT true NOT NULL,
	"is_published" boolean DEFAULT true NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"pin_at" timestamp with time zone,
	"pin_order" integer
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"preview_url" text,
	"doc_url" text,
	"project_url" text,
	"images" text[],
	"description" text NOT NULL,
	"avatar" text,
	"text" text
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"source" text,
	"author" text
);
--> statement-breakpoint
CREATE TABLE "recent_items" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb,
	"ref_type" text,
	"ref_id" text,
	"comments_index" integer DEFAULT 0 NOT NULL,
	"allow_comment" boolean DEFAULT true NOT NULL,
	"modified_at" timestamp with time zone,
	"up" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"type" text,
	"is_private" boolean DEFAULT false NOT NULL,
	"raw" text NOT NULL,
	"path" text NOT NULL,
	"comment" text,
	"meta_type" text,
	"schema" text,
	"method" text,
	"secret" text,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"built_in" boolean DEFAULT false NOT NULL,
	"compiled_code" text
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"introduce" text,
	"icon" text
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" integer,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "analytics" (
	"id" text PRIMARY KEY NOT NULL,
	"visited_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" jsonb,
	"country" text,
	"path" text,
	"referrer" text
);
--> statement-breakpoint
CREATE TABLE "enrichment_captures" (
	"enrichment_id" text PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"thumbhash" text,
	"palette" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrichment_cache" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" varchar(64) NOT NULL,
	"external_id" varchar(256) NOT NULL,
	"url" text NOT NULL,
	"locale" varchar(8) DEFAULT '' NOT NULL,
	"normalized" jsonb NOT NULL,
	"raw" jsonb,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_references" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text NOT NULL,
	"ref_id" text,
	"ref_type" text,
	"s3_object_key" text,
	"reader_id" text,
	"uploaded_by" text,
	"mime_type" text,
	"byte_size" bigint,
	"detached_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "poll_vote_options" (
	"vote_id" text NOT NULL,
	"option_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"poll_id" text NOT NULL,
	"voter_fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" text NOT NULL,
	"lang" text NOT NULL,
	"source_hash" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"search_text" text NOT NULL,
	"terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"title_term_freq" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_term_freq" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title_length" integer DEFAULT 0 NOT NULL,
	"body_length" integer DEFAULT 0 NOT NULL,
	"slug" text,
	"nid" integer,
	"is_published" boolean DEFAULT true NOT NULL,
	"public_at" timestamp with time zone,
	"has_password" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "serverless_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"function_id" text,
	"reference" text NOT NULL,
	"name" text NOT NULL,
	"method" text,
	"ip" text,
	"status" text NOT NULL,
	"execution_time" integer NOT NULL,
	"logs" jsonb,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE "serverless_storages" (
	"id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slug_trackers" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"target_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"cancel_token" text NOT NULL,
	"status" integer NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone,
	"headers" jsonb,
	"payload" jsonb,
	"event" text,
	"response" jsonb,
	"success" boolean,
	"hook_id" text NOT NULL,
	"status" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone,
	"payload_url" text NOT NULL,
	"events" text[] NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"secret" text NOT NULL,
	"scope" integer
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp,
	"aaguid" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_reference_id_user_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_profiles" ADD CONSTRAINT "owner_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_account" ADD CONSTRAINT "admin_account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_insights" ADD CONSTRAINT "ai_insights_source_insights_id_ai_insights_id_fk" FOREIGN KEY ("source_insights_id") REFERENCES "public"."ai_insights"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_comment_id_comments_id_fk" FOREIGN KEY ("root_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reader_id_user_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_histories" ADD CONSTRAINT "draft_histories_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_related_posts" ADD CONSTRAINT "post_related_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_related_posts" ADD CONSTRAINT "post_related_posts_related_post_id_posts_id_fk" FOREIGN KEY ("related_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_captures" ADD CONSTRAINT "enrichment_captures_enrichment_id_enrichment_cache_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment_cache"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_reader_id_user_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote_options" ADD CONSTRAINT "poll_vote_options_vote_id_poll_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."poll_votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_hook_id_webhooks_id_fk" FOREIGN KEY ("hook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_uniq" ON "api_keys" USING btree ("key");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "device_codes_device_code_uniq" ON "device_codes" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "device_codes_user_code_uniq" ON "device_codes" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "device_codes_expires_at_idx" ON "device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_profiles_user_id_uniq" ON "owner_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_agent_conversations_session_idx" ON "ai_agent_conversations" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_insights_ref_lang_uniq" ON "ai_insights" USING btree ("ref_id","lang");--> statement-breakpoint
CREATE INDEX "ai_summaries_ref_id_idx" ON "ai_summaries" USING btree ("ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_translations_ref_lang_uniq" ON "ai_translations" USING btree ("ref_id","ref_type","lang");--> statement-breakpoint
CREATE INDEX "ai_translations_ref_id_idx" ON "ai_translations" USING btree ("ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_entries_key_uniq" ON "translation_entries" USING btree ("key_path","lang","key_type","lookup_key");--> statement-breakpoint
CREATE INDEX "translation_entries_path_lang_idx" ON "translation_entries" USING btree ("key_path","lang");--> statement-breakpoint
CREATE INDEX "translation_entries_lookup_key_idx" ON "translation_entries" USING btree ("lookup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "meta_presets_name_uniq" ON "meta_presets" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "options_name_uniq" ON "options" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name_uniq" ON "categories" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uniq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "comments_thread_idx" ON "comments" USING btree ("ref_type","ref_id","parent_comment_id","pin","created_at");--> statement-breakpoint
CREATE INDEX "comments_root_idx" ON "comments" USING btree ("root_comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_reader_idx" ON "comments" USING btree ("reader_id");--> statement-breakpoint
CREATE UNIQUE INDEX "draft_histories_draft_version_uniq" ON "draft_histories" USING btree ("draft_id","version");--> statement-breakpoint
CREATE INDEX "drafts_ref_idx" ON "drafts" USING btree ("ref_type","ref_id") WHERE "drafts"."ref_id" is not null;--> statement-breakpoint
CREATE INDEX "drafts_updated_at_idx" ON "drafts" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "links_name_uniq" ON "links" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "links_url_uniq" ON "links" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_nid_uniq" ON "notes" USING btree ("nid");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_slug_uniq" ON "notes" USING btree ("slug") WHERE "notes"."slug" is not null;--> statement-breakpoint
CREATE INDEX "notes_nid_desc_idx" ON "notes" USING btree ("nid");--> statement-breakpoint
CREATE INDEX "notes_modified_at_idx" ON "notes" USING btree ("modified_at");--> statement-breakpoint
CREATE INDEX "notes_created_at_idx" ON "notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notes_topic_id_idx" ON "notes" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "notes_published_public_created_idx" ON "notes" USING btree ("is_published","created_at" DESC NULLS LAST,"public_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_slug_uniq" ON "pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pages_sort_order_idx" ON "pages" USING btree ("sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "post_related_posts_pk" ON "post_related_posts" USING btree ("post_id","related_post_id");--> statement-breakpoint
CREATE INDEX "post_related_posts_related_idx" ON "post_related_posts" USING btree ("related_post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_slug_uniq" ON "posts" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "posts_modified_at_idx" ON "posts" USING btree ("modified_at");--> statement-breakpoint
CREATE INDEX "posts_created_at_idx" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_category_id_idx" ON "posts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "posts_published_created_at_idx" ON "posts" USING btree ("is_published","pin_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_category_published_created_idx" ON "posts" USING btree ("category_id","is_published","pin_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_tags_gin_idx" ON "posts" USING gin ("tags");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_uniq" ON "projects" USING btree ("name");--> statement-breakpoint
CREATE INDEX "quotes_created_at_idx" ON "quotes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recent_items_ref_idx" ON "recent_items" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "recent_items_created_at_idx" ON "recent_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "snippets_path_prefix_idx" ON "snippets" USING btree ("path");--> statement-breakpoint
CREATE INDEX "snippets_type_idx" ON "snippets" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_path_idx" ON "snippets" USING btree ("path") WHERE "snippets"."method" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_path_method_idx" ON "snippets" USING btree ("path","method") WHERE "snippets"."method" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "topics_name_uniq" ON "topics" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "topics_slug_uniq" ON "topics" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "activities_created_at_idx" ON "activities" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "analytics_visited_at_idx" ON "analytics" USING btree ("visited_at");--> statement-breakpoint
CREATE INDEX "analytics_visited_at_path_idx" ON "analytics" USING btree ("visited_at","path");--> statement-breakpoint
CREATE INDEX "analytics_visited_at_referrer_idx" ON "analytics" USING btree ("visited_at","referrer");--> statement-breakpoint
CREATE INDEX "analytics_visited_at_ip_idx" ON "analytics" USING btree ("visited_at","ip");--> statement-breakpoint
CREATE INDEX "enrichment_captures_lru_idx" ON "enrichment_captures" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "enrichment_cache_provider_external_id_locale_uniq" ON "enrichment_cache" USING btree ("provider","external_id","locale");--> statement-breakpoint
CREATE INDEX "enrichment_cache_expires_at_idx" ON "enrichment_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "file_references_file_url_idx" ON "file_references" USING btree ("file_url");--> statement-breakpoint
CREATE INDEX "file_references_ref_idx" ON "file_references" USING btree ("ref_id","ref_type");--> statement-breakpoint
CREATE INDEX "file_references_status_created_idx" ON "file_references" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "file_references_reader_status_created_idx" ON "file_references" USING btree ("reader_id","status","created_at");--> statement-breakpoint
CREATE INDEX "file_references_status_detached_idx" ON "file_references" USING btree ("status","detached_at");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_vote_options_pk" ON "poll_vote_options" USING btree ("vote_id","option_id");--> statement-breakpoint
CREATE INDEX "poll_vote_options_option_idx" ON "poll_vote_options" USING btree ("option_id");--> statement-breakpoint
CREATE UNIQUE INDEX "poll_votes_poll_voter_uniq" ON "poll_votes" USING btree ("poll_id","voter_fingerprint");--> statement-breakpoint
CREATE INDEX "poll_votes_poll_id_idx" ON "poll_votes" USING btree ("poll_id");--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_ref_lang_uniq" ON "search_documents" USING btree ("ref_type","ref_id","lang");--> statement-breakpoint
CREATE INDEX "search_documents_published_idx" ON "search_documents" USING btree ("is_published","public_at");--> statement-breakpoint
CREATE INDEX "search_documents_lang_idx" ON "search_documents" USING btree ("lang");--> statement-breakpoint
CREATE INDEX "serverless_logs_created_at_idx" ON "serverless_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "serverless_logs_function_idx" ON "serverless_logs" USING btree ("function_id","created_at");--> statement-breakpoint
CREATE INDEX "serverless_logs_reference_idx" ON "serverless_logs" USING btree ("reference","name","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "serverless_storages_ns_key_uniq" ON "serverless_storages" USING btree ("namespace","key");--> statement-breakpoint
CREATE INDEX "slug_trackers_type_target_idx" ON "slug_trackers" USING btree ("type","target_id");--> statement-breakpoint
CREATE INDEX "slug_trackers_slug_type_idx" ON "slug_trackers" USING btree ("slug","type");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_email_uniq" ON "subscriptions" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_cancel_token_uniq" ON "subscriptions" USING btree ("cancel_token");--> statement-breakpoint
CREATE INDEX "webhook_events_hook_id_idx" ON "webhook_events" USING btree ("hook_id");--> statement-breakpoint
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhooks_is_enabled_idx" ON "webhooks" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");