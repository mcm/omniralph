import { describe, expect, it, vi } from "vitest";
import { ApiRouteError } from "@/lib/api/handler";
import type { ResolvedWorkItem } from "./item";
import { setWorkItemTask } from "./tasks";
import { WorkItemConflictError, type WorkItem, type WorkItemTracker } from "./tracker";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({}));

function workItem(description: string, updatedAt: string): WorkItem {
  return { id: "issue-1", identifier: "SOC-7", description, updatedAt } as WorkItem;
}

/**
 * A tracker holding one issue: `update` writes only when `ifUpdatedAt` is current (else a
 * conflict), and each write moves `updatedAt` on. `edits` are someone else's writes that
 * land just before each of ours.
 */
function fakeTracker(initial: WorkItem, edits: ((description: string) => string)[] = []) {
  let current = initial;
  let version = 1;
  const writes: string[] = [];
  const tracker = {
    get: vi.fn(async () => current),
    update: vi.fn(
      async (_ref: string, input: { description?: string }, options?: { ifUpdatedAt?: string }) => {
        const edit = edits.shift();
        if (edit) current = workItem(edit(current.description), `v${(version += 1)}`);
        if (options?.ifUpdatedAt !== current.updatedAt) {
          throw new WorkItemConflictError(current.id, current.updatedAt);
        }
        writes.push(input.description!);
        current = workItem(input.description!, `v${(version += 1)}`);
      },
    ),
  };
  const resolved = {
    tracker: tracker as unknown as WorkItemTracker,
    item: initial,
  } as ResolvedWorkItem;
  return { resolved, tracker, writes, current: () => current };
}

describe("setWorkItemTask", () => {
  it("checks the task in the tracker's description and answers what was saved", async () => {
    const { resolved, writes } = fakeTracker(workItem("- [ ] a\n- [ ] b", "v1"));
    const result = await setWorkItemTask(resolved, { index: 1, text: "b", checked: true });
    expect(writes).toEqual(["- [ ] a\n- [x] b"]);
    expect(result).toEqual({ description: "- [ ] a\n- [x] b", updatedAt: "v2" });
  });

  it("finds the task by its text when the description changed above it", async () => {
    // The client read "- [ ] a\n- [ ] b"; a new task was added at the top since.
    const { resolved, writes } = fakeTracker(workItem("- [ ] new\n- [ ] a\n- [ ] b", "v1"));
    await setWorkItemTask(resolved, { index: 1, text: "b", checked: true });
    expect(writes).toEqual(["- [ ] new\n- [ ] a\n- [x] b"]);
  });

  it("writes nothing when the task already has that state", async () => {
    const { resolved, tracker } = fakeTracker(workItem("- [x] a", "v1"));
    const result = await setWorkItemTask(resolved, { index: 0, text: "a", checked: true });
    expect(tracker.update).not.toHaveBeenCalled();
    expect(result).toEqual({ description: "- [x] a", updatedAt: "v1" });
  });

  it("answers 409 when the task is gone, writing nothing", async () => {
    const { resolved, tracker } = fakeTracker(workItem("- [ ] other", "v1"));
    const error = await setWorkItemTask(resolved, { index: 0, text: "a", checked: true }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiRouteError);
    expect((error as ApiRouteError).status).toBe(409);
    expect(tracker.update).not.toHaveBeenCalled();
  });

  it("keeps an edit that landed meanwhile: reads again and toggles in the new description", async () => {
    const { resolved, writes, current } = fakeTracker(workItem("- [ ] a\n- [ ] b", "v1"), [
      (description) => `${description}\n- [ ] c`,
    ]);
    await setWorkItemTask(resolved, { index: 0, text: "a", checked: true });
    expect(writes).toEqual(["- [x] a\n- [ ] b\n- [ ] c"]);
    expect(current().description).toBe("- [x] a\n- [ ] b\n- [ ] c");
  });

  it("gives up with a 409 when the item changes again on the second try", async () => {
    const { resolved, writes } = fakeTracker(workItem("- [ ] a", "v1"), [
      (description) => `${description}\nmore`,
      (description) => `${description}\neven more`,
    ]);
    const error = await setWorkItemTask(resolved, { index: 0, text: "a", checked: true }).catch(
      (e: unknown) => e,
    );
    expect((error as ApiRouteError).status).toBe(409);
    expect(writes).toEqual([]);
  });
});
