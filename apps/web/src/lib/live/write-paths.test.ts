import { randomBytes, randomUUID } from "node:crypto";
import {
  acceptInvitation,
  addMember,
  deleteChatChannelPlaybookSetting,
  deleteChatConnection,
  removeMember,
  removeOrganizationDomain,
  requestAgentUpdate,
  revokeInvitation,
  setAgentDesiredVersion,
  upsertChatChannelPlaybookSetting,
  addOrganizationDomain,
  captureChanges,
  claimJob,
  closeDb,
  completeJob,
  connectRepository,
  createDb,
  createAgentEnrollment,
  createHostTool,
  createInvitation,
  createCustomRule,
  createReview,
  createReviewRun,
  createRun,
  createTriageRun,
  createUser,
  deletePlaybook,
  deleteRule,
  deleteWorkItemMatch,
  dismissFinding,
  deleteScmConnection,
  enrollAgent,
  ensureChatThread,
  ensureLane,
  expireQueuedJobs,
  failJob,
  findings,
  agents,
  insertJob,
  insertPlaybook,
  insertLearnedRule,
  insertRunActivity,
  jobs,
  mapThreadRun,
  markAgentDeleted,
  markReviewRunning,
  markReviewRunRunning,
  organizations,
  pinRepositoryToAgent,
  recordAgentHeartbeat,
  replaceRoutingRules,
  requestJobCancel,
  resolveOpenFindings,
  revokeAgent,
  saveChatConnection,
  saveIntegration,
  saveWorkItemMatch,
  setDefaultMaxConcurrency,
  setAgentHostToolPath,
  setRepositorySwitches,
  setTriageRunStatus,
  setWorkItemRepository,
  clearWorkItemRepository,
  recordWorkItemEvent,
  updateAgentConfig,
  updateLane,
  updateMemberRole,
  updateOrganization,
  updatePlaybook,
  updateRule,
  updateRepositoryCoding,
  updateRepositorySettings,
  updateRun,
  updateStory,
  upsertScmConnection,
  upsertStories,
  type Database,
} from "@omniralph/db";
import {
  createTestDatabase,
  testDatabaseAvailable,
  type TestDatabase,
} from "@omniralph/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { changeMessage } = await import("./publisher");

/** The messages (channel and event, without its time) the writes in `fn` publish. */
async function published(fn: () => Promise<unknown>) {
  const { changes } = await captureChanges(fn);
  return changes.map((change) => {
    const { channel, event } = changeMessage(change);
    const { at, ...rest } = event;
    expect(Date.parse(at)).not.toBeNaN();
    return { channel, ...rest };
  });
}

