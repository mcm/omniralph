ALTER TABLE "chat_channel_task_settings" RENAME COLUMN "ask_about_code_task_id" TO "ask_playbook_id";--> statement-breakpoint
ALTER TABLE "chat_channel_task_settings" RENAME COLUMN "start_work_task_id" TO "start_work_playbook_id";--> statement-breakpoint
-- `chat.tasks` `{ askAboutCode, startWork }` becomes `chat.playbooks` `{ ask, startWork }`
-- (0097 refused any value that isn't a built-in ID). A field that isn't a string was read as
-- the built-in default, so it is left out; a row left with no field is removed.
UPDATE "app_settings" SET
  "key" = 'chat.playbooks',
  "value" = jsonb_strip_nulls(jsonb_build_object(
    'ask', CASE WHEN jsonb_typeof("value" -> 'askAboutCode') = 'string' THEN "value" -> 'askAboutCode' END,
    'startWork', CASE WHEN jsonb_typeof("value" -> 'startWork') = 'string' THEN "value" -> 'startWork' END
  ))
WHERE "key" = 'chat.tasks' AND jsonb_typeof("value") = 'object';--> statement-breakpoint
DELETE FROM "app_settings"
WHERE "key" = 'chat.tasks' OR ("key" = 'chat.playbooks' AND "value" = '{}'::jsonb);
