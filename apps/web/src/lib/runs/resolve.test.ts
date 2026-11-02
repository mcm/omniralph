import type * as Db from "@omniralph/db";
import {
  CODING_TASKS_MIN_AGENT_VERSION,
  agentVersionAtLeast,
  QUERY_TASKS_MIN_AGENT_VERSION,
  REVIEW_TASKS_MIN_AGENT_VERSION,
  SETUP_COMMANDS_MIN_AGENT_VERSION,
  TRACKER_PROTOCOL_MIN_AGENT_VERSION,
  reviewProfileConfigForDepth,
  type JobToken,
  type ReviewDepth,
  type ReviewProfileConfig,
  type RunSpecJobPayload,
} from "@omniralph/shared";
import {
  BUILTIN_PLAYBOOKS,
  getBuiltinPlaybook,
  Playbook,
  playbookTaskType,
  PLAYBOOK_ROLES,
  TaskDefinition,
  type PlaybookInput,
  type TaskDefinitionInput,
} from "@omniralph/tasks";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ repository: null as unknown }));
vi.mock("@omniralph/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  getRepositoryWithConnection: async (_db: unknown, id: string, organizationId: string) =>
    state.repository && id === REPO_ID && organizationId === ORG_ID
      ? {
          repository: state.repository,
          connection: { baseUrl: "https://api.github.com" },
        }
      : null,
}));

const { RunSpecError, narrowByReviewDepth, resolveRunSpec, runTokenBudget } =
  await import("./resolve");
const { BUILTIN_PLAYBOOK_SOURCE } = await import("@/lib/playbooks");
const { runSpecJobInput } = await import("./job");

const ORG_ID = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const REPO_ID = "0b8f9c1e-4d2a-4f6b-9e3c-7a5d1c2b3e4f";
const JOB_ID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const db = {} as Db.Database;

const playbookInput: PlaybookInput = {
  id: "builtin:reply-to-finding",
  name: "Reply",
  role: "reply-to-finding",
  systemPrompt: "You read code.",
  promptTemplate: "{{question}}",
  tools: { builtin: ["Read", "Grep", "Glob"] },
  model: "haiku",
  fallbackModel: "sonnet",
  tokenBudget: { tokens: 20_000 },
};

/** A run spec task, for `runSpecJobInput`. */
const taskInput: TaskDefinitionInput = {
  id: "builtin:reply-to-finding",
  name: "Reply",
  taskType: "query",
  agentId: "builtin:code-reader",
  triggers: ["finding.mention"],
  promptTemplate: "{{question}}",
  sink: "finding-thread",
  tokenBudget: { tokens: 20_000 },
};

const tokens: { lifecycle: JobToken; session: JobToken } = {
  lifecycle: { jobId: JOB_ID, token: "lifecycle-jwt", expiresIn: 900, kind: "lifecycle" },
  session: { jobId: JOB_ID, token: "session-jwt", expiresIn: 900, kind: "session" },
};

const payload: RunSpecJobPayload = {
  trigger: { kind: "finding.mention", context: { question: "Why?" } },
  repositoryId: REPO_ID,
  ref: "abc123",
  requireCheckout: true,
};

/** A source of one playbook: `playbookInput` with `overrides` (not validated, as a stored one may not be). */
function playbooks(overrides: Partial<Playbook> = {}) {
  const p: Playbook = { ...Playbook.parse(playbookInput), ...overrides };
  return { getPlaybook: (id: string) => (id === p.id ? p : null) };
}

function job(overrides: Partial<Db.Job> = {}) {
  return {
    id: JOB_ID,
    organizationId: ORG_ID,
    taskType: "query",
    taskId: "builtin:reply-to-finding",
    repositoryId: REPO_ID,
    payload,
    ...overrides,
  } as Db.Job;
}

function repository(reviewDepth = "standard") {
  return { provider: "github", fullPath: "acme/app", reviewDepth };
}

beforeEach(() => {
  state.repository = repository();
});

