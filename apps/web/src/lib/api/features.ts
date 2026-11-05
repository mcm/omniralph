import { z } from "zod";
import { RUN_STATUSES, repositoryRefSchema, scmProviderSchema } from "./runs";
import { SPRINT_EPIC_PR_STATES } from "./sprints";
import { isoDate } from "./schemas";

/**
 * Features (`/api/ui/features/**`, members): groups of epics planned together, each with a
 * PRFAQ and a Plan (every save a new version) and attachments; and the attachments of
 * features and work items (`/api/ui/attachments/**`). Safe to import in the browser.
 */

export const FEATURE_STATUSES = ["planning", "archived"] as const;
export type FeatureStatusValue = (typeof FEATURE_STATUSES)[number];

export const FEATURE_DOCUMENT_KINDS = ["prfaq", "plan"] as const;
export type FeatureDocumentKindValue = (typeof FEATURE_DOCUMENT_KINDS)[number];

export const FEATURE_NAME_MAX_LENGTH = 120;
/** The longest PRFAQ or Plan, in characters. */
export const FEATURE_DOCUMENT_MAX_LENGTH = 500_000;

/**
 * The largest attachment, in bytes: uploads go through the control panel, whose functions
 * take request bodies up to 4.5 MB on Vercel.
 */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

/** The file types an attachment may be, with the extensions each is recognized by. */
export const ATTACHMENT_TYPES = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
  "text/plain": [".txt"],
  "text/markdown": [".md", ".markdown"],
  "text/csv": [".csv"],
  "application/json": [".json"],
} as const satisfies Record<string, readonly string[]>;
export type AttachmentContentType = keyof typeof ATTACHMENT_TYPES;

/**
 * The attachment type of a file: its declared type when it is one we take, else (no type,
 * or a generic one) the type its extension names. Null when it isn't a type we take.
 */
export function attachmentContentType(
  fileName: string,
  declared: string,
): AttachmentContentType | null {
  const type = declared.split(";")[0]!.trim().toLowerCase();
  if (type in ATTACHMENT_TYPES) return type as AttachmentContentType;
  if (type && type !== "application/octet-stream") return null;
  const extension = /\.[^.]+$/.exec(fileName.toLowerCase())?.[0];
  if (!extension) return null;
  const found = Object.entries(ATTACHMENT_TYPES).find(([, extensions]) =>
    (extensions as readonly string[]).includes(extension),
  );
  return (found?.[0] as AttachmentContentType | undefined) ?? null;
}

export const featureRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(FEATURE_STATUSES),
  /** The repo the feature's epics build in, null when it isn't scoped to one. */
  repository: repositoryRefSchema.nullable(),
  /** How many epics the feature has. */
  epicCount: z.number(),
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type FeatureRow = z.infer<typeof featureRowSchema>;

/** `GET /api/ui/features`: the organization's features, newest first. */
export const featureListSchema = z.object({ features: z.array(featureRowSchema) });
export type FeatureList = z.infer<typeof featureListSchema>;

// ── Progress (`GET /api/ui/features/{id}/progress`) ───────────────────────

/** One epic of a feature and how far along it is. */
export const featureEpicProgressSchema = z.object({
  /** The work item's URL ID (`<tracker>-<issue id>`, its Backlog page). */
  workItemId: z.string(),
  /** Its identifier and title: from the tracker, else from its latest run; null when neither knows. */
  identifier: z.string().nullable(),
  title: z.string().nullable(),
  /** Its page in the tracker, null when unknown. */
  url: z.string().nullable(),
  /** Its state in the tracker; null when the tracker couldn't be read. */
  state: z
    .object({
      category: z.enum(["triage", "backlog", "todo", "in_progress", "done", "canceled"]),
      name: z.string(),
    })
    .nullable(),
  /** Its stories done and in all (canceled ones left out); null when the tracker couldn't be read. */
  stories: z.object({ done: z.number(), total: z.number() }).nullable(),
  /** Its latest run, null when Om never ran it. */
  run: z.object({ id: z.string(), status: z.enum(RUN_STATUSES) }).nullable(),
  /** The PRs/MRs that run opened, in lane order, with their code host. */
  pullRequests: z.array(
    z.object({
      number: z.number(),
      url: z.string(),
      state: z.enum(SPRINT_EPIC_PR_STATES),
      host: scmProviderSchema,
    }),
  ),
});
export type FeatureEpicProgress = z.infer<typeof featureEpicProgressSchema>;

/** A feature's epics done and in all, and their stories done and in all (canceled ones left out). */
export const featureRollupSchema = z.object({
  epicsDone: z.number(),
  epicsTotal: z.number(),
  storiesDone: z.number(),
  storiesTotal: z.number(),
});
export type FeatureRollup = z.infer<typeof featureRollupSchema>;

