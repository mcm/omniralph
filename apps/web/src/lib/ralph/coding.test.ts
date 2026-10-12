import { DEFAULT_RALPH_SETTINGS } from "@omniralph/db";
import {
  MAX_ATTEMPTS_PER_STORY,
  QUERY_TASKS_MIN_HARNESS_VERSION,
  RalphDescribePrPayload,
  ralphHiddenRef,
  type RalphPushPayload,
  type RalphStoryPayload,
} from "@omniralph/shared";
import { getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  MAX_ITERATIONS_PER_RUN,
  describePrJobInput,
  describePrPayload,
  describePrText,
  prDescriptionTaskFor,
  jobMaxAttempts,
  opensPullRequestEarly,
  pushJobInput,
  pushResult,
  pushTimingFor,
  ralphJobInput,
  ralphJobPayload,
  requestTaskFor,
  requestTrigger,
  roundLimits,
  storyLimits,
} = await import("./coding");

const story = getBuiltinTask("builtin:implement-story")!;
const request = getBuiltinTask("builtin:handle-request")!;
const strict: TaskDefinition = {
  ...story,
  id: "custom:strict-story",
  maxAttemptsPerStory: 1,
  maxIterationsPerRun: 7,
};
const cautious: TaskDefinition = {
  ...request,
  id: "custom:cautious-request",
  maxReviewRounds: 1,
  maxFixRounds: 0,
};
const describeTask = getBuiltinTask("builtin:describe-pr")!;
const customDescribe: TaskDefinition = { ...describeTask, id: "custom:describe-pr" };
const describing: TaskDefinition = {
  ...story,
  id: "custom:describing-story",
  prDescriptionTaskId: customDescribe.id,
};
const misdescribing: TaskDefinition = {
  ...story,
  id: "custom:misdescribing-story",
  prDescriptionTaskId: request.id,
};
const atTheEnd: TaskDefinition = { ...story, id: "custom:push-at-end", pushTiming: "end" };
const earlyDraft: TaskDefinition = {
  ...story,
  id: "custom:early-draft",
  draftPullRequest: "early",
};
const lateDraft: TaskDefinition = { ...story, id: "custom:late-draft", draftPullRequest: "end" };
const DEFINITIONS = {
  getTask: (id: string) =>
    [
      story,
      atTheEnd,
      earlyDraft,
      lateDraft,
      request,
      strict,
      cautious,
      describeTask,
      customDescribe,
      describing,
      misdescribing,
    ].find((t) => t.id === id) ?? null,
  getAgent: () => null,
};

const repository = (
  overrides: Partial<Parameters<typeof storyLimits>[0] & { ralphSettings: unknown }> = {},
) => ({
  codingPath: "tasks" as const,
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  ralphSettings: { ...DEFAULT_RALPH_SETTINGS, maxReviewRounds: 4, maxFixRounds: 2 },
  ...overrides,
});

describe("storyLimits", () => {
  it("are the legacy loop's on the legacy path, whatever the story task", async () => {
    const legacy = { maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY, maxIterationsPerRun: 50 };
    expect(MAX_ITERATIONS_PER_RUN).toBe(50);
    expect(await storyLimits(null, DEFINITIONS)).toEqual(legacy);
    expect(
      await storyLimits(repository({ codingPath: "legacy", storyTaskId: strict.id }), DEFINITIONS),
    ).toEqual(legacy);
  });

  it("come from the story task on the tasks path (the built-in's are the legacy ones)", async () => {
    expect(await storyLimits(repository(), DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 3,
      maxIterationsPerRun: 50,
    });
    expect(await storyLimits(repository({ storyTaskId: strict.id }), DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 1,
      maxIterationsPerRun: 7,
    });
  });
});

describe("jobMaxAttempts", () => {
  it("is the attempts of the coding task that ran, else the legacy cap", async () => {
    expect(await jobMaxAttempts(null, DEFINITIONS)).toBe(MAX_ATTEMPTS_PER_STORY);
    expect(await jobMaxAttempts({ taskId: null }, DEFINITIONS)).toBe(MAX_ATTEMPTS_PER_STORY);
    expect(await jobMaxAttempts({ taskId: story.id }, DEFINITIONS)).toBe(3);
    expect(await jobMaxAttempts({ taskId: strict.id }, DEFINITIONS)).toBe(1);
  });
});

