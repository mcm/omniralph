import { randomBytes } from "node:crypto";
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { captureChanges } from "./changes.js";
import { decrypt } from "./crypto.js";
import {
  consumeOAuthState,
  deleteIntegration,
  getIntegration,
  getIntegrationByExternalId,
  getIntegrationById,
  getIntegrationWithCredentials,
  listIntegratedOrganizationIds,
  saveIntegration,
  setIntegrationFixLabels,
  setIntegrationStateMapping,
  updateIntegrationCredentials,
} from "./integrations.js";
import {
  DEFAULT_TRACKER_STATE_MAPPING,
  integrations,
  oauthStateUses,
  organizations,
  users,
} from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

interface Creds {
  accessToken: string;
  version: number;
}

describe.skipIf(!databaseAvailable)("integration queries", () => {
  const key = randomBytes(32);
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    await db.insert(users).values({ id: "admin-1", email: "admin@example.com" });
    const [org, other] = await db
      .insert(organizations)
      .values([{ name: "Acme" }, { name: "Other" }])
      .returning();
    orgId = org!.id;
    otherOrgId = other!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(async () => {
    await db.delete(integrations);
  });

  const install = async (
    externalId: string,
    name: string,
    accessToken: string,
    organizationId = orgId,
  ) => {
    const saved = await saveIntegration<Creds>(
      db,
      {
        organizationId,
        provider: "linear",
        externalId,
        name,
        credentials: { accessToken, version: 1 },
        installedByUserId: "admin-1",
      },
      key,
    );
    if (saved === "other_organization") throw new Error("connected to another organization");
    return saved;
  };

  it("stores credentials encrypted and reads them back", async () => {
    expect(await getIntegration(db, orgId, "linear")).toBeNull();
    const saved = await install("org-1", "Acme", "lin_secret_1");
    expect(saved).toMatchObject({
      provider: "linear",
      externalId: "org-1",
      name: "Acme",
      installedByUserId: "admin-1",
    });
    expect(saved).not.toHaveProperty("encryptedCredentials");

    const [row] = await db.select().from(integrations);
    expect(row!.encryptedCredentials).not.toContain("lin_secret_1");
    expect(JSON.parse(decrypt(row!.encryptedCredentials, key))).toEqual({
      accessToken: "lin_secret_1",
      version: 1,
    });

    expect(await getIntegration(db, orgId, "linear")).toMatchObject({ id: saved.id, name: "Acme" });
    expect(
      (await getIntegrationWithCredentials<Creds>(db, orgId, "linear", key))?.credentials,
    ).toEqual({
      accessToken: "lin_secret_1",
      version: 1,
    });
  });

  it("ends concurrent installs of different workspaces with one row", async () => {
    const results = await Promise.allSettled([
      install("org-1", "Acme", "t1"),
      install("org-2", "Other", "t2"),
      install("org-3", "Third", "t3"),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const rows = await db.select().from(integrations);
    expect(rows).toHaveLength(1);
    const stored = await getIntegrationWithCredentials<Creds>(db, orgId, "linear", key);
    // The row and its credentials belong to the same install.
    expect({ "org-1": "t1", "org-2": "t2", "org-3": "t3" }[stored!.externalId]).toBe(
      stored!.credentials.accessToken,
    );
  });

  it("consumes an OAuth state once and sweeps expired ones", async () => {
    await db.delete(oauthStateUses);
    const now = new Date("2026-10-06T12:00:00Z");
    const later = new Date(now.getTime() + 10 * 60_000);
    expect(await consumeOAuthState(db, "nonce-1", later, now)).toBe(true);
    expect(await consumeOAuthState(db, "nonce-1", later, now)).toBe(false);
    expect(await consumeOAuthState(db, "nonce-2", later, now)).toBe(true);
    const rows = await db.select().from(oauthStateUses);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.nonceHash)).not.toContain("nonce-1");

    // After both expire they are swept.
    expect(
      await consumeOAuthState(
        db,
        "nonce-3",
        new Date(later.getTime() + 60_000),
        new Date(later.getTime() + 1),
      ),
    ).toBe(true);
    expect(await db.select().from(oauthStateUses)).toHaveLength(1);
  });

  it("is unique per provider and workspace; reinstalling updates the row", async () => {
    const first = await install("org-1", "Acme", "t1");
    const again = await install("org-1", "Acme Inc", "t2");
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Acme Inc");
    expect(
      (await getIntegrationWithCredentials<Creds>(db, orgId, "linear", key))?.credentials
        .accessToken,
    ).toBe("t2");

    await expect(
      db.insert(integrations).values({
        organizationId: orgId,
        provider: "linear",
        externalId: "org-1",
        name: "dup",
        encryptedCredentials: "x",
      }),
    ).rejects.toThrow();
  });

  it("keeps only one workspace per provider and organization", async () => {
    await install("org-1", "Acme", "t1");
    await install("org-2", "Other", "t2");
    const rows = await db.select().from(integrations);
    expect(rows.map((r) => r.externalId)).toEqual(["org-2"]);
  });

  it("connects a workspace to one organization only", async () => {
    const saved = await install("ws-1", "Acme", "t1");
    await install("ws-2", "Other", "t2", otherOrgId);
    expect(await getIntegration(db, otherOrgId, "linear")).toMatchObject({ externalId: "ws-2" });

    // Another organization can't take over a connected workspace.
    const taken = await saveIntegration<Creds>(
      db,
      {
        organizationId: otherOrgId,
        provider: "linear",
        externalId: "ws-1",
        name: "Stolen",
        credentials: { accessToken: "t3", version: 1 },
        installedByUserId: "admin-1",
      },
      key,
    );
    expect(taken).toBe("other_organization");
    expect(await getIntegrationByExternalId(db, "linear", "ws-1")).toMatchObject({
      id: saved.id,
      organizationId: orgId,
      name: "Acme",
    });
    expect(await getIntegration(db, otherOrgId, "linear")).toMatchObject({ externalId: "ws-2" });
    expect(await getIntegrationByExternalId(db, "linear", "ws-3")).toBeNull();
    expect((await listIntegratedOrganizationIds(db, "linear")).sort()).toEqual(
      [orgId, otherOrgId].sort(),
    );

    // The database enforces it too.
    await expect(
      db.insert(integrations).values({
        organizationId: otherOrgId,
        provider: "linear",
        externalId: "ws-1",
        name: "dup",
        encryptedCredentials: "x",
      }),
    ).rejects.toThrow();

    // Once disconnected, the workspace can move.
    await deleteIntegration(db, orgId, "linear", key);
    expect(await install("ws-1", "Moved", "t4", otherOrgId)).toMatchObject({
      organizationId: otherOrgId,
    });
    expect(await getIntegration(db, otherOrgId, "linear")).toMatchObject({ externalId: "ws-1" });
  });

  it("starts with the default state mapping and saves a new one with a connection change", async () => {
    const saved = await install("org-1", "Acme", "t1");
    expect(saved.stateMapping).toEqual(DEFAULT_TRACKER_STATE_MAPPING);
    expect(await getIntegrationById(db, saved.id)).toMatchObject({
      id: saved.id,
      organizationId: orgId,
      stateMapping: DEFAULT_TRACKER_STATE_MAPPING,
    });
    const mapping = {
      ready: { types: ["unstarted", "started"] },
      needsRefining: { types: ["triage", "backlog"] },
      teams: { "team-1": { ready: ["state-a"], needsRefining: ["state-b"] } },
    };
    const { result, changes } = await captureChanges(() =>
      setIntegrationStateMapping(db, saved.id, mapping),
    );
    expect(result?.stateMapping).toEqual(mapping);
    expect((await getIntegrationById(db, saved.id))?.stateMapping).toEqual(mapping);
    expect(changes).toEqual([
      expect.objectContaining({ resource: "connection", ids: [saved.id], organizationId: orgId }),
    ]);
    // Reinstalling the workspace keeps its mapping.
    expect((await install("org-1", "Acme", "t2")).stateMapping).toEqual(mapping);
    expect(await setIntegrationStateMapping(db, crypto.randomUUID(), mapping)).toBeNull();
    expect(await getIntegrationById(db, crypto.randomUUID())).toBeNull();
  });

  it("starts with the Bug fix label and saves new ones with a connection change", async () => {
    const saved = await install("org-1", "Acme", "t1");
    expect(saved.fixLabels).toEqual(["Bug"]);
    const { result, changes } = await captureChanges(() =>
      setIntegrationFixLabels(db, saved.id, ["Defect", "Regression"]),
    );
    expect(result?.fixLabels).toEqual(["Defect", "Regression"]);
    expect((await getIntegrationById(db, saved.id))?.fixLabels).toEqual(["Defect", "Regression"]);
    expect(changes).toEqual([
      expect.objectContaining({ resource: "connection", ids: [saved.id], organizationId: orgId }),
    ]);
    // Reinstalling the workspace keeps its fix labels.
    expect((await install("org-1", "Acme", "t2")).fixLabels).toEqual(["Defect", "Regression"]);
    expect(await setIntegrationFixLabels(db, crypto.randomUUID(), ["Bug"])).toBeNull();
  });

  it("deletes the integration and returns its credentials", async () => {
    await install("org-1", "Acme", "t1");
    const removed = await deleteIntegration<Creds>(db, orgId, "linear", key);
    expect(removed?.credentials.accessToken).toBe("t1");
    expect(await getIntegration(db, orgId, "linear")).toBeNull();
    expect(await deleteIntegration(db, orgId, "linear", key)).toBeNull();
  });

  it("serializes concurrent credential updates under a row lock", async () => {
    const { id } = await install("org-1", "Acme", "t1");
    const seen: number[] = [];
    const bump = () =>
      updateIntegrationCredentials<Creds>(
        db,
        id,
        async (current) => {
          seen.push(current.version);
          await new Promise((r) => setTimeout(r, 50));
          return { accessToken: `t${current.version + 1}`, version: current.version + 1 };
        },
        key,
      );
    const results = await Promise.all([bump(), bump(), bump()]);
    // Each update saw the previous one's result: no lost update.
    expect(seen.sort()).toEqual([1, 2, 3]);
    expect(results.map((r) => r?.version).sort()).toEqual([2, 3, 4]);
    expect(
      (await getIntegrationWithCredentials<Creds>(db, orgId, "linear", key))?.credentials,
    ).toEqual({
      accessToken: "t4",
      version: 4,
    });

    // null keeps the current credentials.
    expect(await updateIntegrationCredentials<Creds>(db, id, async () => null, key)).toEqual({
      accessToken: "t4",
      version: 4,
    });
    expect(
      await updateIntegrationCredentials<Creds>(
        db,
        "00000000-0000-0000-0000-000000000000",
        async () => null,
        key,
      ),
    ).toBeNull();
  });
});
