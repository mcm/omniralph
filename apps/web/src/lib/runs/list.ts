/**
 * The unified run list (`GET /api/ui/runs`): its query, its cursor and its rows on the wire.
 */
import { workItemUrlId, type RunCursor, type RunKind, type RunListEntry } from "@omniralph/db";
import { z } from "zod";
import {
  RUN_KINDS,
  RUN_LIST_DEFAULT_LIMIT,
  RUN_LIST_MAX_LIMIT,
  RUN_ORIGINS,
  RUN_STATUSES,
  type RunRow,
} from "@/lib/api/runs";
import type { ScopedOrganization } from "@/lib/api/scope";
import { truncate } from "@/lib/ralph/display";
import { changeRequestWebUrl } from "@/lib/repositories/web-url";

/** Longest title a row carries (an ask's question, a chat run's request). */
export const RUN_TITLE_MAX_LENGTH = 200;

/** `{createdAt, id}` of the last row, as an opaque base64url string. */
export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id])).toString("base64url");
}

const cursorShape = z.tuple([z.iso.datetime(), z.uuid()]);

/** The cursor `encodeRunCursor` wrote, or null when `value` isn't one. */
export function decodeRunCursor(value: string): RunCursor | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(value, "base64url").toString()));
    return parsed.success ? { createdAt: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}

/** `GET /api/ui/runs`'s query: `kind`, `status`, `origin` and `repository` repeat, every value must be known. */
export const runListQuerySchema = z.object({
  kind: z.array(z.enum(RUN_KINDS, { error: "Unknown run kind." })).default([]),
  status: z.array(z.enum(RUN_STATUSES, { error: "Unknown run status." })).default([]),
  origin: z.array(z.enum(RUN_ORIGINS, { error: "Unknown run origin." })).default([]),
  repository: z.array(z.uuid({ error: "Unknown repository." })).default([]),
  agent: z.uuid({ error: "Unknown agent." }).optional(),
  organization: z
    .union([z.literal("all"), z.uuid()], { error: "Unknown organization." })
    .optional(),
  cursor: z
    .string()
    .transform((value, ctx) => {
      const cursor = decodeRunCursor(value);
      if (!cursor) ctx.addIssue({ code: "custom", message: "The cursor is invalid." });
      return cursor ?? z.NEVER;
    })
    .optional(),
  limit: z.coerce
    .number({ error: "The limit must be a number from 1 to 100." })
    .int({ error: "The limit must be a number from 1 to 100." })
    .min(1, { error: "The limit must be a number from 1 to 100." })
    .max(RUN_LIST_MAX_LIMIT, { error: "The limit must be a number from 1 to 100." })
    .default(RUN_LIST_DEFAULT_LIMIT),
});
export type RunListQuery = z.infer<typeof runListQuerySchema>;

const REPEATED = ["kind", "status", "origin", "repository"] as const;

/** The search params as `runListQuerySchema` reads them: the repeatable ones as lists. */
export function runListSearch(params: URLSearchParams): Record<string, unknown> {
  const search: Record<string, unknown> = Object.fromEntries(params);
  for (const key of REPEATED) search[key] = params.getAll(key);
  return search;
}

/** What a run without a title of its own is called. */
function fallbackTitle(entry: RunListEntry): string {
  const kinds: Record<RunKind, string> = {
    epic: "Epic",
    request: "Request",
    review: "Review",
    triage: "Triage",
    ask: "Question",
  };
  if (entry.kind === "review" && entry.pullRequest) {
    const gitlab = entry.repository?.provider === "gitlab";
    return gitlab
      ? `Review of merge request !${entry.pullRequest.number}`
      : `Review of pull request #${entry.pullRequest.number}`;
  }
  return kinds[entry.kind];
}

/** Only web links are linked to. */
function webUrl(url: string | null): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

/** A run's list row on the wire. */
export function runRow(entry: RunListEntry, organization: ScopedOrganization): RunRow {
  const { repository, pullRequest } = entry;
  const title = entry.title?.trim().replace(/\s+/g, " ");
  return {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    origin: entry.origin,
    organization: { id: organization.id, name: organization.name, role: organization.role },
    title: title ? truncate(title, RUN_TITLE_MAX_LENGTH) : fallbackTitle(entry),
    workItem: entry.workItem?.issueId
      ? {
          id: workItemUrlId("linear", entry.workItem.issueId),
          tracker: "linear",
          identifier: entry.workItem.identifier,
          url: webUrl(entry.workItem.url),
        }
      : null,
    repository: repository && {
      id: repository.id,
      provider: repository.provider,
      fullPath: repository.fullPath,
    },
    branch: entry.branch,
    pullRequest:
      pullRequest && repository
        ? {
            provider: repository.provider,
            number: pullRequest.number,
            url:
              webUrl(pullRequest.url) ??
              changeRequestWebUrl(
                repository.provider,
                repository.baseUrl,
                repository.fullPath,
                pullRequest.number,
              ),
          }
        : null,
    agent: entry.agent,
    progress: entry.progress,
    tokens: entry.tokens,
    createdAt: entry.createdAt.toISOString(),
    startedAt: entry.startedAt?.toISOString() ?? null,
    finishedAt: entry.finishedAt?.toISOString() ?? null,
    updatedAt: entry.updatedAt.toISOString(),
  };
}
