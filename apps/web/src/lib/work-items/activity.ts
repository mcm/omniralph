import type { TriageRun, WorkItemEvent } from "@omniralph/db";
import { TRIAGE_SIZES } from "@omniralph/shared";
import type { z } from "zod";
import type { workItemActivitySchema } from "@/lib/api/work-items";
import type { WorkItemComment } from "./tracker";

/**
 * A work item's Activity: its Omniralph events (`work_item_events`), its triage runs and its
 * tracker comments, merged newest first, each a plain sentence ("Om triaged it (size M)",
 * "Steve changed the repo to customer-portal", "Anna commented: …").
 */

export type WorkItemActivity = z.infer<typeof workItemActivitySchema>;

/** Most entries Activity shows. */
export const ACTIVITY_LIMIT = 200;

/** Longest comment excerpt, in characters. */
const EXCERPT_LENGTH = 140;

/** How Activity names a person: their first name ("Steve McMaster" → "Steve"). */
export function shortName(name: string): string {
  return name.trim().split(/\s+/)[0] || "Someone";
}

/** A repo by its name, the last segment of its path (`acme/customer-portal` → `customer-portal`). */
const repoName = (fullPath: unknown) =>
  typeof fullPath === "string" ? (fullPath.split("/").filter(Boolean).pop() ?? fullPath) : null;

/** The sentence of an event a member (or Om, or a chat surface) caused in Omniralph. */
export function eventSentence(event: Pick<WorkItemEvent, "kind" | "actorName" | "detail">): string {
  const who = shortName(event.actorName);
  const detail = (event.detail ?? {}) as Record<string, unknown>;
  switch (event.kind) {
    case "created":
      return detail.origin === "ask" ? `${who} created it from Ask` : `${who} created it`;
    case "repo_changed": {
      const repo = repoName(detail.repository);
      return repo ? `${who} changed the repo to ${repo}` : `${who} changed the repo`;
    }
    case "repo_reset":
      return `${who} went back to the routing rules for the repo`;
    case "moved_to_needs_refining":
      return `${who} moved it to Needs refining`;
    case "prd_edited":
      return `${who} edited the PRD`;
    case "triage_requested":
      return `${who} asked Om to triage it`;
    case "started":
      return `${who} started it`;
    case "share_link_created":
      return `${who} created a review link`;
    case "share_link_revoked":
      return `${who} revoked a review link`;
    case "canceled":
      return `${who} removed it from the backlog`;
  }
}

const isSize = (value: unknown): value is (typeof TRIAGE_SIZES)[number] =>
  typeof value === "string" && (TRIAGE_SIZES as readonly string[]).includes(value);

/** A triage run's entries: what Om did (and the open questions it left), when it did. */
export function triageEntries(
  run: Pick<TriageRun, "id" | "status" | "lastResult" | "createdAt" | "updatedAt">,
): WorkItemActivity[] {
  const at = run.updatedAt.toISOString();
  const entry = (suffix: string, text: string, when = at): WorkItemActivity => ({
    id: `triage-${run.id}-${suffix}`,
    source: "triage",
    text,
    at: when,
  });
  switch (run.status) {
    case "queued":
    case "running":
      return [entry("started", "Om started triaging it", run.createdAt.toISOString())];
    case "failed":
      return [entry("failed", "Om couldn't triage it")];
    case "stopped":
      return [entry("stopped", "Om's triage was stopped")];
    case "completed": {
      const outcome = (run.lastResult?.outcome ?? null) as {
        size?: unknown;
        openQuestions?: unknown;
      } | null;
      if (!outcome) return [entry("triaged", "Om triaged it")];
      const size = isSize(outcome.size) ? ` (size ${outcome.size})` : "";
      const questions = Array.isArray(outcome.openQuestions) ? outcome.openQuestions.length : 0;
      return [
        ...(questions > 0
          ? [
              entry(
                "questions",
                `Om left ${questions} open ${questions === 1 ? "question" : "questions"}`,
              ),
            ]
          : []),
        entry("triaged", `Om triaged it${size}`),
      ];
    }
  }
}

/** A comment's first line, shortened. */
export function commentExcerpt(body: string): string {
  const line =
    body
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean) ?? "";
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH - 1).trimEnd()}…` : line;
}

/** Activity, newest first: events, triage runs and comments merged (at most `ACTIVITY_LIMIT`). */
export function workItemActivity(input: {
  events: readonly Pick<WorkItemEvent, "id" | "kind" | "actorName" | "detail" | "createdAt">[];
  triageRuns: readonly Pick<
    TriageRun,
    "id" | "status" | "lastResult" | "createdAt" | "updatedAt"
  >[];
  comments: readonly WorkItemComment[];
}): WorkItemActivity[] {
  const entries: WorkItemActivity[] = [
    ...input.events.map((event) => ({
      id: `event-${event.id}`,
      source: "event" as const,
      text: eventSentence(event),
      at: event.createdAt.toISOString(),
    })),
    ...input.triageRuns.flatMap(triageEntries),
    ...input.comments.flatMap((comment, index) => {
      const at = Date.parse(comment.createdAt);
      if (Number.isNaN(at)) return [];
      const excerpt = commentExcerpt(comment.body);
      const who = comment.author ? shortName(comment.author) : "Someone";
      return [
        {
          id: `comment-${index}`,
          source: "comment" as const,
          text: excerpt ? `${who} commented: ${excerpt}` : `${who} commented`,
          at: new Date(at).toISOString(),
        },
      ];
    }),
  ];
  // Newest first; at the same time, the order built above (a triage's questions before it).
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.at.localeCompare(a.entry.at) || a.index - b.index)
    .map(({ entry }) => entry)
    .slice(0, ACTIVITY_LIMIT);
}
