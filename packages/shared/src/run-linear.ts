/**
 * The read-only Linear tools of a run (`linear_get_issue`,
 * `linear_list_comments`, `linear_search_issues`, `linear_get_document`):
 * served by the control panel under `/api/harness/runs/{id}/linear/*` with
 * the run's organization's Linear workspace, so the harness never holds a
 * Linear token. Requests carry the run's session token (`linear:read`).
 */
import { z } from "zod";

/** An issue ID or identifier (`ENG-123`), or a document ID or slug ID. */
export const LinearEntityId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);

export const MAX_LINEAR_SEARCH_QUERY = 500;
export const DEFAULT_LINEAR_SEARCH_RESULTS = 10;
export const MAX_LINEAR_SEARCH_RESULTS = 50;
/** `linear_list_comments` returns at most this many comments: the most recent ones. */
export const MAX_LINEAR_COMMENTS = 100;

export const LinearSearchQuery = z.object({
  query: z.string().trim().min(1).max(MAX_LINEAR_SEARCH_QUERY),
  first: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LINEAR_SEARCH_RESULTS)
    .default(DEFAULT_LINEAR_SEARCH_RESULTS),
});
export type LinearSearchQuery = z.infer<typeof LinearSearchQuery>;

/** An issue as the Linear tools show it to a session. */
export const RunLinearIssue = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  /** Markdown. */
  description: z.string(),
  url: z.string(),
  team: z.string(),
  state: z.string(),
  /** `triage`, `backlog`, `unstarted`, `started`, `completed` or `canceled`. */
  stateType: z.string(),
  /** 0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low. */
  priority: z.number(),
  labels: z.array(z.string()),
  project: z.string().optional(),
  /** The parent issue's ID. */
  parentId: z.string().optional(),
  creator: z.string().optional(),
});
export type RunLinearIssue = z.infer<typeof RunLinearIssue>;

export const RunLinearComment = z.object({
  /** Markdown. */
  body: z.string(),
  author: z.string().optional(),
  createdAt: z.string().optional(),
});
export type RunLinearComment = z.infer<typeof RunLinearComment>;

export const RunLinearDocument = z.object({
  id: z.string(),
  title: z.string(),
  /** Markdown. */
  content: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  project: z.string().optional(),
  /** The identifier of the issue the document belongs to. */
  issue: z.string().optional(),
});
export type RunLinearDocument = z.infer<typeof RunLinearDocument>;

/** `GET …/linear/issues/{issueId}` */
export const RunLinearIssueResponse = z.object({ issue: RunLinearIssue });
/** `GET …/linear/issues/{issueId}/comments`: oldest first, the most recent `MAX_LINEAR_COMMENTS`. */
export const RunLinearCommentsResponse = z.object({
  comments: z.array(RunLinearComment),
  /** Older comments left out. */
  omitted: z.int().min(0),
});
/** `GET …/linear/issues?query=…&first=…` */
export const RunLinearSearchResponse = z.object({ issues: z.array(RunLinearIssue) });
/** `GET …/linear/documents/{documentId}` */
export const RunLinearDocumentResponse = z.object({ document: RunLinearDocument });
