-- Playbooks replace agent and task definitions. Custom definitions aren't converted, so a
-- definition row, or a repo, chat setting or channel override naming a custom ID, would be
-- lost: stop and name them instead.
DO $$
DECLARE
  offending text;
BEGIN
  SELECT string_agg(item, ', ' ORDER BY item)
  INTO offending
  FROM (
    SELECT format('organization %s agent definition %s', "organization_id", "id") AS item FROM "agent_definitions"
    UNION ALL
    SELECT format('organization %s task definition %s', "organization_id", "id") FROM "task_definitions"
    UNION ALL
    SELECT format('repository %s review task %L', r."id", t.id)
    FROM "repositories" r, unnest(r."review_task_ids") AS t(id)
    WHERE t.id NOT LIKE 'builtin:%'
    UNION ALL
    SELECT format('repository %s correlation task %L', "id", "correlation_task_id")
    FROM "repositories" WHERE "correlation_task_id" NOT LIKE 'builtin:%'
    UNION ALL
    SELECT format('repository %s story task %L', "id", "story_task_id")
    FROM "repositories" WHERE "story_task_id" NOT LIKE 'builtin:%'
    UNION ALL
    SELECT format('repository %s request task %L', "id", "request_task_id")
    FROM "repositories" WHERE "request_task_id" NOT LIKE 'builtin:%'
    UNION ALL
    SELECT format('organization %s chat task %s %L', s."organization_id", v.key, v.value)
    FROM "app_settings" s, jsonb_each_text(CASE WHEN jsonb_typeof(s."value") = 'object' THEN s."value" ELSE '{}'::jsonb END) AS v(key, value)
    WHERE s."key" = 'chat.tasks' AND v.value NOT LIKE 'builtin:%'
    UNION ALL
    SELECT format('chat channel override %s ask about code task %L', "id", "ask_about_code_task_id")
    FROM "chat_channel_task_settings" WHERE "ask_about_code_task_id" NOT LIKE 'builtin:%'
    UNION ALL
    SELECT format('chat channel override %s start work task %L', "id", "start_work_task_id")
    FROM "chat_channel_task_settings" WHERE "start_work_task_id" NOT LIKE 'builtin:%'
  ) AS lost;
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Custom agent and task definitions would be lost: %', offending
      USING HINT = 'Point those settings back at built-in tasks and delete the custom definitions, then migrate again.';
  END IF;
END $$;--> statement-breakpoint
CREATE TABLE "playbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"definition" jsonb NOT NULL,
	"requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "agent_definitions" CASCADE;--> statement-breakpoint
DROP TABLE "task_definitions" CASCADE;--> statement-breakpoint
-- The bindings keep their values (production has only the built-in IDs, which are the playbooks').
ALTER TABLE "repositories" RENAME COLUMN "review_task_ids" TO "review_playbook_ids";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "correlation_task_id" TO "correlation_playbook_id";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "story_task_id" TO "story_playbook_id";--> statement-breakpoint
ALTER TABLE "repositories" RENAME COLUMN "request_task_id" TO "request_playbook_id";--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playbooks_organization_id_idx" ON "playbooks" USING btree ("organization_id");
