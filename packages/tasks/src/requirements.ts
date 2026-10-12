import { z } from "zod";

/**
 * What a run of a task needs from the harness that claims it, derived from
 * the definition when it's saved and stored with it: the installables it
 * uses, the host tools it shells out to and the lowest harness version that
 * provides everything it uses (null for any).
 */
export const TaskRequirements = z.object({
  minHarnessVersion: z.string().min(1).nullable().default(null),
  installables: z.array(z.string().min(1)).default([]),
  hostTools: z.array(z.string().min(1)).default([]),
});
export type TaskRequirements = z.infer<typeof TaskRequirements>;
export type TaskRequirementsInput = z.input<typeof TaskRequirements>;