describe("roundLimits", () => {
  const run = { codingTaskId: null };

  it("are the repository's on the legacy path", async () => {
    expect(
      await roundLimits(
        run,
        repository({ codingPath: "legacy", requestTaskId: cautious.id }),
        DEFINITIONS,
      ),
    ).toEqual({ maxReviewRounds: 4, maxFixRounds: 2 });
  });

  it("are the lesser of the repository's and the request task's on the tasks path", async () => {
    // The built-in's caps (20) never lower the repository's.
    expect(await roundLimits(run, repository(), DEFINITIONS)).toEqual({
      maxReviewRounds: 4,
      maxFixRounds: 2,
    });
    expect(await roundLimits(run, repository({ requestTaskId: cautious.id }), DEFINITIONS)).toEqual(
      {
        maxReviewRounds: 1,
        maxFixRounds: 0,
      },
    );
    // A run's own coding task caps them instead.
    expect(await roundLimits({ codingTaskId: cautious.id }, repository(), DEFINITIONS)).toEqual({
      maxReviewRounds: 1,
      maxFixRounds: 0,
    });
  });
});

describe("requestTaskFor and requestTrigger", () => {
  it("runs requests with the repository's request task", async () => {
    expect(requestTaskFor({ codingTaskId: null }, repository({ requestTaskId: cautious.id }))).toBe(
      cautious.id,
    );
  });

  it("runs requests with the run's own coding task when it has one", async () => {
    expect(
      requestTaskFor({ codingTaskId: cautious.id }, repository({ requestTaskId: story.id })),
    ).toBe(cautious.id);
  });

  it("is the oldest request's trigger, a Linear mention when it has none", async () => {
    expect(requestTrigger([{ trigger: "pr.review-findings" }, { trigger: "chat.request" }])).toBe(
      "pr.review-findings",
    );
    expect(requestTrigger([{ trigger: null }, { trigger: "chat.request" }])).toBe("linear.mention");
    expect(requestTrigger([])).toBe("linear.mention");
  });
});

describe("ralphJobInput", () => {
  const payload = { repositoryId: "6f1c1a4e-8a5c-4d0b-9a57-0e6f2f8f6c11" } as RalphStoryPayload;

  it("is a legacy job with the payload as is on the legacy path", async () => {
    expect(
      await ralphJobInput(
        "ralph.story",
        { codingPath: "legacy" },
        { taskId: "builtin:gone", trigger: "linear.delegated" },
        payload,
        DEFINITIONS,
      ),
    ).toEqual({ taskType: "coding", pool: "long", payload });
  });

  it("is a coding run with the payload as its trigger context on the tasks path", async () => {
    const input = await ralphJobInput(
      "ralph.story",
      { codingPath: "tasks" },
      { taskId: story.id, trigger: "linear.delegated" },
      payload,
      DEFINITIONS,
    );
    expect(input).toMatchObject({
      taskType: "coding",
      pool: "long",
      taskId: story.id,
      repositoryId: payload.repositoryId,
      payload: {
        trigger: { kind: "linear.delegated", context: payload },
        repositoryId: payload.repositoryId,
      },
    });
    expect(ralphJobPayload({ taskId: story.id, payload: input!.payload as never })).toEqual(
      payload,
    );
  });

  it("is null for a task that isn't a coding task taking the trigger", async () => {
    const tasks = { codingPath: "tasks" } as const;
    for (const [taskId, trigger] of [
      ["builtin:gone", "linear.delegated"],
      ["builtin:describe-pr", "run.invoked"],
      [request.id, "linear.delegated"],
    ] as const) {
      expect(
        await ralphJobInput("ralph.story", tasks, { taskId, trigger }, payload, DEFINITIONS),
      ).toBe(null);
    }
  });
});

describe("ralphJobPayload", () => {
  it("is a legacy job's payload, and a coding run's trigger context", async () => {
    expect(ralphJobPayload({ taskId: null, payload: { runId: "r" } })).toEqual({ runId: "r" });
    expect(
      ralphJobPayload({
        taskId: story.id,
        payload: { trigger: { kind: "linear.delegated", context: { runId: "r" } } },
      }),
    ).toEqual({ runId: "r" });
    expect(ralphJobPayload({ taskId: story.id, payload: { runId: "r" } })).toBeNull();
  });
});

