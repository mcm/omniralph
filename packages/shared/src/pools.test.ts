import { describe, expect, it } from "vitest";
import { POOLS, poolForTaskType } from "./pools.js";
import { JOB_TASK_TYPES } from "./protocol.js";

describe("poolForTaskType", () => {
  it("derives a job's pool from its task type", () => {
    expect(POOLS).toEqual(["short", "long"]);
    expect(poolForTaskType("coding")).toBe("long");
    expect(poolForTaskType("query")).toBe("short");
    expect(poolForTaskType("review")).toBe("short");
    expect(poolForTaskType("system")).toBeNull();
  });

  it("gives every task type but system one of the pools", () => {
    for (const taskType of JOB_TASK_TYPES) {
      const pool = poolForTaskType(taskType);
      expect(pool === null).toBe(taskType === "system");
      if (pool !== null) expect(POOLS).toContain(pool);
    }
  });
});