/** `GET /api/ui/features/{id}/progress`: each epic in filing order, and the roll-up. */
export const featureProgressSchema = z.object({
  epics: z.array(featureEpicProgressSchema),
  rollup: featureRollupSchema,
  /** Why the tracker couldn't be read (states and stories are then missing); null when it could. */
  trackerProblem: z.string().nullable(),
});
export type FeatureProgress = z.infer<typeof featureProgressSchema>;

/** The answer to a create or an update. */
export const savedFeatureSchema = z.object({ ok: z.literal(true), feature: featureRowSchema });
export type SavedFeature = z.infer<typeof savedFeatureSchema>;

const nameSchema = z
  .string()
  .trim()
  .min(1, { error: "Name the feature." })
  .max(FEATURE_NAME_MAX_LENGTH, {
    error: `Keep the name under ${FEATURE_NAME_MAX_LENGTH} characters.`,
  });

/** `POST /api/ui/features`. */
export const createFeatureBodySchema = z.strictObject({
  name: nameSchema,
  repositoryId: z.uuid({ error: "Unknown repo." }).nullable().optional(),
});
export type CreateFeatureBody = z.infer<typeof createFeatureBodySchema>;

/** `PATCH /api/ui/features/{id}`: rename, change the repo, archive or restore. */
export const updateFeatureBodySchema = z
  .strictObject({
    name: nameSchema.optional(),
    repositoryId: z.uuid({ error: "Unknown repo." }).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined || body.repositoryId !== undefined || body.archived !== undefined,
    { error: "Nothing to change." },
  );
export type UpdateFeatureBody = z.infer<typeof updateFeatureBodySchema>;

/** One version of a PRFAQ or Plan. */
export const featureDocumentSchema = z.object({
  kind: z.enum(FEATURE_DOCUMENT_KINDS),
  /** 0 for a document never saved (its body empty). */
  version: z.number(),
  body: z.string(),
  /** When this version was saved, null for a document never saved. */
  savedAt: isoDate.nullable(),
});
export type FeatureDocumentRow = z.infer<typeof featureDocumentSchema>;

/** `GET /api/ui/features/{id}/documents/{kind}`: the latest version, or `?version=`. */
export const featureDocumentQuerySchema = z.object({
  version: z.coerce.number().int().positive().optional(),
});

/** `PUT /api/ui/features/{id}/documents/{kind}`: saves a new version. */
export const saveFeatureDocumentBodySchema = z.strictObject({
  body: z.string().max(FEATURE_DOCUMENT_MAX_LENGTH, { error: "The document is too long." }),
  /** The version the edit started from (0 for a document never saved): a later save is a conflict. */
  baseVersion: z.number().int().nonnegative(),
});
export type SaveFeatureDocumentBody = z.infer<typeof saveFeatureDocumentBodySchema>;

/** The answer to a save. */
export const savedFeatureDocumentSchema = z.object({
  ok: z.literal(true),
  document: featureDocumentSchema,
});
export type SavedFeatureDocument = z.infer<typeof savedFeatureDocumentSchema>;

/** `GET /api/ui/features/{id}/documents/{kind}/versions`: every saved version, newest first. */
export const featureDocumentVersionsSchema = z.object({
  versions: z.array(
    // `savedBy`: the name of who saved it, null when unknown.
    z.object({ version: z.number(), savedAt: isoDate, savedBy: z.string().nullable() }),
  ),
});
export type FeatureDocumentVersions = z.infer<typeof featureDocumentVersionsSchema>;

/** One attachment of a feature or a work item. */
export const attachmentRowSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  /** In bytes. */
  size: z.number(),
  /** `GET` it for the file (`?download=1` to save it rather than show it). */
  url: z.string(),
  createdAt: isoDate,
});
export type AttachmentRow = z.infer<typeof attachmentRowSchema>;

/** `GET …/attachments`: the owner's attachments, oldest first. */
export const attachmentListSchema = z.object({ attachments: z.array(attachmentRowSchema) });
export type AttachmentList = z.infer<typeof attachmentListSchema>;

/** `POST …/attachments` (multipart, field `file`): the new attachment (201). */
export const uploadedAttachmentSchema = z.object({
  ok: z.literal(true),
  attachment: attachmentRowSchema,
});
export type UploadedAttachment = z.infer<typeof uploadedAttachmentSchema>;

/** `GET` and `DELETE /api/ui/attachments/{id}`: the attachment's organization, if not the active one. */
export const attachmentQuerySchema = z.object({
  organization: z.uuid({ error: "Unknown organization." }).optional(),
  download: z.enum(["1"]).optional(),
});