describe("describing a lane's PR", () => {
  const payload = RalphDescribePrPayload.parse({
    runId: "6f1c1a4e-8a5c-4d0b-9a57-0e6f2f8f6c12",
    repositoryId: "6f1c1a4e-8a5c-4d0b-9a57-0e6f2f8f6c11",
    repository: {
      provider: "gitlab",
      fullPath: "group/app",
      cloneUrl: "https://gitlab.example.com/group/app.git",
    },
    branch: "feat/epic",
    baseBranch: "main",
    settings: { model: null, setupCommand: null },
    epic: { identifier: "ENG-1", title: "Epic", url: null, prd: "Build the thing." },
    stories: [{ identifier: "ENG-2", title: "Alpha", status: "completed", commitSha: null }],
    progress: "# Log",
    qualityGates: ["pnpm test"],
  });

  it("uses the story task's prDescriptionTaskId, the default's without a coding story task", async () => {
    expect(await prDescriptionTaskFor(repository(), DEFINITIONS)).toBe("builtin:describe-pr");
    expect(
      await prDescriptionTaskFor(repository({ storyTaskId: describing.id }), DEFINITIONS),
    ).toBe(customDescribe.id);
    expect(
      await prDescriptionTaskFor(repository({ storyTaskId: "builtin:gone" }), DEFINITIONS),
    ).toBe("builtin:describe-pr");
  });

  it("is a ralph.describe-pr job with the payload as is on the legacy path", async () => {
    expect(
      await describePrJobInput(repository({ codingPath: "legacy" }), payload, DEFINITIONS),
    ).toEqual({
      taskType: "query",
      pool: "short",
      payload,
    });
  });

  it("is a query run in a checkout of the lane's branch on the tasks path", async () => {
    const input = await describePrJobInput(
      repository({ storyTaskId: describing.id }),
      payload,
      DEFINITIONS,
    );
    expect(input).toMatchObject({
      taskType: "query",
      pool: "short",
      taskId: customDescribe.id,
      repositoryId: payload.repositoryId,
      minHarnessVersion: QUERY_TASKS_MIN_HARNESS_VERSION,
      payload: {
        trigger: {
          kind: "run.invoked",
          context: {
            invoker: { kind: "ralph-run", id: payload.runId },
            payload,
            branch: "feat/epic",
            baseBranch: "main",
            prTerm: "merge request",
            epic: { identifier: "ENG-1", title: "Epic", prd: "Build the thing." },
            stories: { items: [{ identifier: "ENG-2", title: "Alpha", commit: null }] },
            qualityGates: { items: ["pnpm test"] },
            progressLog: "# Log",
          },
        },
        repositoryId: payload.repositoryId,
        ref: "feat/epic",
        requireCheckout: true,
      },
    });
    const job = input as Exclude<typeof input, string>;
    expect(describePrPayload({ taskId: customDescribe.id, payload: job.payload })).toEqual(payload);
    expect(describePrPayload({ taskId: null, payload })).toEqual(payload);
    expect(describePrPayload({ taskId: customDescribe.id, payload })).toBeNull();
  });

  it("says why when the description task isn't a query task taking run.invoked", async () => {
    expect(
      await describePrJobInput(repository({ storyTaskId: misdescribing.id }), payload, DEFINITIONS),
    ).toBe(`${request.id} isn't a query task started by run.invoked`);
  });

  it("reads a legacy job's result, and a query run's output with its title fitted", async () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    expect(
      describePrText({ taskId: null, result: { title: "Add runs", body: "Adds runs.", usage } }),
    ).toEqual({ title: "Add runs", body: "Adds runs." });
    expect(describePrText({ taskId: null, result: { title: "Add runs", usage } })).toBeNull();

    const answered = (structured: unknown) => ({
      taskId: customDescribe.id,
      result: {
        outcome: "answered",
        answer: null,
        structured,
        references: [],
        usage,
        durationMs: 1,
      },
    });
    expect(
      describePrText(answered({ title: `${"word ".repeat(30)}end`, body: " Adds. " })),
    ).toEqual({
      title: `${"word ".repeat(13)}word…`,
      body: "Adds.",
    });
    expect(describePrText(answered({ title: " ", body: "Adds." }))).toBeNull();
    expect(describePrText(answered({ summary: "Adds." }))).toBeNull();
    expect(
      describePrText({
        taskId: customDescribe.id,
        result: {
          outcome: "no_checkout",
          answer: null,
          structured: null,
          references: [],
          usage,
          durationMs: 1,
        },
      }),
    ).toBeNull();
  });
});