describe("resolveRunSpec", () => {
  it("resolves the playbook as its agent and task, the trigger, the repository, ref and tokens", async () => {
    const spec = await resolveRunSpec(db, job(), tokens, playbooks());
    expect(spec).toMatchObject({
      jobId: JOB_ID,
      taskType: "query",
      pool: "short",
      agent: {
        id: "builtin:reply-to-finding",
        systemPrompt: "You read code.",
        tools: { builtin: ["Read", "Grep", "Glob"] },
        // Agents up to 0.13 still require an agent's task types: the run's own.
        taskTypes: ["query"],
      },
      // Agents up to 0.13 still read the task's pool: it is derived from its task type.
      task: {
        id: "builtin:reply-to-finding",
        agentId: "builtin:reply-to-finding",
        triggers: ["finding.mention"],
        sink: "finding-thread",
        pool: "short",
      },
      trigger: payload.trigger,
      repository: {
        provider: "github",
        fullPath: "acme/app",
        cloneUrl: "https://github.com/acme/app.git",
      },
      repositoryId: REPO_ID,
      ref: "abc123",
      requireCheckout: true,
      tools: { allowedTools: [], disallowedTools: [] },
      fallbackModel: "sonnet",
      tokens,
    });
  });

  describe("tracker tools", () => {
    const reader = {
      tools: {
        ...Playbook.parse(playbookInput).tools,
        tracker: ["tracker_get_issue", "tracker_get_document"],
      },
      toolSettings: { ...Playbook.parse(playbookInput).toolSettings, trackerRead: true },
    } satisfies Partial<Playbook>;

    it("offers the document tool when the tracker has documents", async () => {
      const spec = await resolveRunSpec(db, job(), tokens, playbooks(reader), ["documents"]);
      expect(spec.agent.tools.tracker).toEqual(["tracker_get_issue", "tracker_get_document"]);
    });

    it("leaves the document tool out when the tracker has no documents", async () => {
      const spec = await resolveRunSpec(db, job(), tokens, playbooks(reader), ["sessions"]);
      expect(spec.agent.tools.tracker).toEqual(["tracker_get_issue"]);
      expect(spec.task.toolSettings.trackerRead).toBe(true);
    });

    it("offers Linear's document tool by default", async () => {
      const spec = await resolveRunSpec(db, job(), tokens, playbooks(reader));
      expect(spec.agent.tools.tracker).toContain("tracker_get_document");
    });
  });

  describe("model precedence", () => {
    it("takes the playbook's model and fallback model, with or without a repository", async () => {
      expect(await resolveRunSpec(db, job(), tokens, playbooks())).toMatchObject({
        model: "haiku",
        fallbackModel: "sonnet",
      });
      const spec = await resolveRunSpec(
        db,
        job({ repositoryId: null, payload: { trigger: payload.trigger } }),
        tokens,
        playbooks(),
      );
      expect(spec).toMatchObject({
        model: "haiku",
        repository: null,
        repositoryId: null,
        ref: null,
      });
      expect(spec.requireCheckout).toBe(false);
    });

    it("is null when the playbook sets none (the Claude Code default), whatever the repository's depth", async () => {
      for (const depth of ["quick", "standard", "deep"]) {
        state.repository = repository(depth);
        const spec = await resolveRunSpec(db, job(), tokens, playbooks({ model: null }));
        expect(spec.model, depth).toBeNull();
      }
    });

    it("is the playbook's model and fallback model for a run a ralph run invokes", async () => {
      const invoked = job({
        payload: {
          ...payload,
          trigger: { kind: "run.invoked", context: { invoker: { kind: "ralph-run", id: JOB_ID } } },
        },
      });
      const describePr = playbooks({ role: "pr-description" });
      expect(await resolveRunSpec(db, invoked, tokens, describePr)).toMatchObject({
        model: "haiku",
        fallbackModel: "sonnet",
      });
    });
  });

  describe("token budget", () => {
    it("is the playbook's fixed budget, whatever the repository's depth", async () => {
      for (const depth of ["quick", "standard", "deep"]) {
        state.repository = repository(depth);
        expect((await resolveRunSpec(db, job(), tokens, playbooks())).tokenBudget).toBe(20_000);
      }
    });

    it("is null (No limit) when the playbook sets none", async () => {
      const none = playbooks({ tokenBudget: null });
      expect((await resolveRunSpec(db, job(), tokens, none)).tokenBudget).toBeNull();
      const noRepository = job({ repositoryId: null, payload: { trigger: payload.trigger } });
      expect((await resolveRunSpec(db, noRepository, tokens, none)).tokenBudget).toBeNull();
    });

    it("is what runTokenBudget returns", () => {
      expect(runTokenBudget({ tokenBudget: { tokens: 5000 } })).toBe(5000);
      expect(runTokenBudget({ tokenBudget: null })).toBeNull();
    });
  });

  it("gives the run its playbook's own tools, which repositories don't narrow", async () => {
    const spec = await resolveRunSpec(db, job(), tokens, playbooks());
    expect(spec.agent.tools.builtin).toEqual(Playbook.parse(playbookInput).tools.builtin);
    expect(spec.tools).toEqual({ allowedTools: [], disallowedTools: [] });
  });

  describe("failures", () => {
    it("fails an unknown playbook", async () => {
      const result = resolveRunSpec(db, job({ taskId: "builtin:gone" }), tokens, playbooks());
      await expect(result).rejects.toThrow(RunSpecError);
      await expect(result).rejects.toThrow("Unknown playbook builtin:gone");
    });

    it("fails a trigger the playbook's role doesn't allow", async () => {
      const result = resolveRunSpec(
        db,
        job({ payload: { trigger: { kind: "chat.request", context: {} } } }),
        tokens,
        playbooks(),
      );
      await expect(result).rejects.toThrow(
        new RunSpecError("Playbook builtin:reply-to-finding can't be triggered by chat.request"),
      );
    });

    it("fails an invalid payload, a task type mismatch and an unknown repository", async () => {
      const cases: [Partial<Db.Job>, ReturnType<typeof playbooks>, string][] = [
        [{ payload: { question: "Why?" } }, playbooks(), "Invalid run payload"],
        [{ taskType: "coding" }, playbooks(), "doesn't match playbook builtin:reply-to-finding"],
        [{}, playbooks(), "Unknown repository"],
      ];
      for (const [overrides, defs, message] of cases) {
        if (message === "Unknown repository") state.repository = null;
        const result = resolveRunSpec(db, job(overrides), tokens, defs);
        await expect(result).rejects.toThrow(RunSpecError);
        await expect(result).rejects.toThrow(message);
      }
    });
  });
});

