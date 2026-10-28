// Agents report their host tools; the usable ones are scoped to organizations.
import type { HostToolReport } from "@omniralph/shared";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import {
  listAgentsUsableHostTools,
  listHostToolSuggestions,
  listRequiredHostTools,
  missingHostToolNames,
  usableHostToolNames,
} from "./host-tools.js";
import { agents, organizations, playbooks } from "./schema.js";

const configured: HostToolReport = {
  name: "gh",
  path: "/opt/gh/bin/gh",
  source: "configured",
  problem: null,
};
const discovered: HostToolReport = {
  name: "opengrep",
  path: "/usr/bin/opengrep",
  source: "discovered",
  problem: null,
};
const notFound: HostToolReport = { name: "semgrep", path: null, source: null, problem: null };
const blocked: HostToolReport = { name: "trivy", path: null, source: null, problem: "blocked" };

describe("usableHostToolNames", () => {
  it("lists the reported tools with a path, sorted", () => {
    expect(usableHostToolNames([notFound, discovered, blocked, configured])).toEqual([
      "gh",
      "opengrep",
    ]);
    expect(usableHostToolNames([])).toEqual([]);
    expect(usableHostToolNames(null)).toEqual([]);
  });
});

describe("missingHostToolNames", () => {
  it("lists the required names the agent has no path for, sorted", () => {
    expect(missingHostToolNames([configured, blocked], ["trivy", "gh", "syft", "trivy"])).toEqual([
      "syft",
      "trivy",
    ]);
    expect(missingHostToolNames(null, ["gh"])).toEqual(["gh"]);
    expect(missingHostToolNames([configured], [])).toEqual([]);
  });
});

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("host tools", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgA: string;
  let orgB: string;

  const agent = async (
    organizationId: string,
    reportedHostTools: HostToolReport[],
    extra: Partial<typeof agents.$inferInsert> = {},
  ) => {
    const [row] = await db
      .insert(agents)
      .values({ organizationId, name: "h", reportedHostTools, ...extra })
      .returning();
    return row!.id;
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [a] = await db.insert(organizations).values({ name: "A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "B" }).returning();
    orgA = a!.id;
    orgB = b!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("lists each non-revoked agent's tools reported with a path, within the organization", async () => {
    const both = await agent(orgA, [discovered, configured, blocked]);
    const one = await agent(orgA, [notFound, discovered]);
    const none = await agent(orgA, [notFound, blocked]);
    await agent(orgA, []);
    const revoked = await agent(orgA, [configured], { revokedAt: new Date() });
    const other = await agent(orgB, [configured]);

    const usable = await listAgentsUsableHostTools(db, orgA);
    expect(Object.fromEntries(usable)).toEqual({ [both]: ["gh", "opengrep"], [one]: ["opengrep"] });
    expect(usable.has(none)).toBe(false);
    expect(usable.has(revoked)).toBe(false);
    expect(usable.has(other)).toBe(false);

    expect(Object.fromEntries(await listAgentsUsableHostTools(db, orgA, [one, other]))).toEqual({
      [one]: ["opengrep"],
    });
    expect((await listAgentsUsableHostTools(db, orgA, [])).size).toBe(0);
    expect(Object.fromEntries(await listAgentsUsableHostTools(db, orgB))).toEqual({
      [other]: ["gh"],
    });
  });

  it("lists the host tools the organization's playbooks require, sorted and de-duplicated", async () => {
    const [org] = await db.insert(organizations).values({ name: "Playbooks" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    expect(await listRequiredHostTools(db, org!.id)).toEqual([]);
    const playbook = (organizationId: string, requirements: Record<string, unknown>) => ({
      organizationId,
      name: "p",
      role: "review",
      definition: {},
      requirements,
    });
    await db.insert(playbooks).values([
      playbook(org!.id, { installables: [], hostTools: ["opengrep", "gh"] }),
      playbook(org!.id, { hostTools: ["gh"] }),
      playbook(org!.id, { hostTools: [] }),
      playbook(org!.id, {}),
      // Not a list, or not a host tool name: ignored.
      playbook(org!.id, { hostTools: "semgrep" }),
      playbook(org!.id, { hostTools: ["Bad Name"] }),
      playbook(other!.id, { hostTools: ["trivy"] }),
    ]);
    expect(await listRequiredHostTools(db, org!.id)).toEqual(["gh", "opengrep"]);
    expect(await listRequiredHostTools(db, other!.id)).toEqual(["trivy"]);

    // The editor suggests those and the ones agents report with a path.
    await agent(org!.id, [discovered, blocked, { ...configured, name: "syft" }]);
    await agent(org!.id, [notFound], { revokedAt: new Date() });
    await agent(other!.id, [configured]);
    expect(await listHostToolSuggestions(db, org!.id)).toEqual(["gh", "opengrep", "syft"]);
  });
});
