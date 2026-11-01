-- Renames the Linear-named tools and settings of custom playbooks to their tracker names (after
--> statement-breakpoint
-- 0122): the tool names `linear_get_issue`, `linear_list_comments`, `linear_search_issues` and
--> statement-breakpoint
-- `linear_get_document` become `tracker_*` wherever the definition names them (`tools.linear`,
--> statement-breakpoint
-- permission rules, prompts), `tools.linear` becomes `tools.tracker` and
--> statement-breakpoint
-- `toolSettings.linearRead` becomes `toolSettings.trackerRead`. Every other value is kept.
--> statement-breakpoint
UPDATE "playbooks" SET "definition" = replace(replace(replace(replace("definition"::text,
    'linear_get_issue', 'tracker_get_issue'),
    'linear_list_comments', 'tracker_list_comments'),
    'linear_search_issues', 'tracker_search_issues'),
    'linear_get_document', 'tracker_get_document')::jsonb
  WHERE "definition"::text ~ 'linear_(get_issue|list_comments|search_issues|get_document)';
--> statement-breakpoint
UPDATE "playbooks" SET "definition" = jsonb_set(
    "definition" #- '{tools,linear}',
    '{tools,tracker}',
    coalesce("definition" -> 'tools' -> 'tracker', "definition" -> 'tools' -> 'linear')
  )
  WHERE jsonb_typeof("definition" -> 'tools') = 'object' AND "definition" -> 'tools' ? 'linear';
--> statement-breakpoint
UPDATE "playbooks" SET "definition" = jsonb_set(
    "definition" #- '{toolSettings,linearRead}',
    '{toolSettings,trackerRead}',
    coalesce("definition" -> 'toolSettings' -> 'trackerRead', "definition" -> 'toolSettings' -> 'linearRead')
  )
  WHERE jsonb_typeof("definition" -> 'toolSettings') = 'object'
    AND "definition" -> 'toolSettings' ? 'linearRead';
