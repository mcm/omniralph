import type * as Tasks from "@omniralph/tasks";

/**
 * `@omniralph/tasks` with `builtin:triage` as a single session (its loop names no critic): for
 * tests of what happens around one triage job (replies, labels, trackers), which a triage
 * playbook without a critic still runs. Mock the package with it:
 * `vi.mock("@omniralph/tasks", async (importOriginal) => singleSessionTasks(await importOriginal()))`.
 */
export function singleSessionTasks(actual: typeof Tasks): typeof Tasks {
  const { loop: _loop, ...triage } = actual.getBuiltinPlaybook("builtin:triage")!;
  const getBuiltinPlaybook = (id: string) =>
    id === triage.id ? triage : actual.getBuiltinPlaybook(id);
  const getBuiltinRunSpec = (id: string) => {
    const playbook = getBuiltinPlaybook(id);
    return playbook && actual.playbookRunSpec(playbook);
  };
  return {
    ...actual,
    getBuiltinPlaybook,
    getBuiltinRunSpec,
    getBuiltinTask: (id: string) => getBuiltinRunSpec(id)?.task ?? null,
  };
}
