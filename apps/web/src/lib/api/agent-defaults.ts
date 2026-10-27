import { z } from "zod";
import { versionPolicySchema } from "./agents";
import { isoDate } from "./schemas";

/** The organization's agent defaults (`/api/ui/agent-defaults`, `/api/ui/host-tools/**`, admins); Fleet edits the version policy. */

/** An organization's max concurrency, saved or built in. */
export const organizationDefaultsSchema = z.object({
  maxConcurrency: z.number(),
});
export type OrganizationDefaults = z.infer<typeof organizationDefaultsSchema>;

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
  /** The organization's defaults (the built-in ones when not saved). */
  defaults: organizationDefaultsSchema,
  /** The defaults when the organization hasn't saved any. */
  builtInDefaults: organizationDefaultsSchema,
});
export type AgentDefaults = z.infer<typeof agentDefaultsSchema>;

/**
 * `PUT /api/ui/agent-defaults`: the Defaults tab's save, in one request. `defaults`
 * (`{ maxConcurrency }`, its range checked in `setOrganizationDefaults`), then `version` (a
 * version, `latest`, or blank to not manage versions); each only when changed. Strict: task
 * types are the agent's own (its local `acceptedTaskTypes`), so sending any is a 400.
 */
export const agentDefaultsSaveSchema = z.strictObject({
  defaults: z.strictObject({ maxConcurrency: z.unknown() }).optional(),
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

/** A host tool of the organization's catalog. */
export const hostToolCatalogRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
export type HostToolCatalogRow = z.infer<typeof hostToolCatalogRowSchema>;

/** `GET /api/ui/host-tools`: the catalog, by name. */
export const hostToolCatalogSchema = z.object({ hostTools: z.array(hostToolCatalogRowSchema) });

/** `POST /api/ui/host-tools`. */
export const addHostToolSchema = z.object({
  name: z.string().max(200),
  description: z.string().max(10_000).optional(),
});
export type AddHostToolInput = z.infer<typeof addHostToolSchema>;

/** The answer to `POST /api/ui/host-tools`. */
export const addedHostToolSchema = z.object({ ok: z.literal(true), hostToolId: z.string() });
