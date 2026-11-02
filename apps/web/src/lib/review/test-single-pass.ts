import type * as Tasks from "@omniralph/tasks";

/**
 * `@omniralph/tasks` with `builtin:review-pr` as a single-pass review task
 * (its loop names no verifier), plus `extra` built-ins built from it: for
 * tests of single-pass reviews, which a review playbook without a finding
 * verifier still runs. Mock the package with it:
 * `vi.mock("@omniralph/tasks", async (importOriginal) => singlePassTasks(await importOriginal()))`.
 */
export function singlePassTasks(
  actual: typeof Tasks,
  extra: (reviewPr: Tasks.Playbook) => Tasks.Playbook[] = () => [],
): typeof Tasks {
  const { loop: _loop, ...reviewPr } = actual.getBuiltinPlaybook("builtin:review-pr")!;
  const injected = new Map(
    [reviewPr, ...extra(reviewPr)].map((playbook) => [playbook.id, playbook] as const),
  );
  const getBuiltinPlaybook = (id: string) => injected.get(id) ?? actual.getBuiltinPlaybook(id);
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