describe("resolveRunSpec for builtin:review-pr", () => {
  const PROFILES: Record<"quick" | "deep", ReviewProfileConfig> = {
    quick: {
      id: "quick",
      name: "Quick",
      model: "claude-haiku-5-5",
      maxTokensPerReview: 60_000,
      maxFiles: 15,
      allowRepoExploration: false,
    },
    deep: {
      id: "deep",
      name: "Deep",
      model: "claude-opus-5-5",
      maxTokensPerReview: 600_000,
      maxFiles: 100,
      allowRepoExploration: true,
    },
  };

  function reviewJob(profile: ReviewProfileConfig) {
    return job({
      taskType: "review",
      taskId: "builtin:review-pr",
      payload: {
        trigger: {
          kind: "pr.updated",
          context: {
            reviewConfig: { profile, customInstructions: null, rules: [], pathExcludes: [] },
          },
        },
        repositoryId: REPO_ID,
        ref: "c".repeat(40),
      },
    });
  }

  it("narrows a quick review to the diff: its model, budget and max files, no exploration tools", async () => {
    const spec = await resolveRunSpec(
      db,
      reviewJob(PROFILES.quick),
      tokens,
      BUILTIN_PLAYBOOK_SOURCE,
    );
    expect(spec).toMatchObject({
      taskType: "review",
      pool: "short",
      task: { id: "builtin:review-pr", sink: "review" },
      agent: { id: "builtin:review-pr", taskTypes: ["review"] },
      model: "claude-haiku-5-5",
      tokenBudget: 60_000,
      maxFiles: 15,
    });
    expect(spec.agent.tools.builtin).toEqual([]);
  });

  it("keeps the exploration tools of a deep review, with its model, budget and max files", async () => {
    const spec = await resolveRunSpec(
      db,
      reviewJob(PROFILES.deep),
      tokens,
      BUILTIN_PLAYBOOK_SOURCE,
    );
    expect(spec).toMatchObject({ model: "claude-opus-5-5", tokenBudget: 600_000, maxFiles: 100 });
    expect(spec.agent.tools.builtin).toEqual(["Read", "Grep", "Glob"]);
  });

  it("takes the model and budget only from the depth, never the playbook's", async () => {
    // Validation refuses a review playbook with a model, fallback or budget; one that has them
    // never applies.
    const builtin = getBuiltinPlaybook("builtin:review-pr")!;
    const reviewer: Playbook = {
      ...builtin,
      model: "sonnet",
      fallbackModel: "haiku",
      tokenBudget: { tokens: 50_000 },
    };
    const review = { getPlaybook: (id: string) => (id === reviewer.id ? reviewer : null) };
    expect(await resolveRunSpec(db, reviewJob(PROFILES.deep), tokens, review)).toMatchObject({
      model: "claude-opus-5-5",
      fallbackModel: null,
      tokenBudget: 600_000,
      maxFiles: 100,
    });
    // A preset without a model runs on the Claude Code default.
    const noModel = { ...PROFILES.deep, model: null };
    expect(await resolveRunSpec(db, reviewJob(noModel), tokens, review)).toMatchObject({
      model: null,
      tokenBudget: 600_000,
    });
  });

  it("narrowByReviewDepth ignores the run's model, fallback and budget", async () => {
    const spec = await resolveRunSpec(
      db,
      reviewJob(PROFILES.quick),
      tokens,
      BUILTIN_PLAYBOOK_SOURCE,
    );
    const narrowed = narrowByReviewDepth(
      { ...spec, model: "sonnet", fallbackModel: "haiku", tokenBudget: 1 },
      PROFILES.deep,
    );
    expect(narrowed).toMatchObject({
      model: "claude-opus-5-5",
      fallbackModel: null,
      tokenBudget: 600_000,
      maxFiles: 100,
    });
  });

  it("fails a review run without a review configuration", async () => {
    const result = resolveRunSpec(
      db,
      job({
        taskType: "review",
        taskId: "builtin:review-pr",
        payload: { trigger: { kind: "pr.updated", context: {} }, repositoryId: REPO_ID },
      }),
      tokens,
      BUILTIN_PLAYBOOK_SOURCE,
    );
    await expect(result).rejects.toThrow(RunSpecError);
  });
});

