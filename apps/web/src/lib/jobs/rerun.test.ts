import type { Job } from "@omniralph/db";
import {
  INSTALL_JOB_TYPE,
  RALPH_DESCRIBE_PR_JOB_TYPE,
  RALPH_REQUEST_JOB_TYPE,
  RALPH_STORY_JOB_TYPE,
  REPO_SYNC_JOB_TYPE,
  REVIEW_TASK_JOB_TYPE,
} from "@omniralph/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobDispatcher } from "@/lib/dispatch";
import { isRerunnable, jobRerunKind } from "./rerun-kind";

vi.mock("server-only", () => ({}));
const db = vi.hoisted(() => ({
  jobs: new Map<string, unknown>(),
  harnesses: new Map<string, unknown>(),
}));
vi.mock("@omniralph/db", () => ({
  getJob: async (_db: unknown, id: string) => db.jobs.get(id) ?? null,
  getAgent: async (_db: unknown, id: string) => db.harnesses.get(id) ?? null,
}));
const reviews = vi.hoisted(() => ({ rerunOrganizationReview: vi.fn() }));
vi.mock("@/lib/reviews/manage", () => reviews);

const { rerunJob, ALREADY_ACTIVE_WARNING, JOB_NOT_FOUND } = await import("./rerun");

const ORG = "11111111-1111-4111-8111-111111111111";
const REVIEW_ID = "22222222-2222-4222-8222-222222222222";
const HARNESS_ID = "33333333-3333-4333-8333-333333333333";

/** A run spec's payload whose trigger context names the review. */
const reviewPayload = {
  task: { id: "builtin:review-pr" },
  trigger: { kind: "review.rerun", context: { reviewId: REVIEW_ID } },
};

function job(overrides: Partial<Job>): Job {
  const row = {
    id: "44444444-4444-4444-8444-444444444444",
    organizationId: ORG,
    type: INSTALL_JOB_TYPE,
    taskType: "system",
    taskId: null,
    minAgentVersion: null,
    requiredInstallables: [],
    requiredHostTools: [],
    payload: { name: "@acme/tool" },
    status: "failed",
    repositoryId: null,
    agentId: HARNESS_ID,
    targetAgentId: HARNESS_ID,
    dedupeKey: `install:${HARNESS_ID}:@acme/tool@latest`,
    error: "npm failed",
    ...overrides,
  } as Job;
  db.jobs.set(row.id, row);
  return row;
}

function dispatcher(created = true) {
  const createAndPublish = vi.fn(async (input: { organizationId: string }) => ({
    job: { ...input, id: "55555555-5555-4555-8555-555555555555" } as unknown as Job,
    created,
  }));
  return { dispatcher: { createAndPublish } as unknown as JobDispatcher, createAndPublish };
}

beforeEach(() => {
  db.jobs.clear();
  db.harnesses.clear();
  db.harnesses.set(HARNESS_ID, { id: HARNESS_ID, organizationId: ORG, revokedAt: null });
  reviews.rerunOrganizationReview.mockReset();
});

describe("jobRerunKind", () => {
  it("reruns review task jobs as reviews, system RPCs as copies, and nothing else", () => {
    expect(jobRerunKind({ type: REVIEW_TASK_JOB_TYPE, payload: reviewPayload })).toBe("review");
    expect(jobRerunKind({ type: REVIEW_TASK_JOB_TYPE, payload: {} })).toBeNull();
    expect(jobRerunKind({ type: REPO_SYNC_JOB_TYPE, payload: {} })).toBe("copy");
    expect(jobRerunKind({ type: INSTALL_JOB_TYPE, payload: {} })).toBe("copy");
    // Stories, requests and PR/MR descriptions are coding and query runs: their ralph run retries them.
    for (const type of [RALPH_STORY_JOB_TYPE, RALPH_REQUEST_JOB_TYPE, RALPH_DESCRIBE_PR_JOB_TYPE]) {
      expect(jobRerunKind({ type, payload: {} })).toBeNull();
    }
    expect(jobRerunKind({ type: "triage.run", payload: {} })).toBeNull();
  });

  it("offers a rerun of failed, canceled and expired jobs only", () => {
    for (const status of ["failed", "canceled", "expired"]) {
      expect(isRerunnable({ type: INSTALL_JOB_TYPE, status, payload: {} })).toBe(true);
      expect(isRerunnable({ type: REPO_SYNC_JOB_TYPE, status, payload: {} })).toBe(true);
      expect(isRerunnable({ type: RALPH_STORY_JOB_TYPE, status, payload: {} })).toBe(false);
    }
    for (const status of ["queued", "running", "completed", "skipped"]) {
      expect(isRerunnable({ type: INSTALL_JOB_TYPE, status, payload: {} })).toBe(false);
    }
  });
});

