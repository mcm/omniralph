// Host tool catalogs and harness paths are scoped to organizations.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { getContainerRuntimeClient } from "testcontainers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import {
  createHostTool,
  deleteHostTool,
  effectiveHostToolPath,
  listHarnessHostTools,
  listHarnessesUsableHostTools,
  listHostTools,
  recordHarnessHostTools,
  setHarnessHostToolPath,
} from "./host-tools.js";
import { runMigrations } from "./migrate.js";
import { harnessHostTools, harnesses, organizations } from "./schema.js";

describe("effectiveHostToolPath", () => {
  const row = (
    configuredPath: string | null,
    configuredPathExists: boolean | null,
    discoveredPath: string | null,
  ) => ({ configuredPath, configuredPathExists, discoveredPath });

  it("uses a configured path the harness found usable", () => {
    expect(effectiveHostToolPath(row("/opt/x/bin/x", true, "/usr/bin/x"))).toBe("/opt/x/bin/x");
  });

  it("never falls back to the discovered path when the configured one isn't usable or not reported yet", () => {
    expect(effectiveHostToolPath(row("/opt/x/bin/x", false, "/usr/bin/x"))).toBeNull();
    expect(effectiveHostToolPath(row("/opt/x/bin/x", null, "/usr/bin/x"))).toBeNull();
  });

  it("uses the discovered path when none is configured, else none", () => {
    expect(effectiveHostToolPath(row(null, null, "/usr/bin/x"))).toBe("/usr/bin/x");
    expect(effectiveHostToolPath(row(null, null, null))).toBeNull();
  });
});

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("host tools", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;
  let orgA: string;
  let orgB: string;

  const harness = async (organizationId: string, name = "h") => {
    const [row] = await db.insert(harnesses).values({ organizationId, name }).returning();
    return row!.id;
  };

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

  it("creates, lists and deletes catalog entries per organization", async () => {
    const created = await createHostTool(db, orgA, { name: "opengrep", description: "SAST" });
    expect(created).toMatchObject({
      ok: true,
      hostTool: { organizationId: orgA, name: "opengrep", description: "SAST" },
    });
    expect(await createHostTool(db, orgA, { name: "opengrep" })).toEqual({
      ok: false,
      error: "duplicate_name",
    });
    // The same name in another organization is another tool.
    expect((await createHostTool(db, orgB, { name: "opengrep" })).ok).toBe(true);
    for (const name of ["", "Opengrep", "-x", "a/b", "a".repeat(65)]) {
      expect(await createHostTool(db, orgA, { name })).toEqual({
        ok: false,
        error: "invalid_name",
      });
    }
    expect((await createHostTool(db, orgA, { name: "code-graph" })).ok).toBe(true);
    expect((await listHostTools(db, orgA)).map((tool) => tool.name)).toEqual([
      "code-graph",
      "opengrep",
    ]);

    const id = created.ok ? created.hostTool.id : "";
    expect(await deleteHostTool(db, orgB, id)).toBe(false);
    expect(await deleteHostTool(db, orgA, id)).toBe(true);
    expect(await deleteHostTool(db, orgA, id)).toBe(false);
    expect((await listHostTools(db, orgA)).map((tool) => tool.name)).toEqual(["code-graph"]);
    expect((await listHostTools(db, orgB)).map((tool) => tool.name)).toEqual(["opengrep"]);
  });

  it("sets and clears a harness's configured path within the organization", async () => {
    const h = await harness(orgA);
    const other = await harness(orgB);
    const tool = await createHostTool(db, orgA, { name: "semgrep" });
    const foreignTool = await createHostTool(db, orgB, { name: "semgrep" });
    if (!tool.ok || !foreignTool.ok) throw new Error("setup");
    const id = tool.hostTool.id;

    expect(await setHarnessHostToolPath(db, orgA, h, id, "bin/semgrep")).toEqual({
      ok: false,
      error: "invalid_path",
    });
    expect(await setHarnessHostToolPath(db, orgB, h, id, "/usr/bin/semgrep")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await setHarnessHostToolPath(db, orgA, other, id, "/usr/bin/semgrep")).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await setHarnessHostToolPath(db, orgA, h, foreignTool.hostTool.id, "/usr/bin/semgrep"),
    ).toEqual({ ok: false, error: "not_found" });
    expect(await db.select().from(harnessHostTools)).toEqual([]);

    expect(await setHarnessHostToolPath(db, orgA, h, id, "/opt/semgrep/bin/semgrep")).toEqual({
      ok: true,
    });
    await recordHarnessHostTools(db, orgA, h, [
      { name: "semgrep", configuredPathExists: true, discoveredPath: "/usr/bin/semgrep" },
    ]);
    expect(await listHarnessHostTools(db, orgA, h)).toContainEqual(
      expect.objectContaining({
        name: "semgrep",
        configuredPath: "/opt/semgrep/bin/semgrep",
        configuredPathExists: true,
        discoveredPath: "/usr/bin/semgrep",
        effectivePath: "/opt/semgrep/bin/semgrep",
      }),
    );

    // A new path drops the report on the old one until the harness checks it.
    expect(await setHarnessHostToolPath(db, orgA, h, id, "/opt/other/semgrep")).toEqual({
      ok: true,
    });
    expect(await listHarnessHostTools(db, orgA, h)).toContainEqual(
      expect.objectContaining({
        configuredPath: "/opt/other/semgrep",
        configuredPathExists: null,
        discoveredPath: "/usr/bin/semgrep",
        effectivePath: null,
      }),
    );

    expect(await setHarnessHostToolPath(db, orgA, h, id, null)).toEqual({ ok: true });
    expect(await listHarnessHostTools(db, orgA, h)).toContainEqual(
      expect.objectContaining({
        configuredPath: null,
        configuredPathExists: null,
        effectivePath: "/usr/bin/semgrep",
      }),
    );

    await db.update(harnesses).set({ revokedAt: new Date() }).where(eq(harnesses.id, h));
    expect(await setHarnessHostToolPath(db, orgA, h, id, "/usr/bin/semgrep")).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("lists every catalog tool for a harness, empty for another organization's harness", async () => {
    const [org] = await db.insert(organizations).values({ name: "List" }).returning();
    const h = await harness(org!.id);
    await createHostTool(db, org!.id, { name: "b-tool" });
    await createHostTool(db, org!.id, { name: "a-tool" });
    expect(await listHarnessHostTools(db, org!.id, h)).toEqual([
      expect.objectContaining({ name: "a-tool", configuredPath: null, reportedAt: null }),
      expect.objectContaining({ name: "b-tool", configuredPath: null, effectivePath: null }),
    ]);
    expect(await listHarnessHostTools(db, orgA, h)).toEqual([]);
    expect(await listHarnessHostTools(db, org!.id, await harness(orgA))).toEqual([]);
  });

  it("records heartbeat reports, ignoring unknown names and stale or meaningless checks", async () => {
    const [org] = await db.insert(organizations).values({ name: "Report" }).returning();
    const orgId = org!.id;
    const h = await harness(orgId);
    const configured = await createHostTool(db, orgId, { name: "configured" });
    await createHostTool(db, orgId, { name: "discovered" });
    if (!configured.ok) throw new Error("setup");
    await setHarnessHostToolPath(db, orgId, h, configured.hostTool.id, "/opt/c");
    const now = new Date("2026-10-12T12:00:00Z");

    await recordHarnessHostTools(
      db,
      orgId,
      h,
      [
        {
          name: "configured",
          configuredPath: "/opt/c",
          configuredPathExists: false,
          discoveredPath: "/usr/bin/configured",
        },
        // Nothing configured: a check is meaningless and stored as null.
        { name: "discovered", configuredPathExists: true, discoveredPath: "/usr/bin/discovered" },
        { name: "unknown", configuredPathExists: null, discoveredPath: "/usr/bin/unknown" },
      ],
      now,
    );
    expect(await listHarnessHostTools(db, orgId, h)).toEqual([
      expect.objectContaining({
        name: "configured",
        configuredPath: "/opt/c",
        configuredPathExists: false,
        discoveredPath: "/usr/bin/configured",
        reportedAt: now,
        effectivePath: null,
      }),
      expect.objectContaining({
        name: "discovered",
        configuredPath: null,
        configuredPathExists: null,
        discoveredPath: "/usr/bin/discovered",
        reportedAt: now,
        effectivePath: "/usr/bin/discovered",
      }),
    ]);
    expect(
      await db.select().from(harnessHostTools).where(eq(harnessHostTools.harnessId, h)),
    ).toHaveLength(2);

    // A check of a path that's no longer configured is dropped; the rest is replaced.
    await recordHarnessHostTools(db, orgId, h, [
      {
        name: "configured",
        configuredPath: "/opt/old",
        configuredPathExists: true,
        discoveredPath: null,
      },
      { name: "discovered", configuredPathExists: null, discoveredPath: null },
    ]);
    expect(await listHarnessHostTools(db, orgId, h)).toEqual([
      expect.objectContaining({
        configuredPathExists: null,
        discoveredPath: null,
        effectivePath: null,
      }),
      expect.objectContaining({ discoveredPath: null, effectivePath: null }),
    ]);

    // Another organization's tool of the same name isn't touched.
    const foreign = await harness(orgB);
    await recordHarnessHostTools(db, orgB, foreign, [
      { name: "configured", configuredPathExists: null, discoveredPath: "/x" },
    ]);
    expect(
      await db.select().from(harnessHostTools).where(eq(harnessHostTools.harnessId, foreign)),
    ).toEqual([]);
  });

  it("stores a tool left out of a report (or an empty report) as not found, keeping its configured path", async () => {
    const [org] = await db.insert(organizations).values({ name: "Omitted" }).returning();
    const orgId = org!.id;
    const h = await harness(orgId);
    const other = await harness(orgId, "other");
    const configured = await createHostTool(db, orgId, { name: "configured" });
    await createHostTool(db, orgId, { name: "discovered" });
    if (!configured.ok) throw new Error("setup");
    await setHarnessHostToolPath(db, orgId, h, configured.hostTool.id, "/opt/c");
    const report = [
      { name: "configured", configuredPathExists: true, discoveredPath: "/usr/bin/configured" },
      { name: "discovered", configuredPathExists: null, discoveredPath: "/usr/bin/discovered" },
    ];
    await recordHarnessHostTools(db, orgId, h, report);
    await recordHarnessHostTools(db, orgId, other, report);

    const later = new Date("2026-10-12T13:00:00Z");
    await recordHarnessHostTools(db, orgId, h, [report[1]!], later);
    expect(await listHarnessHostTools(db, orgId, h)).toEqual([
      expect.objectContaining({
        name: "configured",
        configuredPath: "/opt/c",
        configuredPathExists: null,
        discoveredPath: null,
        reportedAt: later,
        effectivePath: null,
      }),
      expect.objectContaining({ name: "discovered", effectivePath: "/usr/bin/discovered" }),
    ]);

    const latest = new Date("2026-10-12T14:00:00Z");
    await recordHarnessHostTools(db, orgId, h, [], latest);
    expect(await listHarnessHostTools(db, orgId, h)).toEqual([
      expect.objectContaining({
        configuredPath: "/opt/c",
        reportedAt: latest,
        effectivePath: null,
      }),
      expect.objectContaining({ discoveredPath: null, reportedAt: latest, effectivePath: null }),
    ]);

    // Another harness's rows aren't touched.
    expect(
      (await listHarnessHostTools(db, orgId, other)).map((tool) => tool.effectivePath),
    ).toEqual(["/usr/bin/configured", "/usr/bin/discovered"]);
  });

  it("lists each harness's host tools with an effective path, within the organization", async () => {
    const [org] = await db.insert(organizations).values({ name: "Usable" }).returning();
    const orgId = org!.id;
    const h1 = await harness(orgId, "h1");
    const h2 = await harness(orgId, "h2");
    const h3 = await harness(orgId, "h3");
    const tools: Record<string, string> = {};
    for (const name of ["semgrep", "opengrep", "ctags"]) {
      const tool = await createHostTool(db, orgId, { name });
      if (!tool.ok) throw new Error("setup");
      tools[name] = tool.hostTool.id;
    }
    // h1: semgrep discovered, opengrep configured and found, ctags configured but missing.
    await setHarnessHostToolPath(db, orgId, h1, tools.opengrep!, "/opt/opengrep");
    await setHarnessHostToolPath(db, orgId, h1, tools.ctags!, "/opt/ctags");
    await recordHarnessHostTools(db, orgId, h1, [
      { name: "semgrep", configuredPathExists: null, discoveredPath: "/usr/bin/semgrep" },
      { name: "opengrep", configuredPathExists: true, discoveredPath: null },
      { name: "ctags", configuredPathExists: false, discoveredPath: "/usr/bin/ctags" },
    ]);
    // h2: nothing found; h3: no report.
    await recordHarnessHostTools(db, orgId, h2, [
      { name: "semgrep", configuredPathExists: null, discoveredPath: null },
    ]);
    const usable = await listHarnessesUsableHostTools(db, orgId);
    expect(usable.get(h1)).toEqual(["opengrep", "semgrep"]);
    expect(usable.has(h2)).toBe(false);
    expect(usable.has(h3)).toBe(false);
    expect([...(await listHarnessesUsableHostTools(db, orgB)).keys()]).not.toContain(h1);
  });

  it("cascades harness and tool deletion to the harness rows", async () => {
    const [org] = await db.insert(organizations).values({ name: "Cascade" }).returning();
    const h1 = await harness(org!.id, "h1");
    const h2 = await harness(org!.id, "h2");
    const tool = await createHostTool(db, org!.id, { name: "t" });
    if (!tool.ok) throw new Error("setup");
    await setHarnessHostToolPath(db, org!.id, h1, tool.hostTool.id, "/t");
    await setHarnessHostToolPath(db, org!.id, h2, tool.hostTool.id, "/t");
    await db.delete(harnesses).where(eq(harnesses.id, h1));
    const rows = () =>
      db.select().from(harnessHostTools).where(eq(harnessHostTools.hostToolId, tool.hostTool.id));
    expect((await rows()).map((row) => row.harnessId)).toEqual([h2]);
    await deleteHostTool(db, org!.id, tool.hostTool.id);
    expect(await rows()).toEqual([]);
  });
});