describe("model and budget of every built-in playbook", () => {
  /**
   * Each built-in's model and token budget on a Standard repository before the
   * precedence fix (TOOL-587) and before agents and tasks became playbooks,
   * written out so a change shows here. Null budget: "No limit".
   */
  const STANDARD: Record<string, { model: string | null; tokenBudget: number | null }> = {
    "builtin:learn-rule": { model: "claude-sonnet-5-5", tokenBudget: 5_000 },
    "builtin:reply-to-finding": { model: "claude-sonnet-5-5", tokenBudget: 20_000 },
    "builtin:review-pr": { model: "claude-sonnet-5-5", tokenBudget: 200_000 },
    "builtin:summarize-pr": { model: "claude-sonnet-5-5", tokenBudget: 200_000 },
    "builtin:ask-about-code": { model: "claude-sonnet-5-5", tokenBudget: 50_000 },
    "builtin:triage": { model: "opus", tokenBudget: null },
    "builtin:correlate-findings": { model: "claude-sonnet-5-5", tokenBudget: 100_000 },
    "builtin:implement-story": { model: "opus", tokenBudget: null },
    "builtin:handle-request": { model: "opus", tokenBudget: null },
    "builtin:describe-pr": { model: "opus", tokenBudget: null },
    "builtin:verify-task": { model: "claude-sonnet-5-5", tokenBudget: null },
  };

  /** A run of a built-in playbook on a repository of `depth` (a review's preset comes from it). */
  async function resolveBuiltin(taskId: string, depth: ReviewDepth) {
    state.repository = repository(depth);
    const playbook = getBuiltinPlaybook(taskId)!;
    const taskType = playbookTaskType(playbook);
    const context =
      taskType === "review"
        ? {
            reviewConfig: {
              profile: reviewProfileConfigForDepth(depth),
              customInstructions: null,
              rules: [],
              pathExcludes: [],
            },
          }
        : {};
    return resolveRunSpec(
      db,
      job({
        taskType,
        taskId,
        payload: {
          trigger: { kind: PLAYBOOK_ROLES[playbook.role].triggers[0], context },
          repositoryId: REPO_ID,
        },
      }),
      tokens,
      BUILTIN_PLAYBOOK_SOURCE,
    );
  }

  it("covers every built-in playbook", () => {
    expect(Object.keys(STANDARD).sort()).toEqual(BUILTIN_PLAYBOOKS.map((p) => p.id).sort());
  });

  it.each(Object.entries(STANDARD))(
    "keeps %s's model and budget on a Standard repository",
    async (taskId, expected) => {
      const spec = await resolveBuiltin(taskId, "standard");
      expect({ model: spec.model, tokenBudget: spec.tokenBudget }).toEqual(expected);
      expect(spec.fallbackModel).toBeNull();
    },
  );

  it("changes only review playbooks on a Deep repository", async () => {
    for (const [taskId, expected] of Object.entries(STANDARD)) {
      const spec = await resolveBuiltin(taskId, "deep");
      const actual = { model: spec.model, tokenBudget: spec.tokenBudget };
      if (spec.taskType === "review") {
        expect(actual, taskId).toEqual({ model: "claude-opus-5-5", tokenBudget: 500_000 });
      } else {
        expect(actual, taskId).toEqual(expected);
      }
    }
  });
});

