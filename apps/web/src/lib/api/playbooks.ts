import { Playbook, PlaybookRoleSchema, TaskRequirements } from "@omniralph/tasks";
import { z } from "zod";
import type { PlaybookReferrers } from "@/lib/playbooks/referrers";

/**
 * Playbooks (`/api/ui/playbooks/**`). IDs are `builtin:<name>` or UUIDs; paths carry them
 * URI-encoded (`playbookPath`).
 */

/** The API path of a playbook (`builtin:` IDs have a colon). */
export function playbookPath(id: string, ...rest: string[]): string {
  return [`/api/ui/playbooks/${encodeURIComponent(id)}`, ...rest].join("/");
}

/** The route segment as an ID (links encode the colon of `builtin:` IDs); malformed escapes match nothing. */
export function decodeId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** What uses a playbook: repo bindings, chat settings and coding playbooks naming it. */
export const playbookUsedBySchema = z.object({
  repositories: z.array(
    z.object({
      id: z.string(),
      fullPath: z.string(),
      provider: z.enum(["github", "gitlab"]),
      roles: z.array(z.enum(["review", "correlation", "story", "request"])),
    }),
  ),
  chatPlaybooks: z.array(z.enum(["ask", "startWork"])),
  chatChannels: z.array(
    z.object({
      connectionId: z.string(),
      connectionName: z.string(),
      channelId: z.string(),
      roles: z.array(z.enum(["ask", "startWork"])),
    }),
  ),
  /** Story and request playbooks with it as their PR description playbook. */
  playbooks: z.array(z.object({ id: z.string(), name: z.string(), builtin: z.boolean() })),
}) satisfies z.ZodType<PlaybookReferrers>;
export type PlaybookUsedBy = z.infer<typeof playbookUsedBySchema>;

/** One row of the playbooks list. */
export const playbookSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  role: PlaybookRoleSchema,
  /** Defined in code: it can be cloned, not edited or deleted. */
  builtin: z.boolean(),
  /** Null for the Claude Code default (and for review roles, whose depth sets it). */
  model: z.string().nullable(),
  usedBy: playbookUsedBySchema,
});
export type PlaybookSummary = z.infer<typeof playbookSummarySchema>;

/** `GET /api/ui/playbooks`: built-ins first, then the organization's own by name. */
export const playbookListSchema = z.object({ playbooks: z.array(playbookSummarySchema) });
export type PlaybookList = z.infer<typeof playbookListSchema>;

/** `GET /api/ui/playbooks/{id}`: the playbook, what its runs need and what uses it. */
export const playbookDetailSchema = z.object({
  playbook: Playbook,
  builtin: z.boolean(),
  /**
   * The token budget in words: `No limit` for a null budget, else the cap (review roles:
   * `Set by the review depth`).
   */
  tokenBudgetLabel: z.string(),
  requirements: TaskRequirements,
  usedBy: playbookUsedBySchema,
});
export type PlaybookDetail = z.infer<typeof playbookDetailSchema>;

/** A created or cloned playbook, to navigate to. */
export const savedPlaybookSchema = z.object({ ok: z.literal(true), id: z.string() });
export type SavedPlaybook = z.infer<typeof savedPlaybookSchema>;
