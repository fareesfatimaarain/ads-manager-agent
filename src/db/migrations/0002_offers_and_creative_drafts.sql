CREATE TABLE "creative_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"generation_run_id" uuid NOT NULL,
	"headline" text NOT NULL,
	"primary_text" text NOT NULL,
	"cta" text NOT NULL,
	"angle_tag" text NOT NULL,
	"hook_type" text,
	"reasoning" text NOT NULL,
	"image_asset_id" uuid,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"launched_variant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creative_drafts_status_ck" CHECK (status IN ('DRAFT','APPROVED','REJECTED','LAUNCHED')),
	CONSTRAINT "creative_drafts_launched_ck" CHECK (status <> 'LAUNCHED' OR launched_variant_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "generation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"offer_id" uuid NOT NULL,
	"brand_kit_id" uuid,
	"copy_provider" text NOT NULL,
	"image_provider" text,
	"requested_count" integer NOT NULL,
	"produced_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"error" text,
	"prompt_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"icp_description" text NOT NULL,
	"value_props" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"landing_page_url" text NOT NULL,
	"price_cents" bigint,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "creative_drafts" ADD CONSTRAINT "creative_drafts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_drafts" ADD CONSTRAINT "creative_drafts_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_drafts" ADD CONSTRAINT "creative_drafts_generation_run_id_generation_runs_id_fk" FOREIGN KEY ("generation_run_id") REFERENCES "public"."generation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_drafts" ADD CONSTRAINT "creative_drafts_image_asset_id_creative_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."creative_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_offer_id_offers_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_runs" ADD CONSTRAINT "generation_runs_brand_kit_id_brand_kits_id_fk" FOREIGN KEY ("brand_kit_id") REFERENCES "public"."brand_kits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creative_drafts_client_status_idx" ON "creative_drafts" USING btree ("client_id","status");--> statement-breakpoint
CREATE INDEX "creative_drafts_run_idx" ON "creative_drafts" USING btree ("generation_run_id");--> statement-breakpoint
CREATE INDEX "generation_runs_client_idx" ON "generation_runs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "offers_client_idx" ON "offers" USING btree ("client_id");