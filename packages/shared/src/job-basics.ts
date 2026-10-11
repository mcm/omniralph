/** Job schemas `protocol.ts` and `run-spec.ts` both build on (kept apart so they don't import each other). */
import { z } from "zod";
import { JobTokenKind } from "./harness-protocol.js";

/** A freshly signed job token (`HARNESS_TOKEN_TTL_SECONDS`). */
export const JobToken = z.object({
  jobId: z.uuid(),
  token: z.string(),
  /** Seconds until `token` expires. */
  expiresIn: z.number(),
  /** `lifecycle`/`session` for run-spec jobs; `legacy` for a legacy job's single token. */
  kind: JobTokenKind.default("legacy"),
});
export type JobToken = z.infer<typeof JobToken>;

/** Where a job's repository lives; part of the payload of every job that needs a checkout. */
export const JobRepository = z.object({
  provider: z.enum(["github", "gitlab"]),
  /** `owner/repo` or `group/subgroup/project`. */
  fullPath: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)+$/)
    .refine((p) => p.split("/").every((segment) => segment !== "." && segment !== ".."), {
      message: "invalid path segment",
    }),
  /** HTTPS clone URL without credentials (the agent's `git-credential` helper supplies them). */
  cloneUrl: z.url(),
});
export type JobRepository = z.infer<typeof JobRepository>;
