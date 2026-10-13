// Organization defaults for allowed task types and harness max concurrency.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_TASK_TYPES_KEY,
  DEFAULT_MAX_CONCURRENCY_KEY,
  getAllowedTaskTypeDefaults,
  getAppSetting,
  getDefaultMaxConcurrency,
  setAllowedTaskTypeDefaults,
  setAppSetting,
  setDefaultMaxConcurrency,
} from "./app-settings.js";
import { closeDb, createDb, type Database } from "./client.js";
import { runMigrations } from "./migrate.js";
import { appSettings, organizations } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("organization task-type and concurrency defaults", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgA: string;
  let orgB: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await container?.stop();
  });

  beforeEach(async () => {
    await db.delete(appSettings);
  });

  it("allows every task type and a max concurrency of 5 when unset", async () => {
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual(["query", "review", "coding"]);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(5);
  });

  it("returns stored values, task types in canonical order without duplicates", async () => {
    await setAllowedTaskTypeDefaults(db, orgA, ["coding", "query", "coding"], null);
    await setDefaultMaxConcurrency(db, orgA, 12, null);
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual(["query", "coding"]);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(12);
    expect((await getAppSetting(db, orgA, ALLOWED_TASK_TYPES_KEY))?.updatedBy).toBe(null);

    await setAllowedTaskTypeDefaults(db, orgA, [], null);
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual([]);
  });

  it("accepts the concurrency bounds", async () => {
    await setDefaultMaxConcurrency(db, orgA, 1, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(1);
    await setDefaultMaxConcurrency(db, orgA, 32, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(32);
  });

  it("deletes the stored value on null, so the built-in default is back", async () => {
    await setAllowedTaskTypeDefaults(db, orgA, ["review"], null);
    await setDefaultMaxConcurrency(db, orgA, 2, null);
    await setAllowedTaskTypeDefaults(db, orgA, null, null);
    await setDefaultMaxConcurrency(db, orgA, null, null);
    expect(await getAppSetting(db, orgA, ALLOWED_TASK_TYPES_KEY)).toBeNull();
    expect(await getAppSetting(db, orgA, DEFAULT_MAX_CONCURRENCY_KEY)).toBeNull();
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual(["query", "review", "coding"]);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(5);
  });

  it("rejects unknown task types and out-of-range concurrency without storing them", async () => {
    await setAllowedTaskTypeDefaults(db, orgA, ["review"], null);
    await setDefaultMaxConcurrency(db, orgA, 3, null);
    await expect(setAllowedTaskTypeDefaults(db, orgA, ["query", "ralph"], null)).rejects.toThrow(
      /ralph/,
    );
    await expect(setAllowedTaskTypeDefaults(db, orgA, ["system"], null)).rejects.toThrow();
    for (const bad of [0, 33, -1, 2.5, Number.NaN]) {
      await expect(setDefaultMaxConcurrency(db, orgA, bad, null)).rejects.toThrow();
    }
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual(["review"]);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(3);
  });

  it("falls back to the built-in defaults when a stored value is malformed", async () => {
    await setAppSetting(db, orgA, ALLOWED_TASK_TYPES_KEY, ["query", "bogus"], null);
    await setAppSetting(db, orgA, DEFAULT_MAX_CONCURRENCY_KEY, 99, null);
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual(["query", "review", "coding"]);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(5);
  });

  it("keeps each organization's defaults to itself", async () => {
    await setAllowedTaskTypeDefaults(db, orgA, ["query"], null);
    await setDefaultMaxConcurrency(db, orgA, 8, null);
    expect(await getAllowedTaskTypeDefaults(db, orgB)).toEqual(["query", "review", "coding"]);
    expect(await getDefaultMaxConcurrency(db, orgB)).toBe(5);

    await setDefaultMaxConcurrency(db, orgB, 2, null);
    await setAllowedTaskTypeDefaults(db, orgB, null, null);
    expect(await getDefaultMaxConcurrency(db, orgA)).toBe(8);
    expect(await getAllowedTaskTypeDefaults(db, orgA)).toEqual(["query"]);
  });
});
