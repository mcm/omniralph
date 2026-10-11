import { DEFAULT_RALPH_SETTINGS } from "@omniralph/db";
import { MAX_ATTEMPTS_PER_STORY, type RalphStoryPayload } from "@omniralph/shared";
import { getBuiltinTask, type TaskDefinition } from "@omniralph/tasks";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  MAX_ITERATIONS_PER_RUN,
  jobMaxAttempts,
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
const DEFINITIONS = {
  getTask: (id: string) =>
    [story, request, strict, cautious, getBuiltinTask("builtin:describe-pr")!].find(
      (t) => t.id === id,
    ) ?? null,
  getAgent: () => null,
};

const repository = (overrides: Partial<Parameters<typeof storyLimits>[0] & object> = {}) => ({
  codingPath: "tasks" as const,
  storyTaskId: "builtin:implement-story",
  requestTaskId: "builtin:handle-request",
  ralphSettings: { ...DEFAULT_RALPH_SETTINGS, maxReviewRounds: 4, maxFixRounds: 2 },
  ...overrides,
});

describe("storyLimits", () => {
  it("are the legacy loop's on the legacy path, whatever the story task", () => {
    const legacy = { maxAttemptsPerStory: MAX_ATTEMPTS_PER_STORY, maxIterationsPerRun: 50 };
    expect(MAX_ITERATIONS_PER_RUN).toBe(50);
    expect(storyLimits(null)).toEqual(legacy);
    expect(
      storyLimits(repository({ codingPath: "legacy", storyTaskId: strict.id }), DEFINITIONS),
    ).toEqual(legacy);
  });

  it("come from the story task on the tasks path (the built-in's are the legacy ones)", () => {
    expect(storyLimits(repository(), DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 3,
      maxIterationsPerRun: 50,
    });
    expect(storyLimits(repository({ storyTaskId: strict.id }), DEFINITIONS)).toEqual({
      maxAttemptsPerStory: 1,
      maxIterationsPerRun: 7,
    });
  });
});

describe("jobMaxAttempts", () => {
  it("is the attempts of the coding task that ran, else the legacy cap", () => {
    expect(jobMaxAttempts(null)).toBe(MAX_ATTEMPTS_PER_STORY);
    expect(jobMaxAttempts({ taskId: null }, DEFINITIONS)).toBe(MAX_ATTEMPTS_PER_STORY);
    expect(jobMaxAttempts({ taskId: story.id }, DEFINITIONS)).toBe(3);
    expect(jobMaxAttempts({ taskId: strict.id }, DEFINITIONS)).toBe(1);
  });
});

describe("roundLimits", () => {
  const run = { id: "run-1" };

  it("are the repository's on the legacy path", () => {
    expect(
      roundLimits(
        run,
        repository({ codingPath: "legacy", requestTaskId: cautious.id }),
        DEFINITIONS,
      ),
    ).toEqual({ maxReviewRounds: 4, maxFixRounds: 2 });
  });

  it("are the lesser of the repository's and the request task's on the tasks path", () => {
    // The built-in's caps (20) never lower the repository's.
    expect(roundLimits(run, repository(), DEFINITIONS)).toEqual({
      maxReviewRounds: 4,
      maxFixRounds: 2,
    });
    expect(roundLimits(run, repository({ requestTaskId: cautious.id }), DEFINITIONS)).toEqual({
      maxReviewRounds: 1,
      maxFixRounds: 0,
    });
  });
});

describe("requestTaskFor and requestTrigger", () => {
  it("runs requests with the repository's request task", () => {
    expect(requestTaskFor({ id: "run-1" }, repository({ requestTaskId: cautious.id }))).toBe(
      cautious.id,
    );
  });

  it("is the oldest request's trigger, a Linear mention when it has none", () => {
    expect(requestTrigger([{ trigger: "pr.review-findings" }, { trigger: "chat.request" }])).toBe(
      "pr.review-findings",
    );
    expect(requestTrigger([{ trigger: null }, { trigger: "chat.request" }])).toBe("linear.mention");
    expect(requestTrigger([])).toBe("linear.mention");
  });
});

describe("ralphJobInput", () => {
  const payload = { repositoryId: "6f1c1a4e-8a5c-4d0b-9a57-0e6f2f8f6c11" } as RalphStoryPayload;

  it("is a legacy job with the payload as is on the legacy path", () => {
    expect(
      ralphJobInput(
        "ralph.story",
        { codingPath: "legacy" },
        { taskId: "builtin:gone", trigger: "linear.delegated" },
        payload,
        DEFINITIONS,
      ),
    ).toEqual({ taskType: "coding", pool: "long", payload });
  });

  it("is a coding run with the payload as its trigger context on the tasks path", () => {
    const input = ralphJobInput(
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

  it("is null for a task that isn't a coding task taking the trigger", () => {
    const tasks = { codingPath: "tasks" } as const;
    for (const [taskId, trigger] of [
      ["builtin:gone", "linear.delegated"],
      ["builtin:describe-pr", "run.invoked"],
      [request.id, "linear.delegated"],
    ] as const) {
      expect(ralphJobInput("ralph.story", tasks, { taskId, trigger }, payload, DEFINITIONS)).toBe(
        null,
      );
    }
  });
});

describe("ralphJobPayload", () => {
  it("is a legacy job's payload, and a coding run's trigger context", () => {
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
