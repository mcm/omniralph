import { describe, expect, it } from "vitest";

import { dependencyViolations, workItemKind, workItemRole } from "./model.js";
import type { PlannedItem } from "./model.js";

describe("workItemKind", () => {
  it("is a fix when a label matches the default fix label, ignoring case", () => {
    expect(workItemKind(["Frontend", "bug"])).toBe("fix");
    expect(workItemKind([" BUG "])).toBe("fix");
  });

  it("is a story without the default fix label", () => {
    expect(workItemKind(["Frontend", "Bugfix"])).toBe("story");
    expect(workItemKind([])).toBe("story");
  });

  it("uses custom fix labels instead of the default", () => {
    expect(workItemKind(["defect"], ["Defect", "Regression"])).toBe("fix");
    expect(workItemKind(["REGRESSION"], ["Defect", "Regression"])).toBe("fix");
    expect(workItemKind(["Bug"], ["Defect"])).toBe("story");
  });

  it("is a story when no fix labels are configured", () => {
    expect(workItemKind(["Bug"], [])).toBe("story");
    expect(workItemKind([""], ["  "])).toBe("story");
  });
});

describe("workItemRole", () => {
  const epic = { id: "e", parentId: undefined };

  it("is a standalone task without sub-issues or a parent", () => {
    expect(workItemRole({ id: "t" }, [], [])).toEqual({ role: "task", standalone: true });
  });

  it("is a task in an epic without sub-issues but with a parent", () => {
    expect(workItemRole({ id: "t", parentId: "e" }, [], [])).toEqual({
      role: "task",
      standalone: false,
    });
  });

  it("is an epic when none of its sub-issues have sub-issues", () => {
    const children = [
      { id: "a", parentId: "e" },
      { id: "b", parentId: "e" },
    ];
    expect(workItemRole(epic, children, [])).toEqual({ role: "epic" });
    // Grandchildren of some other item don't count.
    expect(workItemRole(epic, children, [{ parentId: "x" }, {}])).toEqual({ role: "epic" });
  });

  it("is a feature when any sub-issue has sub-issues", () => {
    const children = [
      { id: "a", parentId: "f" },
      { id: "b", parentId: "f" },
    ];
    expect(workItemRole({ id: "f" }, children, [{ parentId: "b" }])).toEqual({ role: "feature" });
  });

  it("ignores the item listed among its own sub-issues", () => {
    expect(workItemRole({ id: "t" }, [{ id: "t" }], [{ parentId: "t" }])).toEqual({
      role: "task",
      standalone: true,
    });
  });
});

describe("dependencyViolations", () => {
  const epicA: PlannedItem = { id: "ea", identifier: "ENG-1", role: "epic" };
  const epicB: PlannedItem = { id: "eb", identifier: "ENG-2", role: "epic" };
  const feature: PlannedItem = { id: "f", identifier: "ENG-3", role: "feature" };
  const ref = (item: PlannedItem) => ({ id: item.id, identifier: item.identifier });
  const taskA1: PlannedItem = { id: "a1", identifier: "ENG-11", role: "task", parent: ref(epicA) };
  const taskA2: PlannedItem = { id: "a2", identifier: "ENG-12", role: "task", parent: ref(epicA) };
  const taskB1: PlannedItem = { id: "b1", identifier: "ENG-21", role: "task", parent: ref(epicB) };
  const standalone: PlannedItem = { id: "s", identifier: "ENG-30", role: "task" };
  const standalone2: PlannedItem = { id: "s2", identifier: "ENG-31", role: "task" };

  describe("a task in an epic", () => {
    it("may be blocked by another epic, a standalone task or a task in its own epic", () => {
      expect(dependencyViolations(taskA1, [epicB, standalone, taskA2])).toEqual([]);
    });

    it("may not be blocked by a task in another epic: block on that epic instead", () => {
      expect(dependencyViolations(taskA1, [taskB1])).toEqual([
        {
          blocker: { id: "b1", identifier: "ENG-21" },
          blocked: { id: "a1", identifier: "ENG-11" },
          reason: "task-in-other-epic",
          blockOn: { id: "eb", identifier: "ENG-2" },
          fix: "Block ENG-11 on ENG-2 instead.",
          message:
            "ENG-11 is blocked by ENG-21: ENG-21 is a task in another epic, ENG-2. Block ENG-11 on ENG-2 instead.",
        },
      ]);
    });

    it("may not be blocked by a feature", () => {
      const [violation] = dependencyViolations(taskA1, [feature]);
      expect(violation).toMatchObject({
        blocker: { identifier: "ENG-3" },
        blocked: { identifier: "ENG-11" },
        reason: "feature",
      });
      expect(violation?.blockOn).toBeUndefined();
      expect(violation?.message).toContain("ENG-3 is a feature");
    });

    it("may not be blocked by its own epic", () => {
      expect(dependencyViolations(taskA1, [epicA])).toEqual([
        expect.objectContaining({ reason: "own-epic", fix: "Remove the relation." }),
      ]);
    });
  });

  describe("an epic", () => {
    it("may be blocked by another epic or a standalone task", () => {
      expect(dependencyViolations(epicA, [epicB, standalone])).toEqual([]);
    });

    it("may not be blocked by a task in another epic: block on that epic instead", () => {
      expect(dependencyViolations(epicA, [taskB1])).toEqual([
        expect.objectContaining({
          blocker: { id: "b1", identifier: "ENG-21" },
          blocked: { id: "ea", identifier: "ENG-1" },
          reason: "task-in-other-epic",
          blockOn: { id: "eb", identifier: "ENG-2" },
          fix: "Block ENG-1 on ENG-2 instead.",
        }),
      ]);
    });

    it("may not be blocked by one of its own tasks", () => {
      expect(dependencyViolations(epicA, [taskA1])).toEqual([
        expect.objectContaining({
          blocker: { id: "a1", identifier: "ENG-11" },
          reason: "own-task",
          fix: "Remove the relation.",
        }),
      ]);
    });

    it("may not be blocked by a feature", () => {
      expect(dependencyViolations(epicA, [feature])).toEqual([
        expect.objectContaining({ reason: "feature" }),
      ]);
    });
  });

  describe("a standalone task, an epic of one", () => {
    it("may be blocked by an epic or another standalone task", () => {
      expect(dependencyViolations(standalone, [epicA, standalone2])).toEqual([]);
    });

    it("may not be blocked by a task in an epic: block on that epic instead", () => {
      expect(dependencyViolations(standalone, [taskA1])).toEqual([
        expect.objectContaining({
          blocked: { id: "s", identifier: "ENG-30" },
          reason: "task-in-other-epic",
          blockOn: { id: "ea", identifier: "ENG-1" },
          fix: "Block ENG-30 on ENG-1 instead.",
        }),
      ]);
    });

    it("may not be blocked by a feature", () => {
      expect(dependencyViolations(standalone, [feature])).toEqual([
        expect.objectContaining({ reason: "feature" }),
      ]);
    });
  });

  it("returns every bad relation, in the blockers' order, and skips the good ones", () => {
    const violations = dependencyViolations(taskA1, [taskB1, epicB, feature, taskA2]);
    expect(violations.map((v) => [v.blocker.identifier, v.reason])).toEqual([
      ["ENG-21", "task-in-other-epic"],
      ["ENG-3", "feature"],
    ]);
  });

  it("checks nothing on a feature, which isn't run", () => {
    expect(dependencyViolations(feature, [taskA1, feature])).toEqual([]);
  });

  it("ignores a relation of an item to itself", () => {
    expect(dependencyViolations(epicA, [epicA])).toEqual([]);
  });
});
