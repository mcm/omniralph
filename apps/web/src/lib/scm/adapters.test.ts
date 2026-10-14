import { randomBytes } from "node:crypto";
import {
  closeDb,
  createDb,
  organizations,
  scmConnections,
  updateScmConnectionCredentials,
  upsertScmConnection,
  type Database,
  type ScmConnection,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { scmAdapterFor } = await import("./adapters");

const databaseAvailable = testDatabaseAvailable();

const HOST = "https://gitlab.example.com";
const repo = { fullPath: "acme/web", externalId: "10" };

/** The token GitLab accepts, and the tokens each request came with. */
let validToken: string;
let projectStatus: number;
let requestTokens: string[];

const server = setupServer(
  http.get(`${HOST}/api/v4/projects/10`, ({ request }) => {
    const token = request.headers.get("private-token") ?? "";
    requestTokens.push(token);
    if (token !== validToken) {
      return HttpResponse.json({ message: "401 Unauthorized" }, { status: 401 });
    }
    if (projectStatus !== 200) {
      return HttpResponse.json({ message: "boom" }, { status: projectStatus });
    }
    return HttpResponse.json({ id: 10, default_branch: "trunk" });
  }),
);

describe.skipIf(!databaseAvailable)("scmAdapterFor (GitLab)", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    server.listen({ onUnhandledFrame: "error" });
  }, 120_000);

  afterAll(async () => {
    server.close();
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  beforeEach(() => {
    validToken = "glpat-old";
    projectStatus = 200;
    requestTokens = [];
  });

  afterEach(async () => {
    await db.delete(scmConnections);
  });

  async function connection(): Promise<ScmConnection> {
    return (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "gitlab",
      name: `bot @ gitlab.example.com`,
      baseUrl: HOST,
      externalId: "42",
      credentials: { token: "glpat-old", webhookSecret: "secret" },
    }))!;
  }

  /** What the daily rotation does: GitLab revokes the old token, the new one is stored. */
  async function rotate(id: string) {
    validToken = "glpat-new";
    await updateScmConnectionCredentials<{ token: string }>(db, id, async (credentials) => ({
      ...credentials,
      token: "glpat-new",
    }));
  }

  it("reloads the credentials on a 401 and retries once", async () => {
    const conn = await connection();
    const adapter = scmAdapterFor(db, conn);
    expect(await adapter.getDefaultBranch(repo)).toBe("trunk");

    await rotate(conn.id);

    expect(await adapter.getDefaultBranch(repo)).toBe("trunk");
    // Later calls use the reloaded token straight away.
    expect(await adapter.getDefaultBranch(repo)).toBe("trunk");
    expect(requestTokens).toEqual(["glpat-old", "glpat-old", "glpat-new", "glpat-new"]);
  });

  it("retries only once", async () => {
    const adapter = scmAdapterFor(db, await connection());
    validToken = "glpat-revoked-elsewhere";

    await expect(adapter.getDefaultBranch(repo)).rejects.toThrow("401 Unauthorized");
    expect(requestTokens).toEqual(["glpat-old", "glpat-old"]);
  });

  it("doesn't retry other errors", async () => {
    const adapter = scmAdapterFor(db, await connection());
    projectStatus = 500;

    await expect(adapter.getDefaultBranch(repo)).rejects.toThrow();
    expect(requestTokens).toEqual(["glpat-old"]);
  });

  it("keeps non-method properties", async () => {
    const adapter = scmAdapterFor(db, await connection());
    expect(adapter.provider).toBe("gitlab");
  });
});
