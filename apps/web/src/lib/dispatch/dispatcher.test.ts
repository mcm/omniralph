import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@omniralph/db", () => ({
  getHarness: vi.fn(),
  getJob: vi.fn(),
  insertJob: vi.fn(),
  pinnedHarnessFor: vi.fn(),
  requestJobCancel: vi.fn(),
  setQueuedJobTarget: vi.fn(),
}));

import {
  getHarness,
  getJob,
  insertJob,
  pinnedHarnessFor,
  setQueuedJobTarget,
  type Database,
  type Harness,
  type Job,
} from "@omniralph/db";
import type { WakePublisher } from "@/lib/ably/publisher";
import { PostgresDispatcher, type DispatchJobInput } from "./dispatcher";

const ORG_ID = "0b7d9a2e-4c1f-4e8a-9b3d-5f6a7b8c9d0e";
const HARNESS_ID = "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f";
const REPO_ID = "3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a";
const db = {} as Database;

const input: DispatchJobInput = {
  organizationId: ORG_ID,
  type: "repo.sync",
  taskType: "system",
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: "job-1",
    organizationId: ORG_ID,
    status: "queued",
    targetHarnessId: null,
    repositoryId: null,
    ...overrides,
  } as Job;
}

function publisher(wake: WakePublisher["wake"] = vi.fn(async () => {})) {
  return { wake: vi.fn(wake) };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getHarness).mockResolvedValue({ organizationId: ORG_ID } as Harness);
});

describe("PostgresDispatcher.createAndPublish", () => {
  it("wakes the target harness's channel when the job has a target", async () => {
    vi.mocked(insertJob).mockResolvedValue({
      job: job({ targetHarnessId: HARNESS_ID }),
      created: true,
    });
    const wakes = publisher();
    const dispatcher = new PostgresDispatcher({ db, wakePublisher: wakes });

    await dispatcher.createAndPublish({ ...input, targetHarnessId: HARNESS_ID });

    expect(vi.mocked(insertJob).mock.calls[0]?.[1]).toMatchObject({ targetHarnessId: HARNESS_ID });
    expect(wakes.wake).toHaveBeenCalledExactlyOnceWith(`harness:${HARNESS_ID}`);
  });

  it("wakes the organization's channel when the job has no target", async () => {
    vi.mocked(insertJob).mockResolvedValue({ job: job(), created: true });
    const wakes = publisher();
    await new PostgresDispatcher({ db, wakePublisher: wakes }).createAndPublish(input);
    expect(wakes.wake).toHaveBeenCalledExactlyOnceWith(`org:${ORG_ID}`);
  });

  it("wakes the existing job's channel when the job was deduplicated", async () => {
    vi.mocked(insertJob).mockResolvedValue({
      job: job({ status: "running", targetHarnessId: HARNESS_ID }),
      created: false,
    });
    const wakes = publisher();
    const result = await new PostgresDispatcher({ db, wakePublisher: wakes }).createAndPublish({
      ...input,
      dedupeKey: "k",
    });
    expect(result.created).toBe(false);
    expect(wakes.wake).toHaveBeenCalledExactlyOnceWith(`harness:${HARNESS_ID}`);
  });

  it("publishes nothing without a wake publisher", async () => {
    const dispatched = { job: job(), created: true };
    vi.mocked(insertJob).mockResolvedValue(dispatched);
    await expect(new PostgresDispatcher({ db }).createAndPublish(input)).resolves.toBe(dispatched);
  });

  it("logs a failed wake and still returns the job", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatched = { job: job(), created: true };
    vi.mocked(insertJob).mockResolvedValue(dispatched);
    const wakes = publisher(async () => {
      throw new Error("Ably is down");
    });
    await expect(
      new PostgresDispatcher({ db, wakePublisher: wakes }).createAndPublish(input),
    ).resolves.toBe(dispatched);
    expect(error).toHaveBeenCalledWith(
      `Couldn't publish a wake to org:${ORG_ID}`,
      expect.any(Error),
    );
    error.mockRestore();
  });
});

describe("PostgresDispatcher.republish", () => {
  it("wakes the re-resolved target's channel when the job is still queued", async () => {
    vi.mocked(getJob).mockResolvedValue(job({ repositoryId: REPO_ID }));
    vi.mocked(pinnedHarnessFor).mockResolvedValue(HARNESS_ID);
    vi.mocked(setQueuedJobTarget).mockResolvedValue(true);
    const wakes = publisher();

    await expect(
      new PostgresDispatcher({ db, wakePublisher: wakes }).republish("job-1"),
    ).resolves.toBe(true);

    expect(setQueuedJobTarget).toHaveBeenCalledWith(db, "job-1", HARNESS_ID);
    expect(wakes.wake).toHaveBeenCalledExactlyOnceWith(`harness:${HARNESS_ID}`);
  });

  it("wakes the organization's channel when no agent is pinned", async () => {
    vi.mocked(getJob).mockResolvedValue(job({ targetHarnessId: HARNESS_ID }));
    vi.mocked(setQueuedJobTarget).mockResolvedValue(true);
    const wakes = publisher();
    await new PostgresDispatcher({ db, wakePublisher: wakes }).republish("job-1");
    expect(setQueuedJobTarget).toHaveBeenCalledWith(db, "job-1", null);
    expect(wakes.wake).toHaveBeenCalledExactlyOnceWith(`org:${ORG_ID}`);
  });

  it("wakes nobody when the job isn't queued", async () => {
    const wakes = publisher();
    const dispatcher = new PostgresDispatcher({ db, wakePublisher: wakes });
    vi.mocked(getJob).mockResolvedValue(job({ status: "running" }));
    await expect(dispatcher.republish("job-1")).resolves.toBe(false);
    vi.mocked(getJob).mockResolvedValue(job());
    vi.mocked(setQueuedJobTarget).mockResolvedValue(false);
    await expect(dispatcher.republish("job-1")).resolves.toBe(false);
    expect(wakes.wake).not.toHaveBeenCalled();
  });

  it("logs a failed wake and still reports the job republished", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getJob).mockResolvedValue(job());
    vi.mocked(setQueuedJobTarget).mockResolvedValue(true);
    const wakes = publisher(async () => {
      throw new Error("Ably is down");
    });
    await expect(
      new PostgresDispatcher({ db, wakePublisher: wakes }).republish("job-1"),
    ).resolves.toBe(true);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
  });
});
