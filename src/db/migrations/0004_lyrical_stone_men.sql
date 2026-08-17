ALTER TABLE "campaign_briefs" ADD COLUMN "launched_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_briefs" ADD COLUMN "launched_cohort_id" uuid;--> statement-breakpoint
ALTER TABLE "creative_reviews" ADD COLUMN "launched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "creative_reviews" ADD COLUMN "launched_variant_id" uuid;--> statement-breakpoint
ALTER TABLE "creative_reviews" ADD CONSTRAINT "creative_reviews_launch_requires_approval_ck" CHECK (launched_at IS NULL OR status = 'APPROVED');