describe("push and draft PR timing", () => {
  const early = (openPullRequestEarly: boolean) => ({
    ralphSettings: { ...DEFAULT_RALPH_SETTINGS, openPullRequestEarly },
  });

  it("pushes after each story on the legacy path, and as the story task says on the tasks path", async () => {
    expect(
      await pushTimingFor(
        repository({ codingPath: "legacy", storyTaskId: atTheEnd.id }),
        DEFINITIONS,
      ),
    ).toBe("per-story");
    expect(await pushTimingFor(repository(), DEFINITIONS)).toBe("per-story");
    expect(await pushTimingFor(repository({ storyTaskId: atTheEnd.id }), DEFINITIONS)).toBe("end");
    expect(await pushTimingFor(repository({ storyTaskId: "custom:gone" }), DEFINITIONS)).toBe(
      "per-story",
    );
  });

  it("opens drafts early per the story task's draftPullRequest, else the repository's openPullRequestEarly", async () => {
    const legacy = { codingPath: "legacy" as const, storyTaskId: earlyDraft.id };
    expect(
      await opensPullRequestEarly(repository({ ...legacy, ...early(true) }), DEFINITIONS),
    ).toBe(true);
    expect(
      await opensPullRequestEarly(repository({ ...legacy, ...early(false) }), DEFINITIONS),
    ).toBe(false);
    // The built-in leaves draftPullRequest unset: today's setting applies.
    expect(await opensPullRequestEarly(repository(early(true)), DEFINITIONS)).toBe(true);
    expect(await opensPullRequestEarly(repository(early(false)), DEFINITIONS)).toBe(false);
    expect(
      await opensPullRequestEarly(
        repository({ storyTaskId: earlyDraft.id, ...early(false) }),
        DEFINITIONS,
      ),
    ).toBe(true);
    expect(
      await opensPullRequestEarly(
        repository({ storyTaskId: lateDraft.id, ...early(true) }),
        DEFINITIONS,
      ),
    ).toBe(false);
    // Pushing only at the end, there's no branch for an early draft.
    expect(
      await opensPullRequestEarly(
        repository({ storyTaskId: atTheEnd.id, ...early(true) }),
        DEFINITIONS,
      ),
    ).toBe(false);
  });

  const pushPayload: RalphPushPayload = {
    runId: "6f1c7f6e-3a59-4f0e-9f53-5a0f4d0c2b11",
    repositoryId: "0d5e4b1c-8f7a-4c3e-9b2a-1e6d7f8a9b0c",
    repository: { provider: "github", fullPath: "acme/api", cloneUrl: "https://x/acme/api.git" },
    branch: "feat/epic",
    baseBranch: "main",
    settings: {
      model: null,
      setupCommand: null,
      fallbackModel: null,
      appendInstruction: null,
      allowedTools: null,
      disallowedTools: null,
    },
    hiddenRef: ralphHiddenRef("6f1c7f6e-3a59-4f0e-9f53-5a0f4d0c2b11"),
  };

  it("pushes a lane with a coding run of the story task, the push as its trigger context", async () => {
    const input = await pushJobInput({ storyTaskId: atTheEnd.id }, pushPayload, DEFINITIONS);
    expect(input).toMatchObject({
      taskType: "coding",
      pool: "long",
      taskId: atTheEnd.id,
      payload: {
        trigger: { kind: "linear.delegated", context: pushPayload },
        repositoryId: pushPayload.repositoryId,
      },
    });
    expect(
      await pushJobInput({ storyTaskId: describeTask.id }, pushPayload, DEFINITIONS),
    ).toBeNull();
  });

  it("reads a push run's result", async () => {
    const pushed = { pushed: { branch: "feat/epic", sha: "a".repeat(40) }, durationMs: 3 };
    expect(pushResult({ result: pushed })).toEqual(pushed);
    expect(pushResult({ result: { summary: "x" } })).toBeNull();
    expect(pushResult({ result: null })).toBeNull();
  });
});
