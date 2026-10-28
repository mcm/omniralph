CREATE TABLE "attempt_model_usage" (
	"job_id" uuid NOT NULL,
	"model" text NOT NULL,
	"price_model_id" text,
	"input_tokens" bigint NOT NULL,
	"cache_read_tokens" bigint NOT NULL,
	"cache_write_5m_tokens" bigint NOT NULL,
	"cache_write_1h_tokens" bigint,
	"output_tokens" bigint NOT NULL,
	"largest_request_input_tokens" integer,
	"fast_mode" boolean DEFAULT false NOT NULL,
	CONSTRAINT "attempt_model_usage_job_id_model_pk" PRIMARY KEY("job_id","model")
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"model_id" text NOT NULL,
	"name" text NOT NULL,
	"input_usd" numeric NOT NULL,
	"output_usd" numeric NOT NULL,
	"cache_read_usd" numeric,
	"cache_write_usd" numeric,
	"base_tier_max_tokens" integer,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"checked_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_model_usage" ADD CONSTRAINT "attempt_model_usage_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_prices_open_model_id_idx" ON "model_prices" USING btree ("model_id") WHERE valid_to is null;--> statement-breakpoint
CREATE INDEX "model_prices_model_id_valid_from_idx" ON "model_prices" USING btree ("model_id","valid_from");--> statement-breakpoint
-- Each attempt's list price: its usage per model × the price in effect when it finished.
-- 1-hour cache writes cost 2× base input for every model (Anthropic's pricing page,
-- https://docs.anthropic.com/en/docs/about-claude/pricing; the Gateway lists no such price):
-- `ONE_HOUR_CACHE_WRITE_MULTIPLIER` in queries/attempt-costs.ts. A model that can't be priced
-- exactly (no price, a missing component price, an unknown 1-hour split, fast mode, or a
-- tiered price whose tier can't be decided) makes the whole attempt unpriced (null).
CREATE VIEW "attempt_costs" AS
SELECT u.job_id,
  CASE WHEN bool_and(r.cost IS NOT NULL) THEN sum(r.cost) END AS cost_usd
FROM "attempt_model_usage" u
JOIN "jobs" j ON j.id = u.job_id
LEFT JOIN "model_prices" p ON p.model_id = u.price_model_id
  AND j.finished_at >= p.valid_from
  AND (p.valid_to IS NULL OR j.finished_at < p.valid_to)
CROSS JOIN LATERAL (SELECT CASE
  WHEN p.id IS NULL THEN NULL
  WHEN u.fast_mode THEN NULL
  WHEN u.cache_read_tokens > 0 AND p.cache_read_usd IS NULL THEN NULL
  WHEN u.cache_write_5m_tokens > 0 AND p.cache_write_usd IS NULL THEN NULL
  WHEN u.cache_write_1h_tokens IS NULL AND u.cache_write_5m_tokens > 0 THEN NULL
  WHEN p.base_tier_max_tokens IS NOT NULL AND (u.largest_request_input_tokens IS NULL
    OR u.largest_request_input_tokens >= p.base_tier_max_tokens) THEN NULL
  ELSE u.input_tokens * p.input_usd
    + u.cache_read_tokens * coalesce(p.cache_read_usd, 0)
    + u.cache_write_5m_tokens * coalesce(p.cache_write_usd, 0)
    + coalesce(u.cache_write_1h_tokens, 0) * p.input_usd * 2
    + u.output_tokens * p.output_usd
  END AS cost) r
GROUP BY u.job_id;
