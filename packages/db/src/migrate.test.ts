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
import { closeDb, createDb, type Database } from "./client.js";
import { migrationsFolder, runMigrations } from "./migrate.js";
import { seedReviewProfiles } from "./settings.js";
import {
  appSettings,
  jobs,
  organizationEmailDomains,
  organizations,
  repositories,
  reviewProfiles,
  scmConnections,
} from "./schema.js";

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
    if (db) await closeDb(db);
    await container?.stop();
  });

  it("is idempotent", async () => {
    await expect(runMigrations(container.getConnectionUri())).resolves.toBeUndefined();
  });

  it("seeds the quick, standard and deep profiles per organization (0031)", async () => {
    // Profiles belong to organizations now: none survive the migration.
    expect(await db.select().from(reviewProfiles)).toEqual([]);
    const [acme] = await db.insert(organizations).values({ name: "Acme" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    await seedReviewProfiles(db, acme!.id);
    await seedReviewProfiles(db, other!.id);

    const profiles = await db
      .select({
        id: reviewProfiles.id,
        model: reviewProfiles.model,
        maxTokensPerReview: reviewProfiles.maxTokensPerReview,
        maxFiles: reviewProfiles.maxFiles,
        allowRepoExploration: reviewProfiles.allowRepoExploration,
        builtIn: reviewProfiles.builtIn,
      })
      .from(reviewProfiles)
      .where(eq(reviewProfiles.organizationId, acme!.id))
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
      expect(profile.builtIn).toBe(true);
    }
    // IDs are unique per organization, not globally.
    expect(await db.select().from(reviewProfiles)).toHaveLength(6);
  });

  it("defaults repositories to the standard profile and default triggers", async () => {
    const [org] = await db.insert(organizations).values({ name: "Repos" }).returning();
    await seedReviewProfiles(db, org!.id);
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
      profileId: "standard",
      enabled: true,
      triggers: { onOpen: true, onPush: true, drafts: false },
      pathExcludes: [],
      // Ralph runs stay on the legacy jobs until an admin switches (0064).
      codingPath: "legacy",
      storyTaskId: "builtin:implement-story",
      requestTaskId: "builtin:handle-request",
    });

    // The profile must be one of the repository's organization.
    const [bare] = await db.insert(organizations).values({ name: "No profiles" }).returning();
    await expect(
      db.insert(repositories).values({
        organizationId: bare!.id,
        provider: "github",
        externalId: "2",
        fullPath: "mcm/other",
        connectionId: connection!.id,
      }),
    ).rejects.toThrow();
  });

  it("adds the coding path and a request's trigger (0064)", async () => {
    const { rows } = await db.$client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'public'
         and ((table_name = 'repositories' and column_name in ('coding_path', 'story_task_id', 'request_task_id'))
           or (table_name = 'ralph_messages' and column_name = 'trigger'))
       order by column_name`,
    );
    expect(rows).toEqual([
      { column_name: "coding_path", is_nullable: "NO" },
      { column_name: "request_task_id", is_nullable: "NO" },
      { column_name: "story_task_id", is_nullable: "NO" },
      { column_name: "trigger", is_nullable: "YES" },
    ]);
    await expect(db.$client.query(`select 'other'::repository_coding_path`)).rejects.toThrow();
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

  it("keys app settings by organization and puts harnesses in an organization (0033)", async () => {
    const [a] = await db.insert(organizations).values({ name: "Settings A" }).returning();
    const [b] = await db.insert(organizations).values({ name: "Settings B" }).returning();
    await db.insert(appSettings).values([
      { organizationId: a!.id, key: "harness.desiredVersion", value: "1.0.0" },
      { organizationId: b!.id, key: "harness.desiredVersion", value: "2.0.0" },
    ]);
    await expect(
      db
        .insert(appSettings)
        .values({ organizationId: a!.id, key: "harness.desiredVersion", value: 1 }),
    ).rejects.toThrow();
    await expect(db.execute(sql`insert into harnesses (name) values ('no-org')`)).rejects.toThrow();
    await expect(
      db.execute(sql`insert into harness_enrollments (token_hash, expires_at) values ('h', now())`),
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
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/bot_usernames");
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
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/run_origins");
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
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/job_queue");
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

        await runMigrations(uri);
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
       where table_name = 'harnesses' and column_name = 'poll_interval_seconds'`,
    );
    expect(rows).toEqual([]);
  });

  it("drops the capability columns from jobs and harnesses (0057)", async () => {
    const { rows } = await db.$client.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where (table_name = 'jobs' and column_name = 'capability')
          or (table_name = 'harnesses'
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
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/harnesses");
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
           values ($1, 'standard', 'Standard', 'm', 1, 1, false)`,
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

        await runMigrations(uri);
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
           where table_schema = 'public' and table_name like 'agent%'`,
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
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/task_types");
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

        await runMigrations(uri);
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

  it("cancels legacy review.run jobs and renames review task jobs (0063)", async () => {
    await db.execute(sql`create database legacy_review_jobs`);
    const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/legacy_review_jobs");
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
           values ($1, 'standard', 'Standard', 'm', 1, 1, false)`,
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
      pool: "short",
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
      const uri = container.getConnectionUri().replace(/\/[^/]*$/, "/lanes");
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
});
