import { describe, expect, it, vi } from "vitest";
import type { MenuItem } from "@omniralph/ui";
import type { RunDetail, RunStep } from "@/lib/api/runs";
import { RUN_STATUSES } from "@/lib/api/runs";
import { defaultStep, runMenuItems, runStatusLine, runToolbar, selectedStep } from "./run-detail";
import { attempt, epicRunDetail, reviewRunDetail, runDetail, storyStep } from "./test-fixtures";

const MR = {
  provider: "gitlab" as const,
  number: 12,
  url: "https://gitlab.com/acme/portal/-/merge_requests/12",
};
const PR = { provider: "github" as const, number: 7, url: "https://github.com/acme/api/pull/7" };

function withPullRequest(
  detail: RunDetail,
  pr: typeof MR | typeof PR,
  state: { merged: boolean | null; closed: boolean | null } = { merged: false, closed: false },
): RunDetail {
  return {
    ...detail,
    pullRequest: pr,
    details: { ...detail.details, pullRequest: { ...pr, ...state } },
  };
}

const NO_ACTIONS = { stop: false, retry: { run: false, storyIds: [], attemptIds: [] } };

function withActions(detail: RunDetail, actions: Partial<RunDetail["details"]["actions"]>) {
  return {
    ...detail,
    details: { ...detail.details, actions: { ...NO_ACTIONS, ...actions } },
  };
}

describe("runStatusLine", () => {
  const WORDS: Record<RunDetail["status"], string> = {
    queued: "Queued",
    running: "Running",
    waiting: "Waiting on you",
    completed: "Finished",
    failed: "Failed",
    stopped: "Stopped",
    skipped: "Skipped",
  };
  const TONES: Record<RunDetail["status"], string> = {
    queued: "run",
    running: "run",
    waiting: "need",
    completed: "neutral",
    failed: "fail",
    stopped: "need",
    skipped: "neutral",
  };

  it.each(RUN_STATUSES)("reads %s without a PR/MR, and with one on either code host", (status) => {
    const run = runDetail(null, { kind: "request", status, progress: null });
    expect(runStatusLine(run)).toEqual({ text: WORDS[status], tone: TONES[status] });
    expect(runStatusLine(withPullRequest(run, MR)).text).toBe(
      `${WORDS[status]} · merge request open`,
    );
    expect(runStatusLine(withPullRequest(run, PR)).text).toBe(
      `${WORDS[status]} · pull request open`,
    );
  });

  it("says whether the PR/MR is merged or closed", () => {
    const run = runDetail(null, { status: "completed" });
    expect(runStatusLine(withPullRequest(run, MR, { merged: true, closed: false })).text).toBe(
      "Finished · merge request merged",
    );
    expect(runStatusLine(withPullRequest(run, PR, { merged: false, closed: true })).text).toBe(
      "Finished · pull request closed",
    );
    // A review of a PR Om didn't open: its state is unknown, so it reads as open.
    expect(runStatusLine(withPullRequest(run, PR, { merged: null, closed: null })).text).toBe(
      "Finished · pull request open",
    );
  });

  it("counts the story a running epic is on", () => {
    const run = runDetail(null, { status: "running", progress: { done: 1, total: 4 } });
    expect(runStatusLine(run)).toEqual({ text: "Running · story 2 of 4", tone: "run" });
    expect(runStatusLine(withPullRequest(run, MR)).text).toBe(
      "Running · story 2 of 4 · merge request open",
    );
  });
});

describe("defaultStep", () => {
  const steps = (...list: RunStep[]) => ({ steps: list, attempts: [] });

  it("is the first running step", () => {
    expect(
      defaultStep(
        steps(
          storyStep("1", "exhausted", 1),
          storyStep("2", "running", 1),
          storyStep("3", "running"),
        ),
      ),
    ).toBe("2");
  });

  it("else the first failed one", () => {
    expect(
      defaultStep(
        steps(
          storyStep("1", "manual"),
          storyStep("2", "exhausted", 1),
          storyStep("3", "exhausted"),
        ),
      ),
    ).toBe("2");
  });

  it("else the first waiting one", () => {
    expect(
      defaultStep(
        steps(storyStep("1", "completed", 1), storyStep("2", "manual"), storyStep("3", "manual")),
      ),
    ).toBe("2");
  });

  it("else the last step that has an attempt", () => {
    expect(
      defaultStep(
        steps(
          storyStep("1", "completed", 1),
          storyStep("2", "completed", 1),
          storyStep("3", "pending"),
        ),
      ),
    ).toBe("2");
    // A story with an attempt the epic hasn't counted yet.
    expect(
      defaultStep({
        steps: [storyStep("1", "completed", 1), storyStep("2", "canceled")],
        attempts: [attempt("a2", { step: "2" })],
      }),
    ).toBe("2");
    expect(defaultStep(steps(storyStep("1", "pending")))).toBeUndefined();
    expect(defaultStep(steps())).toBeUndefined();
  });

  it("works on a review's passes and a request's turns", () => {
    expect(defaultStep(reviewRunDetail())).toBe("pass-2");
    const turns: RunStep[] = [
      { kind: "attempt", id: "t1", label: "Worked", status: "completed", durationMs: 1 },
      { kind: "attempt", id: "t2", label: "Worked", status: "completed", durationMs: 1 },
    ];
    expect(defaultStep(steps(...turns))).toBe("t2");
  });

  it("gives way to the URL's step when the run has it", () => {
    const run = epicRunDetail();
    expect(selectedStep(run, "1")?.id).toBe("1");
    expect(selectedStep(run, "nope")?.id).toBe("2");
    expect(selectedStep(run, null)?.id).toBe("2");
  });
});

