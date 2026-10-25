import { DEFAULT_RALPH_SETTINGS } from "@omniralph/db";
import {
  MAX_ATTEMPTS_PER_STORY,
  MAX_ROUNDS_PER_STORY,
  QUERY_TASKS_MIN_HARNESS_VERSION,
  RalphDescribePrPayload,
  STALL_ROUNDS,
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
  jobStoryCaps,
  opensPullRequestEarly,
  pushJobInput,
  pushResult,
  pushTimingFor,
  codingJobInput,
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
  maxRoundsPerStory: 4,
  stallRounds: 2,
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
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  ralphSettings: { ...DEFAULT_RALPH_SETTINGS, maxReviewRounds: 4, maxFixRounds: 2 },
  ...overrides,
});

describe("storyLimits", () => {
  it("are the defaults without a repository", async () => {
    expect(MAX_ITERATIONS_PER_RUN).toBe(50);
    expect(await storyLimits(null, DEFINITIONS)).toEqual({
      maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY,
      maxRoundsPerStory: MAX_ROUNDS_PER_STORY,
      stallRounds: STALL_ROUNDS,
      maxIterationsPerRun: 50,
    });
  });

  it("come from the story task (the built-in's are the defaults)", async () => {
    expect(await storyLimits(repository(), DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 3,
      maxRoundsPerStory: 8,
      stallRounds: 3,
      maxIterationsPerRun: 50,
    });
    expect(await storyLimits(repository({ storyTaskId: strict.id }), DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 1,
      maxRoundsPerStory: 4,
      stallRounds: 2,
      maxIterationsPerRun: 7,
    });
  });
});

describe("jobStoryCaps", () => {
  it("are the attempts and rounds of the coding task that ran, else the defaults", async () => {
    const defaults = {
      maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY,
      maxRoundsPerStory: MAX_ROUNDS_PER_STORY,
      stallRounds: STALL_ROUNDS,
    };
    expect(await jobStoryCaps(null, DEFINITIONS)).toEqual(defaults);
    expect(await jobStoryCaps({ taskId: null }, DEFINITIONS)).toEqual(defaults);
    expect(await jobStoryCaps({ taskId: story.id }, DEFINITIONS)).toEqual(defaults);
    expect(await jobStoryCaps({ taskId: strict.id }, DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 1,
      maxRoundsPerStory: 4,
      stallRounds: 2,
    });
  });
});

describe("roundLimits", () => {
  const run = { codingTaskId: null };

  it("are the lesser of the repository's and the request task's", async () => {
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

describe("codingJobInput", () => {
  const payload = { repositoryId: "6f1c1a4e-8a5c-4d0b-9a57-0e6f2f8f6c11" } as RalphStoryPayload;

  it("is a coding run with the payload as its trigger context", async () => {
    const input = await codingJobInput(
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
    expect(ralphJobPayload({ payload: input!.payload as never })).toEqual(payload);
  });

  it("is null for a task that isn't a coding task taking the trigger", async () => {
    for (const [taskId, trigger] of [
      ["builtin:gone", "linear.delegated"],
      ["builtin:describe-pr", "run.invoked"],
      [request.id, "linear.delegated"],
    ] as const) {
      expect(await codingJobInput({ taskId, trigger }, payload, DEFINITIONS)).toBe(null);
    }
  });
});

describe("ralphJobPayload", () => {
  it("is a coding run's trigger context", async () => {
    expect(
      ralphJobPayload({
        payload: { trigger: { kind: "linear.delegated", context: { runId: "r" } } },
      }),
    ).toEqual({ runId: "r" });
    expect(ralphJobPayload({ payload: { runId: "r" } })).toBeNull();
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

  it("is a query run in a checkout of the lane's branch", async () => {
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
    expect(describePrPayload({ payload: job.payload })).toEqual(payload);
    // A bare payload isn't a query run's.
    expect(describePrPayload({ payload })).toBeNull();
  });

  it("says why when the description task isn't a query task taking run.invoked", async () => {
    expect(
      await describePrJobInput(repository({ storyTaskId: misdescribing.id }), payload, DEFINITIONS),
    ).toBe(`${request.id} isn't a query task started by run.invoked`);
  });

  it("reads a query run's output with its title fitted", async () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    // A legacy `ralph.describe-pr` result isn't a query run's.
    expect(describePrText({ result: { title: "Add runs", body: "Adds runs.", usage } })).toBeNull();

    const answered = (structured: unknown) => ({
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

  it("pushes as the story task says, after each story by default", async () => {
    expect(await pushTimingFor(repository(), DEFINITIONS)).toBe("per-story");
    expect(await pushTimingFor(repository({ storyTaskId: atTheEnd.id }), DEFINITIONS)).toBe("end");
    expect(await pushTimingFor(repository({ storyTaskId: "custom:gone" }), DEFINITIONS)).toBe(
      "per-story",
    );
  });

  it("opens drafts early per the story task's draftPullRequest, else the repository's openPullRequestEarly", async () => {
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
