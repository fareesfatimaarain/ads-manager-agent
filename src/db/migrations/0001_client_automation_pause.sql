ALTER TABLE "clients" ADD COLUMN "automation_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "automation_paused_by" text;