describe("runToolbar", () => {
  it("offers nothing on a running epic without a PR/MR", () => {
    const run = epicRunDetail();
    expect(runToolbar(run, selectedStep(run, null))).toEqual([]);
  });

  it("opens the MR of a finished epic, and re-runs its selected story", () => {
    const run = withActions(
      withPullRequest(
        epicRunDetail({
          status: "completed",
          steps: [storyStep("1", "completed", 1), storyStep("2", "completed", 1)],
        }),
        MR,
      ),
      { retry: { run: false, storyIds: ["1", "2"], attemptIds: [] } },
    );
    expect(runToolbar(run, run.steps[1])).toEqual([
      { kind: "pull_request", label: "Open merge request", href: MR.url },
      { kind: "retry", label: "Re-run story", target: { kind: "story", storyId: "2" } },
    ]);
    // A story that can't be re-run (its PR merged…): no second button.
    const noRerun = withActions(run, { retry: { run: false, storyIds: ["1"], attemptIds: [] } });
    expect(runToolbar(noRerun, run.steps[1])).toEqual([
      { kind: "pull_request", label: "Open merge request", href: MR.url },
    ]);
  });

  it("retries a failed request", () => {
    const run = withActions(runDetail(null, { kind: "request", status: "failed" }), {
      retry: { run: true, storyIds: [], attemptIds: [] },
    });
    expect(runToolbar(run, undefined)).toEqual([
      { kind: "retry", label: "Retry run", target: { kind: "run" } },
    ]);
  });

  it("opens a review's pull request, and retries a failed review", () => {
    const review = withPullRequest(reviewRunDetail(), PR);
    expect(runToolbar(review, undefined)).toEqual([
      { kind: "pull_request", label: "Open pull request", href: PR.url },
    ]);
    const failed = withActions(
      { ...review, status: "failed" },
      {
        retry: { run: true, storyIds: [], attemptIds: [] },
      },
    );
    expect(runToolbar(failed, undefined).map((item) => item.label)).toEqual([
      "Open pull request",
      "Retry run",
    ]);
  });

  it("offers nothing on a finished triage run", () => {
    const run = withActions(runDetail(null, { kind: "triage", status: "completed" }), {});
    expect(runToolbar(run, undefined)).toEqual([]);
  });
});

describe("runMenuItems", () => {
  const handlers = () => ({ onCopyBranch: vi.fn(), onStop: vi.fn() });
  const labels = (items: MenuItem[]) =>
    items.map((item) =>
      item === "separator" ? "—" : `${item.label}${item.destructive ? " (destructive)" : ""}`,
    );

  it("offers Linear, Copy branch and Stop on a running epic", () => {
    const run = { ...epicRunDetail(), branch: "omniralph/tool-42" };
    const h = handlers();
    const items = runMenuItems(run, h);
    expect(labels(items)).toEqual(["Open in Linear", "Copy branch", "Stop run (destructive)"]);
    const [linear, copy, stop] = items as Exclude<MenuItem, "separator">[];
    expect(linear!.href).toBe("https://linear.app/acme/issue/TOOL-42");
    copy!.onSelect!();
    expect(h.onCopyBranch).toHaveBeenCalled();
    stop!.onSelect!();
    expect(h.onStop).toHaveBeenCalled();
  });

  it("can't stop a finished epic", () => {
    const run = withActions({ ...epicRunDetail({ status: "completed" }), branch: "b" }, {});
    expect(labels(runMenuItems(run, handlers()))).toEqual(["Open in Linear", "Copy branch"]);
  });

  it("offers Linear and Copy branch on a failed request", () => {
    const run = withActions(
      { ...runDetail(null, { kind: "request", status: "failed" }), branch: "b" },
      {},
    );
    expect(labels(runMenuItems(run, handlers()))).toEqual(["Open in Linear", "Copy branch"]);
  });

  it("offers Linear alone on a review and a triage run without a branch", () => {
    const review = withActions(reviewRunDetail(), {});
    expect(labels(runMenuItems(review, handlers()))).toEqual(["Open in Linear"]);
    const triage = withActions(
      runDetail(null, { kind: "triage", status: "completed", workItem: null }),
      {},
    );
    expect(runMenuItems(triage, handlers())).toEqual([]);
  });

  it("puts the items other screens add first", () => {
    const run = epicRunDetail();
    const items = runMenuItems(run, {
      ...handlers(),
      leading: [{ label: "View PRD", onSelect: () => {} }],
    });
    expect(labels(items)).toEqual(["View PRD", "Open in Linear", "Stop run (destructive)"]);
  });
});
