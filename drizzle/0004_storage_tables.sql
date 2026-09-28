DROP TABLE IF EXISTS "enrichment_captures" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "enrichment_cache" CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS "file_references" CASCADE;--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"object_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"thumbhash" text,
	"palette" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"detached_at" timestamp with time zone,
	"uploaded_by" text,
	CONSTRAINT "files_status_check" CHECK ("files"."status" in ('pending', 'attached', 'detached'))
);
--> statement-breakpoint
CREATE TABLE "photo_tags" (
	"photo_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photos" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"file_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"title" jsonb,
	"description" jsonb,
	"taken_at" timestamp with time zone,
	"camera_make" text,
	"camera_model" text,
	"lens_model" text,
	"f_number" text,
	"focal_length_mm" text,
	"exposure_time_s" text,
	"iso" integer,
	"latitude" text,
	"longitude" text,
	"altitude_m" text,
	"exif" jsonb,
	"is_visible" boolean DEFAULT true NOT NULL,
	CONSTRAINT "photos_coords_check" CHECK (("photos"."latitude" is null) = ("photos"."longitude" is null)),
	CONSTRAINT "photos_title_shape_check" CHECK ("photos"."title" is null or jsonb_typeof("photos"."title") = 'object'),
	CONSTRAINT "photos_description_shape_check" CHECK ("photos"."description" is null or jsonb_typeof("photos"."description") = 'object')
);
--> statement-breakpoint
CREATE TABLE "enrichment_captures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"source_url" text NOT NULL,
	"object_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"thumbhash" text,
	"palette" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_references" (
	"file_id" uuid NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_references_file_id_ref_type_ref_id_pk" PRIMARY KEY("file_id","ref_type","ref_id"),
	CONSTRAINT "file_references_ref_type_check" CHECK ("file_references"."ref_type" in ('post', 'note', 'page', 'comment'))
);
--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_tags" ADD CONSTRAINT "photo_tags_photo_id_photos_id_fk" FOREIGN KEY ("photo_id") REFERENCES "public"."photos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_tags" ADD CONSTRAINT "photo_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photos" ADD CONSTRAINT "photos_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_references" ADD CONSTRAINT "file_references_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "files_object_key_uniq" ON "files" USING btree ("object_key");--> statement-breakpoint
CREATE UNIQUE INDEX "files_content_hash_uniq" ON "files" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "files_status_created_idx" ON "files" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "files_uploaded_by_idx" ON "files" USING btree ("uploaded_by") WHERE "files"."uploaded_by" is not null;--> statement-breakpoint
CREATE INDEX "files_status_detached_idx" ON "files" USING btree ("status","detached_at");--> statement-breakpoint
CREATE INDEX "photo_tags_tag_idx" ON "photo_tags" USING btree ("tag_id","photo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "photos_slug_uniq" ON "photos" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "photos_file_id_uniq" ON "photos" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "photos_visible_taken_idx" ON "photos" USING btree ("is_visible","taken_at");--> statement-breakpoint
CREATE INDEX "enrichment_captures_lru_idx" ON "enrichment_captures" USING btree ("last_accessed_at");--> statement-breakpoint
CREATE INDEX "enrichment_captures_source_idx" ON "enrichment_captures" USING btree ("provider","source_url");--> statement-breakpoint
CREATE INDEX "file_references_ref_idx" ON "file_references" USING btree ("ref_type","ref_id");