describe.skipIf(!testDatabaseAvailable())("write paths record live changes", () => {
  let testDb: TestDatabase;
  let db: Database;
  let orgId: string;
  let userId: string;
  let otherUserId: string;
  let connectionId: string;
  let repoId: string;
  let agentId: string;
  let orgChannel: string;
  let issue = 0;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    db = createDb(testDb.uri);
    const user = await createUser(db, { email: "ada@example.com", name: "Ada" });
    const other = await createUser(db, { email: "bob@example.com", name: "Bob" });
    userId = user.id;
    otherUserId = other.id;
    const [org] = await db.insert(organizations).values({ name: "Acme" }).returning();
    orgId = org!.id;
    orgChannel = `org:${orgId}:changes`;
    const connection = (await upsertScmConnection(db, {
      organizationId: orgId,
      provider: "github",
      name: "acme",
      baseUrl: "https://api.github.com",
      externalId: "acme-installation",
      credentials: {},
    }))!;
    connectionId = connection.id;
    const repo = await connectRepository(db, {
      connectionId,
      provider: "github",
      externalId: "500",
      fullPath: "acme/app",
    });
    repoId = repo.id;
    const [agent] = await db
      .insert(agents)
      .values({ organizationId: orgId, name: "host", reportedVersion: "1.0.0" })
      .returning();
    agentId = agent!.id;
  }, 180_000);

  afterAll(async () => {
    if (db) await closeDb(db);
    await testDb?.stop();
  });

  async function epicRun() {
    issue += 1;
    const { run } = await createRun(db, {
      organizationId: orgId,
      linearIssueId: `issue-${issue}`,
      linearIdentifier: `SOC-${issue}`,
      linearTitle: "Epic",
      linearUrl: null,
      linearAgentSessionId: `session-${issue}`,
      kind: "children",
      repositoryId: repoId,
      branch: `branch-${issue}`,
      baseBranch: "main",
    });
    return run;
  }

  const runEvent = (runId: string, ids: string[] = [runId]) => ({
    channel: orgChannel,
    v: 1,
    resource: "run",
    ids,
    organizationId: orgId,
    runId,
  });

  /** A `work_item` event of Linear issues. */
  const workItemEvent = (...issueIds: string[]) => ({
    channel: orgChannel,
    v: 1,
    resource: "work_item",
    ids: issueIds.map((id) => `linear-${id}`),
    organizationId: orgId,
  });

  describe("runs", () => {
    it("createRun, updateRun, updateStory and upsertStories publish the run", async () => {
      let runId = "";
      // A new run also changes its work item (it leaves the Backlog).
      expect(
        await published(async () => {
          runId = (await epicRun()).id;
        }),
      ).toEqual([runEvent(runId), workItemEvent(`issue-${issue}`)]);
      expect(await published(() => updateRun(db, runId, { status: "running" }))).toEqual([
        runEvent(runId),
      ]);
      let storyId = "";
      expect(
        await published(async () => {
          const [story] = await upsertStories(db, runId, [
            { linearIssueId: "story-1", identifier: "SOC-100", title: "Story" },
          ]);
          storyId = story!.id;
        }),
      ).toEqual([runEvent(runId)]);
      expect(await published(() => updateStory(db, storyId, { status: "completed" }))).toEqual([
        runEvent(runId),
      ]);
    });

    it("updateLane publishes the run, and the pull request when its PR changed", async () => {
      const run = await epicRun();
      const lane = await ensureLane(db, {
        runId: run.id,
        repositoryId: repoId,
        branch: "b",
        baseBranch: "main",
      });
      expect(await published(() => updateLane(db, lane.id, { publish: null }))).toEqual([
        runEvent(run.id),
      ]);
      expect(
        await published(() =>
          updateLane(db, lane.id, { prNumber: 42, prUrl: "https://github.com/acme/app/pull/42" }),
        ),
      ).toEqual([
        runEvent(run.id),
        {
          channel: orgChannel,
          v: 1,
          resource: "pull_request",
          ids: [lane.id],
          organizationId: orgId,
          runId: run.id,
        },
      ]);
    });

    it("review run and review status updates publish the review run", async () => {
      let reviewRunId = "";
      expect(
        await published(async () => {
          reviewRunId = (
            await createReviewRun(db, {
              organizationId: orgId,
              repositoryId: repoId,
              prNumber: 3,
              headSha: "a".repeat(40),
              baseSha: "b".repeat(40),
              trigger: "mention",
              mode: "full",
              depth: "standard",
            })
          ).id;
        }),
      ).toEqual([runEvent(reviewRunId)]);
      let reviewId = "";
      expect(
        await published(async () => {
          reviewId = (
            await createReview(db, {
              reviewRunId,
              repositoryId: repoId,
              prNumber: 3,
              prTitle: "Change",
              headSha: "a".repeat(40),
              baseSha: "b".repeat(40),
              trigger: "mention",
              depth: "standard",
              model: null,
              budget: 100_000,
            })
          ).id;
        }),
      ).toEqual([runEvent(reviewRunId)]);
      expect(await published(() => markReviewRunning(db, reviewId, agentId))).toEqual([
        runEvent(reviewRunId),
      ]);
      expect(await published(() => markReviewRunRunning(db, reviewRunId))).toEqual([
        runEvent(reviewRunId),
      ]);
      // Already running: nothing changed, nothing is published.
      expect(await published(() => markReviewRunRunning(db, reviewRunId))).toEqual([]);
    });

    it("dismissing, restoring and resolving a finding publish its review run", async () => {
      const reviewRun = await createReviewRun(db, {
        organizationId: orgId,
        repositoryId: repoId,
        prNumber: 4,
        headSha: "c".repeat(40),
        baseSha: "d".repeat(40),
        trigger: "mention",
        mode: "full",
        depth: "standard",
      });
      const review = await createReview(db, {
        reviewRunId: reviewRun.id,
        repositoryId: repoId,
        prNumber: 4,
        prTitle: "Change",
        headSha: "c".repeat(40),
        baseSha: "d".repeat(40),
        trigger: "mention",
        depth: "standard",
        model: null,
        budget: 100_000,
      });
      const finding = {
        reviewId: review.id,
        path: "a.ts",
        startLine: 1,
        endLine: 1,
        severity: "high" as const,
        category: "bug",
        title: "t",
        body: "b",
        confidence: 0.9,
      };
      const [first, second] = await db.insert(findings).values([finding, finding]).returning();
      expect(
        await published(() =>
          dismissFinding(db, {
            findingId: first!.id,
            reason: "false_positive",
            scmUsername: "ada",
          }),
        ),
      ).toEqual([runEvent(reviewRun.id)]);
      expect(await published(() => resolveOpenFindings(db, [first!.id, second!.id]))).toEqual([
        runEvent(reviewRun.id),
      ]);
      // Nothing left to change: nothing is published.
      expect(
        await published(() =>
          dismissFinding(db, { findingId: first!.id, reason: "false_positive" }),
        ),
      ).toEqual([]);
      expect(await published(() => resolveOpenFindings(db, [first!.id]))).toEqual([]);
    });

    it("triage run updates publish the triage run", async () => {
      let runId = "";
      expect(
        await published(async () => {
          runId = (
            await createTriageRun(db, {
              organizationId: orgId,
              linearIssueId: "triage-issue",
              linearAgentSessionId: "triage-session",
              trigger: "mention",
            })
          ).run.id;
        }),
      ).toEqual([runEvent(runId), workItemEvent("triage-issue")]);
      expect(await published(() => setTriageRunStatus(db, runId, "failed"))).toEqual([
        runEvent(runId),
        workItemEvent("triage-issue"),
      ]);
    });

    it("mapping an ask to its chat thread publishes the ask run", async () => {
      const connection = await saveChatConnection(db, {
        organizationId: orgId,
        platform: "slack",
        externalId: "T1",
        name: "Acme",
        credentials: null,
        installedByUserId: null,
      });
      if (connection === "other_organization") throw new Error("connected elsewhere");
      const thread = (await ensureChatThread(db, {
        connectionId: connection.id,
        externalThreadId: "thread-1",
        channelId: "slack:C1",
        startedByExternalUserId: "U1",
      }))!;
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "chat.ask",
        taskType: "query",
      });
      let askId = "";
      expect(
        await published(async () => {
          askId = (await mapThreadRun(db, {
            organizationId: orgId,
            chatThreadId: thread.id,
            jobId: job.id,
          }))!.id;
        }),
      ).toEqual([runEvent(askId)]);
    });
  });

  describe("attempts", () => {
    async function queuedJob(run?: { id: string }) {
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "ralph.story",
        taskType: "coding",
        ralphRunId: run?.id ?? null,
      });
      return job;
    }

    it("creating, claiming, completing, failing and canceling a job publish its run", async () => {
      await db.delete(jobs);
      const run = await epicRun();
      let jobId = "";
      expect(
        await published(async () => {
          jobId = (await queuedJob(run)).id;
        }),
      ).toEqual([runEvent(run.id, [jobId])]);
      const claim = {
        agentId,
        organizationId: orgId,
        acceptedTaskTypes: ["coding"],
        pools: ["long"],
        agentVersion: "1.0.0",
        maxDeliveries: 3,
      };
      expect(await published(() => claimJob(db, claim))).toEqual([runEvent(run.id, [jobId])]);
      expect(
        await published(() => failJob(db, { jobId, agentId, retryable: true, maxDeliveries: 3 })),
      ).toEqual([runEvent(run.id, [jobId])]);
      await claimJob(db, claim);
      expect(await published(() => completeJob(db, { jobId, agentId, result: {} }))).toEqual([
        runEvent(run.id, [jobId]),
      ]);
      // A rejected result (not running any more) publishes nothing.
      expect(await published(() => completeJob(db, { jobId, agentId, result: {} }))).toEqual([]);
      const queued = await queuedJob(run);
      expect(await published(() => requestJobCancel(db, queued.id))).toEqual([
        runEvent(run.id, [queued.id]),
      ]);
    });

    it("a system job's change has no run", async () => {
      let jobId = "";
      expect(
        await published(async () => {
          jobId = (
            await insertJob(db, {
              organizationId: orgId,
              type: "repo.sync",
              taskType: "system",
            })
          ).job.id;
        }),
      ).toEqual([
        { channel: orgChannel, v: 1, resource: "run", ids: [jobId], organizationId: orgId },
      ]);
    });

    it("expiring queued jobs publishes them, merged into one event per run", async () => {
      await db.delete(jobs);
      const run = await epicRun();
      const first = await queuedJob(run);
      const second = await queuedJob(run);
      expect(await published(() => expireQueuedJobs(db, new Date(Date.now() + 60_000)))).toEqual([
        runEvent(run.id, [first.id, second.id]),
      ]);
    });
  });

  describe("transcript", () => {
    it("insertRunActivity publishes the attempt's transcript", async () => {
      const run = await epicRun();
      const { job } = await insertJob(db, {
        organizationId: orgId,
        type: "ralph.story",
        taskType: "coding",
        ralphRunId: run.id,
      });
      expect(
        await published(() =>
          insertRunActivity(db, {
            jobId: job.id,
            organizationId: orgId,
            type: "thought",
            body: "Thinking about the secret plan",
          }),
        ),
      ).toEqual([
        {
          channel: orgChannel,
          v: 1,
          resource: "transcript",
          ids: [job.id],
          organizationId: orgId,
          runId: run.id,
        },
      ]);
    });
  });

  describe("agents", () => {
    const agentEvent = (id: string) => ({
      channel: orgChannel,
      v: 1,
      resource: "agent",
      ids: [id],
      organizationId: orgId,
    });

    it("enroll, settings, pins, host tool paths, revoke and delete publish the agent", async () => {
      const { token } = await createAgentEnrollment(db, { organizationId: orgId });
      let id = "";
      expect(
        await published(async () => {
          id = (await enrollAgent(db, { enrollmentToken: token, name: "new", version: "1.0.0" }))!
            .agentId;
        }),
      ).toEqual([agentEvent(id)]);
      expect(
        await published(() =>
          updateAgentConfig(db, orgId, id, {
            maxConcurrency: 2,
            poolLimits: {},
          }),
        ),
      ).toEqual([agentEvent(id)]);
      expect(
        await published(() => pinRepositoryToAgent(db, { agentId: id, repositoryId: repoId })),
      ).toEqual([
        agentEvent(id),
        {
          channel: orgChannel,
          v: 1,
          resource: "settings",
          section: "repository.agents",
          ids: [repoId],
          subjectId: repoId,
          organizationId: orgId,
        },
      ]);
      const tool = await createHostTool(db, orgId, { name: "psql" });
      if (!tool.ok) throw new Error("setup");
      expect(
        await published(() => setAgentHostToolPath(db, orgId, id, tool.hostTool.id, "/bin/psql")),
      ).toEqual([agentEvent(id)]);
      const revoked = await published(() => revokeAgent(db, id, { organizationId: orgId }));
      expect(revoked).toContainEqual(agentEvent(id));
      expect(revoked).toContainEqual(expect.objectContaining({ section: "repository.agents" }));
      expect(await published(() => markAgentDeleted(db, orgId, id))).toEqual([agentEvent(id)]);
    });

    it("a heartbeat publishes a changed update state or install, not a steady report", async () => {
      const report = { version: "1.0.0", installables: [] };
      await recordAgentHeartbeat(db, agentId, report);
      expect(await published(() => recordAgentHeartbeat(db, agentId, report))).toEqual([]);
      const failing = {
        ...report,
        update: { status: "failed" as const, version: "1.1.0", error: "boom", at: "x" },
      };
      expect(await published(() => recordAgentHeartbeat(db, agentId, failing as never))).toEqual([
        agentEvent(agentId),
      ]);
      expect(
        await published(() =>
          recordAgentHeartbeat(db, agentId, {
            ...(failing as never as typeof report),
            installables: [{ name: "gh", version: "2.0.0" }],
          } as never),
        ),
      ).toEqual([agentEvent(agentId)]);
    });

    it("a heartbeat publishes reported task types that differ from the stored ones", async () => {
      const report = { version: "1.0.0", acceptedTaskTypes: ["query", "review", "coding"] };
      await recordAgentHeartbeat(db, agentId, report);
      expect(await published(() => recordAgentHeartbeat(db, agentId, report))).toEqual([]);
      expect(
        await published(() =>
          recordAgentHeartbeat(db, agentId, { ...report, acceptedTaskTypes: ["review"] }),
        ),
      ).toEqual([agentEvent(agentId)]);
      // An older agent reports none: the stored ones stay, nothing is published.
      expect(
        await published(() => recordAgentHeartbeat(db, agentId, { version: "1.0.0" })),
      ).toEqual([]);
    });

    it("a desired version or an update request from the control panel publishes the agent", async () => {
      expect(await published(() => setAgentDesiredVersion(db, orgId, agentId, "1.2.0"))).toEqual([
        agentEvent(agentId),
      ]);
      expect(await published(() => requestAgentUpdate(db, orgId, agentId, "1.2.0"))).toEqual([
        agentEvent(agentId),
      ]);
      expect(await published(() => setAgentDesiredVersion(db, orgId, agentId, null))).toEqual([
        agentEvent(agentId),
      ]);
    });

    it("an install job targeted at an agent publishes the agent", async () => {
      const events = await published(() =>
        insertJob(db, {
          organizationId: orgId,
          type: "install",
          taskType: "system",
          targetAgentId: agentId,
        }),
      );
      expect(events).toContainEqual(agentEvent(agentId));
    });
  });

  describe("settings", () => {
    const settingsEvent = (section: string, subjectId?: string) => ({
      channel: orgChannel,
      v: 1,
      resource: "settings",
      section,
      ids: [subjectId ?? orgId],
      ...(subjectId ? { subjectId } : {}),
      organizationId: orgId,
    });

    it("repository review, coding and task-type saves publish their section", async () => {
      expect(
        await published(() =>
          updateRepositorySettings(db, orgId, repoId, {
            depth: "standard",
            triggers: { onOpen: true, onPush: false, drafts: false },
            pathExcludes: [],
            customInstructions: "",
          }),
        ),
      ).toEqual([settingsEvent("repository.reviews", repoId)]);
      expect(
        await published(() => updateRepositoryCoding(db, repoId, { historyRewrite: "always" })),
      ).toEqual([settingsEvent("repository.coding", repoId)]);
      expect(
        await published(() =>
          setRepositorySwitches(db, orgId, repoId, { reviews: true, coding: false }),
        ),
      ).toEqual([
        { channel: orgChannel, v: 1, resource: "repository", ids: [repoId], organizationId: orgId },
        settingsEvent("repository.reviews", repoId),
        settingsEvent("repository.coding", repoId),
      ]);
    });

    it("work item match saves and clears publish the repository's coding section", async () => {
      const match = {
        tracker: "linear" as const,
        team: "ENG",
        project: null,
        withoutProject: false,
        labels: ["web"],
      };
      expect(
        await published(() =>
          saveWorkItemMatch(db, { organizationId: orgId, repositoryId: repoId, userId, match }),
        ),
      ).toEqual([settingsEvent("repository.coding", repoId)]);
      expect(await published(() => deleteWorkItemMatch(db, orgId, repoId))).toEqual([
        settingsEvent("repository.coding", repoId),
      ]);
      // Nothing to clear, nothing published.
      expect(await published(() => deleteWorkItemMatch(db, orgId, repoId))).toEqual([]);
    });

    it("routing rules and agent defaults publish their section", async () => {
      expect(
        await published(() =>
          replaceRoutingRules(db, orgId, [
            {
              repositoryId: repoId,
              query: {
                combinator: "and",
                rules: [{ field: "labels", operator: "containsAny", value: ["web"] }],
              },
            },
          ]),
        ),
      ).toEqual([settingsEvent("routing_rules")]);
      expect(await published(() => setDefaultMaxConcurrency(db, orgId, 3, userId))).toEqual([
        settingsEvent("agent_defaults"),
      ]);
      expect(await published(() => createHostTool(db, orgId, { name: "jq" }))).toEqual([
        settingsEvent("agent_defaults"),
      ]);
    });

    it("playbook saves and deletes publish the playbooks section, the playbook its subject", async () => {
      const playbook = {
        name: "Review",
        role: "review",
        definition: { promptTemplate: "x" },
        requirements: {},
      };
      let playbookId = "";
      const inserted = await published(async () => {
        playbookId = (await insertPlaybook(db, orgId, { ...playbook, createdBy: userId })).id;
      });
      expect(inserted).toEqual([settingsEvent("playbooks", playbookId)]);
      expect(
        await published(() =>
          updatePlaybook(db, orgId, playbookId, { ...playbook, updatedBy: userId }),
        ),
      ).toEqual([settingsEvent("playbooks", playbookId)]);
      expect(await published(() => deletePlaybook(db, orgId, playbookId))).toEqual([
        settingsEvent("playbooks", playbookId),
      ]);

      // Nothing saved or deleted (gone, or another organization's): nothing published.
      expect(
        await published(async () => {
          await updatePlaybook(db, orgId, playbookId, { ...playbook, updatedBy: userId });
          await deletePlaybook(db, orgId, playbookId);
        }),
      ).toEqual([]);
    });

    it("connections and integrations publish the connection", async () => {
      const connectionEvent = (id: string) => ({
        channel: orgChannel,
        v: 1,
        resource: "connection",
        ids: [id],
        organizationId: orgId,
      });
      let gitlabId = "";
      expect(
        await published(async () => {
          gitlabId = (await upsertScmConnection(db, {
            organizationId: orgId,
            provider: "gitlab",
            name: "gl",
            baseUrl: "https://gitlab.example.com",
            externalId: "gl-1",
            credentials: { token: "secret-token" },
          }))!.id;
        }),
      ).toEqual([connectionEvent(gitlabId)]);
      expect(await published(() => deleteScmConnection(db, orgId, gitlabId))).toEqual([
        connectionEvent(gitlabId),
      ]);
      let integrationId = "";
      expect(
        await published(async () => {
          const saved = await saveIntegration(db, {
            organizationId: orgId,
            provider: "linear",
            externalId: "workspace-1",
            name: "Acme workspace",
            credentials: { accessToken: "secret" },
            installedByUserId: userId,
          });
          if (saved === "other_organization") throw new Error("setup");
          integrationId = saved.id;
        }),
      ).toEqual([connectionEvent(integrationId)]);
    });

    it("chat connections and their channel playbook settings publish the connection", async () => {
      const connectionEvent = (id: string) => ({
        channel: orgChannel,
        v: 1,
        resource: "connection",
        ids: [id],
        organizationId: orgId,
      });
      let chatId = "";
      expect(
        await published(async () => {
          const saved = await saveChatConnection(db, {
            organizationId: orgId,
            platform: "slack",
            externalId: "T-live",
            name: "Acme Slack",
            credentials: { botToken: "xoxb-secret" },
            installedByUserId: userId,
          });
          if (saved === "other_organization") throw new Error("setup");
          chatId = saved.id;
        }),
      ).toEqual([connectionEvent(chatId)]);
      expect(
        await published(() =>
          upsertChatChannelPlaybookSetting(db, {
            organizationId: orgId,
            connectionId: chatId,
            channelId: "slack:C1",
            askPlaybookId: null,
            startWorkPlaybookId: null,
            updatedBy: userId,
          }),
        ),
      ).toEqual([connectionEvent(chatId)]);
      expect(
        await published(() => deleteChatChannelPlaybookSetting(db, orgId, chatId, "slack:C1")),
      ).toEqual([connectionEvent(chatId)]);
      expect(await published(() => deleteChatConnection(db, orgId, chatId))).toEqual([
        connectionEvent(chatId),
      ]);
    });

    it("organization, member, invitation and domain changes publish the organization", async () => {
      const orgEvent = {
        channel: orgChannel,
        v: 1,
        resource: "organization",
        ids: [orgId],
        organizationId: orgId,
      };
      // The member also hears it on their own channel: their organizations changed.
      const memberEvent = (id: string) => ({ ...orgEvent, channel: `user:${id}:changes` });
      expect(await published(() => updateOrganization(db, orgId, { name: "Acme Inc" }))).toEqual([
        orgEvent,
      ]);
      expect(
        await published(() => addMember(db, { organizationId: orgId, userId, role: "admin" })),
      ).toEqual([orgEvent, memberEvent(userId)]);
      await addMember(db, { organizationId: orgId, userId: otherUserId, role: "member" });
      expect(
        await published(() =>
          updateMemberRole(db, { organizationId: orgId, userId: otherUserId, role: "admin" }),
        ),
      ).toEqual([orgEvent, memberEvent(otherUserId)]);
      expect(
        await published(() =>
          createInvitation(db, {
            organizationId: orgId,
            email: "carol@example.com",
            role: "member",
            invitedBy: userId,
          }),
        ),
      ).toEqual([orgEvent]);
      expect(await published(() => addOrganizationDomain(db, orgId, "example.com"))).toEqual([
        orgEvent,
      ]);
    });

    it("member removal, invitation revoke and accept, and domain removal publish the organization", async () => {
      const orgEvent = {
        channel: orgChannel,
        v: 1,
        resource: "organization",
        ids: [orgId],
        organizationId: orgId,
      };
      const memberEvent = (id: string) => ({ ...orgEvent, channel: `user:${id}:changes` });
      const dave = await createUser(db, { email: "dave@example.com", name: "Dave" });
      await addMember(db, { organizationId: orgId, userId: dave.id, role: "member" });
      // The removed member hears it on their own channel: their next live token drops the org.
      expect(
        await published(() => removeMember(db, { organizationId: orgId, userId: dave.id })),
      ).toEqual([orgEvent, memberEvent(dave.id)]);

      const invite = async (email: string) => {
        const result = await createInvitation(db, {
          organizationId: orgId,
          email,
          role: "member",
          invitedBy: userId,
        });
        if (result.status !== "created") throw new Error(`setup: ${result.status}`);
        return result.invitation.id;
      };
      const revoked = await invite("erin@example.com");
      expect(
        await published(() =>
          revokeInvitation(db, { organizationId: orgId, invitationId: revoked }),
        ),
      ).toEqual([orgEvent]);
      const frank = await createUser(db, { email: "frank@example.com", name: "Frank" });
      const accepted = await invite("frank@example.com");
      expect(
        await published(() => acceptInvitation(db, { invitationId: accepted, userId: frank.id })),
      ).toEqual([orgEvent, memberEvent(frank.id)]);

      await addOrganizationDomain(db, orgId, "removed.example.com");
      expect(
        await published(() => removeOrganizationDomain(db, orgId, "removed.example.com")),
      ).toEqual([orgEvent]);
    });
  });

  describe("work items", () => {
    it("a repo choice saved or cleared and an Omniralph action publish the work item", async () => {
      const key = { organizationId: orgId, tracker: "linear" as const, externalId: "item-1" };
      expect(
        await published(() =>
          setWorkItemRepository(db, { ...key, repositoryId: repoId, userId: null }),
        ),
      ).toEqual([workItemEvent("item-1")]);
      expect(await published(() => clearWorkItemRepository(db, key))).toEqual([
        workItemEvent("item-1"),
      ]);
      // Nothing to clear: nothing changed.
      expect(await published(() => clearWorkItemRepository(db, key))).toEqual([]);
      expect(
        await published(() =>
          recordWorkItemEvent(db, {
            ...key,
            kind: "moved_to_needs_refining",
            actorUserId: null,
            actorName: "Ada",
          }),
        ),
      ).toEqual([workItemEvent("item-1")]);
    });
  });

  describe("repository rules", () => {
    it("adding, editing, deleting and learning a rule publish the repository", async () => {
      const event = {
        channel: orgChannel,
        v: 1,
        resource: "repository",
        ids: [repoId],
        organizationId: orgId,
      };
      let ruleId = "";
      expect(
        await published(async () => {
          const rule = await createCustomRule(db, {
            repositoryId: repoId,
            text: "No",
            createdBy: userId,
          });
          ruleId = rule.id;
        }),
      ).toEqual([event]);
      expect(
        await published(() => updateRule(db, { repositoryId: repoId, ruleId, enabled: false })),
      ).toEqual([event]);
      expect(await published(() => deleteRule(db, { repositoryId: repoId, ruleId }))).toEqual([
        event,
      ]);
      // No such rule: nothing is published.
      expect(
        await published(() => updateRule(db, { repositoryId: repoId, ruleId, enabled: true })),
      ).toEqual([]);
      expect(await published(() => deleteRule(db, { repositoryId: repoId, ruleId }))).toEqual([]);

      const [finding] = await db.select({ id: findings.id }).from(findings).limit(1);
      const learn = () =>
        insertLearnedRule(db, {
          repositoryId: repoId,
          text: "Learned",
          sourceFindingId: finding!.id,
          findDuplicate: (text, existing) => existing.find((rule) => rule.text === text),
        });
      expect(await published(learn)).toEqual([event]);
      // A duplicate isn't stored: nothing is published.
      expect(await published(learn)).toEqual([]);
    });
  });

  it("publishes nothing for a write that changed nothing", async () => {
    expect(await published(() => updateRun(db, randomUUID(), { status: "running" }))).toEqual([]);
    expect(
      await published(() =>
        updateAgentConfig(db, orgId, randomUUID(), {
          maxConcurrency: 2,
          poolLimits: {},
        }),
      ),
    ).toEqual([]);
  });

  it("never puts names, titles or bodies in an event", async () => {
    const run = await epicRun();
    const events = await published(async () => {
      await updateRun(db, run.id, { status: "running" });
      await updateOrganization(db, orgId, { name: "Secret Name" });
    });
    const text = JSON.stringify(events);
    for (const content of ["Epic", "Secret Name", "SOC-", "Acme"])
      expect(text).not.toContain(content);
    await db.update(organizations).set({ name: "Acme" }).where(eq(organizations.id, orgId));
  });
});