describe("runSpecJobInput", () => {
  it("routes the job by its task and stores the run payload", () => {
    const task = TaskDefinition.parse(taskInput);
    expect(runSpecJobInput(task, payload)).toEqual({
      taskType: "query",
      taskId: "builtin:reply-to-finding",
      payload,
      repositoryId: REPO_ID,
      minAgentVersion: QUERY_TASKS_MIN_AGENT_VERSION,
      requiredInstallables: [],
      requiredHostTools: [],
    });
  });

  it("requires the installables and host tools it's given, each once and sorted", () => {
    const task = TaskDefinition.parse(taskInput);
    expect(
      runSpecJobInput(task, payload, {
        installables: ["@omniralph/sast", "@omniralph/code-graph", "@omniralph/sast"],
        hostTools: ["opengrep"],
      }),
    ).toMatchObject({
      requiredInstallables: ["@omniralph/code-graph", "@omniralph/sast"],
      requiredHostTools: ["opengrep"],
    });
  });

  it("requires an agent with the review lifecycle for review tasks", () => {
    const task = TaskDefinition.parse({ ...taskInput, taskType: "review" });
    expect(runSpecJobInput(task, payload).minAgentVersion).toBe(REVIEW_TASKS_MIN_AGENT_VERSION);
  });

  it("requires an agent with the coding lifecycle and the tracker protocol for coding tasks", () => {
    // Coding runs' ralph payloads carry `trackerIssueId` and `trackerProvider`.
    const task = TaskDefinition.parse({ ...taskInput, taskType: "coding" });
    expect(runSpecJobInput(task, payload).minAgentVersion).toBe(TRACKER_PROTOCOL_MIN_AGENT_VERSION);
    expect(
      agentVersionAtLeast(TRACKER_PROTOCOL_MIN_AGENT_VERSION, CODING_TASKS_MIN_AGENT_VERSION),
    ).toBe(true);
    // Coding runs run a coding task's setup commands too: the higher minimum wins.
    const withSetup = TaskDefinition.parse({
      ...taskInput,
      taskType: "coding",
      setupCommands: [{ name: "deps", command: "pnpm install" }],
    });
    expect(runSpecJobInput(withSetup, payload).minAgentVersion).toBe(
      TRACKER_PROTOCOL_MIN_AGENT_VERSION,
    );
  });

  it("requires an agent with the tracker protocol when the task turns on the tracker tools", () => {
    const reader = TaskDefinition.parse({ ...taskInput, toolSettings: { trackerRead: true } });
    expect(runSpecJobInput(reader, payload).minAgentVersion).toBe(
      TRACKER_PROTOCOL_MIN_AGENT_VERSION,
    );
    // Without them a query run still goes to any agent with the query lifecycle.
    const task = TaskDefinition.parse(taskInput);
    expect(runSpecJobInput(task, payload).minAgentVersion).toBe(QUERY_TASKS_MIN_AGENT_VERSION);
    // A custom playbook's stored minimum below it doesn't lower it.
    expect(runSpecJobInput(reader, payload, { minAgentVersion: "2.0.0" }).minAgentVersion).toBe(
      TRACKER_PROTOCOL_MIN_AGENT_VERSION,
    );
  });

  it("keeps older agents (before the tracker protocol) off tracker runs", () => {
    expect(agentVersionAtLeast("2.0.2", TRACKER_PROTOCOL_MIN_AGENT_VERSION)).toBe(false);
  });

  it("requires coding runs to wait for an agent release after 0.10.0", () => {
    // 0.10.0 predates the coding lifecycle and fails coding runs as an unsupported task type.
    expect(agentVersionAtLeast("0.10.0", CODING_TASKS_MIN_AGENT_VERSION)).toBe(false);
  });

  it("requires an agent that runs setup and teardown commands when the task has any", () => {
    const setup = TaskDefinition.parse({
      ...taskInput,
      setupCommands: [{ name: "lint", command: "semgrep --json ." }],
    });
    expect(runSpecJobInput(setup, payload).minAgentVersion).toBe(SETUP_COMMANDS_MIN_AGENT_VERSION);
    const teardown = TaskDefinition.parse({
      ...taskInput,
      taskType: "review",
      teardownCommands: [{ name: "clean", command: "rm -rf .cache" }],
    });
    expect(runSpecJobInput(teardown, payload).minAgentVersion).toBe(
      SETUP_COMMANDS_MIN_AGENT_VERSION,
    );
  });
});