describe("rerunJob", () => {
  it("dispatches a failed system RPC again to the harness it targeted", async () => {
    const failed = job({});
    const { dispatcher: d, createAndPublish } = dispatcher();
    expect(await rerunJob({} as never, d, ORG, failed.id)).toEqual({
      ok: true,
      jobId: "55555555-5555-4555-8555-555555555555",
    });
    expect(createAndPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG,
        type: INSTALL_JOB_TYPE,
        taskType: "system",
        payload: { name: "@acme/tool" },
        dedupeKey: failed.dedupeKey,
        targetHarnessId: HARNESS_ID,
      }),
    );
  });

  it("dispatches a canceled or expired system RPC again", async () => {
    for (const [i, status] of (["canceled", "expired"] as const).entries()) {
      const ended = job({
        id: `4444444${i}-4444-4444-8444-444444444444`,
        status,
        type: REPO_SYNC_JOB_TYPE,
      });
      const { dispatcher: d, createAndPublish } = dispatcher();
      expect(await rerunJob({} as never, d, ORG, ended.id)).toMatchObject({ ok: true });
      expect(createAndPublish).toHaveBeenCalledWith(
        expect.objectContaining({ type: REPO_SYNC_JOB_TYPE, targetHarnessId: HARNESS_ID }),
      );
    }
  });

  it("warns when the same job is already queued or running", async () => {
    const failed = job({});
    const { dispatcher: d } = dispatcher(false);
    expect(await rerunJob({} as never, d, ORG, failed.id)).toMatchObject({
      ok: true,
      warning: ALREADY_ACTIVE_WARNING,
    });
  });

  it("refuses a system RPC whose harness is gone or revoked", async () => {
    const { dispatcher: d, createAndPublish } = dispatcher();
    const untargeted = job({ targetAgentId: null });
    expect(await rerunJob({} as never, d, ORG, untargeted.id)).toMatchObject({ ok: false });
    db.harnesses.set(HARNESS_ID, { id: HARNESS_ID, organizationId: ORG, revokedAt: new Date() });
    const revoked = job({ id: "66666666-6666-4666-8666-666666666666" });
    expect(await rerunJob({} as never, d, ORG, revoked.id)).toMatchObject({ ok: false });
    expect(createAndPublish).not.toHaveBeenCalled();
  });

  it("re-runs a failed review job's review on the PR's current head", async () => {
    const failed = job({ type: REVIEW_TASK_JOB_TYPE, taskType: "review", payload: reviewPayload });
    reviews.rerunOrganizationReview.mockResolvedValue({ ok: true, reviewId: "new" });
    const { dispatcher: d } = dispatcher();
    expect(await rerunJob({} as never, d, ORG, failed.id)).toEqual({ ok: true });
    expect(reviews.rerunOrganizationReview).toHaveBeenCalledWith({}, d, ORG, REVIEW_ID, {
      mode: "incremental",
      depth: null,
    });

    reviews.rerunOrganizationReview.mockResolvedValue({
      ok: false,
      error: "A review of abc is already queued or running.",
      activeReviewId: "active",
    });
    expect(await rerunJob({} as never, d, ORG, failed.id)).toEqual({
      ok: true,
      warning: "A review of abc is already queued or running.",
    });

    reviews.rerunOrganizationReview.mockResolvedValue({
      ok: false,
      error: "This change request is merged, so it can't be reviewed again.",
    });
    expect(await rerunJob({} as never, d, ORG, failed.id)).toEqual({
      ok: false,
      error: "This change request is merged, so it can't be reviewed again.",
    });
  });

  it("refuses jobs that didn't fail, can't be rerun or aren't the organization's", async () => {
    const { dispatcher: d, createAndPublish } = dispatcher();
    const done = job({ status: "completed" });
    expect(await rerunJob({} as never, d, ORG, done.id)).toEqual({
      ok: false,
      error: "Only failed, canceled or expired jobs can be rerun.",
    });
    const story = job({
      id: "77777777-7777-4777-8777-777777777777",
      type: RALPH_STORY_JOB_TYPE,
      taskType: "coding",
      taskId: "builtin:implement-story",
    });
    expect(await rerunJob({} as never, d, ORG, story.id)).toEqual({
      ok: false,
      error: "Retry this from its run.",
    });
    const other = job({
      id: "88888888-8888-4888-8888-888888888888",
      organizationId: "99999999-9999-4999-8999-999999999999",
    });
    expect(await rerunJob({} as never, d, ORG, other.id)).toEqual({
      ok: false,
      error: JOB_NOT_FOUND,
    });
    expect(await rerunJob({} as never, d, ORG, "missing")).toEqual({
      ok: false,
      error: JOB_NOT_FOUND,
    });
    expect(createAndPublish).not.toHaveBeenCalled();
    expect(reviews.rerunOrganizationReview).not.toHaveBeenCalled();
  });
});
