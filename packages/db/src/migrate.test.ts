// Applies the real migrations to a throwaway Postgres (Testcontainers).
// Skipped when no container runtime (Docker) is available.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { getContainerRuntimeClient } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Database } from "./client.js";
import { migrationsFolder, runMigrations } from "./migrate.js";
import { jobs, repositories, reviewProfiles, scmConnections } from "./schema.js";

const dockerAvailable = await getContainerRuntimeClient().then(
  () => true,
  () => false,
);

describe.skipIf(!dockerAvailable)("migrations", () => {
  let container: StartedPostgreSqlContainer;
  let db: Database;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:17-alpine").start();
    await runMigrations(container.getConnectionUri());
    db = createDb(container.getConnectionUri());
  }, 180_000);

  afterAll(async () => {
    await db?.$client.end();
    await container?.stop();
  });

  it("is idempotent", async () => {
    await expect(runMigrations(container.getConnectionUri())).resolves.toBeUndefined();
  });

  it("seeds the quick, standard and deep profiles", async () => {
    const profiles = await db
      .select({
        id: reviewProfiles.id,
        model: reviewProfiles.model,
        maxTokensPerReview: reviewProfiles.maxTokensPerReview,
        maxFiles: reviewProfiles.maxFiles,
        allowRepoExploration: reviewProfiles.allowRepoExploration,
      })
      .from(reviewProfiles)
      .orderBy(asc(reviewProfiles.maxTokensPerReview));

    expect(profiles.map((p) => [p.id, p.allowRepoExploration])).toEqual([
      ["quick", false],
      ["standard", true],
      ["deep", true],
    ]);
    for (const profile of profiles) {
      expect(profile.model).toMatch(/^claude-/);
      expect(profile.maxTokensPerReview).toBeGreaterThan(0);
      expect(profile.maxFiles).toBeGreaterThan(0);
    }
  });

  it("defaults repositories to the standard profile and default triggers", async () => {
    const [connection] = await db
      .insert(scmConnections)
      .values({
        provider: "github",
        name: "GitHub",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        provider: "github",
        externalId: "1",
        fullPath: "mcm/omniralph",
        connectionId: connection!.id,
      })
      .returning();
    expect(repo).toMatchObject({
      profileId: "standard",
      enabled: true,
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
    });
  });

  it("allows one queued/running job per dedupe key", async () => {
    const job = { capability: "review", type: "review.run", dedupeKey: "repo:1:pr:2" };
    const [first] = await db.insert(jobs).values(job).returning();
    await expect(db.insert(jobs).values(job)).rejects.toThrow();

    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first!.id));
    await expect(db.insert(jobs).values(job)).resolves.toBeDefined();
  });

  it("moves the runs' branch and PR/MR into their main lane (0024)", async () => {
    // A fresh database migrated up to 0023, with a v2a run, then migrated the rest of the way.
    await db.execute(sql`create database lanes`);
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/lanes");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0024_"));
      journal.entries = journal.entries.slice(0, upTo);
      writeFileSync(journalPath, JSON.stringify(journal));

      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (provider, name, base_url, encrypted_credentials)
           values ('github', 'GitHub', 'https://api.github.com', 'x') returning id`,
        );
        const { rows: repos } = await client.query<{ id: string }>(
          `insert into repositories (provider, external_id, full_path, connection_id)
           values ('github', '1', 'acme/api', $1) returning id`,
          [connections[0]!.id],
        );
        const { rows: runs } = await client.query<{ id: string }>(
          `insert into ralph_runs (linear_issue_id, linear_identifier, linear_agent_session_id, kind,
             repository_id, branch, base_branch, pr_number, pr_url)
           values ('i-1', 'ENG-1', 's-1', 'children', $1, 'eng-1', 'develop', 7, 'https://x/pull/7'),
                  ('i-2', 'ENG-2', 's-2', 'children', null, 'eng-2', '', null, null)
           returning id`,
          [repos[0]!.id],
        );
        await client.query(
          `insert into ralph_stories (run_id, linear_issue_id, identifier, title)
           values ($1, 'st-1', 'ENG-3', 'Story'), ($2, 'st-2', 'ENG-4', 'Other')`,
          [runs[0]!.id, runs[1]!.id],
        );

        await runMigrations(uri);
        const { rows: lanes } = await client.query(
          `select id, run_id, repository_id, branch, base_branch, pr_number, pr_url from ralph_lanes`,
        );
        expect(lanes).toEqual([
          {
            id: expect.any(String),
            run_id: runs[0]!.id,
            repository_id: repos[0]!.id,
            branch: "eng-1",
            base_branch: "develop",
            pr_number: 7,
            pr_url: "https://x/pull/7",
          },
        ]);
        const { rows: stories } = await client.query(
          `select identifier, lane_id from ralph_stories order by identifier`,
        );
        expect(stories).toEqual([
          { identifier: "ENG-3", lane_id: lanes[0].id },
          { identifier: "ENG-4", lane_id: null },
        ]);
        const { rows: columns } = await client.query(
          `select column_name from information_schema.columns
           where table_name = 'ralph_runs' and column_name in ('branch', 'base_branch', 'pr_number', 'pr_url')`,
        );
        expect(columns).toEqual([]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });
});
