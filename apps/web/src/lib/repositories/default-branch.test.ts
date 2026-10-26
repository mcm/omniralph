import {
  captureChanges,
  closeDb,
  connectRepository,
  createDb,
  getRepository,
  organizations,
  scmConnections,
  type Database,
  type Repository,
  type ScmConnection,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import type { ScmAdapter } from "@omniralph/scm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchDefaultBranch } from "./default-branch";

vi.mock("server-only", () => ({}));

const databaseAvailable = testDatabaseAvailable();

describe.skipIf(!databaseAvailable)("fetchDefaultBranch", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let connection: ScmConnection;
  let repository: Repository;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Managed Services" }).returning();
    orgId = org!.id;
    [connection] = (await db
      .insert(scmConnections)
      .values({
        organizationId: orgId,
        provider: "gitlab",
        name: "GitLab",
        baseUrl: "https://gitlab.example.com",
        externalId: "77",
        encryptedCredentials: "x",
      })
      .returning()) as [ScmConnection];
    repository = await connectRepository(db, {
      connectionId: connection.id,
      provider: "gitlab",
      externalId: "4211",
      fullPath: "managed-services/customer-portal",
    });
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  /** Deps whose adapter answers `branch` (or throws `error`), recording what it was asked. */
  function deps(branch: string | Error) {
    const getDefaultBranch = vi.fn(async () => {
      if (branch instanceof Error) throw branch;
      return branch;
    });
    return {
      deps: { db, adapterFor: () => ({ getDefaultBranch }) as unknown as ScmAdapter },
      getDefaultBranch,
    };
  }

  it("stores the branch and publishes one repository change, and none for a repeat", async () => {
    const develop = deps("develop");
    const first = await captureChanges(() =>
      fetchDefaultBranch(develop.deps, connection, repository),
    );
    expect(first.result).toBe("develop");
    expect(develop.getDefaultBranch).toHaveBeenCalledWith({
      fullPath: "managed-services/customer-portal",
      externalId: "4211",
    });
    expect((await getRepository(db, repository.id))?.defaultBranch).toBe("develop");
    expect(first.changes).toEqual([
      expect.objectContaining({
        resource: "repository",
        ids: [repository.id],
        organizationId: orgId,
      }),
    ]);

    const repeat = await captureChanges(() =>
      fetchDefaultBranch(develop.deps, connection, repository),
    );
    expect(repeat).toEqual({ result: "develop", changes: [] });

    const main = await captureChanges(() =>
      fetchDefaultBranch(deps("main").deps, connection, repository),
    );
    expect(main.changes).toHaveLength(1);
    expect((await getRepository(db, repository.id))?.defaultBranch).toBe("main");
  });

  it("throws the code host's error and keeps the stored branch", async () => {
    const failing = deps(new Error("404 Project Not Found"));
    const { changes } = await captureChanges(() =>
      expect(fetchDefaultBranch(failing.deps, connection, repository)).rejects.toThrow(
        "404 Project Not Found",
      ),
    );
    expect(changes).toEqual([]);
    expect((await getRepository(db, repository.id))?.defaultBranch).toBe("main");
  });
});
