CREATE TYPE "public"."reference_asset_kind" AS ENUM('LOGO', 'PAST_AD', 'POSTER', 'BRAND_VIDEO', 'STYLE_GUIDE', 'BRAND_DOCUMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."intake_status" AS ENUM('IN_PROGRESS', 'COMPLETED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('PENDING_REVIEW', 'BLOCKED', 'APPROVED', 'REJECTED', 'EDITED');--> statement-breakpoint
CREATE TABLE "brand_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"industry_key" text NOT NULL,
	"compliance_template_key" text NOT NULL,
	"core" jsonb NOT NULL,
	"industry" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"locks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"creative_direction" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" text NOT NULL,
	"source_kind" text DEFAULT 'INTAKE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"brand_profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"campaign_type" text NOT NULL,
	"placements" jsonb NOT NULL,
	"tone_override" text,
	"brief_notes" text,
	"landing_page_url" text NOT NULL,
	"variant_count" integer DEFAULT 4 NOT NULL,
	"daily_budget_per_variant_cents" bigint NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_briefs_type_ck" CHECK (campaign_type IN ('awareness', 'conversion', 'retargeting', 'launch', 'seasonal')),
	CONSTRAINT "campaign_briefs_variants_ck" CHECK (variant_count BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "compliance_rule_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"template_rule_id" text NOT NULL,
	"disabled" boolean DEFAULT true NOT NULL,
	"justification" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compliance_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"rule_key" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"reason" text NOT NULL,
	"applies_to" jsonb NOT NULL,
	"match" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_rules_severity_ck" CHECK (severity IN ('BLOCK', 'FLAG'))
);
--> statement-breakpoint
CREATE TABLE "creative_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"brand_profile_id" uuid NOT NULL,
	"campaign_brief_id" uuid,
	"status" "review_status" DEFAULT 'PENDING_REVIEW' NOT NULL,
	"angle_tag" text NOT NULL,
	"hook_type" text,
	"headline" text NOT NULL,
	"primary_text" text NOT NULL,
	"cta" text NOT NULL,
	"image_concept" text,
	"image_asset_id" uuid,
	"generation_reasoning" text,
	"compliance_verdict" jsonb NOT NULL,
	"compliance_blocked" boolean NOT NULL,
	"edited_by" text,
	"edited_at" timestamp with time zone,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_reviews_blocked_not_approved_ck" CHECK (NOT (compliance_blocked AND status = 'APPROVED')),
	CONSTRAINT "creative_reviews_approved_ck" CHECK (status <> 'APPROVED' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "intake_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"status" "intake_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"industry_key" text,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prefilled" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resulting_profile_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reference_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" "reference_asset_kind" NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"storage_key" text NOT NULL,
	"usage_note" text,
	"extracted_text" text,
	"active" boolean DEFAULT true NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reference_assets_size_ck" CHECK (size_bytes >= 0)
);
--> statement-breakpoint
ALTER TABLE "brand_profiles" ADD CONSTRAINT "brand_profiles_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_briefs" ADD CONSTRAINT "campaign_briefs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_briefs" ADD CONSTRAINT "campaign_briefs_brand_profile_id_brand_profiles_id_fk" FOREIGN KEY ("brand_profile_id") REFERENCES "public"."brand_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rule_overrides" ADD CONSTRAINT "compliance_rule_overrides_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compliance_rules" ADD CONSTRAINT "compliance_rules_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_reviews" ADD CONSTRAINT "creative_reviews_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_reviews" ADD CONSTRAINT "creative_reviews_brand_profile_id_brand_profiles_id_fk" FOREIGN KEY ("brand_profile_id") REFERENCES "public"."brand_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake_sessions" ADD CONSTRAINT "intake_sessions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_assets" ADD CONSTRAINT "reference_assets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_profiles_client_version_key" ON "brand_profiles" USING btree ("client_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "brand_profiles_one_live_key" ON "brand_profiles" USING btree ("client_id") WHERE effective_to IS NULL;--> statement-breakpoint
CREATE INDEX "brand_profiles_client_idx" ON "brand_profiles" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "campaign_briefs_client_idx" ON "campaign_briefs" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_overrides_client_rule_key" ON "compliance_rule_overrides" USING btree ("client_id","template_rule_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compliance_rules_client_key" ON "compliance_rules" USING btree ("client_id","rule_key");--> statement-breakpoint
CREATE INDEX "creative_reviews_client_status_idx" ON "creative_reviews" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "intake_sessions_client_idx" ON "intake_sessions" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "reference_assets_client_idx" ON "reference_assets" USING btree ("client_id","active");