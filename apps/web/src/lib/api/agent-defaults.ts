import { z } from "zod";
import { versionPolicySchema } from "./agents";
import { isoDate } from "./schemas";

/** The organization's agent defaults (`/api/ui/agent-defaults`, admins); Fleet edits the version policy. */

/** `GET /api/ui/agent-defaults`: the Defaults tab. */
export const agentDefaultsSchema = z.object({
  /** A version, `latest` or null. */
  desiredVersion: z.string().nullable(),
  /** When the desired version last changed. */
  updatedAt: isoDate.nullable(),
  /** Tracking `latest`: the version last read from npm, or why reading failed. */
  latest: z
    .object({
      version: z.string().nullable(),
      error: z.string().nullable(),
      checkedAt: isoDate.nullable(),
    })
    .nullable(),
  packageName: z.string(),
});
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

/**
 * `PUT /api/ui/agent-defaults`: the version policy's save, `version` (a version, `latest`, or
 * blank to not manage versions). Strict: slots and task types are each agent's own (its
 * `settings.json`, reported read-only), so sending `maxConcurrency`, `defaults` or task
 * types is a 400.
 */
export const agentDefaultsSaveSchema = z.strictObject({
  version: z.string().max(200).optional(),
});
export type AgentDefaultsSave = z.infer<typeof agentDefaultsSaveSchema>;

/**
 * The answer to `PUT /api/ui/agent-defaults`: with a version sent, the version policy it set
 * (Fleet's Version policy cell writes it into its cache).
 */
export const agentDefaultsSavedSchema = z.object({
  ok: z.literal(true),
  versionPolicy: versionPolicySchema.optional(),
});
export type AgentDefaultsSaved = z.infer<typeof agentDefaultsSavedSchema>;
