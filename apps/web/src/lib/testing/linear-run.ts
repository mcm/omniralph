import { isTrackerRun, type TrackerRun } from "@omniralph/db";

/** A run a test expects to have come from Linear, with its issue and session; throws otherwise. */
export function linearRun<T extends Parameters<typeof isTrackerRun>[0]>(run: T): TrackerRun<T> {
  if (!isTrackerRun(run)) throw new Error("Expected a run from Linear");
  return run;
}
