import { z } from "zod";
import { organizationRefSchema, repositoryRefSchema, RUN_STATUSES } from "./runs";
import { isoDate } from "./schemas";

/**
 * Wire formats of Ask (`/api/ui/ask/**`): the caller's own web chats, starting one about a
 * repo or all of an organization's repos, sending a message, reading a chat with its
 * messages, and the repos a new chat can pick. Sending answers `text/event-stream`
 * (`lib/ask/sse.ts`).
 */

/** Default and largest page of `GET /api/ui/ask/chats`. */
export const ASK_CHAT_LIST_DEFAULT_LIMIT = 50;
export const ASK_CHAT_LIST_MAX_LIMIT = 100;
/** Messages per page of `GET /api/ui/ask/chats/{id}` (the latest, then `before` for older). */
export const ASK_MESSAGE_PAGE_SIZE = 100;
/** Longest message, after trimming. */
export const ASK_MESSAGE_MAX_LENGTH = 8_000;

/** `{updatedAt, id}` of the last chat of a page, as an opaque base64url string. */
export function encodeAskChatCursor(cursor: { updatedAt: string; id: string }): string {
  return Buffer.from(JSON.stringify([cursor.updatedAt, cursor.id])).toString("base64url");
}

const cursorShape = z.tuple([z.iso.datetime(), z.uuid()]);

/** The cursor `encodeAskChatCursor` wrote, or null when `value` isn't one. */
export function decodeAskChatCursor(value: string): { updatedAt: string; id: string } | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? { updatedAt: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

const organizationScope = z
  .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
  .optional();

const LIMIT_ERROR = `The limit must be a number from 1 to ${ASK_CHAT_LIST_MAX_LIMIT}.`;

/** `GET /api/ui/ask/chats?organization=&cursor=&limit=`. */
export const askChatListQuerySchema = z.object({
  organization: organizationScope,
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeAskChatCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "The cursor is invalid." });
      return cursor ?? z.NEVER;
    })
    .optional(),
  limit: z.coerce
    .number({ error: LIMIT_ERROR })
    .int({ error: LIMIT_ERROR })
    .min(1, { error: LIMIT_ERROR })
    .max(ASK_CHAT_LIST_MAX_LIMIT, { error: LIMIT_ERROR })
    .default(ASK_CHAT_LIST_DEFAULT_LIMIT),
});
export type AskChatListQuery = z.infer<typeof askChatListQuerySchema>;

/** `GET /api/ui/ask/chats/{id}?before=`: the messages older than `before`. */
export const askChatQuerySchema = z.object({
  before: z.uuid({ error: "Unknown message." }).optional(),
});

/** `GET /api/ui/ask/repositories?organization=`. */
export const askRepositoriesQuerySchema = z.object({ organization: organizationScope });

const messageText = z
  .string({ error: "Write a message." })
  .trim()
  .min(1, { error: "Write a message." })
  .max(ASK_MESSAGE_MAX_LENGTH, {
    error: `A message can be at most ${ASK_MESSAGE_MAX_LENGTH.toLocaleString("en-US")} characters.`,
  });

/** `POST /api/ui/ask/chats`: a new chat about a repo (null: all the organization's repos). */
export const askChatCreateSchema = z.object({
  organizationId: z.uuid({ error: "Unknown organization." }),
  repositoryId: z.uuid({ error: "Unknown repo." }).nullable(),
  text: messageText,
});
export type AskChatCreate = z.infer<typeof askChatCreateSchema>;

/** `POST /api/ui/ask/chats/{id}/messages`. */
export const askMessageCreateSchema = z.object({ text: messageText });
export type AskMessageCreate = z.infer<typeof askMessageCreateSchema>;

/** A web chat as the chats list and the chat header show it. */
export const askChatSchema = z.object({
  id: z.string(),
  title: z.string(),
  organization: organizationRefSchema,
  /** Null for "All repos". */
  repository: repositoryRefSchema.nullable(),
  /** The repo's default branch when the chat started; null for "All repos". */
  branch: z.string().nullable(),
  updatedAt: isoDate,
});
export type AskChat = z.infer<typeof askChatSchema>;

