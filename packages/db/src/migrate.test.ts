// Applies the real migrations to a throwaway database in the test run's Postgres
// (Testcontainers, see testing/global-setup.ts). Skipped when no container runtime (Docker) is available.
import { createTestDatabase, testDatabaseAvailable, type TestDatabase } from "../testing/index.js";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Database } from "./client.js";
import { migrationsFolder, runMigrations } from "./migrate.js";
import {
  appSettings,
  jobs,
  organizationEmailDomains,
  organizations,
  repositories,
  scmConnections,
  workItemEvents,
  workItemOverrides,
  workItemShareLinks,
} from "./schema.js";

const databaseAvailable = testDatabaseAvailable();

/**
 * Applies the migrations before the one whose tag starts with `tag`. For tests of older
 * migrations that read their tables by the names a later migration (0103) renames.
 */
async function migrateBefore(uri: string, tag: string): Promise<void> {
  const before = mkdtempSync(join(tmpdir(), "migrations-"));
  const client = new pg.Client({ connectionString: uri });
  try {
    cpSync(migrationsFolder, before, { recursive: true });
    const journalPath = join(before, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const upTo = journal.entries.findIndex((e) => e.tag.startsWith(tag));
    writeFileSync(
      journalPath,
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
    );
    await client.connect();
    await migrate(drizzle(client), { migrationsFolder: before });
  } finally {
    await client.end();
    rmSync(before, { recursive: true, force: true });
  }
}

describe.skipIf(!databaseAvailable)("migrations", () => {
  let testDb: TestDatabase;
  let db: Database;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  it("is idempotent", async () => {
    await expect(runMigrations(testDb.uri)).resolves.toBeUndefined();
  });

  it("defaults repositories to the standard review depth and default triggers", async () => {
    const [org] = await db.insert(organizations).values({ name: "Repos" }).returning();
    const [connection] = await db
      .insert(scmConnections)
      .values({
        organizationId: org!.id,
        provider: "github",
        name: "GitHub",
        baseUrl: "https://api.github.com",
        encryptedCredentials: "x",
      })
      .returning();
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId: org!.id,
        provider: "github",
        externalId: "1",
        fullPath: "mcm/omniralph",
        connectionId: connection!.id,
      })
      .returning();
    expect(repo).toMatchObject({
      reviewDepth: "standard",
      // Reviews and Ask start on, Coding off (0101).
      reviewsEnabled: true,
      codingEnabled: false,
      askEnabled: true,
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
      storyPlaybookId: "builtin:implement-story",
      requestPlaybookId: "builtin:handle-request",
      // The coding policy (0098).
      codingInstructions: null,
      openPullRequestEarly: false,
      historyRewrite: "when-asked",
      respondToReviewsAndCi: true,
    });
  });

  it("adds the story and request tasks and a request's trigger (0064), without the coding path (0092), as playbooks (0097)", async () => {
    const { rows } = await db.$client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'repositories' and column_name in ('coding_path', 'story_task_id', 'request_task_id', 'story_playbook_id', 'request_playbook_id'))
           or (table_name = 'ralph_messages' and column_name = 'trigger'))
       order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "request_playbook_id", is_nullable: "NO" },
      { column_name: "story_playbook_id", is_nullable: "NO" },
      { column_name: "trigger", is_nullable: "YES" },
    ]);
    await expect(db.$client.query(`select 'tasks'::repository_coding_path`)).rejects.toThrow();
  });

  it("adds hidden refs, unique per repository and ref (0065)", async () => {
    const { rows } = await db.$client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'public' and table_name = 'hidden_refs' order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "deleted_at", is_nullable: "YES" },
      { column_name: "id", is_nullable: "NO" },
      { column_name: "ref", is_nullable: "NO" },
      { column_name: "repository_id", is_nullable: "NO" },
      { column_name: "run_id", is_nullable: "NO" },
      { column_name: "sha", is_nullable: "NO" },
    ]);
    const { rows: indexes } = await db.$client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'hidden_refs' and indexname = 'hidden_refs_repository_ref_uq'`,
    );
    expect(indexes[0]?.indexdef).toMatch(/UNIQUE INDEX .*\(repository_id, ref\)/);
  });

  it("creates work item overrides and events with their keys and indexes (0106)", async () => {
    const { rows: keys } = await db.$client.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid in ('work_item_overrides'::regclass, 'work_item_events'::regclass)
       order by conname`,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        {
          conname: "work_item_overrides_organization_id_tracker_external_id_pk",
          def: "PRIMARY KEY (organization_id, tracker, external_id)",
        },
        {
          conname: "work_item_overrides_repository_id_repositories_id_fk",
          def: expect.stringMatching(/REFERENCES repositories\(id\) ON DELETE SET NULL/),
        },
        { conname: "work_item_events_pkey", def: "PRIMARY KEY (id)" },
      ]),
    );
    const { rows: indexes } = await db.$client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
       where tablename in ('work_item_overrides', 'work_item_events') order by indexname`,
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([
        "work_item_events_item_idx",
        "work_item_overrides_repository_id_idx",
      ]),
    );
    expect(indexes.find((i) => i.indexname === "work_item_events_item_idx")?.indexdef).toMatch(
      /\(organization_id, tracker, external_id, created_at\)/,
    );

    const [org] = await db.insert(organizations).values({ name: "Work items" }).returning();
    const item = { organizationId: org!.id, tracker: "linear" as const, externalId: "issue-1" };
    await db.insert(workItemOverrides).values(item);
    // One choice per work item.
    await expect(db.insert(workItemOverrides).values(item)).rejects.toThrow();
    const [event] = await db
      .insert(workItemEvents)
      .values({ ...item, actorName: "Om", kind: "created" })
      .returning();
    expect(event).toMatchObject({ actorUserId: null, detail: {} });
  });

  it("creates work item share links with a unique token hash (0107)", async () => {
    const { rows: keys } = await db.$client.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
       where conrelid = 'work_item_share_links'::regclass order by conname`,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        { conname: "work_item_share_links_pkey", def: "PRIMARY KEY (id)" },
        { conname: "work_item_share_links_token_hash_unique", def: "UNIQUE (token_hash)" },
        {
          conname: "work_item_share_links_created_by_users_id_fk",
          def: expect.stringMatching(/REFERENCES users\(id\) ON DELETE SET NULL/),
        },
      ]),
    );
    const { rows: indexes } = await db.$client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where indexname = 'work_item_share_links_item_idx'`,
    );
    expect(indexes[0]?.indexdef).toMatch(/\(organization_id, tracker, external_id\)/);

    const [org] = await db.insert(organizations).values({ name: "Share links" }).returning();
    const link = {
      organizationId: org!.id,
      tracker: "linear" as const,
      externalId: "issue-1",
      tokenHash: "hash",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const [row] = await db.insert(workItemShareLinks).values(link).returning();
    expect(row).toMatchObject({ passwordHash: null, createdBy: null, revokedAt: null });
    await expect(db.insert(workItemShareLinks).values(link)).rejects.toThrow();
  });

  it("creates the organization tables (0029)", async () => {
    const { rows } = await db.$client.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name like 'organization%' order by table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      "organization_email_domains",
      "organization_invitations",
      "organization_members",
      "organizations",
    ]);
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    expect(org).toMatchObject({ allowDomainJoin: false, createdBy: null });
    await expect(
      db.insert(organizationEmailDomains).values({ organizationId: org!.id, domain: "Acme.io" }),
    ).rejects.toThrow();
    await db
      .insert(organizationEmailDomains)
      .values({ organizationId: org!.id, domain: "acme.io" });
    await expect(
      db.insert(organizationEmailDomains).values({ organizationId: org!.id, domain: "acme.io" }),
    ).rejects.toThrow();
  });

  it("keys app settings by organization and puts agents in an organization (0033)", async () => {
    const [a] = await db.insert(organizations).values({ name: "Settings A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "Settings B" }).returning();
    await db.insert(appSettings).values([
      { organizationId: a!.id, key: "agent.desiredVersion", value: "1.0.0" },
      { organizationId: b!.id, key: "agent.desiredVersion", value: "2.0.0" },
    ]);
    await expect(
      db
        .insert(appSettings)
        .values({ organizationId: a!.id, key: "agent.desiredVersion", value: 1 }),
    ).rejects.toThrow();
    await expect(db.execute(sql`insert into agents (name) values ('no-org')`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into agent_enrollments (token_hash, expires_at) values ('h', now())`),
    ).rejects.toThrow();
  });

  it("puts jobs in an organization (0034)", async () => {
    await expect(
      db.execute(
        sql`insert into jobs (type, task_type, pool) values ('review.run', 'review', 'short')`,
      ),
    ).rejects.toThrow();
  });

  it("backfills GitLab connections' bot username from their name (0035)", async () => {
    await db.execute(sql`create database bot_usernames`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/bot_usernames");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0035_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        await client.query(
          `insert into scm_connections (organization_id, provider, name, base_url, external_id, encrypted_credentials)
           values ($1, 'gitlab', 'service_account_group_12_bot @ gitlab.example.com', 'https://gitlab.example.com', '1', 'x'),
                  ($1, 'gitlab', 'Odd name', 'https://gitlab.example.com', '2', 'x'),
                  ($1, 'github', 'acme @ github.com', 'https://api.github.com', '3', 'x')`,
          [orgs[0]!.id],
        );

        await runMigrations(uri);
        const { rows } = await client.query(
          `select external_id, bot_username from scm_connections order by external_id`,
        );
        expect(rows).toEqual([
          { external_id: "1", bot_username: "service_account_group_12_bot" },
          { external_id: "2", bot_username: null },
          { external_id: "3", bot_username: null },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("makes existing runs Linear runs (0043)", async () => {
    await db.execute(sql`create database run_origins`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/run_origins");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0043_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        await client.query(
          `insert into ralph_runs (organization_id, linear_issue_id, linear_identifier, linear_agent_session_id, kind, mode, status)
           values ($1, 'i-1', 'ENG-1', 's-1', 'children', 'epic', 'running'),
                  ($1, 'i-2', 'ENG-2', 's-2', 'single', 'request', 'completed')`,
          [orgs[0]!.id],
        );

        await runMigrations(uri);
        const { rows } = await client.query(
          `select linear_identifier, origin, chat_thread_id from ralph_runs order by linear_identifier`,
        );
        expect(rows).toEqual([
          { linear_identifier: "ENG-1", origin: "linear", chat_thread_id: null },
          { linear_identifier: "ENG-2", origin: "linear", chat_thread_id: null },
        ]);
        // The unfinished run still holds its issue.
        await expect(
          client.query(
            `insert into ralph_runs (organization_id, linear_issue_id, linear_identifier, linear_agent_session_id, kind)
             values ($1, 'i-1', 'ENG-1', 's-3', 'children')`,
            [orgs[0]!.id],
          ),
        ).rejects.toThrow(/ralph_runs_issue_active_uq/);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("targets per-agent topic jobs at their agent and leases running jobs (0052)", async () => {
    await db.execute(sql`create database job_queue`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/job_queue");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0052_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        const { rows: agentRows } = await client.query<{ id: string }>(
          `insert into agents (organization_id, name) values ($1, 'a') returning id`,
          [org],
        );
        const agent = agentRows[0]!.id;
        await client.query(
          `insert into jobs (organization_id, capability, type, status, topic, dedupe_key) values
             ($1, 'review', 'review.run', 'queued', 'review-jobs-agent-' || $2, 'pinned'),
             ($1, 'system', 'repo.sync', 'running', 'system-jobs-agent-' || $2, 'sync'),
             ($1, 'review', 'review.run', 'queued', 'review-jobs-org-' || $1, 'shared'),
             ($1, 'review', 'review.run', 'completed', 'review-jobs-agent-' || $2, 'done')`,
          [org, agent],
        );

        await migrateBefore(uri, "0103_");
        const { rows } = await client.query(
          `select dedupe_key, target_harness_id, lease_expires_at > now() + interval '100 seconds' as leased,
                  available_at <= now() as available
           from jobs order by dedupe_key`,
        );
        expect(rows).toEqual([
          { dedupe_key: "done", target_harness_id: null, leased: null, available: true },
          { dedupe_key: "pinned", target_harness_id: agent, leased: null, available: true },
          { dedupe_key: "shared", target_harness_id: null, leased: null, available: true },
          { dedupe_key: "sync", target_harness_id: agent, leased: true, available: true },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("drops the Vercel Queues columns from jobs (0053)", async () => {
    const { rows } = await db.$client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'jobs' and column_name in ('topic', 'queue_message_id')`,
    );
    expect(rows).toEqual([]);
  });

  it("drops the poll interval from agents (0054)", async () => {
    const { rows } = await db.$client.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'agents' and column_name = 'poll_interval_seconds'`,
    );
    expect(rows).toEqual([]);
  });

  it("adds reported models to agents, empty by default (0078)", async () => {
    const [org] = await db.insert(organizations).values({ name: "Models" }).returning();
    const { rows } = await db.$client.query<{ reported_models: unknown }>(
      `insert into agents (organization_id, name) values ($1, 'h') returning reported_models`,
      [org!.id],
    );
    expect(rows).toEqual([{ reported_models: [] }]);
  });

  it("adds live_online to agents, false by default (0086)", async () => {
    const [org] = await db.insert(organizations).values({ name: "Live" }).returning();
    const { rows } = await db.$client.query<{ live_online: unknown }>(
      `insert into agents (organization_id, name) values ($1, 'h') returning live_online`,
      [org!.id],
    );
    expect(rows).toEqual([{ live_online: false }]);
  });

  it("adds reported installables to agents, empty by default (0071)", async () => {
    const [org] = await db.insert(organizations).values({ name: "Installables" }).returning();
    const { rows } = await db.$client.query<{ reported_installables: unknown }>(
      `insert into agents (organization_id, name) values ($1, 'h') returning reported_installables`,
      [org!.id],
    );
    expect(rows).toEqual([{ reported_installables: [] }]);
    await expect(
      db.$client.query(
        `update agents set reported_installables = null where organization_id = $1`,
        [org!.id],
      ),
    ).rejects.toThrow(/not-null/);
  });

  it("adds host_tools and agent_host_tools, cascading on delete (0072)", async () => {
    const [org] = await db.insert(organizations).values({ name: "Host tools" }).returning();
    const q = db.$client;
    const {
      rows: [tool],
    } = await q.query<{ id: string }>(
      `insert into host_tools (organization_id, name) values ($1, 'opengrep') returning id`,
      [org!.id],
    );
    await expect(
      q.query(`insert into host_tools (organization_id, name) values ($1, 'opengrep')`, [org!.id]),
    ).rejects.toThrow(/host_tools_organization_name_uq/);
    const {
      rows: [agent],
    } = await q.query<{ id: string }>(
      `insert into agents (organization_id, name) values ($1, 'h') returning id`,
      [org!.id],
    );
    const { rows } = await q.query(
      `insert into agent_host_tools (agent_id, host_tool_id) values ($1, $2)
       returning configured_path, configured_path_exists, discovered_path, reported_at`,
      [agent!.id, tool!.id],
    );
    expect(rows).toEqual([
      {
        configured_path: null,
        configured_path_exists: null,
        discovered_path: null,
        reported_at: null,
      },
    ]);
    await expect(
      q.query(`insert into agent_host_tools (agent_id, host_tool_id) values ($1, $2)`, [
        agent!.id,
        tool!.id,
      ]),
    ).rejects.toThrow(/agent_host_tools_agent_id_host_tool_id_pk/);
    await q.query(`delete from organizations where id = $1`, [org!.id]);
    const { rows: left } = await q.query(
      `select (select count(*) from host_tools where id = $1)::int as tools,
              (select count(*) from agent_host_tools where host_tool_id = $1)::int as rows`,
      [tool!.id],
    );
    expect(left).toEqual([{ tools: 0, rows: 0 }]);
  });

  it("adds required installables and host tools to jobs, empty by default (0073)", async () => {
    const [org] = await db.insert(organizations).values({ name: "Job requirements" }).returning();
    const { rows } = await db.$client.query(
      `insert into jobs (organization_id, type, task_type) values ($1, 'review.run', 'review')
       returning required_installables, required_host_tools`,
      [org!.id],
    );
    expect(rows).toEqual([{ required_installables: [], required_host_tools: [] }]);
  });

  it("drops the capability columns from jobs and agents (0057)", async () => {
    const { rows } = await db.$client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where (table_name = 'jobs' and column_name = 'capability')
          or (table_name = 'agents'
              and column_name in ('enabled_capabilities', 'capability_limits', 'reported_capabilities'))`,
    );
    expect(rows).toEqual([]);
  });

  it("adds run activities and permission requests (0058)", async () => {
    const { rows: columns } = await db.$client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_name in ('run_activities', 'run_permission_requests')
       order by table_name, ordinal_position`,
    );
    expect(columns).toEqual([
      ...["id", "job_id", "organization_id", "type", "body", "parameter", "created_at"].map(
        (column_name) => ({ table_name: "run_activities", column_name }),
      ),
      ...[
        "id",
        "job_id",
        "request_id",
        "tool",
        "detail",
        "asked_at",
        "expires_at",
        "answer",
        "answered_at",
        "answered_by",
      ].map((column_name) => ({ table_name: "run_permission_requests", column_name })),
    ]);
    const { rows: indexes } = await db.$client.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
       where indexname in ('run_activities_job_id_created_at_idx', 'run_permission_requests_job_request_uq')
       order by indexname`,
    );
    expect(indexes.map((i) => i.indexdef)).toEqual([
      expect.stringContaining("(job_id, created_at)"),
      expect.stringMatching(/UNIQUE INDEX .*\(job_id, request_id\)/),
    ]);
    const { rows: fks } = await db.$client.query<{ table_name: string; delete_rule: string }>(
      `select tc.table_name, rc.delete_rule
       from information_schema.table_constraints tc
       join information_schema.referential_constraints rc on rc.constraint_name = tc.constraint_name
       where tc.constraint_name in ('run_activities_job_id_jobs_id_fk', 'run_permission_requests_job_id_jobs_id_fk')
       order by tc.table_name`,
    );
    expect(fks).toEqual([
      { table_name: "run_activities", delete_rule: "CASCADE" },
      { table_name: "run_permission_requests", delete_rule: "CASCADE" },
    ]);
  });

  it("renames agents to harnesses and keeps their rows (0055)", async () => {
    await db.execute(sql`create database harnesses`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/harnesses");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0055_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        const { rows: agentRows } = await client.query<{ id: string }>(
          `insert into agents (organization_id, name) values ($1, 'a') returning id`,
          [org],
        );
        const agent = agentRows[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        const { rows: repos } = await client.query<{ id: string }>(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', '1', 'acme/api', $2) returning id`,
          [org, connections[0]!.id],
        );
        await client.query(
          `insert into jobs (organization_id, capability, type, agent_id, target_agent_id)
           values ($1, 'review', 'review.run', $2, $2)`,
          [org, agent],
        );
        await client.query(
          `insert into agent_repo_pins (agent_id, repository_id) values ($1, $2)`,
          [agent, repos[0]!.id],
        );
        await client.query(`insert into agent_audit (agent_id, event) values ($1, 'enroll')`, [
          agent,
        ]);
        await client.query(
          `insert into app_settings (organization_id, key, value) values ($1, 'agent.desiredVersion', '"1.2.3"'), ($1, 'agent.latestVersion', '{"version": "0.8.0"}')`,
          [org],
        );

        await migrateBefore(uri, "0103_");
        const { rows: harnesses } = await client.query(`select id, name from harnesses`);
        expect(harnesses).toEqual([{ id: agent, name: "a" }]);
        const { rows: jobRows } = await client.query(
          `select harness_id, target_harness_id from jobs`,
        );
        expect(jobRows).toEqual([{ harness_id: agent, target_harness_id: agent }]);
        const { rows: pins } = await client.query(
          `select harness_id, repository_id from harness_repo_pins`,
        );
        expect(pins).toEqual([{ harness_id: agent, repository_id: repos[0]!.id }]);
        const { rows: audit } = await client.query(`select harness_id, event from harness_audit`);
        expect(audit).toEqual([{ harness_id: agent, event: "enroll" }]);
        const { rows: settings } = await client.query(`select key, value from app_settings`);
        expect(settings).toEqual([{ key: "harness.desiredVersion", value: "1.2.3" }]);
        const { rows: old } = await client.query(
          `select table_name from information_schema.tables
           where table_schema = 'public' and table_name like 'agent%'
             and table_name <> 'agent_definitions'`,
        );
        expect(old).toEqual([]);
        // The renamed foreign keys still hold.
        await expect(
          client.query(
            `insert into harness_repo_pins (harness_id, repository_id) values ($1, $2)`,
            [agent, repos[0]!.id],
          ),
        ).rejects.toThrow(/harness_repo_pins_harness_repo_uq/);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("backfills task types, pools, accepted task types and pool limits (0056)", async () => {
    await db.execute(sql`create database task_types`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/task_types");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0056_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme'), ('Globex') returning id`,
        );
        const [acme, globex] = orgs.map((o) => o.id) as [string, string];
        const legacy: [string, string][] = [
          ["review", "review.run"],
          ["review", "review.reply"],
          ["review", "review.learn-rule"],
          ["review", "chat.ask"],
          ["triage", "triage.run"],
          ["ralph", "ralph.describe-pr"],
          ["ralph", "ralph.story"],
          ["ralph", "ralph.request"],
          ["ralph", "ralph.prepare"],
          ["ralph", "ralph.cleanup"],
          ["system", "repo.sync"],
        ];
        for (const [capability, type] of legacy) {
          await client.query(
            `insert into jobs (organization_id, capability, type) values ($1, $2, $3)`,
            [acme, capability, type],
          );
        }
        const harnesses: [string, string[], Record<string, number>][] = [
          ["review-only", ["review"], {}],
          ["ralph-only", ["ralph"], { ralph: 1 }],
          ["triage-only", ["triage"], { triage: 3 }],
          ["everything", ["review", "ralph", "triage"], { review: 4, triage: 2, ralph: 1 }],
          ["nothing", [], {}],
        ];
        for (const [name, capabilities, limits] of harnesses) {
          await client.query(
            `insert into harnesses (organization_id, name, enabled_capabilities, capability_limits)
             values ($1, $2, $3, $4)`,
            [acme, name, capabilities, JSON.stringify(limits)],
          );
        }

        // Up to 0075, which resets every harness to the organization defaults.
        const upTo0075 = journal.entries.findIndex((e) => e.tag.startsWith("0075_"));
        writeFileSync(
          journalPath,
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo0075) }),
        );
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: jobRows } = await client.query<{
          type: string;
          task_type: string;
          pool: string | null;
          task_id: string | null;
          min_harness_version: string | null;
        }>(`select type, task_type, pool, task_id, min_harness_version from jobs order by type`);
        expect(Object.fromEntries(jobRows.map((r) => [r.type, [r.task_type, r.pool]]))).toEqual({
          "review.run": ["review", "short"],
          "review.reply": ["query", "short"],
          "review.learn-rule": ["query", "short"],
          "chat.ask": ["query", "short"],
          "triage.run": ["query", "short"],
          "ralph.describe-pr": ["query", "short"],
          "ralph.story": ["coding", "long"],
          "ralph.request": ["coding", "long"],
          "ralph.prepare": ["coding", "long"],
          "ralph.cleanup": ["coding", "long"],
          "repo.sync": ["system", null],
        });
        expect(jobRows.every((r) => r.task_id === null && r.min_harness_version === null)).toBe(
          true,
        );

        const { rows: harnessRows } = await client.query<{
          name: string;
          accepted_task_types: string[];
          pool_limits: Record<string, number>;
        }>(`select name, accepted_task_types, pool_limits from harnesses`);
        expect(
          Object.fromEntries(
            harnessRows.map((r) => [r.name, [r.accepted_task_types, r.pool_limits]]),
          ),
        ).toEqual({
          "review-only": [["query", "review"], {}],
          "ralph-only": [["coding"], { long: 1 }],
          "triage-only": [["query"], { short: 3 }],
          everything: [["coding", "query", "review"], { short: 2, long: 1 }],
          nothing: [[], {}],
        });

        const { rows: pools } = await client.query<{ organization_id: string; name: string }>(
          `select organization_id, name from pools order by organization_id, name`,
        );
        expect(pools).toEqual(
          [acme, globex].toSorted().flatMap((org) => [
            { organization_id: org, name: "long" },
            { organization_id: org, name: "short" },
          ]),
        );
        await expect(
          client.query(`insert into pools (organization_id, name) values ($1, 'short')`, [acme]),
        ).rejects.toThrow(/pools_organization_name_uq/);

        // New rows need a valid task type, and a pool exactly when not `system`.
        await expect(
          client.query(
            `insert into jobs (organization_id, type, task_type, pool)
             values ($1, 'review.run', 'deploy', 'short')`,
            [acme],
          ),
        ).rejects.toThrow(/jobs_task_type_valid/);
        await expect(
          client.query(
            `insert into jobs (organization_id, type, task_type)
             values ($1, 'review.run', 'review')`,
            [acme],
          ),
        ).rejects.toThrow(/jobs_pool_system_only_null/);

        const { rows: indexes } = await client.query<{ indexdef: string }>(
          `select indexdef from pg_indexes where indexname in ('jobs_claim_queued_idx', 'jobs_claim_lease_idx')`,
        );
        expect(indexes).toHaveLength(2);
        expect(indexes.every((i) => i.indexdef.includes("task_type"))).toBe(true);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("makes harnesses inherit the organization defaults (0075)", async () => {
    await db.execute(sql`create database harness_defaults`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/harness_defaults");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0075_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const acme = orgs[0]!.id;
        await client.query(
          `insert into harnesses (organization_id, name) values ($1, 'defaults')`,
          [acme],
        );
        await client.query(
          `insert into harnesses (organization_id, name, max_concurrency, accepted_task_types, pool_limits)
           values ($1, 'configured', 3, '{review,coding}', '{"long": 1, "short": 2}')`,
          [acme],
        );

        await migrateBefore(uri, "0103_");
        // 0102 then turned the inherited (null) task types into every type, as reported.
        const all = ["query", "review", "coding"];
        const { rows } = await client.query<{
          name: string;
          max_concurrency: number | null;
          reported_accepted_task_types: string[] | null;
          pool_limits: Record<string, number>;
        }>(
          `select name, max_concurrency, reported_accepted_task_types, pool_limits from harnesses order by name`,
        );
        expect(rows).toEqual([
          {
            name: "configured",
            max_concurrency: null,
            reported_accepted_task_types: all,
            pool_limits: {},
          },
          {
            name: "defaults",
            max_concurrency: null,
            reported_accepted_task_types: all,
            pool_limits: {},
          },
        ]);

        // New harnesses inherit too: no column default.
        const { rows: added } = await client.query<{ max_concurrency: number | null }>(
          `insert into harnesses (organization_id, name) values ($1, 'new')
           returning max_concurrency`,
          [acme],
        );
        expect(added).toEqual([{ max_concurrency: null }]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("makes repositories inherit the organization's task types (0076)", async () => {
    await db.execute(sql`create database repository_defaults`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/repository_defaults");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0076_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        const connection = connections[0]!.id;
        await client.query(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', '1', 'acme/defaults', $2)`,
          [org, connection],
        );
        await client.query(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id, enabled, ralph_enabled)
           values ($1, 'github', '2', 'acme/configured', $2, false, true)`,
          [org, connection],
        );

        await runMigrations(uri);
        // 0076 made every switch inherit (null); 0101 then turned each into the organization's
        // default, which (with no `tasks.allowedTypes`) is on.
        const { rows } = await client.query<{
          full_path: string;
          reviews_enabled: boolean;
          coding_enabled: boolean;
          ask_enabled: boolean;
        }>(
          `select full_path, reviews_enabled, coding_enabled, ask_enabled from repositories order by full_path`,
        );
        expect(rows).toEqual([
          {
            full_path: "acme/configured",
            reviews_enabled: true,
            coding_enabled: true,
            ask_enabled: true,
          },
          {
            full_path: "acme/defaults",
            reviews_enabled: true,
            coding_enabled: true,
            ask_enabled: true,
          },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("moves every repository to the tasks coding path, keeping its tasks, and cancels active legacy coding jobs (0092)", async () => {
    await db.execute(sql`create database repository_coding_path`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/repository_coding_path");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0092_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        const connection = connections[0]!.id;
        // Production-shaped: most repositories on the legacy jobs with the default tasks, a few on tasks.
        await client.query(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id, coding_path)
           values ($1, 'github', '1', 'acme/legacy', $2, 'legacy')`,
          [org, connection],
        );
        await client.query(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id, coding_path, story_task_id, request_task_id)
           values ($1, 'github', '2', 'acme/tasks', $2, 'tasks', 'builtin:implement-story', 'builtin:handle-request')`,
          [org, connection],
        );
        // Active legacy jobs never run again; finished ones and task runs stay as they are.
        await client.query(
          `insert into jobs (organization_id, type, task_type, pool, task_id, status, payload, dedupe_key) values
             ($1, 'ralph.story', 'coding', 'long', null, 'running', '{}', 'legacy-story'),
             ($1, 'ralph.request', 'coding', 'long', null, 'queued', '{}', 'legacy-request'),
             ($1, 'ralph.describe-pr', 'query', 'short', null, 'queued', '{}', 'legacy-describe'),
             ($1, 'ralph.story', 'coding', 'long', null, 'completed', '{}', 'legacy-done'),
             ($1, 'ralph.story', 'coding', 'long', 'builtin:implement-story', 'queued', '{}', 'task-story'),
             ($1, 'ralph.cleanup', 'coding', 'long', null, 'queued', '{}', 'legacy-cleanup')`,
          [org],
        );

        await runMigrations(uri);
        const { rows: jobRows } = await client.query(
          `select dedupe_key, status, cancel_requested, error is not null as has_error from jobs order by dedupe_key`,
        );
        expect(jobRows).toEqual([
          {
            dedupe_key: "legacy-cleanup",
            status: "queued",
            cancel_requested: false,
            has_error: false,
          },
          {
            dedupe_key: "legacy-describe",
            status: "canceled",
            cancel_requested: true,
            has_error: true,
          },
          {
            dedupe_key: "legacy-done",
            status: "completed",
            cancel_requested: false,
            has_error: false,
          },
          {
            dedupe_key: "legacy-request",
            status: "canceled",
            cancel_requested: true,
            has_error: true,
          },
          {
            dedupe_key: "legacy-story",
            status: "canceled",
            cancel_requested: true,
            has_error: true,
          },
          { dedupe_key: "task-story", status: "queued", cancel_requested: false, has_error: false },
        ]);
        const { rows } = await client.query<Record<string, unknown>>(
          `select * from repositories order by full_path`,
        );
        expect(
          rows.map((r) => ({
            full_path: r.full_path,
            story_playbook_id: r.story_playbook_id,
            request_playbook_id: r.request_playbook_id,
          })),
        ).toEqual([
          {
            full_path: "acme/legacy",
            story_playbook_id: "builtin:implement-story",
            request_playbook_id: "builtin:handle-request",
          },
          {
            full_path: "acme/tasks",
            story_playbook_id: "builtin:implement-story",
            request_playbook_id: "builtin:handle-request",
          },
        ]);
        for (const row of rows) expect(row).not.toHaveProperty("coding_path");
        const { rows: types } = await client.query(
          `select 1 from pg_type where typname = 'repository_coding_path'`,
        );
        expect(types).toEqual([]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("drops the stored pools: jobs and tasks keep their task type, pools follow from it (0093)", async () => {
    await db.execute(sql`create database job_pools`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/job_pools");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0093_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        // Production-shaped: the seeded pools, and jobs of each kind with their stored pool.
        await client.query(
          `insert into pools (organization_id, name) values ($1, 'short'), ($1, 'long')`,
          [org],
        );
        await client.query(
          `insert into jobs (organization_id, type, task_type, pool, task_id, status) values
             ($1, 'ralph.story', 'coding', 'long', 'builtin:implement-story', 'running'),
             ($1, 'chat.ask', 'query', 'short', null, 'queued'),
             ($1, 'review.task', 'review', 'short', 'builtin:review-pr', 'completed'),
             ($1, 'repo.sync', 'system', null, null, 'queued')`,
          [org],
        );
        await client.query(
          `insert into task_definitions (organization_id, name, definition)
           values ($1, 'Custom', '{"name": "Custom", "taskType": "query", "pool": "short"}')`,
          [org],
        );

        // Up to 0097, which drops the task definitions (and refuses a custom one).
        const playbooks = journal.entries.findIndex((e) => e.tag.startsWith("0097_"));
        writeFileSync(
          journalPath,
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, playbooks) }),
        );
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: definitions } = await client.query<{ definition: unknown }>(
          `select definition from task_definitions`,
        );
        expect(definitions).toEqual([{ definition: { name: "Custom", taskType: "query" } }]);
        const { rows } = await client.query<Record<string, unknown>>(
          `select * from jobs order by type`,
        );
        expect(rows.map((r) => [r.type, r.task_type, r.task_id, r.status])).toEqual([
          ["chat.ask", "query", null, "queued"],
          ["ralph.story", "coding", "builtin:implement-story", "running"],
          ["repo.sync", "system", null, "queued"],
          ["review.task", "review", "builtin:review-pr", "completed"],
        ]);
        for (const row of rows) expect(row).not.toHaveProperty("pool");
        const { rows: tables } = await client.query(
          `select 1 from information_schema.tables where table_name = 'pools'`,
        );
        expect(tables).toEqual([]);
        const { rows: constraints } = await client.query(
          `select 1 from pg_constraint where conname = 'jobs_pool_system_only_null'`,
        );
        expect(constraints).toEqual([]);
        // New jobs carry no pool; the task type check stays.
        await client.query(
          `insert into jobs (organization_id, type, task_type) values ($1, 'review.task', 'review')`,
          [org],
        );
        await expect(
          client.query(
            `insert into jobs (organization_id, type, task_type) values ($1, 'review.task', 'deploy')`,
            [org],
          ),
        ).rejects.toThrow(/jobs_task_type_valid/);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  describe("review depth replaces review profiles (0094)", () => {
    /** A database migrated up to just before 0094, with a connection per organization. */
    async function beforeReviewDepth(name: string) {
      await db.execute(sql.raw(`create database ${name}`));
      const uri = testDb.uri.replace(/\/[^/]*$/, `/${name}`);
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0094_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      await migrate(drizzle(client), { migrationsFolder: before });

      /** An organization with the three built-in profiles, as production has them. */
      const organization = async (orgName: string) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into organizations (name) values ($1) returning id`,
          [orgName],
        );
        const org = rows[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, description, model, max_tokens_per_review, max_files, allow_repo_exploration, built_in) values
             ($1, 'quick', 'Quick', 'Fast, diff-only review for small changes.', 'claude-haiku-5-5', 60000, 15, false, true),
             ($1, 'standard', 'Standard', 'Balanced review with repository exploration.', 'claude-sonnet-5-5', 200000, 40, true, true),
             ($1, 'deep', 'Deep', 'Thorough review for large or high-risk changes.', 'claude-opus-5-5', 500000, 100, true, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        return { org, connection: connections[0]!.id };
      };
      const cleanup = async () => {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      };
      return { uri, client, organization, cleanup };
    }

    it("moves each repository to its profile's depth and keeps the depth of past runs", async () => {
      const { uri, client, organization, cleanup } = await beforeReviewDepth("review_depth");
      try {
        const acme = await organization("Acme");
        const globex = await organization("Globex");
        const repository = async (
          { org, connection }: { org: string; connection: string },
          path: string,
          profile: string,
        ) => {
          const { rows } = await client.query<{ id: string }>(
            `insert into repositories (organization_id, provider, external_id, full_path, connection_id, profile_id)
             values ($1, 'github', $2, $2, $3, $4) returning id`,
            [org, path, connection, profile],
          );
          return rows[0]!.id;
        };
        const api = await repository(acme, "acme/api", "standard");
        await repository(acme, "acme/web", "standard");
        await repository(globex, "globex/app", "standard");
        await repository(globex, "globex/core", "deep");
        // Past review runs and their reviews, all on Standard.
        const { rows: runs } = await client.query<{ id: string }>(
          `insert into review_runs (organization_id, repository_id, pr_number, head_sha, base_sha, trigger, mode, profile_id, profile_name, status)
           values ($1, $2, 7, $3, $4, 'webhook', 'full', 'standard', 'Standard', 'completed'),
                  ($1, $2, 8, $3, $4, 'mention', 'incremental', 'standard', 'Standard', 'failed')
           returning id`,
          [acme.org, api, "a".repeat(40), "b".repeat(40)],
        );
        await client.query(
          `insert into reviews (review_run_id, repository_id, pr_number, head_sha, base_sha, trigger, status, profile_id, budget)
           values ($1, $2, 7, $3, $4, 'webhook', 'completed', 'standard', 200000)`,
          [runs[0]!.id, api, "a".repeat(40), "b".repeat(40)],
        );

        await runMigrations(uri);

        const { rows: repos } = await client.query<Record<string, unknown>>(
          `select * from repositories order by full_path`,
        );
        expect(repos.map((r) => [r.full_path, r.review_depth])).toEqual([
          ["acme/api", "standard"],
          ["acme/web", "standard"],
          ["globex/app", "standard"],
          ["globex/core", "deep"],
        ]);
        for (const row of repos) expect(row).not.toHaveProperty("profile_id");
        const { rows: runRows } = await client.query<Record<string, unknown>>(
          `select * from review_runs order by pr_number`,
        );
        expect(runRows.map((r) => [r.pr_number, r.depth])).toEqual([
          [7, "standard"],
          [8, "standard"],
        ]);
        for (const row of runRows) {
          expect(row).not.toHaveProperty("profile_id");
          expect(row).not.toHaveProperty("profile_name");
        }
        const { rows: reviewRows } =
          await client.query<Record<string, unknown>>(`select * from reviews`);
        expect(reviewRows.map((r) => r.depth)).toEqual(["standard"]);
        expect(reviewRows[0]).not.toHaveProperty("profile_id");
        const { rows: tables } = await client.query(
          `select 1 from information_schema.tables where table_name = 'review_profiles'`,
        );
        expect(tables).toEqual([]);

        // A new repository starts on Standard, and only the three depths exist.
        const { rows: created } = await client.query<{ review_depth: string }>(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', 'new', 'acme/new', $2) returning review_depth`,
          [acme.org, acme.connection],
        );
        expect(created[0]!.review_depth).toBe("standard");
        await expect(
          client.query(`update repositories set review_depth = 'thorough' where id = $1`, [api]),
        ).rejects.toThrow();
      } finally {
        await cleanup();
      }
    });

    it("refuses to drop a profile that differs from its built-in values", async () => {
      const { uri, client, organization, cleanup } = await beforeReviewDepth("review_depth_edited");
      try {
        const acme = await organization("Acme");
        await organization("Globex");
        await client.query(
          `update review_profiles set model = 'claude-opus-5-5' where organization_id = $1 and id = 'quick'`,
          [acme.org],
        );
        await client.query(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id, profile_id)
           values ($1, 'github', '1', 'acme/api', $2, 'quick')`,
          [acme.org, acme.connection],
        );

        await expect(runMigrations(uri)).rejects.toMatchObject({
          cause: {
            message: `Review profiles differ from the built-in depths and would be lost: organization ${acme.org} profile 'quick'`,
          },
        });
        // Nothing was converted or dropped.
        const { rows } = await client.query<{ profile_id: string }>(
          `select profile_id from repositories`,
        );
        expect(rows).toEqual([{ profile_id: "quick" }]);
        const { rows: profiles } = await client.query(`select 1 from review_profiles`);
        expect(profiles).toHaveLength(6);
      } finally {
        await cleanup();
      }
    });

    it("refuses to drop a profile that isn't built in", async () => {
      const { uri, client, organization, cleanup } = await beforeReviewDepth("review_depth_custom");
      try {
        const acme = await organization("Acme");
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'thorough', 'Thorough', 'claude-opus-5-5', 900000, 200, true)`,
          [acme.org],
        );

        await expect(runMigrations(uri)).rejects.toMatchObject({
          cause: {
            message: expect.stringContaining(`organization ${acme.org} profile 'thorough'`),
          },
        });
      } finally {
        await cleanup();
      }
    });
  });

  describe("playbooks replace agent and task definitions (0097)", () => {
    /** A database migrated up to just before 0097, with one production-shaped organization. */
    async function beforePlaybooks(name: string) {
      await db.execute(sql.raw(`create database ${name}`));
      const uri = testDb.uri.replace(/\/[^/]*$/, `/${name}`);
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0097_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      await migrate(drizzle(client), { migrationsFolder: before });

      const { rows } = await client.query<{ id: string }>(
        `insert into organizations (name) values ('Acme') returning id`,
      );
      const org = rows[0]!.id;
      const { rows: connections } = await client.query<{ id: string }>(
        `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
         values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
        [org],
      );
      const connection = connections[0]!.id;
      // Production: every repository on the built-in defaults, chat tasks on built-ins too.
      await client.query(
        `insert into repositories (organization_id, provider, external_id, full_path, connection_id) values
           ($1, 'github', '1', 'acme/api', $2),
           ($1, 'github', '2', 'acme/web', $2)`,
        [org, connection],
      );
      await client.query(
        `insert into app_settings (organization_id, key, value)
         values ($1, 'chat.tasks', '{"askAboutCode":"builtin:ask-about-code","startWork":"builtin:handle-request"}')`,
        [org],
      );
      const cleanup = async () => {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      };
      return { uri, client, org, connection, cleanup };
    }

    it("drops the empty definition tables and keeps every repo's built-in bindings", async () => {
      const { uri, client, cleanup } = await beforePlaybooks("playbooks_production");
      try {
        await runMigrations(uri);

        const { rows: repos } = await client.query<Record<string, unknown>>(
          `select * from repositories order by full_path`,
        );
        expect(
          repos.map((r) => [
            r.full_path,
            r.review_playbook_ids,
            r.correlation_playbook_id,
            r.story_playbook_id,
            r.request_playbook_id,
          ]),
        ).toEqual([
          [
            "acme/api",
            ["builtin:review-pr"],
            "builtin:correlate-findings",
            "builtin:implement-story",
            "builtin:handle-request",
          ],
          [
            "acme/web",
            ["builtin:review-pr"],
            "builtin:correlate-findings",
            "builtin:implement-story",
            "builtin:handle-request",
          ],
        ]);
        for (const row of repos) {
          for (const old of [
            "review_task_ids",
            "correlation_task_id",
            "story_task_id",
            "request_task_id",
          ]) {
            expect(row).not.toHaveProperty(old);
          }
        }
        const { rows: tables } = await client.query<{ table_name: string }>(
          `select table_name from information_schema.tables
           where table_schema = 'public' and table_name in ('agent_definitions', 'task_definitions', 'playbooks')`,
        );
        expect(tables).toEqual([{ table_name: "playbooks" }]);
        // The built-in chat choice is kept (as `chat.playbooks` from 0099).
        const { rows: chat } = await client.query(
          `select value from app_settings where key = 'chat.playbooks'`,
        );
        expect(chat).toEqual([
          { value: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" } },
        ]);
      } finally {
        await cleanup();
      }
    });

    it("refuses to drop a custom task and names it", async () => {
      const { uri, client, org, cleanup } = await beforePlaybooks("playbooks_custom_task");
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into task_definitions (organization_id, name, definition) values ($1, 'Security review', '{}') returning id`,
          [org],
        );

        await expect(runMigrations(uri)).rejects.toMatchObject({
          cause: {
            message: `Custom agent and task definitions would be lost: organization ${org} task definition ${rows[0]!.id}`,
          },
        });
        // Nothing was dropped or renamed.
        const { rows: tasks } = await client.query(`select 1 from task_definitions`);
        expect(tasks).toHaveLength(1);
        const { rows: columns } = await client.query(
          `select 1 from information_schema.columns where table_name = 'repositories' and column_name = 'story_task_id'`,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it("refuses to drop a custom agent and names it", async () => {
      const { uri, client, org, cleanup } = await beforePlaybooks("playbooks_custom_agent");
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into agent_definitions (organization_id, name, definition) values ($1, 'Security reviewer', '{}') returning id`,
          [org],
        );

        await expect(runMigrations(uri)).rejects.toMatchObject({
          cause: {
            message: `Custom agent and task definitions would be lost: organization ${org} agent definition ${rows[0]!.id}`,
          },
        });
        const { rows: agents } = await client.query(`select 1 from agent_definitions`);
        expect(agents).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });

    it("refuses to drop when a repo, chat setting or channel override names a custom ID", async () => {
      const { uri, client, org, cleanup } = await beforePlaybooks("playbooks_custom_bindings");
      try {
        const custom = "11111111-1111-4111-8111-111111111111";
        const { rows: repos } = await client.query<{ id: string }>(
          `update repositories set review_task_ids = $1, request_task_id = $2
           where full_path = 'acme/api' returning id`,
          [["builtin:review-pr", custom], custom],
        );
        await client.query(`update app_settings set value = $1 where key = 'chat.tasks'`, [
          { askAboutCode: custom },
        ]);
        const { rows: chatConnections } = await client.query<{ id: string }>(
          `insert into chat_connections (organization_id, platform, external_id, name, encrypted_credentials)
           values ($1, 'slack', 'T1', 'Slack', 'x') returning id`,
          [org],
        );
        const { rows: overrides } = await client.query<{ id: string }>(
          `insert into chat_channel_task_settings (organization_id, connection_id, channel_id, start_work_task_id)
           values ($1, $2, 'C1', $3) returning id`,
          [org, chatConnections[0]!.id, custom],
        );

        const repo = repos[0]!.id;
        await expect(runMigrations(uri)).rejects.toMatchObject({
          cause: {
            message: `Custom agent and task definitions would be lost: ${[
              `chat channel override ${overrides[0]!.id} start work task '${custom}'`,
              `organization ${org} chat task askAboutCode '${custom}'`,
              `repository ${repo} request task '${custom}'`,
              `repository ${repo} review task '${custom}'`,
            ]
              .sort()
              .join(", ")}`,
          },
        });
      } finally {
        await cleanup();
      }
    });
  });

  describe("repo coding policy columns replace ralph_settings (0098)", () => {
    /** Every key of `ralph_settings` at its default, as production stores it. */
    const DEFAULT_BLOB = {
      verifyCommands: [],
      runPrdQualityGates: true,
      appendInstruction: null,
      allowedTools: null,
      disallowedTools: null,
      model: "opus",
      fallbackModel: null,
      allowPreparation: true,
      manualLabels: ["manual"],
      blockedLabels: ["under-review", "blocked"],
      historyRewrite: "when-asked",
      respondToReviews: true,
      maxReviewRounds: 3,
      respondToCiFailures: true,
      maxFixRounds: 3,
      cleanupMergedWorktrees: true,
      unmergedBranchTimeoutMinutes: 60,
      epicCompletedState: null,
      openPullRequestEarly: false,
      setupCommand: null,
    };
    const REBASE = "NEVER use `git merge` in this repo, ALWAYS rebase.";
    const RELEASE_NOTE =
      "Every user-facing change needs a release note: add a changeset with `pnpm changeset`.";

    /** A database migrated up to just before 0098, with a repo per `ralph_settings` blob. */
    async function beforeCodingPolicy(name: string, blobs: Record<string, unknown>[]) {
      await db.execute(sql.raw(`create database ${name}`));
      const uri = testDb.uri.replace(/\/[^/]*$/, `/${name}`);
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0098_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      await migrate(drizzle(client), { migrationsFolder: before });

      const { rows } = await client.query<{ id: string }>(
        `insert into organizations (name) values ('Acme') returning id`,
      );
      const org = rows[0]!.id;
      const { rows: connections } = await client.query<{ id: string }>(
        `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
         values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
        [org],
      );
      const repos: string[] = [];
      for (const [index, blob] of blobs.entries()) {
        const { rows: inserted } = await client.query<{ id: string }>(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id, ralph_settings)
           values ($1, 'github', $2, $3, $4, $5) returning id`,
          [org, String(index + 1), `acme/repo-${index + 1}`, connections[0]!.id, blob],
        );
        repos.push(inserted[0]!.id);
      }
      const cleanup = async () => {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      };
      return { uri, client, repos, cleanup };
    }

    it("converts the production blobs into the coding policy columns", async () => {
      const { uri, client, cleanup } = await beforeCodingPolicy("coding_policy_production", [
        { ...DEFAULT_BLOB, historyRewrite: "always", appendInstruction: REBASE },
        DEFAULT_BLOB,
        DEFAULT_BLOB,
        { ...DEFAULT_BLOB, openPullRequestEarly: true, appendInstruction: RELEASE_NOTE },
        // One review switch off still responds (CI is on); both off turns it off.
        { ...DEFAULT_BLOB, respondToReviews: false },
        { ...DEFAULT_BLOB, respondToReviews: false, respondToCiFailures: false },
        // An old row without most keys gets the defaults.
        { model: "opus" },
      ]);
      try {
        await runMigrations(uri);

        const { rows } = await client.query<Record<string, unknown>>(
          `select * from repositories order by full_path`,
        );
        expect(
          rows.map((r) => [
            r.full_path,
            r.coding_instructions,
            r.open_pull_request_early,
            r.history_rewrite,
            r.respond_to_reviews_and_ci,
          ]),
        ).toEqual([
          ["acme/repo-1", REBASE, false, "always", true],
          ["acme/repo-2", null, false, "when-asked", true],
          ["acme/repo-3", null, false, "when-asked", true],
          ["acme/repo-4", RELEASE_NOTE, true, "when-asked", true],
          ["acme/repo-5", null, false, "when-asked", true],
          ["acme/repo-6", null, false, "when-asked", false],
          ["acme/repo-7", null, false, "when-asked", true],
        ]);
        for (const row of rows) expect(row).not.toHaveProperty("ralph_settings");
      } finally {
        await cleanup();
      }
    });

    it("refuses to drop a setting that differs from its default and names the repo and key", async () => {
      const { uri, client, repos, cleanup } = await beforeCodingPolicy("coding_policy_custom", [
        DEFAULT_BLOB,
        { ...DEFAULT_BLOB, model: "sonnet", maxFixRounds: 3, blockedLabels: ["blocked"] },
      ]);
      try {
        await expect(runMigrations(uri)).rejects.toMatchObject({
          cause: {
            message: `Repo coding settings differ from the defaults and would be lost: repository ${repos[1]} (acme/repo-2) key blockedLabels, repository ${repos[1]} (acme/repo-2) key model`,
          },
        });
        // Nothing was converted or dropped.
        const { rows: columns } = await client.query(
          `select 1 from information_schema.columns where table_name = 'repositories' and column_name = 'ralph_settings'`,
        );
        expect(columns).toHaveLength(1);
      } finally {
        await cleanup();
      }
    });
  });

  describe("chat tasks become chat playbooks (0099)", () => {
    it("converts the organization's choice and renames the channel override columns", async () => {
      const name = "chat_playbooks";
      await db.execute(sql.raw(`create database ${name}`));
      const uri = testDb.uri.replace(/\/[^/]*$/, `/${name}`);
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0099_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme'), ('Beta'), ('Gamma') returning id`,
        );
        const [acme, beta, gamma] = orgs.map((o) => o.id) as [string, string, string];
        await client.query(
          `insert into app_settings (organization_id, key, value) values
             ($1, 'chat.tasks', '{"askAboutCode":"builtin:ask-about-code","startWork":"builtin:handle-request"}'),
             ($2, 'chat.tasks', '{"startWork":"builtin:handle-request","askAboutCode":7}'),
             ($3, 'chat.tasks', '{"askAboutCode":null}'),
             ($1, 'harness.maxConcurrency', '2')`,
          [acme, beta, gamma],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into chat_connections (organization_id, platform, external_id, name, encrypted_credentials)
           values ($1, 'slack', 'T1', 'Slack', 'x') returning id`,
          [acme],
        );
        await client.query(
          `insert into chat_channel_task_settings (organization_id, connection_id, channel_id, ask_about_code_task_id, start_work_task_id)
           values ($1, $2, 'slack:C1', 'builtin:ask-about-code', null),
                  ($1, $2, 'slack:C2', null, 'builtin:handle-request')`,
          [acme, connections[0]!.id],
        );

        await migrateBefore(uri, "0103_");

        const { rows: settings } = await client.query<{
          organization_id: string;
          key: string;
          value: unknown;
        }>(
          `select organization_id, key, value from app_settings
           where key like 'chat.%' or key = 'harness.maxConcurrency' order by key, organization_id`,
        );
        expect(settings).toEqual(
          [
            {
              organization_id: acme,
              key: "chat.playbooks",
              value: { ask: "builtin:ask-about-code", startWork: "builtin:handle-request" },
            },
            // A field that isn't an ID was the built-in default: it is left out.
            {
              organization_id: beta,
              key: "chat.playbooks",
              value: { startWork: "builtin:handle-request" },
            },
            // Gamma chose nothing: no row. Other settings are untouched.
            { organization_id: acme, key: "harness.maxConcurrency", value: 2 },
          ].sort((a, b) =>
            a.key === b.key
              ? Number(a.organization_id > b.organization_id) - 0.5
              : Number(a.key > b.key) - 0.5,
          ),
        );
        const { rows: overrides } = await client.query(
          `select channel_id, ask_playbook_id, start_work_playbook_id
           from chat_channel_task_settings order by channel_id`,
        );
        expect(overrides).toEqual([
          {
            channel_id: "slack:C1",
            ask_playbook_id: "builtin:ask-about-code",
            start_work_playbook_id: null,
          },
          {
            channel_id: "slack:C2",
            ask_playbook_id: null,
            start_work_playbook_id: "builtin:handle-request",
          },
        ]);
      } finally {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      }
    });
  });

  describe("repository switches stop inheriting (0101)", () => {
    it("turns each null switch into the organization's allowed task types, keeping explicit ones", async () => {
      await db.execute(sql`create database repository_switches`);
      const uri = testDb.uri.replace(/\/[^/]*$/, "/repository_switches");
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      const client = new pg.Client({ connectionString: uri });
      try {
        cpSync(migrationsFolder, before, { recursive: true });
        const journalPath = join(before, "meta", "_journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          entries: { tag: string }[];
        };
        const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0101_"));
        writeFileSync(
          journalPath,
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
        );
        await client.connect();
        await migrate(drizzle(client), { migrationsFolder: before });

        /** An organization (with `allowedTypes` when given) and its repositories' own switches. */
        const organization = async (
          name: string,
          allowedTypes: unknown,
          repos: { path: string; enabled?: boolean; ralph?: boolean; query?: boolean }[],
        ) => {
          const { rows } = await client.query<{ id: string }>(
            `insert into organizations (name) values ($1) returning id`,
            [name],
          );
          const org = rows[0]!.id;
          if (allowedTypes !== undefined) {
            await client.query(
              `insert into app_settings (organization_id, key, value) values ($1, 'tasks.allowedTypes', $2)`,
              [org, JSON.stringify(allowedTypes)],
            );
          }
          const { rows: connections } = await client.query<{ id: string }>(
            `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
             values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
            [org],
          );
          for (const repo of repos) {
            await client.query(
              `insert into repositories (organization_id, provider, external_id, full_path, connection_id, enabled, ralph_enabled, query_enabled)
               values ($1, 'github', $2, $2, $3, $4, $5, $6)`,
              [
                org,
                repo.path,
                connections[0]!.id,
                repo.enabled ?? null,
                repo.ralph ?? null,
                repo.query ?? null,
              ],
            );
          }
        };
        // Production: no setting and every switch null, no work item match anywhere.
        await organization("Production", undefined, [
          { path: "prod/a" },
          { path: "prod/b" },
          { path: "prod/c" },
        ]);
        await organization(
          "Reviews only",
          ["review"],
          [{ path: "reviews/inheriting" }, { path: "reviews/coding", ralph: true }],
        );
        // Explicit values are kept; a setting that isn't a list of task types counts as absent.
        await organization(
          "Explicit",
          ["query", "coding"],
          [
            { path: "explicit/off", enabled: false, ralph: false, query: false },
            { path: "explicit/on", enabled: true },
          ],
        );
        await organization("Malformed", ["review", "bogus"], [{ path: "malformed/repo" }]);

        await runMigrations(uri);
        const { rows } = await client.query<{
          full_path: string;
          reviews_enabled: boolean;
          coding_enabled: boolean;
          ask_enabled: boolean;
        }>(
          `select full_path, reviews_enabled, coding_enabled, ask_enabled from repositories order by full_path`,
        );
        const switches = Object.fromEntries(
          rows.map((r) => [
            r.full_path,
            { review: r.reviews_enabled, coding: r.coding_enabled, ask: r.ask_enabled },
          ]),
        );
        expect(switches).toEqual({
          "prod/a": { review: true, coding: true, ask: true },
          "prod/b": { review: true, coding: true, ask: true },
          "prod/c": { review: true, coding: true, ask: true },
          "reviews/inheriting": { review: true, coding: false, ask: false },
          "reviews/coding": { review: true, coding: true, ask: false },
          "explicit/off": { review: false, coding: false, ask: false },
          "explicit/on": { review: true, coding: true, ask: true },
          "malformed/repo": { review: true, coding: true, ask: true },
        });
        // Production repos keep Coding on without a work item match.
        const { rows: matches } = await client.query(`select 1 from work_item_matches`);
        expect(matches).toEqual([]);

        // The old columns are gone; the new ones are not null with defaults.
        const { rows: columns } = await client.query<{
          column_name: string;
          is_nullable: string;
          column_default: string | null;
        }>(
          `select column_name, is_nullable, column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'repositories'
             and column_name in ('enabled', 'ralph_enabled', 'query_enabled', 'reviews_enabled', 'coding_enabled', 'ask_enabled')
           order by column_name`,
        );
        expect(columns).toEqual([
          { column_name: "ask_enabled", is_nullable: "NO", column_default: "true" },
          { column_name: "coding_enabled", is_nullable: "NO", column_default: "false" },
          { column_name: "reviews_enabled", is_nullable: "NO", column_default: "true" },
        ]);
        // New repositories: Reviews on, Coding off, Ask on.
        const { rows: orgs } = await client.query<{ id: string; connection: string }>(
          `select o.id, c.id as connection from organizations o
           join scm_connections c on c.organization_id = o.id where o.name = 'Production'`,
        );
        const { rows: added } = await client.query(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', 'new', 'prod/new', $2)
           returning reviews_enabled, coding_enabled, ask_enabled`,
          [orgs[0]!.id, orgs[0]!.connection],
        );
        expect(added).toEqual([
          { reviews_enabled: true, coding_enabled: false, ask_enabled: true },
        ]);
        await expect(
          client.query(`update repositories set coding_enabled = null where full_path = 'prod/a'`),
        ).rejects.toThrow(/null value/);
      } finally {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      }
    });
  });

  describe("agents report their accepted task types (0102)", () => {
    it("fills the reported task types from each agent's own value, else its organization's, else all", async () => {
      await db.execute(sql`create database reported_task_types`);
      const uri = testDb.uri.replace(/\/[^/]*$/, "/reported_task_types");
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      const client = new pg.Client({ connectionString: uri });
      try {
        cpSync(migrationsFolder, before, { recursive: true });
        const journalPath = join(before, "meta", "_journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          entries: { tag: string }[];
        };
        const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0102_"));
        writeFileSync(
          journalPath,
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
        );
        await client.connect();
        await migrate(drizzle(client), { migrationsFolder: before });

        /** An organization (with `allowedTypes` when given) and its agents' own task types. */
        const organization = async (
          name: string,
          allowedTypes: unknown,
          agents: { name: string; accepted?: string[]; deleted?: boolean }[],
        ) => {
          const { rows } = await client.query<{ id: string }>(
            `insert into organizations (name) values ($1) returning id`,
            [name],
          );
          const org = rows[0]!.id;
          await client.query(
            `insert into app_settings (organization_id, key, value) values ($1, 'harness.maxConcurrency', '2')`,
            [org],
          );
          if (allowedTypes !== undefined) {
            await client.query(
              `insert into app_settings (organization_id, key, value) values ($1, 'tasks.allowedTypes', $2)`,
              [org, JSON.stringify(allowedTypes)],
            );
          }
          for (const agent of agents) {
            await client.query(
              `insert into harnesses (organization_id, name, accepted_task_types, revoked_at, deleted_at)
               values ($1, $2, $3, $4, $4)`,
              [org, agent.name, agent.accepted ?? null, agent.deleted ? new Date() : null],
            );
          }
        };
        // Production: 9 agents, all inheriting (null), 2 of them soft-deleted; no setting.
        await organization(
          "Production",
          undefined,
          Array.from({ length: 9 }, (_, i) => ({ name: `prod-${i + 1}`, deleted: i >= 7 })),
        );
        // The organization's setting (kept in task type order), and an agent's own value.
        await organization(
          "Allowed",
          ["coding", "query"],
          [
            { name: "allowed-inheriting" },
            { name: "allowed-own", accepted: ["review"] },
            { name: "allowed-deleted", deleted: true },
          ],
        );
        await organization("Malformed", ["review", "bogus"], [{ name: "malformed-agent" }]);

        await migrateBefore(uri, "0103_");
        const { rows } = await client.query<{
          name: string;
          reported_accepted_task_types: string[] | null;
        }>(`select name, reported_accepted_task_types from harnesses order by name`);
        const all = ["query", "review", "coding"];
        expect(
          Object.fromEntries(rows.map((r) => [r.name, r.reported_accepted_task_types])),
        ).toEqual({
          ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`prod-${i + 1}`, all])),
          "allowed-inheriting": ["query", "coding"],
          "allowed-own": ["review"],
          "allowed-deleted": ["query", "coding"],
          "malformed-agent": all,
        });

        // The old column and the organization setting are gone; other settings stay.
        const { rows: columns } = await client.query(
          `select column_name from information_schema.columns
           where table_schema = 'public' and table_name = 'harnesses'
             and column_name in ('accepted_task_types', 'reported_accepted_task_types')`,
        );
        expect(columns).toEqual([{ column_name: "reported_accepted_task_types" }]);
        const { rows: settings } = await client.query<{ key: string }>(
          `select key from app_settings order by key`,
        );
        expect(settings.map((r) => r.key)).toEqual([
          "harness.maxConcurrency",
          "harness.maxConcurrency",
          "harness.maxConcurrency",
        ]);
        // A new agent has reported nothing yet.
        const { rows: added } = await client.query(
          `insert into harnesses (organization_id, name)
           select id, 'new' from organizations where name = 'Production'
           returning reported_accepted_task_types`,
        );
        expect(added).toEqual([{ reported_accepted_task_types: null }]);
      } finally {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      }
    });
  });

  describe("harnesses become agents (0103)", () => {
    /** A database migrated up to just before 0103. */
    async function beforeAgents(name: string) {
      await db.execute(sql.raw(`create database ${name}`));
      const uri = testDb.uri.replace(/\/[^/]*$/, `/${name}`);
      await migrateBefore(uri, "0103_");
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      return { uri, client };
    }

    /** Each table's rows, read by its names before (`harness`) and after (`agent`) 0103. */
    const snapshot = async (client: pg.Client, renamed: boolean) => {
      const n = (s: string) =>
        renamed ? s.replaceAll("harnesses", "agents").replaceAll("harness", "agent") : s;
      const read = async (query: string) =>
        (await client.query(n(query))).rows as Record<string, unknown>[];
      // The columns 0103 resets, compared on their own, and the ones later migrations add
      // (`reported_host`, 0108).
      const reset = `'failed_versions' - 'update_state' - 'update_request_id'
        - 'update_request_version' - 'update_requested_at' - 'reported_host'`;
      return {
        organizations: await read(`select id, name from organizations order by id`),
        repositories: await read(`select id, organization_id from repositories order by id`),
        agents: await read(
          `select id, to_jsonb(h) - ${reset} as kept from harnesses h order by id`,
        ),
        pins: await read(
          `select id, harness_id as agent, repository_id from harness_repo_pins order by id`,
        ),
        enrollments: await read(
          `select id, harness_id as agent, organization_id, token_hash, used_at, expires_at
           from harness_enrollments order by id`,
        ),
        refreshTokens: await read(
          `select id, harness_id as agent, family_id, token_hash, used_at, revoked_at
           from harness_refresh_tokens order by id`,
        ),
        audit: await read(
          `select id, harness_id as agent, event::text, detail from harness_audit order by id`,
        ),
        hostTools: await read(
          `select harness_id as agent, host_tool_id, configured_path, discovered_path
           from harness_host_tools order by harness_id, host_tool_id`,
        ),
        jobs: await read(
          `select id, harness_id as agent, target_harness_id as target, min_harness_version as min_version,
             status::text, payload
           from jobs order by id`,
        ),
        reviews: await read(`select id, harness_id as agent from reviews order by id`),
        runs: await read(`select id, harness_id as agent from ralph_runs order by id`),
        lanes: await read(
          `select id, harness_id as agent, request_harness_id as request_agent
           from ralph_lanes order by id`,
        ),
        auditEvents: await read(`select enum_range(null::harness_audit_event)::text[] as values`),
      };
    };

    it("keeps every production row and reference, resets old-package version state and converts the settings", async () => {
      const { uri, client } = await beforeAgents("agents_production");
      try {
        // Production: 3 organizations with 17 repositories, all 9 agents in the first.
        const orgs: string[] = [];
        for (const name of ["Frakinship", "Acme", "Initech"]) {
          const { rows } = await client.query<{ id: string }>(
            `insert into organizations (name) values ($1) returning id`,
            [name],
          );
          orgs.push(rows[0]!.id);
        }
        const [org, other] = orgs as [string, string, string];
        const repos: string[] = [];
        for (const [i, organization] of orgs.entries()) {
          const { rows: connections } = await client.query<{ id: string }>(
            `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
             values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
            [organization],
          );
          for (let r = 0; r < [12, 3, 2][i]!; r++) {
            const { rows } = await client.query<{ id: string }>(
              `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
               values ($1, 'github', $2, $3, $4) returning id`,
              [organization, `${i}-${r}`, `org${i}/repo-${r}`, connections[0]!.id],
            );
            repos.push(rows[0]!.id);
          }
        }
        expect(repos).toHaveLength(17);

        // 7 live agents and 2 revoked and soft-deleted, on the organization defaults.
        const agents: string[] = [];
        for (let i = 0; i < 9; i++) {
          const gone = i >= 7;
          const { rows } = await client.query<{ id: string }>(
            `insert into harnesses (organization_id, name, reported_version, self_update, reported_models,
               reported_installables, reported_accepted_task_types, last_heartbeat_at, live_online,
               revoked_at, deleted_at)
             values ($1, $2, '0.13.2', 'supported',
               '[{"value": "claude-opus-5-5", "displayName": "Opus 5.5"}]',
               '[{"name": "@anthropic-ai/claude-code", "version": "3.1.0"}]',
               '{query,review,coding}', now(), $3, $4, $4)
             returning id`,
            [org, `coder-${i + 1}`, !gone, gone ? new Date("2026-09-01T00:00:00Z") : null],
          );
          agents.push(rows[0]!.id);
        }
        const [first, second, failing] = agents as [string, string, string];
        // One agent failed an update: a failed version and its update state.
        await client.query(
          `update harnesses set failed_versions = '{0.12.0}',
             update_state = '{"state": "idle", "version": "0.12.0", "previous": "0.11.0", "startsSincePending": 0, "error": "crashed"}',
             update_request_id = gen_random_uuid(), update_request_version = '0.12.0', update_requested_at = now()
           where id = $1`,
          [failing],
        );
        // 16 pins over the first 8 repositories, two agents each.
        for (let r = 0; r < 8; r++) {
          for (const agent of [agents[r % 7]!, agents[(r + 1) % 7]!]) {
            await client.query(
              `insert into harness_repo_pins (harness_id, repository_id) values ($1, $2)`,
              [agent, repos[r]],
            );
          }
        }
        // One used and linked enrollment, one expired and unused.
        await client.query(
          `insert into harness_enrollments (organization_id, token_hash, name, expires_at, used_at, harness_id)
           values ($1, 'used', 'coder-1', now() + interval '1 hour', now(), $2),
                  ($1, 'expired', null, now() - interval '1 day', null, null)`,
          [org, first],
        );
        // Refresh-token families: used tokens and the current one.
        for (const [agent, family] of [
          [first, "11111111-1111-4111-8111-111111111111"],
          [second, "22222222-2222-4222-8222-222222222222"],
        ] as const) {
          await client.query(
            `insert into harness_refresh_tokens (harness_id, family_id, token_hash, used_at)
             values ($1, $2, $3, now() - interval '30 minutes'), ($1, $2, $4, now() - interval '15 minutes'),
                    ($1, $2, $5, null)`,
            [agent, family, `${agent}-1`, `${agent}-2`, `${agent}-3`],
          );
        }
        // An audit row for every event.
        const { rows: events } = await client.query<{ event: string }>(
          `select unnest(enum_range(null::harness_audit_event))::text as event`,
        );
        expect(events.length).toBeGreaterThan(1);
        for (const { event } of events) {
          await client.query(
            `insert into harness_audit (harness_id, event, ip, detail) values ($1, $2, '10.0.0.1', $3)`,
            [first, event, JSON.stringify({ event })],
          );
        }
        // Jobs that ran on an agent, were targeted at one and need a harness version.
        const payload = { kind: "review", spec: { prompt: "Review it" } };
        for (const [status, agent, target] of [
          ["completed", first, first],
          ["running", second, second],
          ["queued", null, first],
          ["queued", null, null],
        ] as const) {
          await client.query(
            `insert into jobs (organization_id, type, task_type, status, harness_id, target_harness_id,
               min_harness_version, payload)
             values ($1, 'review.run', 'review', $2, $3, $4, '0.11.0', $5)`,
            [org, status, agent, target, JSON.stringify(payload)],
          );
        }
        // A review, a run and its lane on agents.
        await client.query(
          `insert into reviews (repository_id, pr_number, head_sha, base_sha, trigger, budget, harness_id)
           values ($1, 7, 'head', 'base', 'webhook', 200000, $2)`,
          [repos[0], first],
        );
        const { rows: runs } = await client.query<{ id: string }>(
          `insert into ralph_runs (organization_id, kind, repository_id, harness_id,
             linear_issue_id, linear_identifier, linear_agent_session_id)
           values ($1, 'prd', $2, $3, 'i1', 'TOOL-570', 's1') returning id`,
          [org, repos[0], first],
        );
        await client.query(
          `insert into ralph_lanes (run_id, repository_id, branch, base_branch, harness_id, request_harness_id)
           values ($1, $2, 'omniralph/tool-570', 'v2', $3, $4)`,
          [runs[0]!.id, repos[0], first, second],
        );
        // One host tool configured on an agent.
        const { rows: tools } = await client.query<{ id: string }>(
          `insert into host_tools (organization_id, name) values ($1, 'opengrep') returning id`,
          [org],
        );
        await client.query(
          `insert into harness_host_tools (harness_id, host_tool_id, configured_path, discovered_path)
           values ($1, $2, '/usr/local/bin/opengrep', '/usr/bin/opengrep')`,
          [first, tools[0]!.id],
        );
        // The organization's settings: tracking latest, a default concurrency and the cached latest.
        await client.query(
          `insert into app_settings (organization_id, key, value) values
             ($1, 'harness.desiredVersion', '"latest"'),
             ($1, 'harness.maxConcurrency', '2'),
             ($1, 'harness.latestVersion', '{"version": "0.13.2", "checkedAt": "2026-10-26T00:00:00Z"}'),
             ($1, 'chat.playbooks', '{}')`,
          [org],
        );

        const before = await snapshot(client, false);
        await runMigrations(uri);
        const after = await snapshot(client, true);

        // Every row, ID and reference is kept, and the enum's values too.
        expect(after).toEqual(before);
        expect(before.agents).toHaveLength(9);
        expect(before.pins).toHaveLength(16);
        expect(before.enrollments).toHaveLength(2);
        expect(before.refreshTokens).toHaveLength(6);
        expect(before.audit).toHaveLength(events.length);
        expect(before.hostTools).toHaveLength(1);
        expect(before.jobs).toHaveLength(4);
        expect(before.lanes).toEqual([
          expect.objectContaining({ agent: first, request_agent: second }),
        ]);

        // Version state naming @omniralph/harness versions is reset on every agent.
        const { rows: versions } = await client.query(
          `select distinct desired_version, failed_versions, update_state, update_request_id,
             update_request_version, update_requested_at
           from agents`,
        );
        expect(versions).toEqual([
          {
            desired_version: null,
            failed_versions: [],
            update_state: null,
            update_request_id: null,
            update_request_version: null,
            update_requested_at: null,
          },
        ]);

        // The settings move to `agent.*`; the cached latest is gone.
        const { rows: settings } = await client.query(
          `select key, value from app_settings order by key`,
        );
        expect(settings).toEqual([
          { key: "agent.desiredVersion", value: "latest" },
          { key: "agent.maxConcurrency", value: 2 },
          { key: "chat.playbooks", value: {} },
        ]);

        // Nothing is named after harnesses any more.
        const { rows: names } = await client.query(
          `select relname as name from pg_class
             where relnamespace = 'public'::regnamespace and relname like '%harness%'
           union all select conname from pg_constraint where conname like '%harness%'
           union all select typname from pg_type where typname like '%harness%'
           union all select table_name || '.' || column_name from information_schema.columns
             where table_schema = 'public' and column_name like '%harness%'`,
        );
        expect(names).toEqual([]);

        // The renamed keys and constraints still enforce.
        await expect(
          client.query(`insert into agent_repo_pins (agent_id, repository_id) values ($1, $2)`, [
            first,
            repos[0],
          ]),
        ).rejects.toThrow(/agent_repo_pins_agent_repo_uq/);
        await expect(
          client.query(`insert into agent_repo_pins (agent_id, repository_id) values ($1, $2)`, [
            other,
            repos[0],
          ]),
        ).rejects.toThrow(/agent_repo_pins_agent_id_agents_id_fk/);
        await client.query(`delete from agents where id = $1`, [first]);
        const { rows: left } = await client.query(
          `select (select count(*) from agent_repo_pins where agent_id = $1)::int as pins,
                  (select count(*) from agent_refresh_tokens where agent_id = $1)::int as tokens,
                  (select count(*) from agent_host_tools where agent_id = $1)::int as host_tools,
                  (select count(*) from jobs where agent_id = $1 or target_agent_id = $1)::int as jobs,
                  (select count(*) from jobs)::int as all_jobs,
                  (select count(*) from agent_refresh_tokens)::int as all_tokens`,
          [first],
        );
        expect(left).toEqual([
          { pins: 0, tokens: 0, host_tools: 0, jobs: 0, all_jobs: 4, all_tokens: 3 },
        ]);
      } finally {
        await client.end();
      }
    });

    it("keeps a desired version of 2.0.0 or later and drops older ones", async () => {
      const { uri, client } = await beforeAgents("agents_versions");
      try {
        const versions = ["latest", "0.13.2", "1.0.0", "2.0.0-rc.1", "2.0.0", "2.0.1", "10.0.0"];
        const kept = ["latest", "2.0.0", "2.0.1", "10.0.0"];
        for (const version of versions) {
          const { rows } = await client.query<{ id: string }>(
            `insert into organizations (name) values ($1) returning id`,
            [version],
          );
          await client.query(
            `insert into app_settings (organization_id, key, value) values ($1, 'harness.desiredVersion', $2)`,
            [rows[0]!.id, JSON.stringify(version)],
          );
          await client.query(
            `insert into harnesses (organization_id, name, desired_version) values ($1, $2, $2)`,
            [rows[0]!.id, version],
          );
        }
        await runMigrations(uri);
        const { rows: settings } = await client.query<{ value: string }>(
          `select value from app_settings where key = 'agent.desiredVersion'`,
        );
        expect(settings.map((r) => r.value).sort()).toEqual([...kept].sort());
        const { rows: agents } = await client.query<{ name: string; desired_version: string }>(
          `select name, desired_version from agents`,
        );
        expect(Object.fromEntries(agents.map((r) => [r.name, r.desired_version]))).toEqual(
          Object.fromEntries(versions.map((v) => [v, kept.includes(v) ? v : null])),
        );
        const { rows: old } = await client.query(
          `select key from app_settings where key like 'harness.%'`,
        );
        expect(old).toEqual([]);
      } finally {
        await client.end();
      }
    });
  });

  describe("playbook and run spec keys say agent (0104)", () => {
    it("renames tools.harness and minHarnessVersion and keeps every other value", async () => {
      await db.execute(sql`create database playbook_agent_keys`);
      const uri = testDb.uri.replace(/\/[^/]*$/, "/playbook_agent_keys");
      await migrateBefore(uri, "0104_");
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('acme') returning id`,
        );
        const org = orgs[0]!.id;
        const tools = (key: string) => ({
          builtin: ["Read", "Grep"],
          [key]: ["post_activity", "ship"],
          linear: ["get_issue"],
          mcpServers: [],
        });
        const definition = (key: string) => ({
          description: "Implements stories",
          systemPrompt: "You are an engineer. The harness word in prose stays.",
          tools: tools(key),
          coding: { model: "opus", qualityGates: ["pnpm test"] },
          variables: { harness: "a variable named harness stays" },
        });
        const requirements = (key: string) => ({
          [key]: "0.40.0",
          installables: ["@acme/linter"],
          hostTools: ["git"],
        });
        const { rows: playbooks } = await client.query<{ id: string }>(
          `insert into playbooks (organization_id, name, role, definition, requirements)
           values ($1, 'Custom', 'coding', $2, $3) returning id`,
          [
            org,
            JSON.stringify(definition("harness")),
            JSON.stringify(requirements("minHarnessVersion")),
          ],
        );
        // Run specs inside job payloads: a pending and a completed job carry the old key;
        // a job without it is left alone.
        const payload = (key: string) => ({
          trigger: { kind: "linear", context: { issue: "TOOL-584", tools: "not an object" } },
          runSpec: {
            jobId: "00000000-0000-4000-8000-000000000001",
            agent: { systemPrompt: "You are Om.", tools: tools(key) },
            task: { taskType: "coding" },
          },
          ref: "main",
        });
        const plain = { kind: "review", spec: { prompt: "Review it" }, list: [1, "two", null] };
        const jobs: Record<string, string> = {};
        for (const [name, status, body] of [
          ["pending", "queued", payload("harness")],
          ["completed", "completed", payload("harness")],
          ["plain", "queued", plain],
        ] as const) {
          const { rows } = await client.query<{ id: string }>(
            `insert into jobs (organization_id, type, task_type, task_id, status, min_agent_version, payload)
             values ($1, 'run', 'coding', $2, $3, '0.40.0', $4) returning id`,
            [org, playbooks[0]!.id, status, JSON.stringify(body)],
          );
          jobs[name] = rows[0]!.id;
        }
        const read = async () => ({
          playbooks: (
            await client.query(
              `select id, organization_id, name, role, definition, requirements, created_at, updated_at
               from playbooks order by id`,
            )
          ).rows,
          jobs: (
            await client.query(
              `select id, organization_id, type, task_type, task_id, status, min_agent_version,
                 payload, created_at
               from jobs order by id`,
            )
          ).rows as Record<string, unknown>[],
        });
        const before = await read();

        await runMigrations(uri);
        const after = await read();

        expect(after.playbooks).toEqual([
          {
            ...before.playbooks[0],
            definition: definition("agent"),
            requirements: requirements("minAgentVersion"),
          },
        ]);
        const byId = (rows: Record<string, unknown>[], id: string) =>
          rows.find((row) => row.id === id);
        for (const name of ["pending", "completed"]) {
          expect(byId(after.jobs, jobs[name]!)).toEqual({
            ...byId(before.jobs, jobs[name]!),
            payload: payload("agent"),
          });
        }
        expect(byId(after.jobs, jobs.plain!)).toEqual(byId(before.jobs, jobs.plain!));
        expect(after.jobs).toHaveLength(3);
      } finally {
        await client.end();
      }
    });
  });

  describe("routing rules become work item matches (0100)", () => {
    type Condition = { field: string; operator: string; value: unknown };
    const and = (...rules: unknown[]) => ({ combinator: "and", rules });
    const team = (key: string): Condition => ({ field: "team", operator: "=", value: key });
    const project = (name: string): Condition => ({ field: "project", operator: "=", value: name });
    const noProject: Condition = { field: "project", operator: "null", value: null };
    const labels = (...names: string[]): Condition => ({
      field: "labels",
      operator: "containsAny",
      value: names,
    });

    /** Migrates a new database up to 0099 and inserts `orgs`' rules (one repo per rule unless named). */
    async function beforeConversion(
      name: string,
      orgs: Record<string, { repo: string; query: unknown }[]>,
    ) {
      await db.execute(sql.raw(`create database ${name}`));
      const uri = testDb.uri.replace(/\/[^/]*$/, `/${name}`);
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0100_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      await migrate(drizzle(client), { migrationsFolder: before });

      const orgIds: Record<string, string> = {};
      const repoIds: Record<string, string> = {};
      for (const [orgName, rules] of Object.entries(orgs)) {
        const { rows } = await client.query<{ id: string }>(
          `insert into organizations (name) values ($1) returning id`,
          [orgName],
        );
        const org = rows[0]!.id;
        orgIds[orgName] = org;
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        for (const [position, rule] of rules.entries()) {
          if (!repoIds[rule.repo]) {
            const { rows: inserted } = await client.query<{ id: string }>(
              `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
               values ($1, 'github', $2, $2, $3) returning id`,
              [org, rule.repo, connections[0]!.id],
            );
            repoIds[rule.repo] = inserted[0]!.id;
          }
          await client.query(
            `insert into routing_rules (organization_id, position, repository_id, query)
             values ($1, $2, $3, $4)`,
            [org, position, repoIds[rule.repo], rule.query],
          );
        }
      }
      const cleanup = async () => {
        await client.end();
        rmSync(before, { recursive: true, force: true });
      };
      return { uri, client, orgIds, repoIds, cleanup };
    }

    async function matchesAndRules(client: pg.Client) {
      const { rows: matches } = await client.query<{
        full_path: string;
        tracker: string;
        team: string;
        project: string | null;
        without_project: boolean;
        labels: string[];
      }>(
        `select r.full_path, m.tracker, m.team, m.project, m.without_project, m.labels
         from work_item_matches m join repositories r on r.id = m.repository_id
         where m.organization_id = r.organization_id
         order by r.full_path`,
      );
      const { rows: rules } = await client.query<{ organization_id: string; count: number }>(
        `select organization_id, count(*)::int as count from routing_rules group by organization_id`,
      );
      return { matches, rules };
    }

    it("converts the production rules of both organizations and deletes them", async () => {
      const { uri, client, cleanup } = await beforeConversion("routing_conversion_production", {
        Acme: [
          { repo: "acme/fans", query: and(team("MOD"), project("Create More Fans")) },
          { repo: "acme/mod-portal", query: and(team("MOD"), project("Portal")) },
          { repo: "acme/mod-billing", query: and(team("MOD"), project("Billing")) },
          { repo: "acme/mod-search", query: and(team("MOD"), project("Search")) },
          { repo: "acme/mod", query: and(team("MOD"), noProject) },
          { repo: "acme/omniralph", query: and(team("TOOL"), project("Omniralph")) },
          { repo: "acme/toolbox", query: and(team("TOOL"), project("Toolbox")) },
          { repo: "acme/ui-kit", query: and(team("UI"), project("UI Kit")) },
          { repo: "acme/ui-docs", query: and(team("UI"), project("Docs")) },
          { repo: "acme/schematic", query: and(team("SCHEM"), project("Schematic Lab")) },
        ],
        Beta: [
          { repo: "beta/portal", query: and(labels("product:portal"), team("SOC")) },
          { repo: "beta/mobile", query: and(labels("product:mobile"), team("SOC")) },
          { repo: "beta/api", query: and(labels("product:api"), team("SOC")) },
          { repo: "beta/admin", query: and(labels("product:admin"), team("SOC")) },
          { repo: "beta/mss", query: and(team("MSS")) },
        ],
      });
      try {
        await runMigrations(uri);
        const { matches, rules } = await matchesAndRules(client);
        const match = (
          full_path: string,
          teamKey: string,
          projectName: string | null,
          extra: { without_project?: boolean; labels?: string[] } = {},
        ) => ({
          full_path,
          tracker: "linear",
          team: teamKey,
          project: projectName,
          without_project: extra.without_project ?? false,
          labels: extra.labels ?? [],
        });
        expect(matches).toEqual([
          match("acme/fans", "MOD", "Create More Fans"),
          match("acme/mod", "MOD", null, { without_project: true }),
          match("acme/mod-billing", "MOD", "Billing"),
          match("acme/mod-portal", "MOD", "Portal"),
          match("acme/mod-search", "MOD", "Search"),
          match("acme/omniralph", "TOOL", "Omniralph"),
          match("acme/schematic", "SCHEM", "Schematic Lab"),
          match("acme/toolbox", "TOOL", "Toolbox"),
          match("acme/ui-docs", "UI", "Docs"),
          match("acme/ui-kit", "UI", "UI Kit"),
          match("beta/admin", "SOC", null, { labels: ["product:admin"] }),
          match("beta/api", "SOC", null, { labels: ["product:api"] }),
          match("beta/mobile", "SOC", null, { labels: ["product:mobile"] }),
          match("beta/mss", "MSS", null),
          match("beta/portal", "SOC", null, { labels: ["product:portal"] }),
        ]);
        expect(rules).toEqual([]);
        // No flag or preference is set.
        const { rows: settings } = await client.query(`select key from app_settings`);
        expect(settings).toEqual([]);
      } finally {
        await cleanup();
      }
    });

    it("keeps an organization's rules when one of them is a nested OR group", async () => {
      const { uri, client, orgIds, cleanup } = await beforeConversion("routing_conversion_nested", {
        Acme: [
          {
            repo: "acme/web",
            query: and(team("MOD"), {
              combinator: "or",
              rules: [project("Portal"), labels("web")],
            }),
          },
          { repo: "acme/fans", query: and(team("MOD"), project("Create More Fans")) },
        ],
        // Another organization still converts.
        Beta: [{ repo: "beta/mss", query: and(team("MSS")) }],
      });
      try {
        await runMigrations(uri);
        const { matches, rules } = await matchesAndRules(client);
        expect(matches.map((m) => m.full_path)).toEqual(["beta/mss"]);
        expect(rules).toEqual([{ organization_id: orgIds.Acme, count: 2 }]);
      } finally {
        await cleanup();
      }
    });

    it("keeps an organization's rules when two of them target the same repo", async () => {
      const { uri, client, orgIds, cleanup } = await beforeConversion(
        "routing_conversion_same_repo",
        {
          Acme: [
            { repo: "acme/web", query: and(team("MOD"), project("Portal")) },
            { repo: "acme/web", query: and(team("MOD"), project("Billing")) },
            { repo: "acme/mss", query: and(team("MSS")) },
          ],
        },
      );
      try {
        await runMigrations(uri);
        const { matches, rules } = await matchesAndRules(client);
        expect(matches).toEqual([]);
        expect(rules).toEqual([{ organization_id: orgIds.Acme, count: 3 }]);
      } finally {
        await cleanup();
      }
    });

    it("keeps an organization's rules when their matches would overlap or a rule doesn't convert", async () => {
      const { uri, client, orgIds, cleanup } = await beforeConversion("routing_conversion_kept", {
        // Same team, no project, intersecting labels (ignoring case).
        Overlap: [
          { repo: "o/portal", query: and(team("SOC"), labels("product:portal", "web")) },
          { repo: "o/web", query: and(team("soc"), labels("WEB")) },
        ],
        // Two team-only rules for one team.
        Twice: [
          { repo: "t/one", query: and(team("MSS")) },
          { repo: "t/two", query: and(team("MSS")) },
        ],
        Negated: [{ repo: "n/web", query: { ...and(team("MOD")), not: true } }],
        Or: [{ repo: "or/web", query: { combinator: "or", rules: [team("MOD")] } }],
        NoTeam: [{ repo: "nt/web", query: and(project("Portal")) }],
        TeamNotEqual: [
          { repo: "tn/web", query: and({ field: "team", operator: "!=", value: "MOD" }) },
        ],
        OtherField: [
          {
            repo: "of/web",
            query: and(team("MOD"), { field: "title", operator: "contains", value: "x" }),
          },
        ],
        TwoProjects: [{ repo: "tp/web", query: and(team("MOD"), project("A"), noProject) }],
        LabelsAll: [
          {
            repo: "la/web",
            query: and(team("MOD"), { field: "labels", operator: "containsAll", value: ["a"] }),
          },
        ],
        Empty: [{ repo: "e/web", query: and() }],
        TeamTwice: [{ repo: "tt/web", query: and(team("MOD"), team("MOD")) }],
        TwoLabelTests: [{ repo: "tl/web", query: and(team("MOD"), labels("a"), labels("b")) }],
        ProjectContains: [
          {
            repo: "pc/web",
            query: and(team("MOD"), { field: "project", operator: "contains", value: "Port" }),
          },
        ],
      });
      try {
        await runMigrations(uri);
        const { matches, rules } = await matchesAndRules(client);
        expect(matches).toEqual([]);
        expect(Object.fromEntries(rules.map((r) => [r.organization_id, r.count]))).toEqual(
          Object.fromEntries(
            Object.entries(orgIds).map(([org, id]) => [
              id,
              ["Overlap", "Twice"].includes(org) ? 2 : 1,
            ]),
          ),
        );
      } finally {
        await cleanup();
      }
    });

    it("keeps an organization's rules when a rule's repo already has a work item match", async () => {
      const { uri, client, orgIds, repoIds, cleanup } = await beforeConversion(
        "routing_conversion_existing_match",
        { Acme: [{ repo: "acme/web", query: and(team("MOD")) }] },
      );
      try {
        await client.query(
          `insert into work_item_matches (repository_id, organization_id, tracker, team)
           values ($1, $2, 'linear', 'WEB')`,
          [repoIds["acme/web"], orgIds.Acme],
        );
        await runMigrations(uri);
        const { matches, rules } = await matchesAndRules(client);
        expect(matches.map((m) => [m.full_path, m.team])).toEqual([["acme/web", "WEB"]]);
        expect(rules).toEqual([{ organization_id: orgIds.Acme, count: 1 }]);
      } finally {
        await cleanup();
      }
    });

    it("converts different projects and different labels of one team without conflict", async () => {
      const { uri, client, cleanup } = await beforeConversion("routing_conversion_distinct", {
        Acme: [
          { repo: "a/team", query: and(team("MOD")) },
          { repo: "a/project", query: and(team("MOD"), project("Portal")) },
          { repo: "a/label", query: and(team("MOD"), labels("web")) },
          { repo: "a/both", query: and(team("MOD"), project("Portal"), labels("web")) },
        ],
      });
      try {
        await runMigrations(uri);
        const { matches, rules } = await matchesAndRules(client);
        expect(matches.map((m) => m.full_path)).toEqual([
          "a/both",
          "a/label",
          "a/project",
          "a/team",
        ]);
        expect(rules).toEqual([]);
      } finally {
        await cleanup();
      }
    });
  });

  it("adds the show advanced settings preference, off for every user, keeping their theme (0095)", async () => {
    await db.execute(sql`create database user_show_advanced`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/user_show_advanced");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0095_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        // Production-shaped: one user chose dark, the other follows the OS.
        await client.query(
          `insert into users (id, email, theme) values
             ('dark-user', 'dark@example.com', 'dark'),
             ('os-user', 'os@example.com', null)`,
        );

        await runMigrations(uri);
        const { rows } = await client.query<{
          id: string;
          theme: string | null;
          show_advanced: boolean;
        }>(`select id, theme, show_advanced from users order by id`);
        expect(rows).toEqual([
          { id: "dark-user", theme: "dark", show_advanced: false },
          { id: "os-user", theme: null, show_advanced: false },
        ]);
        // New users start with advanced settings hidden.
        await client.query(`insert into users (id, email) values ('new-user', 'new@example.com')`);
        const { rows: created } = await client.query<{ show_advanced: boolean }>(
          `select show_advanced from users where id = 'new-user'`,
        );
        expect(created).toEqual([{ show_advanced: false }]);
        await expect(
          client.query(`update users set show_advanced = null where id = 'os-user'`),
        ).rejects.toThrow(/null value/);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("backfills each lane's harness from its run (0077)", async () => {
    await db.execute(sql`create database lane_harnesses`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/lane_harnesses");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0077_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        const { rows: repos } = await client.query<{ id: string }>(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', '1', 'acme/main', $2), ($1, 'github', '2', 'acme/other', $2)
           returning id`,
          [org, connections[0]!.id],
        );
        const { rows: harnessRows } = await client.query<{ id: string }>(
          `insert into harnesses (organization_id, name) values ($1, 'sticky') returning id`,
          [org],
        );
        const harness = harnessRows[0]!.id;
        const { rows: runs } = await client.query<{ id: string }>(
          `insert into ralph_runs (organization_id, kind, repository_id, harness_id,
             linear_issue_id, linear_identifier, linear_agent_session_id)
           values ($1, 'prd', $2, $3, 'i1', 'ENG-1', 's1'), ($1, 'prd', $2, null, 'i2', 'ENG-2', 's2')
           returning id`,
          [org, repos[0]!.id, harness],
        );
        for (const [run, repo, branch] of [
          [runs[0]!.id, repos[0]!.id, "a"],
          [runs[0]!.id, repos[1]!.id, "b"],
          [runs[1]!.id, repos[0]!.id, "c"],
        ]) {
          await client.query(
            `insert into ralph_lanes (run_id, repository_id, branch, base_branch)
             values ($1, $2, $3, 'main')`,
            [run, repo, branch],
          );
        }

        await migrateBefore(uri, "0103_");
        const { rows } = await client.query<{ branch: string; harness_id: string | null }>(
          `select branch, harness_id from ralph_lanes order by branch`,
        );
        expect(rows).toEqual([
          { branch: "a", harness_id: harness },
          { branch: "b", harness_id: harness },
          { branch: "c", harness_id: null },
        ]);

        // Deleting the harness clears the lanes' harness.
        await client.query(`delete from harnesses where id = $1`, [harness]);
        const { rows: after } = await client.query<{ harness_id: string | null }>(
          `select distinct harness_id from ralph_lanes`,
        );
        expect(after).toEqual([{ harness_id: null }]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("gives existing lanes no review state and no draft (0087)", async () => {
    await db.execute(sql`create database lane_review_state`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/lane_review_state");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0087_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        const { rows: repos } = await client.query<{ id: string }>(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', '1', 'acme/main', $2) returning id`,
          [org, connections[0]!.id],
        );
        const { rows: runs } = await client.query<{ id: string }>(
          `insert into ralph_runs (organization_id, kind, repository_id, status,
             linear_issue_id, linear_identifier, linear_agent_session_id)
           values ($1, 'prd', $2, 'completed', 'i1', 'ENG-1', 's1'),
                  ($1, 'prd', $2, 'completed', 'i2', 'ENG-2', 's2'),
                  ($1, 'prd', $2, 'running', 'i3', 'ENG-3', 's3'),
                  ($1, 'prd', $2, 'stopped', 'i4', 'ENG-4', 's4')
           returning id`,
          [org, repos[0]!.id],
        );
        // Production's lane shapes: a merged PR, an open PR, no PR yet, a PR closed unmerged.
        await client.query(
          `insert into ralph_lanes (run_id, repository_id, branch, base_branch, pr_number, pr_url, pr_closed, pr_merged)
           values ($1, $4, 'a', 'main', 1, 'https://github.com/acme/main/pull/1', true, true),
                  ($2, $4, 'b', 'main', 2, 'https://github.com/acme/main/pull/2', false, false),
                  ($3, $4, 'c', 'main', null, null, false, false),
                  ($5, $4, 'd', 'main', 4, 'https://github.com/acme/main/pull/4', true, false)`,
          [runs[0]!.id, runs[1]!.id, runs[2]!.id, repos[0]!.id, runs[3]!.id],
        );

        await runMigrations(uri);
        const { rows } = await client.query(
          `select branch, pr_closed, pr_merged, pr_draft, pr_review_state, pr_state_updated_at
           from ralph_lanes order by branch`,
        );
        expect(rows).toEqual([
          {
            branch: "a",
            pr_closed: true,
            pr_merged: true,
            pr_draft: false,
            pr_review_state: "none",
            pr_state_updated_at: null,
          },
          {
            branch: "b",
            pr_closed: false,
            pr_merged: false,
            pr_draft: false,
            pr_review_state: "none",
            pr_state_updated_at: null,
          },
          {
            branch: "c",
            pr_closed: false,
            pr_merged: false,
            pr_draft: false,
            pr_review_state: "none",
            pr_state_updated_at: null,
          },
          {
            branch: "d",
            pr_closed: true,
            pr_merged: false,
            pr_draft: false,
            pr_review_state: "none",
            pr_state_updated_at: null,
          },
        ]);
        await expect(
          client.query(`update ralph_lanes set pr_review_state = 'merged'`),
        ).rejects.toThrow();
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("gives existing Linear integrations the default readiness state mapping (0089)", async () => {
    await db.execute(sql`create database integration_state_mapping`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/integration_state_mapping");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0089_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme'), ('Frakinship') returning id`,
        );
        // Production's two Linear integrations, one per organization.
        await client.query(
          `insert into integrations (organization_id, provider, external_id, name, encrypted_credentials)
           values ($1, 'linear', 'ws-1', 'Acme', 'x'), ($2, 'linear', 'ws-2', 'Frakinship', 'y')`,
          [orgs[0]!.id, orgs[1]!.id],
        );

        await runMigrations(uri);
        const { rows } = await client.query(
          `select external_id, state_mapping from integrations order by external_id`,
        );
        const mapping = {
          ready: { types: ["unstarted"] },
          needsRefining: { types: ["backlog"] },
          teams: {},
        };
        expect(rows).toEqual([
          { external_id: "ws-1", state_mapping: mapping },
          { external_id: "ws-2", state_mapping: mapping },
        ]);
        await expect(
          client.query(`update integrations set state_mapping = null`),
        ).rejects.toThrow();
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("cancels legacy review.run jobs and renames review task jobs (0063)", async () => {
    await db.execute(sql`create database legacy_review_jobs`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/legacy_review_jobs");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0063_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        await client.query(
          `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
           values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
          [org],
        );
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
           values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
          [org],
        );
        const { rows: repos } = await client.query<{ id: string }>(
          `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
           values ($1, 'github', '1', 'acme/api', $2) returning id`,
          [org, connections[0]!.id],
        );
        const { rows: reviews } = await client.query<{ id: string }>(
          `insert into reviews (repository_id, pr_number, head_sha, base_sha, trigger, status, budget)
           values ($1, 1, 'h', 'b', 'webhook', 'running', 1), ($1, 2, 'h', 'b', 'webhook', 'queued', 1),
                  ($1, 3, 'h', 'b', 'webhook', 'completed', 1)
           returning id`,
          [repos[0]!.id],
        );
        const [legacyActive, task, legacyDone] = reviews.map((r) => r.id) as [
          string,
          string,
          string,
        ];
        await client.query(
          `insert into jobs (organization_id, type, task_type, pool, task_id, status, payload, dedupe_key) values
             ($1, 'review.run', 'review', 'short', null, 'running', $2, 'legacy-active'),
             ($1, 'review.run', 'review', 'short', 'builtin:review-pr', 'queued', $3, 'task'),
             ($1, 'review.run', 'review', 'short', null, 'completed', $4, 'legacy-done'),
             ($1, 'chat.ask', 'query', 'short', null, 'queued', '{}', 'other')`,
          [
            org,
            JSON.stringify({ reviewId: legacyActive }),
            JSON.stringify({ trigger: { kind: "pr.updated", context: { reviewId: task } } }),
            JSON.stringify({ reviewId: legacyDone }),
          ],
        );

        await runMigrations(uri);
        const { rows: jobRows } = await client.query(
          `select dedupe_key, type, status, error is not null as has_error from jobs order by dedupe_key`,
        );
        expect(jobRows).toEqual([
          { dedupe_key: "legacy-active", type: "review.run", status: "canceled", has_error: true },
          { dedupe_key: "legacy-done", type: "review.run", status: "completed", has_error: false },
          { dedupe_key: "other", type: "chat.ask", status: "queued", has_error: false },
          { dedupe_key: "task", type: "review.task", status: "queued", has_error: false },
        ]);
        const { rows: reviewRows } = await client.query(
          `select pr_number, status, error is not null as has_error from reviews order by pr_number`,
        );
        expect(reviewRows).toEqual([
          { pr_number: 1, status: "failed", has_error: true },
          { pr_number: 2, status: "queued", has_error: false },
          { pr_number: 3, status: "completed", has_error: false },
        ]);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it("maps chat runs and code questions to their threads (0067)", async () => {
    await db.execute(sql`create database thread_runs`);
    const uri = testDb.uri.replace(/\/[^/]*$/, "/thread_runs");
    const before = mkdtempSync(join(tmpdir(), "migrations-"));
    try {
      cpSync(migrationsFolder, before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0067_"));
      writeFileSync(
        journalPath,
        JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
      );
      const client = new pg.Client({ connectionString: uri });
      await client.connect();
      try {
        await migrate(drizzle(client), { migrationsFolder: before });
        const { rows: orgs } = await client.query<{ id: string }>(
          `insert into organizations (name) values ('Acme') returning id`,
        );
        const org = orgs[0]!.id;
        const { rows: connections } = await client.query<{ id: string }>(
          `insert into chat_connections (organization_id, platform, external_id, name)
           values ($1, 'slack', 'T1', 'Acme') returning id`,
          [org],
        );
        const { rows: threads } = await client.query<{ id: string }>(
          `insert into chat_threads (organization_id, connection_id, platform, external_thread_id, channel_id, started_by_external_user_id)
           values ($1, $2, 'slack', 'slack:C1:1', 'slack:C1', 'U1'), ($1, $2, 'slack', 'slack:C1:2', 'slack:C1', 'U1')
           returning id`,
          [org, connections[0]!.id],
        );
        const [thread, other] = threads.map((t) => t.id) as [string, string];
        const { rows: runs } = await client.query<{ id: string; linear_identifier: string | null }>(
          `insert into ralph_runs (organization_id, origin, chat_thread_id, kind, mode, status,
             linear_issue_id, linear_identifier, linear_agent_session_id)
           values ($1, 'chat', $2, 'single', 'request', 'completed', null, null, null),
                  ($1, 'chat', $2, 'single', 'request', 'running', null, null, null),
                  ($1, 'chat', null, 'single', 'request', 'completed', null, null, null),
                  ($1, 'linear', $3, 'single', 'epic', 'running', 'i-1', 'ENG-1', 's-1')
           returning id, linear_identifier`,
          [org, thread, other],
        );
        const [chatDone, chatActive] = runs.map((r) => r.id) as [string, string];
        const { rows: jobRows } = await client.query<{ id: string; dedupe_key: string }>(
          `insert into jobs (organization_id, type, task_type, pool, status, payload, dedupe_key) values
             ($1, 'chat.ask', 'query', 'short', 'completed', $2, 'context'),
             ($1, 'chat.ask', 'query', 'short', 'queued', $3, 'top-level'),
             ($1, 'chat.ask', 'query', 'short', 'completed', $4, 'gone-thread'),
             ($1, 'chat.ask', 'query', 'short', 'completed', $5, 'not-a-uuid'),
             ($1, 'repo.sync', 'system', null, 'completed', '{}', 'no-thread'),
             ($1, 'ralph.request', 'coding', 'long', 'completed', $2, 'not-a-question')
           returning id, dedupe_key`,
          [
            org,
            JSON.stringify({
              trigger: { kind: "chat.request", context: { chatThreadId: thread } },
            }),
            JSON.stringify({ chatThreadId: other }),
            JSON.stringify({ chatThreadId: "00000000-0000-4000-8000-000000000000" }),
            JSON.stringify({ chatThreadId: "nope" }),
          ],
        );
        const jobId = (key: string) => jobRows.find((j) => j.dedupe_key === key)!.id;

        await runMigrations(uri);
        const { rows } = await client.query(
          `select organization_id, chat_thread_id, kind, job_id, ralph_run_id from chat_thread_runs`,
        );
        const mapped = (
          chatThreadId: string,
          kind: string,
          jobId: string | null,
          ralphRunId: string | null,
        ) => ({
          organization_id: org,
          chat_thread_id: chatThreadId,
          kind,
          job_id: jobId,
          ralph_run_id: ralphRunId,
        });
        // Linear runs delegated from chat, threadless runs, jobs naming no thread and
        // jobs other than code questions aren't mapped.
        expect(rows).toHaveLength(4);
        expect(rows).toEqual(
          expect.arrayContaining([
            mapped(thread, "coding", null, chatDone),
            mapped(thread, "coding", null, chatActive),
            mapped(thread, "query", jobId("context"), null),
            mapped(other, "query", jobId("top-level"), null),
          ]),
        );
      } finally {
        await client.end();
      }
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
  });

  it(
    "gives legacy reviews a review run and links every job to its run (0084)",
    { timeout: 30_000 },
    async () => {
      await db.execute(sql`create database job_runs`);
      const uri = testDb.uri.replace(/\/[^/]*$/, "/job_runs");
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      try {
        cpSync(migrationsFolder, before, { recursive: true });
        const journalPath = join(before, "meta", "_journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          entries: { tag: string }[];
        };
        const upTo = journal.entries.findIndex((e) => e.tag.startsWith("0084_"));
        writeFileSync(
          journalPath,
          JSON.stringify({ ...journal, entries: journal.entries.slice(0, upTo) }),
        );
        const client = new pg.Client({ connectionString: uri });
        await client.connect();
        try {
          await migrate(drizzle(client), { migrationsFolder: before });
          const { rows: orgs } = await client.query<{ id: string }>(
            `insert into organizations (name) values ('Acme') returning id`,
          );
          const org = orgs[0]!.id;
          await client.query(
            `insert into review_profiles (organization_id, id, name, model, max_tokens_per_review, max_files, allow_repo_exploration)
             values ($1, 'standard', 'Standard', 'claude-sonnet-5-5', 200000, 40, true)`,
            [org],
          );
          const { rows: connections } = await client.query<{ id: string }>(
            `insert into scm_connections (organization_id, provider, name, base_url, encrypted_credentials)
             values ($1, 'github', 'GitHub', 'https://api.github.com', 'x') returning id`,
            [org],
          );
          const { rows: repos } = await client.query<{ id: string }>(
            `insert into repositories (organization_id, provider, external_id, full_path, connection_id)
             values ($1, 'github', '1', 'acme/api', $2) returning id`,
            [org, connections[0]!.id],
          );
          const repo = repos[0]!.id;

          // A review run with one review task, and two legacy reviews with no run.
          const { rows: reviewRuns } = await client.query<{ id: string }>(
            `insert into review_runs (organization_id, repository_id, pr_number, head_sha, base_sha, trigger, mode, profile_id, status)
             values ($1, $2, 1, 'h1', 'b1', 'webhook', 'full', 'standard', 'completed') returning id`,
            [org, repo],
          );
          const reviewRun = reviewRuns[0]!.id;
          const { rows: reviewRows } = await client.query<{ id: string }>(
            `insert into reviews (review_run_id, repository_id, pr_number, head_sha, base_sha, trigger, status, profile_id, budget, error, created_at, updated_at)
             values ($1, $2, 1, 'h1', 'b1', 'webhook', 'completed', 'standard', 1, null, now(), now()),
                    (null, $2, 2, 'h2', 'b2', 'mention', 'budget_exhausted', 'deep', 1, 'Out of tokens',
                     '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z'),
                    (null, $2, 3, 'h3', 'b3', 'webhook', 'completed', null, 1, null,
                     '2026-01-02T00:00:00Z', '2026-01-02T00:05:00Z')
             returning id`,
            [reviewRun, repo],
          );
          const [taskReview, legacyExhausted, legacyDone] = reviewRows.map((r) => r.id) as [
            string,
            string,
            string,
          ];

          const { rows: triageRuns } = await client.query<{ id: string }>(
            `insert into triage_runs (organization_id, linear_issue_id, linear_agent_session_id, trigger, status)
             values ($1, 'i-1', 's-1', 'label', 'completed') returning id`,
            [org],
          );
          const triageRun = triageRuns[0]!.id;
          const { rows: ralphRuns } = await client.query<{ id: string }>(
            `insert into ralph_runs (organization_id, kind, mode, status, linear_issue_id, linear_identifier, linear_agent_session_id)
             values ($1, 'children', 'epic', 'completed', 'i-2', 'ENG-2', 's-2') returning id`,
            [org],
          );
          const ralphRun = ralphRuns[0]!.id;
          const { rows: stories } = await client.query<{ id: string }>(
            `insert into ralph_stories (run_id, linear_issue_id, identifier, title)
             values ($1, 'st-1', 'ENG-3', 'Legacy story'), ($1, 'st-2', 'ENG-4', 'Task story')
             returning id`,
            [ralphRun],
          );
          const [legacyStory, taskStory] = stories.map((s) => s.id) as [string, string];

          const context = (value: Record<string, unknown>) =>
            JSON.stringify({ trigger: { kind: "x", context: value } });
          const { rows: jobRows } = await client.query<{ id: string; dedupe_key: string }>(
            `insert into jobs (organization_id, type, task_type, pool, task_id, status, payload, dedupe_key, ralph_run_id) values
               ($1, 'review.task', 'review', 'short', 'builtin:review-pr', 'completed', $2, 'review-task', null),
               ($1, 'review.run', 'review', 'short', null, 'completed', $3, 'legacy-review', null),
               ($1, 'review.run', 'review', 'short', null, 'canceled', $4, 'legacy-review-2', null),
               ($1, 'review.correlate', 'query', 'short', 'builtin:correlate', 'completed', '{}', 'correlation', null),
               ($1, 'review.reply', 'query', 'short', 'builtin:reply', 'completed', $2, 'reply', null),
               ($1, 'triage.run', 'query', 'short', 'builtin:triage', 'failed', $5, 'triage', null),
               ($1, 'triage.run', 'query', 'short', 'builtin:triage', 'completed', $5, 'triage-turn-2', null),
               ($1, 'triage.run', 'query', 'short', 'builtin:triage', 'failed', $6, 'triage-bad-id', null),
               ($1, 'chat.ask', 'query', 'short', 'builtin:ask', 'expired', $7, 'ask', null),
               ($1, 'ralph.story', 'coding', 'long', null, 'completed', $8, 'legacy-story', $10),
               ($1, 'ralph.story', 'coding', 'long', 'builtin:story', 'failed', $9, 'task-story', $10),
               ($1, 'ralph.request', 'coding', 'long', null, 'completed', $8, 'request', $10),
               ($1, 'repo.sync', 'system', null, null, 'failed', '{}', 'sync', null)
             returning id, dedupe_key`,
            [
              org,
              context({ reviewId: taskReview }),
              JSON.stringify({ reviewId: legacyExhausted }),
              JSON.stringify({ reviewId: legacyDone }),
              context({ triageRunId: triageRun }),
              context({ triageRunId: "nope" }),
              context({ chatThreadId: "t" }),
              JSON.stringify({ storyId: legacyStory }),
              context({ storyId: taskStory }),
              ralphRun,
            ],
          );
          const jobId = (key: string) => jobRows.find((j) => j.dedupe_key === key)!.id;
          await client.query(`update review_runs set correlation_job_id = $1 where id = $2`, [
            jobId("correlation"),
            reviewRun,
          ]);
          const { rows: chatConnections } = await client.query<{ id: string }>(
            `insert into chat_connections (organization_id, platform, external_id, name)
             values ($1, 'slack', 'T1', 'Acme') returning id`,
            [org],
          );
          const { rows: threads } = await client.query<{ id: string }>(
            `insert into chat_threads (organization_id, connection_id, platform, external_thread_id, channel_id, started_by_external_user_id)
             values ($1, $2, 'slack', 'slack:C1:1', 'slack:C1', 'U1') returning id`,
            [org, chatConnections[0]!.id],
          );
          const { rows: threadRuns } = await client.query<{ id: string }>(
            `insert into chat_thread_runs (organization_id, chat_thread_id, kind, job_id)
             values ($1, $2, 'query', $3) returning id`,
            [org, threads[0]!.id, jobId("ask")],
          );

          await runMigrations(uri);

          // Every review belongs to a run; each legacy review got one of its own.
          const { rows: runs } = await client.query(
            `select id, organization_id, repository_id, pr_number, head_sha, base_sha, trigger, mode,
                    depth, status, error, created_at, updated_at
             from review_runs where id <> $1 order by pr_number`,
            [reviewRun],
          );
          expect(runs).toEqual([
            {
              id: legacyExhausted,
              organization_id: org,
              repository_id: repo,
              pr_number: 2,
              head_sha: "h2",
              base_sha: "b2",
              trigger: "mention",
              mode: "incremental",
              depth: "deep",
              status: "failed",
              error: "Out of tokens",
              created_at: new Date("2026-01-01T00:00:00Z"),
              updated_at: new Date("2026-01-01T00:05:00Z"),
            },
            {
              id: legacyDone,
              organization_id: org,
              repository_id: repo,
              pr_number: 3,
              head_sha: "h3",
              base_sha: "b3",
              trigger: "webhook",
              mode: "incremental",
              depth: null,
              status: "completed",
              error: null,
              created_at: new Date("2026-01-02T00:00:00Z"),
              updated_at: new Date("2026-01-02T00:05:00Z"),
            },
          ]);
          const { rows: reviewLinks } = await client.query(
            `select id, review_run_id from reviews order by pr_number`,
          );
          expect(reviewLinks).toEqual([
            { id: taskReview, review_run_id: reviewRun },
            { id: legacyExhausted, review_run_id: legacyExhausted },
            { id: legacyDone, review_run_id: legacyDone },
          ]);

          // Each job with a run is linked to exactly that run; the others to none.
          const { rows: links } = await client.query<Record<string, string | null>>(
            `select dedupe_key, ralph_run_id, ralph_story_id, review_run_id, triage_run_id, chat_thread_run_id
             from jobs order by dedupe_key`,
          );
          const link = (
            key: string,
            columns: Partial<
              Record<
                | "ralph_run_id"
                | "ralph_story_id"
                | "review_run_id"
                | "triage_run_id"
                | "chat_thread_run_id",
                string
              >
            > = {},
          ) => ({
            dedupe_key: key,
            ralph_run_id: null,
            ralph_story_id: null,
            review_run_id: null,
            triage_run_id: null,
            chat_thread_run_id: null,
            ...columns,
          });
          expect(links).toEqual([
            link("ask", { chat_thread_run_id: threadRuns[0]!.id }),
            link("correlation", { review_run_id: reviewRun }),
            link("legacy-review", { review_run_id: legacyExhausted }),
            link("legacy-review-2", { review_run_id: legacyDone }),
            link("legacy-story", { ralph_run_id: ralphRun, ralph_story_id: legacyStory }),
            link("reply"),
            link("request", { ralph_run_id: ralphRun }),
            link("review-task", { review_run_id: reviewRun }),
            link("sync"),
            link("task-story", { ralph_run_id: ralphRun, ralph_story_id: taskStory }),
            link("triage", { triage_run_id: triageRun }),
            link("triage-bad-id"),
            link("triage-turn-2", { triage_run_id: triageRun }),
          ]);

          // The links are cleared, not cascaded, when their run goes.
          await client.query(`delete from triage_runs where id = $1`, [triageRun]);
          const { rows: kept } = await client.query(
            `select triage_run_id from jobs where id = $1`,
            [jobId("triage")],
          );
          expect(kept).toEqual([{ triage_run_id: null }]);
        } finally {
          await client.end();
        }
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
    },
  );

  it("creates the triage_runs table (0046, pending_reply from 0047)", async () => {
    const { rows } = await db.$client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_name = 'triage_runs' order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "current_job_id", is_nullable: "YES" },
      { column_name: "id", is_nullable: "NO" },
      { column_name: "last_result", is_nullable: "YES" },
      { column_name: "linear_agent_session_id", is_nullable: "NO" },
      { column_name: "linear_issue_id", is_nullable: "NO" },
      { column_name: "organization_id", is_nullable: "NO" },
      { column_name: "pending_reply", is_nullable: "YES" },
      { column_name: "status", is_nullable: "NO" },
      { column_name: "trigger", is_nullable: "NO" },
      { column_name: "updated_at", is_nullable: "NO" },
    ]);

    const [org] = await db.insert(organizations).values({ name: "Triage" }).returning();
    const insert = (session: string, status = "queued") =>
      db.$client.query(
        `insert into triage_runs (organization_id, linear_issue_id, linear_agent_session_id, trigger, status)
         values ($1, 'issue-1', $2, 'mention', $3)`,
        [org!.id, session, status],
      );
    await insert("s-1", "completed");
    // The agent session is unique.
    await expect(insert("s-1", "completed")).rejects.toThrow();
    await insert("s-2");
    // One unfinished run per issue.
    await expect(insert("s-3", "running")).rejects.toThrow();
    await expect(
      db.$client.query(
        `insert into triage_runs (organization_id, linear_issue_id, linear_agent_session_id, trigger)
         values ($1, 'issue-2', 's-4', 'comment')`,
        [org!.id],
      ),
    ).rejects.toThrow();
  });

  it("allows one queued/running job per dedupe key", async () => {
    const [org] = await db.insert(organizations).values({ name: "Jobs" }).returning();
    const job = {
      organizationId: org!.id,
      type: "review.run",
      taskType: "review" as const,
      dedupeKey: "repo:1:pr:2",
    };
    const [first] = await db.insert(jobs).values(job).returning();
    await expect(db.insert(jobs).values(job)).rejects.toThrow();

    await db.update(jobs).set({ status: "completed" }).where(eq(jobs.id, first!.id));
    await expect(db.insert(jobs).values(job)).resolves.toBeDefined();
  });

  // Migrates a second database from scratch, twice: slow under a full `pnpm test`.
  it(
    "moves the runs' branch and PR/MR into their main lane (0024)",
    { timeout: 30_000 },
    async () => {
      // A fresh database migrated up to 0023, with a v2a run, then migrated the rest of the way.
      await db.execute(sql`create database lanes`);
      const uri = testDb.uri.replace(/\/[^/]*$/, "/lanes");
      const before = mkdtempSync(join(tmpdir(), "migrations-"));
      try {
        cpSync(migrationsFolder, before, { recursive: true });
        const journalPath = join(before, "meta", "_journal.json");
        const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
          entries: { tag: string }[];
        };
        const allEntries = journal.entries;
        // Only the entries before the migration `tag` starts with.
        const migrateBefore = async (client: pg.Client, tag: string) => {
          const upTo = allEntries.findIndex((e) => e.tag.startsWith(tag));
          writeFileSync(
            journalPath,
            JSON.stringify({ ...journal, entries: allEntries.slice(0, upTo) }),
          );
          await migrate(drizzle(client), { migrationsFolder: before });
        };

        const client = new pg.Client({ connectionString: uri });
        await client.connect();
        try {
          await migrateBefore(client, "0024_");
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

          // Up to 0031, which deletes connections, repositories and their runs.
          await migrateBefore(client, "0031_");
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

          await runMigrations(uri);
          const { rows: left } = await client.query(
            `select (select count(*) from repositories)::int as repositories,
                    (select count(*) from ralph_lanes)::int as lanes`,
          );
          expect(left).toEqual([{ repositories: 0, lanes: 0 }]);
        } finally {
          await client.end();
        }
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
    },
  );

  it("adds a nullable default branch to repositories, keeping existing ones (0105)", async () => {
    await db.execute(sql.raw(`create database default_branch_before`));
    const uri = testDb.uri.replace(/\/[^/]*$/, "/default_branch_before");
    await migrateBefore(uri, "0105_");
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into organizations (name) values ('Managed Services') returning id`,
      );
      const org = rows[0]!.id;
      const { rows: connections } = await client.query<{ id: string }>(
        `insert into scm_connections (organization_id, provider, name, base_url, external_id,
           encrypted_credentials, bot_username)
         values ($1, 'gitlab', 'omniralph @ gitlab.example.com', 'https://gitlab.example.com', '77',
           'x', 'service_account_group_12_omniralph')
         returning id`,
        [org],
      );
      // Production: a GitLab project with its webhook, reviews and Ask on, Coding off.
      const { rows: repos } = await client.query<{ id: string }>(
        `insert into repositories (organization_id, provider, external_id, full_path, connection_id,
           review_depth, path_excludes, custom_instructions, webhook_id)
         values ($1, 'gitlab', '4211', 'managed-services/customer-portal', $2, 'deep',
           '{"*.lock"}', 'Check the API contracts.', '9001')
         returning id`,
        [org, connections[0]!.id],
      );

      await runMigrations(uri);

      const { rows: after } = await client.query<Record<string, unknown>>(
        `select id, full_path, provider, review_depth, path_excludes, custom_instructions,
           webhook_id, reviews_enabled, coding_enabled, ask_enabled, default_branch
         from repositories`,
      );
      expect(after).toEqual([
        {
          id: repos[0]!.id,
          full_path: "managed-services/customer-portal",
          provider: "gitlab",
          review_depth: "deep",
          path_excludes: ["*.lock"],
          custom_instructions: "Check the API contracts.",
          webhook_id: "9001",
          reviews_enabled: true,
          coding_enabled: false,
          ask_enabled: true,
          default_branch: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });

  it("adds a nullable reported host to agents, keeping existing ones (0108)", async () => {
    await db.execute(sql.raw(`create database reported_host_before`));
    const uri = testDb.uri.replace(/\/[^/]*$/, "/reported_host_before");
    await migrateBefore(uri, "0108_");
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into organizations (name) values ('Managed Services') returning id`,
      );
      const org = rows[0]!.id;
      // Production: 7 live agents reporting versions, installables, models and task types,
      // and 2 revoked and soft-deleted ones.
      const live = Array.from({ length: 7 }, (_, i) => `coder-agent-${i + 1}`);
      for (const [i, name] of live.entries()) {
        await client.query(
          `insert into agents (organization_id, name, reported_version, self_update,
             reported_installables, reported_models, reported_accepted_task_types,
             failed_versions, max_concurrency, last_heartbeat_at, live_online)
           values ($1, $2, '2.0.3', 'supported',
             '[{"name":"@omniralph/hello","version":"1.0.0"}]',
             '[{"value":"opus","displayName":"Opus"}]', $3, '{"2.0.1"}', $4, now(), true)`,
          [org, name, i % 2 === 0 ? null : ["review", "query"], i === 0 ? 3 : null],
        );
      }
      for (const name of ["old-laptop", "retired-runner"]) {
        await client.query(
          `insert into agents (organization_id, name, reported_version, revoked_at, deleted_at)
           values ($1, $2, '1.9.0', now() - interval '30 days', now() - interval '29 days')`,
          [org, name],
        );
      }

      await runMigrations(uri);

      const { rows: after } = await client.query<{
        name: string;
        reported_version: string;
        revoked: boolean;
        deleted: boolean;
        reported_host: unknown;
      }>(
        `select name, reported_version, revoked_at is not null as revoked,
           deleted_at is not null as deleted, reported_host
         from agents order by name`,
      );
      expect(after).toHaveLength(9);
      expect(after.every((row) => row.reported_host === null)).toBe(true);
      expect(after.filter((row) => row.revoked && row.deleted).map((row) => row.name)).toEqual([
        "old-laptop",
        "retired-runner",
      ]);
      expect(after.filter((row) => !row.revoked && !row.deleted).map((row) => row.name)).toEqual(
        live,
      );
      expect(after.find((row) => row.name === "coder-agent-1")?.reported_version).toBe("2.0.3");
    } finally {
      await client.end();
    }
  });

  it("adds a nullable account type to code-host connections, keeping existing ones (0109)", async () => {
    await db.execute(sql.raw(`create database account_type_before`));
    const uri = testDb.uri.replace(/\/[^/]*$/, "/account_type_before");
    await migrateBefore(uri, "0109_");
    const client = new pg.Client({ connectionString: uri });
    await client.connect();
    try {
      const { rows } = await client.query<{ id: string }>(
        `insert into organizations (name) values ('Managed Services') returning id`,
      );
      const org = rows[0]!.id;
      await client.query(
        `insert into scm_connections (organization_id, provider, name, base_url, external_id,
           encrypted_credentials, bot_username)
         values ($1, 'github', 'managed-services', 'https://api.github.com', '4242', 'enc', null),
                ($1, 'gitlab', 'ops @ gitlab.netbuilder.io', 'https://gitlab.netbuilder.io', '17',
                 'enc', 'omniralph-bot')`,
        [org],
      );

      await runMigrations(uri);

      const { rows: after } = await client.query<{
        provider: string;
        name: string;
        external_id: string;
        bot_username: string | null;
        account_type: string | null;
      }>(
        `select provider, name, external_id, bot_username, account_type
         from scm_connections order by provider`,
      );
      expect(after).toEqual([
        {
          provider: "github",
          name: "managed-services",
          external_id: "4242",
          bot_username: null,
          account_type: null,
        },
        {
          provider: "gitlab",
          name: "ops @ gitlab.netbuilder.io",
          external_id: "17",
          bot_username: "omniralph-bot",
          account_type: null,
        },
      ]);
    } finally {
      await client.end();
    }
  });
});
