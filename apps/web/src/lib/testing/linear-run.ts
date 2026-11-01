import { isLinearRun, type LinearRun } from "@omniralph/db";

/** A run a test expects to have come from Linear, with its issue and session; throws otherwise. */
export function linearRun<T extends Parameters<typeof isLinearRun>[0]>(run: T): LinearRun<T> {
  if (!isLinearRun(run)) throw new Error("Expected a run from Linear");
  return run;
}