/** `GET /api/ui/ask/chats`: newest activity first. */
export const askChatListSchema = z.object({
  chats: z.array(askChatSchema),
  nextCursor: z.string().nullable(),
});
export type AskChatList = z.infer<typeof askChatListSchema>;

/** The ask run an Om answer came from. */
export const askMessageRunSchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  durationMs: z.number().nullable(),
  filesRead: z.number(),
});

export const askFileSchema = z.object({
  path: z.string(),
  startLine: z.number().nullable(),
  endLine: z.number().nullable(),
  url: z.string().nullable(),
});

export const askWorkItemSchema = z.object({
  tracker: z.literal("linear"),
  identifier: z.string(),
  url: z.string(),
  runId: z.string().nullable(),
});

/** A card button: the action ID and value a click sends. */
export const askCardActionSchema = z.object({
  id: z.string(),
  label: z.string(),
  value: z.string().nullable(),
});
export type AskCardAction = z.infer<typeof askCardActionSchema>;

export const LINEAR_ISSUE_DRAFT_STATES = [
  "pending",
  "creating",
  "created",
  "cancelled",
  "expired",
] as const;

/** A Linear issue Om drafted (`draft_linear_issue`), in its current state. */
export const askLinearIssueDraftSchema = z.object({
  id: z.string(),
  /** `expired` once its 24 hours are over, even before anyone clicked. */
  status: z.enum(LINEAR_ISSUE_DRAFT_STATES),
  title: z.string(),
  team: z.string(),
  project: z.string().nullable(),
  labels: z.array(z.string()),
  /** The priority's name, or null. */
  priority: z.string().nullable(),
  /** The description preview (Markdown). */
  description: z.string(),
  /** File names of the screenshots it will attach. */
  screenshots: z.array(z.string()),
  /** The created work item. */
  issue: z.object({ identifier: z.string(), url: z.string().nullable() }).nullable(),
  /** Create, Create and delegate, Cancel while pending; none after. */
  actions: z.array(askCardActionSchema),
});
export type AskLinearIssueDraft = z.infer<typeof askLinearIssueDraftSchema>;

/** A card in a chat: a Linear issue draft, or any other card as its title, text and buttons. */
export const askCardSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear_issue_draft"), draft: askLinearIssueDraftSchema }),
  z.object({
    kind: z.literal("generic"),
    title: z.string(),
    text: z.string(),
    actions: z.array(askCardActionSchema),
  }),
]);
export type AskCard = z.infer<typeof askCardSchema>;

export const askMessageSchema = z.object({
  id: z.string(),
  author: z.enum(["user", "om"]),
  markdown: z.string(),
  status: z.enum(["streaming", "complete"]),
  createdAt: isoDate,
  /** For an Om answer relayed from an ask run; else null. */
  run: askMessageRunSchema.nullable(),
  files: z.array(askFileSchema),
  workItems: z.array(askWorkItemSchema),
  card: askCardSchema.nullable(),
});
export type AskMessageView = z.infer<typeof askMessageSchema>;

/** The chat's ask that hasn't answered yet. */
export const askActivitySchema = z.object({
  state: z.enum(["queued", "running"]),
  repository: repositoryRefSchema.nullable(),
  filesRead: z.number(),
  runIds: z.array(z.string()),
});

/** `GET /api/ui/ask/chats/{id}`: oldest message first. */
export const askChatDetailSchema = z.object({
  chat: askChatSchema,
  messages: z.array(askMessageSchema),
  activity: askActivitySchema.nullable(),
  /** The `before` for the older messages; null when there are none. */
  nextBefore: z.string().nullable(),
});
export type AskChatDetail = z.infer<typeof askChatDetailSchema>;

/** A repo a new chat can pick, with its organization. */
export const askRepositoryOptionSchema = repositoryRefSchema.extend({
  organization: organizationRefSchema,
});
export type AskRepositoryOption = z.infer<typeof askRepositoryOptionSchema>;

/** `GET /api/ui/ask/repositories`: by organization name, then path. */
export const askRepositoryListSchema = z.object({
  repositories: z.array(askRepositoryOptionSchema),
});
export type AskRepositoryList = z.infer<typeof askRepositoryListSchema>;
