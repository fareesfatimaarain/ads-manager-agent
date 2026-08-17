CREATE TABLE "platform_mutation_ledger" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"platform" "platform" NOT NULL,
	"method" text NOT NULL,
	"platform_entity_id" text,
	"result_json" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "platform_mutation_ledger_platform_idx" ON "platform_mutation_ledger" USING btree ("platform");