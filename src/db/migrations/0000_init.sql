CREATE TYPE "public"."ad_account_status" AS ENUM('ACTIVE', 'TOKEN_EXPIRED', 'DISABLED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."ad_set_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."cohort_status" AS ENUM('RUNNING', 'CONCLUDED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('PENDING_APPROVAL', 'PENDING_EXECUTION', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTING', 'EXECUTED', 'FAILED', 'BLOCKED', 'RECORDED_ONLY');--> statement-breakpoint
CREATE TYPE "public"."decision_type" AS ENUM('KILL', 'SCALE', 'MUTATE', 'NO_ACTION', 'ESCALATE');--> statement-breakpoint
CREATE TYPE "public"."mutated_field" AS ENUM('HEADLINE', 'PRIMARY_TEXT', 'CTA', 'IMAGE');--> statement-breakpoint
CREATE TYPE "public"."objective_type" AS ENUM('CPA', 'ROAS');--> statement-breakpoint
CREATE TYPE "public"."performance_source" AS ENUM('PLATFORM', 'MOCK', 'BACKFILL');--> statement-breakpoint
CREATE TYPE "public"."platform_action_status" AS ENUM('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'DEAD');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('META', 'GOOGLE', 'TIKTOK', 'MOCK');--> statement-breakpoint
CREATE TYPE "public"."variant_status" AS ENUM('DRAFT', 'PENDING_LAUNCH', 'TESTING', 'SCALING', 'PAUSED', 'KILLED', 'FAILED');--> statement-breakpoint
CREATE TABLE "ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"platform_account_id" text NOT NULL,
	"name" text NOT NULL,
	"currency" text NOT NULL,
	"timezone" text NOT NULL,
	"access_token_ciphertext" text,
	"refresh_token_ciphertext" text,
	"token_key_version" smallint,
	"token_expires_at" timestamp with time zone,
	"status" "ad_account_status" DEFAULT 'ACTIVE' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_accounts_currency_ck" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "ad_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"platform_ad_set_id" text,
	"name" text NOT NULL,
	"daily_budget_cents" bigint NOT NULL,
	"targeting" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"targeting_hash" text NOT NULL,
	"status" "ad_set_status" DEFAULT 'DRAFT' NOT NULL,
	"last_budget_change_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_sets_budget_positive_ck" CHECK (daily_budget_cents > 0)
);
--> statement-breakpoint
CREATE TABLE "ad_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_set_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"platform_ad_id" text,
	"headline" text NOT NULL,
	"primary_text" text NOT NULL,
	"cta" text NOT NULL,
	"image_asset_id" uuid,
	"video_asset_id" uuid,
	"angle_tag" text NOT NULL,
	"hook_type" text,
	"generation_reasoning" text,
	"generation_run_id" uuid,
	"parent_variant_id" uuid,
	"mutated_field" "mutated_field",
	"status" "variant_status" DEFAULT 'DRAFT' NOT NULL,
	"test_started_at" timestamp with time zone,
	"evaluations_proxy" integer DEFAULT 0 NOT NULL,
	"evaluations_outcome" integer DEFAULT 0 NOT NULL,
	"last_evaluated_at" timestamp with time zone,
	"last_action_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ad_variants_mutation_ck" CHECK ((parent_variant_id IS NULL AND mutated_field IS NULL)
          OR
          (parent_variant_id IS NOT NULL AND mutated_field IS NOT NULL)),
	CONSTRAINT "ad_variants_evaluations_ck" CHECK (evaluations_proxy >= 0 AND evaluations_outcome >= 0)
);
--> statement-breakpoint
CREATE TABLE "brand_kits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"palette" jsonb NOT NULL,
	"fonts" jsonb NOT NULL,
	"tone" text NOT NULL,
	"logo_asset_id" uuid,
	"banned_words" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"banned_claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_disclaimers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"platform_campaign_id" text,
	"name" text NOT NULL,
	"objective_type" "objective_type",
	"target_cpa_cents" bigint,
	"target_roas" numeric(10, 4),
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"default_objective_type" "objective_type" NOT NULL,
	"default_target_cpa_cents" bigint,
	"default_target_roas" numeric(10, 4),
	"autonomous_kill_enabled" boolean DEFAULT true NOT NULL,
	"autonomous_scale_enabled" boolean DEFAULT false NOT NULL,
	"autonomous_mutate_enabled" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clients_objective_target_ck" CHECK ((default_objective_type = 'CPA'  AND default_target_cpa_cents IS NOT NULL AND default_target_cpa_cents > 0)
          OR
          (default_objective_type = 'ROAS' AND default_target_roas IS NOT NULL AND default_target_roas > 0))
);
--> statement-breakpoint
CREATE TABLE "creative_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"provider_asset_id" text,
	"url" text,
	"prompt" text,
	"brand_kit_version" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ad_variant_id" uuid NOT NULL,
	"stat_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"impressions" bigint NOT NULL,
	"clicks" bigint NOT NULL,
	"spend_cents" bigint NOT NULL,
	"conversions" bigint NOT NULL,
	"conversion_value_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text NOT NULL,
	"source" "performance_source" NOT NULL,
	"raw_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_performance_nonneg_ck" CHECK (impressions >= 0 AND clicks >= 0 AND spend_cents >= 0
          AND conversions >= 0 AND conversion_value_cents >= 0),
	CONSTRAINT "daily_performance_clicks_ck" CHECK (clicks <= impressions)
);
--> statement-breakpoint
CREATE TABLE "decisions_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ad_variant_id" uuid,
	"cohort_id" uuid,
	"guardrail_config_id" uuid NOT NULL,
	"cycle_id" uuid NOT NULL,
	"decision_type" "decision_type" NOT NULL,
	"status" "decision_status" NOT NULL,
	"triggering_data" jsonb NOT NULL,
	"statistical_evidence" jsonb NOT NULL,
	"guardrail_evaluations" jsonb NOT NULL,
	"proposed_action" jsonb NOT NULL,
	"reasoning" text,
	"blocked_by_rule" text,
	"blocked_reason" text,
	"idempotency_key" text NOT NULL,
	"engine_version" text NOT NULL,
	"ruleset_version" text NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"rejected_by" text,
	"rejected_at" timestamp with time zone,
	"execution_started_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "decisions_log_executed_ck" CHECK (status <> 'EXECUTED' OR executed_at IS NOT NULL),
	CONSTRAINT "decisions_log_blocked_ck" CHECK (status <> 'BLOCKED' OR blocked_by_rule IS NOT NULL),
	CONSTRAINT "decisions_log_approved_ck" CHECK (status <> 'APPROVED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "guardrail_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"max_budget_increase_pct" numeric(5, 2) DEFAULT '20.00' NOT NULL,
	"max_budget_decrease_pct" numeric(5, 2) DEFAULT '50.00' NOT NULL,
	"max_daily_autonomous_increase_cents" bigint NOT NULL,
	"max_total_daily_budget_cents" bigint NOT NULL,
	"min_ad_set_daily_budget_cents" bigint DEFAULT 500 NOT NULL,
	"max_ad_set_daily_budget_cents" bigint NOT NULL,
	"min_runtime_hours" integer DEFAULT 72 NOT NULL,
	"min_spend_multiple_of_target_cpa" numeric(6, 2) DEFAULT '1.00' NOT NULL,
	"min_conversions_per_arm" integer DEFAULT 25 NOT NULL,
	"min_test_spend_cents" bigint DEFAULT 5000 NOT NULL,
	"zero_conversion_kill_spend_cents" bigint DEFAULT 15000 NOT NULL,
	"kill_p_threshold" numeric(5, 4) DEFAULT '0.1000' NOT NULL,
	"scale_p_threshold" numeric(5, 4) DEFAULT '0.0500' NOT NULL,
	"proxy_kill_min_impressions" integer DEFAULT 3000 NOT NULL,
	"proxy_kill_ctr_drop_pct" numeric(5, 2) DEFAULT '50.00' NOT NULL,
	"zero_conversion_kill_spend_multiple" numeric(6, 2) DEFAULT '2.00' NOT NULL,
	"roas_scale_safety_margin" numeric(5, 3) DEFAULT '1.100' NOT NULL,
	"roas_bootstrap_min_days" integer DEFAULT 5 NOT NULL,
	"roas_bootstrap_iterations" integer DEFAULT 2000 NOT NULL,
	"msprt_tau_relative" numeric(6, 3) DEFAULT '0.500' NOT NULL,
	"mutate_cpa_band_multiple" numeric(6, 2) DEFAULT '1.50' NOT NULL,
	"max_mutation_depth" integer DEFAULT 2 NOT NULL,
	"mutate_test_budget_cents" bigint DEFAULT 3000 NOT NULL,
	"allow_scale_without_comparative_baseline" boolean DEFAULT true NOT NULL,
	"action_cooldown_hours" integer DEFAULT 24 NOT NULL,
	"max_actions_per_cycle_per_client" integer DEFAULT 10 NOT NULL,
	"min_active_campaigns" integer DEFAULT 1 NOT NULL,
	"allow_targeting_changes" boolean DEFAULT false NOT NULL,
	"allow_audience_expansion" boolean DEFAULT false NOT NULL,
	"allow_campaign_creation" boolean DEFAULT false NOT NULL,
	"attribution_settling_hours" integer DEFAULT 72 NOT NULL,
	"max_performance_staleness_hours" integer DEFAULT 36 NOT NULL,
	"approval_expiry_hours" integer DEFAULT 48 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_to" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_pct_bounds_ck" CHECK (max_budget_increase_pct > 0 AND max_budget_increase_pct <= 100
          AND max_budget_decrease_pct > 0 AND max_budget_decrease_pct <= 100),
	CONSTRAINT "guardrail_p_bounds_ck" CHECK (kill_p_threshold > 0 AND kill_p_threshold <= 0.2
          AND scale_p_threshold > 0 AND scale_p_threshold <= 0.1
          AND scale_p_threshold <= kill_p_threshold),
	CONSTRAINT "guardrail_money_bounds_ck" CHECK (max_daily_autonomous_increase_cents >= 0
          AND max_total_daily_budget_cents > 0
          AND min_ad_set_daily_budget_cents > 0
          AND max_ad_set_daily_budget_cents >= min_ad_set_daily_budget_cents
          AND max_ad_set_daily_budget_cents <= max_total_daily_budget_cents
          AND min_test_spend_cents > 0
          AND zero_conversion_kill_spend_cents > 0
          AND mutate_test_budget_cents > 0),
	CONSTRAINT "guardrail_evidence_bounds_ck" CHECK (min_runtime_hours >= 24
          AND min_conversions_per_arm >= 1
          AND proxy_kill_min_impressions >= 500
          AND attribution_settling_hours >= 0
          AND approval_expiry_hours > 0
          AND max_mutation_depth >= 0
          AND action_cooldown_hours >= 0
          AND max_actions_per_cycle_per_client >= 0
          AND min_active_campaigns >= 0
          AND roas_bootstrap_min_days >= 2
          AND roas_bootstrap_iterations >= 100
          AND msprt_tau_relative > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"platform" "platform" NOT NULL,
	"method" text NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_payload" jsonb,
	"idempotency_key" text NOT NULL,
	"status" "platform_action_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" text,
	"next_retry_at" timestamp with time zone,
	"acknowledged_by" text,
	"acknowledged_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spend_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"ad_account_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"ledger_date" date NOT NULL,
	"delta_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "test_cohorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "cohort_status" DEFAULT 'RUNNING' NOT NULL,
	"started_at" timestamp with time zone,
	"concluded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_variants" ADD CONSTRAINT "ad_variants_ad_set_id_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "public"."ad_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_variants" ADD CONSTRAINT "ad_variants_cohort_id_test_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."test_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_variants" ADD CONSTRAINT "ad_variants_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_performance" ADD CONSTRAINT "daily_performance_ad_variant_id_ad_variants_id_fk" FOREIGN KEY ("ad_variant_id") REFERENCES "public"."ad_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_log" ADD CONSTRAINT "decisions_log_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_log" ADD CONSTRAINT "decisions_log_ad_variant_id_ad_variants_id_fk" FOREIGN KEY ("ad_variant_id") REFERENCES "public"."ad_variants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_log" ADD CONSTRAINT "decisions_log_cohort_id_test_cohorts_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."test_cohorts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions_log" ADD CONSTRAINT "decisions_log_guardrail_config_id_guardrail_configs_id_fk" FOREIGN KEY ("guardrail_config_id") REFERENCES "public"."guardrail_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD CONSTRAINT "guardrail_configs_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_actions" ADD CONSTRAINT "platform_actions_decision_id_decisions_log_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions_log"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_actions" ADD CONSTRAINT "platform_actions_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_ad_account_id_ad_accounts_id_fk" FOREIGN KEY ("ad_account_id") REFERENCES "public"."ad_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spend_ledger" ADD CONSTRAINT "spend_ledger_decision_id_decisions_log_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions_log"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cohorts" ADD CONSTRAINT "test_cohorts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ad_accounts_platform_account_key" ON "ad_accounts" USING btree ("platform","platform_account_id");--> statement-breakpoint
CREATE INDEX "ad_accounts_client_idx" ON "ad_accounts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "ad_sets_campaign_idx" ON "ad_sets" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_sets_platform_id_key" ON "ad_sets" USING btree ("campaign_id","platform_ad_set_id") WHERE platform_ad_set_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ad_variants_cohort_idx" ON "ad_variants" USING btree ("cohort_id");--> statement-breakpoint
CREATE INDEX "ad_variants_campaign_status_idx" ON "ad_variants" USING btree ("campaign_id","status");--> statement-breakpoint
CREATE INDEX "ad_variants_angle_idx" ON "ad_variants" USING btree ("angle_tag");--> statement-breakpoint
CREATE UNIQUE INDEX "ad_variants_platform_id_key" ON "ad_variants" USING btree ("ad_set_id","platform_ad_id") WHERE platform_ad_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "brand_kits_client_version_key" ON "brand_kits" USING btree ("client_id","version");--> statement-breakpoint
CREATE INDEX "campaigns_client_idx" ON "campaigns" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "campaigns_account_idx" ON "campaigns" USING btree ("ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_platform_id_key" ON "campaigns" USING btree ("ad_account_id","platform_campaign_id") WHERE platform_campaign_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_slug_key" ON "clients" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "creative_assets_client_idx" ON "creative_assets" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_performance_snapshot_key" ON "daily_performance" USING btree ("ad_variant_id","stat_date","fetched_at");--> statement-breakpoint
CREATE INDEX "daily_performance_variant_date_idx" ON "daily_performance" USING btree ("ad_variant_id","stat_date");--> statement-breakpoint
CREATE INDEX "daily_performance_date_idx" ON "daily_performance" USING btree ("stat_date");--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_log_idempotency_key" ON "decisions_log" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "decisions_log_client_decided_idx" ON "decisions_log" USING btree ("client_id","decided_at");--> statement-breakpoint
CREATE INDEX "decisions_log_variant_idx" ON "decisions_log" USING btree ("ad_variant_id");--> statement-breakpoint
CREATE INDEX "decisions_log_status_idx" ON "decisions_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX "decisions_log_cycle_idx" ON "decisions_log" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_configs_client_version_key" ON "guardrail_configs" USING btree ("client_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_configs_one_live_key" ON "guardrail_configs" USING btree ("client_id") WHERE effective_to IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_actions_idempotency_key" ON "platform_actions" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "platform_actions_decision_idx" ON "platform_actions" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "platform_actions_status_retry_idx" ON "platform_actions" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "platform_actions_dead_idx" ON "platform_actions" USING btree ("created_at") WHERE status = 'DEAD' AND acknowledged_at IS NULL;--> statement-breakpoint
CREATE INDEX "spend_ledger_client_date_idx" ON "spend_ledger" USING btree ("client_id","ledger_date");--> statement-breakpoint
CREATE UNIQUE INDEX "spend_ledger_decision_key" ON "spend_ledger" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "test_cohorts_campaign_idx" ON "test_cohorts" USING btree ("campaign_id");