CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"slug" text NOT NULL,
	"bio" text,
	"avatar_url" text,
	"links" jsonb,
	"email_notifications_enabled" boolean DEFAULT true NOT NULL,
	"profile_public" boolean DEFAULT false NOT NULL,
	"online_status_public" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_slug_unique" UNIQUE("slug"),
	CONSTRAINT "user_profiles_status_check" CHECK ("user_profiles"."status" in ('active', 'deleted')),
	CONSTRAINT "user_profiles_deleted_at_check" CHECK (("user_profiles"."status" = 'deleted') = ("user_profiles"."deleted_at" is not null)),
	CONSTRAINT "user_profiles_links_is_array_check" CHECK ("user_profiles"."links" is null or jsonb_typeof("user_profiles"."links") = 'array')
);
--> statement-breakpoint
CREATE TABLE "ai_agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"session_id" text NOT NULL,
	"model" text,
	"provider_id" text,
	"title" text,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "insights" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ref_id" uuid NOT NULL,
	"lang" text NOT NULL,
	"hash" text NOT NULL,
	"content" text NOT NULL,
	"is_translation" boolean DEFAULT false NOT NULL,
	"source_insights_id" uuid,
	"source_lang" text,
	"model_info" jsonb
);
--> statement-breakpoint
CREATE TABLE "summaries" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"hash" text NOT NULL,
	"summary" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"lang" text,
	CONSTRAINT "summaries_ref_lang_uniq" UNIQUE NULLS NOT DISTINCT("ref_id","lang")
);
--> statement-breakpoint
CREATE TABLE "translations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"source_post_id" uuid NOT NULL,
	"target_lang" text NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"summary" text,
	"content_format" text DEFAULT 'markdown' NOT NULL,
	"origin" text NOT NULL,
	"model" text,
	"source_hash" text,
	"status" text DEFAULT 'draft' NOT NULL,
	CONSTRAINT "translations_target_lang_check" CHECK ("translations"."target_lang" in ('en', 'zh-cn', 'ja')),
	CONSTRAINT "translations_origin_check" CHECK ("translations"."origin" in ('human', 'ai', 'machine')),
	CONSTRAINT "translations_status_check" CHECK ("translations"."status" in ('draft', 'accepted', 'discarded'))
);
--> statement-breakpoint
CREATE TABLE "meta_presets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"name" text NOT NULL,
	"content_type" text,
	"description" text,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"value" jsonb
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"post_id" uuid,
	"note_id" uuid,
	"page_id" uuid,
	"author" text,
	"mail" text,
	"url" text,
	"text" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"parent_comment_id" uuid,
	"root_comment_id" uuid,
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
	"meta" jsonb,
	"reader_id" text,
	"edited_at" timestamp with time zone,
	"anchor" jsonb,
	"is_owner_reply" boolean DEFAULT false NOT NULL,
	"country_code" text,
	CONSTRAINT "comments_ref_exclusive_check" CHECK (num_nonnulls("comments"."post_id", "comments"."note_id", "comments"."page_id") = 1),
	CONSTRAINT "comments_state_check" CHECK ("comments"."state" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "comments_deleted_at_check" CHECK (("comments"."is_deleted") = ("comments"."deleted_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"ref_type" text NOT NULL,
	"ref_id" uuid,
	"title" text DEFAULT '' NOT NULL,
	"slug" text,
	"category_id" uuid,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"content" text,
	"content_format" text DEFAULT 'markdown' NOT NULL,
	"summary" text,
	"version" integer DEFAULT 1 NOT NULL,
	"base_version" integer,
	"author" text
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
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
CREATE TABLE "memos" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"content" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
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
	"topic_id" uuid
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"subtitle" text,
	"text" text,
	"content" text,
	"content_format" text NOT NULL,
	"images" jsonb,
	"meta" jsonb,
	"sort_order" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_related_posts" (
	"post_id" uuid NOT NULL,
	"related_post_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "post_related_posts_post_id_related_post_id_pk" PRIMARY KEY("post_id","related_post_id")
);
--> statement-breakpoint
CREATE TABLE "post_revisions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"post_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text,
	"summary" text,
	"source" text NOT NULL,
	"author" text,
	CONSTRAINT "post_revisions_source_check" CHECK ("post_revisions"."source" in ('publish'))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"title" text NOT NULL,
	"slug" text NOT NULL,
	"content" text,
	"content_format" text DEFAULT 'markdown' NOT NULL,
	"summary" text,
	"images" jsonb,
	"meta" jsonb,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"translation_group" uuid DEFAULT uuidv7() NOT NULL,
	"translated_from_post_id" uuid,
	"translation_origin" text,
	"category_id" uuid NOT NULL,
	"copyright" boolean DEFAULT true NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"like_count" integer DEFAULT 0 NOT NULL,
	"pin_at" timestamp with time zone,
	CONSTRAINT "posts_status_check" CHECK ("posts"."status" in ('draft', 'scheduled', 'published', 'trash')),
	CONSTRAINT "posts_content_format_check" CHECK ("posts"."content_format" in ('markdown')),
	CONSTRAINT "posts_lang_check" CHECK ("posts"."lang" in ('en', 'zh-cn', 'ja')),
	CONSTRAINT "posts_translation_origin_check" CHECK ("posts"."translation_origin" in ('human', 'ai', 'machine'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
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
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"text" text NOT NULL,
	"source" text,
	"author" text
);
--> statement-breakpoint
CREATE TABLE "recent_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"type" text NOT NULL,
	"metadata" jsonb,
	"ref_type" text,
	"ref_id" uuid,
	"comments_index" integer DEFAULT 0 NOT NULL,
	"allow_comment" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone,
	"up" integer DEFAULT 0 NOT NULL,
	"down" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "snippets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
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
CREATE TABLE "post_tags" (
	"post_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "post_tags_post_id_tag_id_pk" PRIMARY KEY("post_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"introduce" text,
	"icon" text
);
--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" integer,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "analytics" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"visited_at" timestamp with time zone NOT NULL,
	"ip" text,
	"user_agent" jsonb,
	"country" text,
	"path" text,
	"referrer" text
);
--> statement-breakpoint
CREATE TABLE "enrichment_captures" (
	"enrichment_id" uuid PRIMARY KEY NOT NULL,
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
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
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
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_url" text NOT NULL,
	"file_name" text NOT NULL,
	"status" text NOT NULL,
	"ref_id" uuid,
	"ref_type" text,
	"s3_object_key" text,
	"reader_id" text,
	"uploaded_by" text,
	"mime_type" text,
	"byte_size" bigint,
	"detached_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "poll_vote_options" (
	"vote_id" uuid NOT NULL,
	"option_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "poll_votes" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"poll_id" text NOT NULL,
	"voter_fingerprint" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
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
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "serverless_logs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
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
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"namespace" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "slug_trackers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"lang" text DEFAULT 'en' NOT NULL,
	"target_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"cancel_token" text NOT NULL,
	"status" integer NOT NULL,
	"is_verified" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"headers" jsonb,
	"payload" jsonb,
	"event" text,
	"response" jsonb,
	"success" boolean,
	"hook_id" uuid NOT NULL,
	"status" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
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
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
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
	"impersonated_by" text,
	"active_organization_id" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp
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
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	"two_factor_enabled" boolean DEFAULT false,
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
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insights" ADD CONSTRAINT "insights_source_insights_id_insights_id_fk" FOREIGN KEY ("source_insights_id") REFERENCES "public"."insights"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "translations" ADD CONSTRAINT "translations_source_post_id_posts_id_fk" FOREIGN KEY ("source_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reviewed_by_user_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_comment_id_comments_id_fk" FOREIGN KEY ("parent_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_root_comment_id_comments_id_fk" FOREIGN KEY ("root_comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_reader_id_user_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_author_user_id_fk" FOREIGN KEY ("author") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_topic_id_topics_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_related_posts" ADD CONSTRAINT "post_related_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_related_posts" ADD CONSTRAINT "post_related_posts_related_post_id_posts_id_fk" FOREIGN KEY ("related_post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_author_user_id_fk" FOREIGN KEY ("author") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_translated_from_post_id_posts_id_fk" FOREIGN KEY ("translated_from_post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_tags" ADD CONSTRAINT "post_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_captures" ADD CONSTRAINT "enrichment_captures_enrichment_id_enrichment_cache_id_fk" FOREIGN KEY ("enrichment_id") REFERENCES "public"."enrichment_cache"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_reader_id_user_id_fk" FOREIGN KEY ("reader_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "poll_vote_options" ADD CONSTRAINT "poll_vote_options_vote_id_poll_votes_id_fk" FOREIGN KEY ("vote_id") REFERENCES "public"."poll_votes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_hook_id_webhooks_id_fk" FOREIGN KEY ("hook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey" ADD CONSTRAINT "passkey_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_agent_conversations_session_idx" ON "ai_agent_conversations" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insights_ref_lang_uniq" ON "insights" USING btree ("ref_id","lang");--> statement-breakpoint
CREATE INDEX "insights_source_insights_idx" ON "insights" USING btree ("source_insights_id");--> statement-breakpoint
CREATE UNIQUE INDEX "translations_active_uniq" ON "translations" USING btree ("source_post_id","target_lang") WHERE "translations"."status" <> 'discarded';--> statement-breakpoint
CREATE UNIQUE INDEX "meta_presets_name_uniq" ON "meta_presets" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "options_name_uniq" ON "options" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_name_uniq" ON "categories" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_slug_uniq" ON "categories" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "comments_post_thread_idx" ON "comments" USING btree ("post_id","parent_comment_id","pin","created_at") WHERE "comments"."post_id" is not null;--> statement-breakpoint
CREATE INDEX "comments_root_idx" ON "comments" USING btree ("root_comment_id","created_at");--> statement-breakpoint
CREATE INDEX "comments_reader_idx" ON "comments" USING btree ("reader_id");--> statement-breakpoint
CREATE INDEX "comments_parent_idx" ON "comments" USING btree ("parent_comment_id") WHERE "comments"."parent_comment_id" is not null;--> statement-breakpoint
CREATE INDEX "comments_note_idx" ON "comments" USING btree ("note_id") WHERE "comments"."note_id" is not null;--> statement-breakpoint
CREATE INDEX "comments_page_idx" ON "comments" USING btree ("page_id") WHERE "comments"."page_id" is not null;--> statement-breakpoint
CREATE INDEX "comments_reviewed_by_idx" ON "comments" USING btree ("reviewed_by") WHERE "comments"."reviewed_by" is not null;--> statement-breakpoint
CREATE INDEX "comments_review_idx" ON "comments" USING btree ("state","created_at") WHERE "comments"."state" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_ref_uniq" ON "drafts" USING btree ("ref_type","ref_id") WHERE "drafts"."ref_id" is not null;--> statement-breakpoint
CREATE INDEX "drafts_updated_at_idx" ON "drafts" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "links_name_uniq" ON "links" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "links_url_uniq" ON "links" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_nid_uniq" ON "notes" USING btree ("nid");--> statement-breakpoint
CREATE UNIQUE INDEX "notes_slug_uniq" ON "notes" USING btree ("slug") WHERE "notes"."slug" is not null;--> statement-breakpoint
CREATE INDEX "notes_nid_desc_idx" ON "notes" USING btree ("nid");--> statement-breakpoint
CREATE INDEX "notes_updated_at_idx" ON "notes" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "notes_created_at_idx" ON "notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notes_topic_id_idx" ON "notes" USING btree ("topic_id");--> statement-breakpoint
CREATE INDEX "notes_published_public_created_idx" ON "notes" USING btree ("is_published","created_at" DESC NULLS LAST,"public_at");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_slug_uniq" ON "pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "pages_sort_order_idx" ON "pages" USING btree ("sort_order");--> statement-breakpoint
CREATE INDEX "post_related_posts_related_idx" ON "post_related_posts" USING btree ("related_post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "post_revisions_post_version_uniq" ON "post_revisions" USING btree ("post_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_lang_slug_uniq" ON "posts" USING btree ("lang","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "posts_translation_group_lang_uniq" ON "posts" USING btree ("translation_group","lang");--> statement-breakpoint
CREATE INDEX "posts_updated_at_idx" ON "posts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "posts_created_at_idx" ON "posts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "posts_category_id_idx" ON "posts" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "posts_status_pin_published_idx" ON "posts" USING btree ("lang","status","pin_at" DESC NULLS LAST,"published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "posts_category_status_published_idx" ON "posts" USING btree ("category_id","lang","status","pin_at" DESC NULLS LAST,"published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_uniq" ON "projects" USING btree ("name");--> statement-breakpoint
CREATE INDEX "quotes_created_at_idx" ON "quotes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "recent_items_ref_idx" ON "recent_items" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE INDEX "recent_items_created_at_idx" ON "recent_items" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "snippets_path_prefix_idx" ON "snippets" USING btree ("path");--> statement-breakpoint
CREATE INDEX "snippets_type_idx" ON "snippets" USING btree ("type");--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_path_idx" ON "snippets" USING btree ("path") WHERE "snippets"."method" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "snippets_path_method_idx" ON "snippets" USING btree ("path","method") WHERE "snippets"."method" is not null;--> statement-breakpoint
CREATE INDEX "post_tags_tag_idx" ON "post_tags" USING btree ("tag_id","post_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_uniq" ON "tags" USING btree ("slug");--> statement-breakpoint
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
CREATE INDEX "file_references_uploaded_by_idx" ON "file_references" USING btree ("uploaded_by");--> statement-breakpoint
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
CREATE INDEX "slug_trackers_type_lang_slug_idx" ON "slug_trackers" USING btree ("type","lang","slug");--> statement-breakpoint
CREATE INDEX "slug_trackers_type_target_idx" ON "slug_trackers" USING btree ("type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_email_uniq" ON "subscriptions" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_cancel_token_uniq" ON "subscriptions" USING btree ("cancel_token");--> statement-breakpoint
CREATE INDEX "webhook_events_hook_id_idx" ON "webhook_events" USING btree ("hook_id");--> statement-breakpoint
CREATE INDEX "webhook_events_created_at_idx" ON "webhook_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "webhooks_is_enabled_idx" ON "webhooks" USING btree ("is_enabled");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_userId_idx" ON "passkey" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "passkey_credentialID_idx" ON "passkey" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "twoFactor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "twoFactor_userId_idx" ON "two_factor" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");