/**
 * Files uploaded to Linear for a run (cyralph's `gatherAttachments`): the
 * control panel finds the `uploads.linear.app` URLs in the epic, its stories,
 * their comments and the thread, remembers them on the run by attachment ID
 * and lists them in job payloads. Agents download them by ID through
 * `GET /api/agent/jobs/{id}/attachments/{attachmentId}` and never see the
 * Linear token.
 */
import { createHash } from "node:crypto";
import {
  listPendingRequests,
  updateRun,
  type RalphAttachmentLink,
  type RalphRun,
  type RalphTransaction,
} from "@omniralph/db";
import {
  attachmentsForStory,
  gatherAttachments,
  type AttachmentSource,
  type Epic,
  type GatheredAttachment,
} from "@omniralph/ralph";
import type { RalphAttachment } from "@omniralph/shared";
import type { LinearGateway } from "@omniralph/tracker/linear";
import type { IssueComment } from "@omniralph/tracker";

/** Attachments listed in one payload at most. */
const MAX_ATTACHMENTS_PER_PAYLOAD = 200;

/** A run's attachment, with its ID. */
export interface RunAttachment extends GatheredAttachment {
  id: string;
}

/** The attachment ID of an (unsigned) upload URL: stable across runs, so agents cache by it. */
export function attachmentId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

/** The label of a comment as a source, e.g. `comment on ENG-1 by Ana`. */
function commentLabel(identifier: string, comment: IssueComment): string {
  return `comment on ${identifier}${comment.author ? ` by ${comment.author}` : ""}`;
}

/**
 * The uploads referenced by the epic's description and comments, every
 * story's description, open stories' comments, and the thread (guidance and
 * pending requests, as "Linear thread"), each shared or scoped to one story.
 * New ones are recorded on the run (`ralph_runs.attachments`), which the
 * download endpoint resolves IDs with. Comments that can't be read are
 * skipped (logged).
 */
export async function gatherRunAttachments(
  linear: LinearGateway,
  tx: RalphTransaction,
  run: RalphRun,
  epic: Epic,
): Promise<RunAttachment[]> {
  const comments = async (issueId: string) =>
    linear.getComments(issueId).catch((error: unknown) => {
      console.warn(`Reading the comments of ${issueId} for attachments failed`, error);
      return [] as IssueComment[];
    });
  const sources: AttachmentSource[] = [
    { label: `${epic.identifier} description`, text: epic.description },
  ];
  for (const c of await comments(epic.issueId)) {
    sources.push({ label: commentLabel(epic.identifier, c), text: c.body });
  }
  for (const s of epic.stories) {
    if (!s.issueId || s.issueId === epic.issueId) continue;
    sources.push({ label: s.storyId, text: s.sourceText ?? s.description, storyKey: s.key });
    if (s.status === "completed" || s.status === "cancelled") continue;
    for (const c of await comments(s.issueId)) {
      sources.push({ label: commentLabel(s.storyId, c), text: c.body, storyKey: s.key });
    }
  }
  const thread = [
    ...run.guidance.map((g) => g.text),
    ...(await listPendingRequests(tx, run.id)).map((m) => m.text),
  ];
  for (const text of thread) sources.push({ label: "Linear thread", text });

  const found = gatherAttachments(sources).map((a) => ({ ...a, id: attachmentId(a.url) }));
  const known = run.attachments ?? {};
  const added = found.filter((a) => known[a.id]?.url !== a.url);
  if (added.length > 0) {
    const links: Record<string, RalphAttachmentLink> = { ...known };
    for (const a of added) links[a.id] = { url: a.url, title: a.title ?? null };
    await updateRun(tx, run.id, { attachments: links });
  }
  return found;
}

/** Attachments as a payload lists them; with `storyKey`, only those in that story's scope. */
export function payloadAttachments(
  attachments: readonly RunAttachment[],
  storyKey?: string,
): RalphAttachment[] {
  const inScope = storyKey === undefined ? attachments : attachmentsForStory(attachments, storyKey);
  return inScope.slice(0, MAX_ATTACHMENTS_PER_PAYLOAD).map((a) => ({
    id: a.id,
    title: a.title?.slice(0, 500) || null,
    sources: a.sources.slice(0, 50).map((s) => s.slice(0, 500)),
  }));
}
