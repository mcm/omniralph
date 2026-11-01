/**
 * The read-only tracker tools of a run (`tracker_get_issue`,
 * `tracker_list_comments`, `tracker_search_issues`, `tracker_get_document`):
 * served by the control panel under `/api/agent/runs/{id}/tracker/*` with
 * the run's organization's connected tracker, so the agent never holds a
 * tracker token. Requests carry the run's session token (`tracker:read`).
 * `tracker_get_document` is offered only when the tracker has documents.
 */
import { z } from "zod";

/**
 * The issue trackers a job can name (`trackerProvider` of ralph and triage
 * jobs); the same values as `@omniralph/tracker`'s `TrackerProvider`.
 */
export const JOB_TRACKER_PROVIDERS = ["linear"] as const;
export const JobTrackerProvider = z.enum(JOB_TRACKER_PROVIDERS);
export type JobTrackerProvider = z.infer<typeof JobTrackerProvider>;

/** An issue ID or identifier (`ENG-123`), or a document ID or slug ID. */
export const TrackerEntityId = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);

export const MAX_TRACKER_SEARCH_QUERY = 500;
export const DEFAULT_TRACKER_SEARCH_RESULTS = 10;
export const MAX_TRACKER_SEARCH_RESULTS = 25;
/** `tracker_list_comments` returns at most this many comments: the most recent ones. */
export const MAX_TRACKER_COMMENTS = 100;

export const TrackerSearchQuery = z.object({
  query: z.string().trim().min(1).max(MAX_TRACKER_SEARCH_QUERY),
  first: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TRACKER_SEARCH_RESULTS)
    .default(DEFAULT_TRACKER_SEARCH_RESULTS),
});
export type TrackerSearchQuery = z.infer<typeof TrackerSearchQuery>;

/** A work item as the tracker tools show it to a session. */
export const RunTrackerIssue = z.object({
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
export type RunTrackerIssue = z.infer<typeof RunTrackerIssue>;

export const RunTrackerComment = z.object({
  /** Markdown. */
  body: z.string(),
  author: z.string().optional(),
  createdAt: z.string().optional(),
});
export type RunTrackerComment = z.infer<typeof RunTrackerComment>;

export const RunTrackerDocument = z.object({
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
export type RunTrackerDocument = z.infer<typeof RunTrackerDocument>;

/** `GET …/tracker/issues/{issueId}` */
export const RunTrackerIssueResponse = z.object({ issue: RunTrackerIssue });
/** `GET …/tracker/issues/{issueId}/comments`: oldest first, the most recent `MAX_TRACKER_COMMENTS`. */
export const RunTrackerCommentsResponse = z.object({
  comments: z.array(RunTrackerComment),
  /** Older comments left out. */
  omitted: z.int().min(0),
});
/** `GET …/tracker/issues?query=…&first=…` */
export const RunTrackerSearchResponse = z.object({ issues: z.array(RunTrackerIssue) });
/** `GET …/tracker/documents/{documentId}` */
export const RunTrackerDocumentResponse = z.object({ document: RunTrackerDocument });
