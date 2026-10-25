import type { SettingsFieldChange } from "@omniralph/db";
import { z } from "zod";
import { SETTINGS_SECTIONS } from "@/lib/live/events";
import { organizationRefSchema } from "./runs";
import { isoDate } from "./schemas";

/** Wire formats of `GET /api/ui/settings-history`: a settings section's change history. */

export const SETTINGS_HISTORY_DEFAULT_LIMIT = 20;
export const SETTINGS_HISTORY_MAX_LIMIT = 100;

/** `{changedAt, id}` of the last entry, as an opaque base64url string. */
export function encodeSettingsHistoryCursor(cursor: { changedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([cursor.changedAt, cursor.id])).toString("base64url");
}

const cursorShape = z.tuple([z.iso.datetime(), z.uuid()]);

function decodeCursor(value: string): { changedAt: string; id: string } | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? { changedAt: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

const LIMIT_ERROR = `The limit must be a number from 1 to ${SETTINGS_HISTORY_MAX_LIMIT}.`;

/**
 * The section, its subject (a repository or connection ID; absent for organization-wide
 * sections), the organization (the active one by default) and the page.
 */
export const settingsHistoryQuerySchema = z.object({
  section: z.enum(SETTINGS_SECTIONS, { error: "Unknown settings section." }),
  subject: z.uuid({ error: "Unknown subject." }).optional(),
  organization: z
    .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
    .optional(),
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "The cursor is invalid." });
      return cursor ?? z.NEVER;
    })
    .optional(),
  limit: z.coerce
    .number({ error: LIMIT_ERROR })
    .int({ error: LIMIT_ERROR })
    .min(1, { error: LIMIT_ERROR })
    .max(SETTINGS_HISTORY_MAX_LIMIT, { error: LIMIT_ERROR })
    .default(SETTINGS_HISTORY_DEFAULT_LIMIT),
});
export type SettingsHistoryQuery = z.infer<typeof settingsHistoryQuerySchema>;

/** A field's display value: text, a number, a switch, a list, or none (`"changed"` for secrets). */
const settingsValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string()),
]);

export const settingsFieldChangeSchema = z.object({
  field: z.string(),
  label: z.string(),
  before: settingsValueSchema,
  after: settingsValueSchema,
}) satisfies z.ZodType<SettingsFieldChange>;

/** One save: who, when, the fields it changed, and how many runs started since. */
export const settingsHistoryEntrySchema = z.object({
  id: z.string(),
  organization: organizationRefSchema,
  section: z.enum(SETTINGS_SECTIONS),
  subjectId: z.string().nullable(),
  actor: z.object({ id: z.string().nullable(), name: z.string() }),
  changedAt: isoDate,
  changes: z.array(settingsFieldChangeSchema),
  /** Runs started since the change, as the section counts them. */
  runsSince: z.number().int().min(0),
});
export type SettingsHistoryEntry = z.infer<typeof settingsHistoryEntrySchema>;

/** A page of the history, newest first; `latest` is the newest entry of all (the info button). */
export const settingsHistorySchema = z.object({
  latest: settingsHistoryEntrySchema.nullable(),
  entries: z.array(settingsHistoryEntrySchema),
  next: z.string().nullable(),
});
export type SettingsHistory = z.infer<typeof settingsHistorySchema>;
