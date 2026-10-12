import { describe, expect, it } from "vitest";
import {
  chatChannelLabel,
  linearIssueUrl,
  parseRalphRunListParams,
  ralphMessageState,
  ralphRunFailure,
  ralphRunListHref,
  roundsLabel,
  runSourceLabel,
  shortSha,
  truncate,
  type RalphJobView,
  type RalphStoryView,
} from "./display";

const REPO = "0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a11";

describe("ralph run list params", () => {
  it("parses status, repository and page; ignores unknown values", () => {
    expect(parseRalphRunListParams({ status: "waiting", repository: REPO, page: "2" })).toEqual({
      status: "waiting",
      repositoryId: REPO,
      page: 2,
    });
    expect(parseRalphRunListParams({ status: "nope", repository: "x", page: "-1" })).toEqual({
      status: null,
      repositoryId: null,
      page: 1,
    });
    expect(parseRalphRunListParams({ status: ["failed", "waiting"] }).status).toBe("failed");
  });

  it("builds list URLs without defaults", () => {
    expect(ralphRunListHref("/ralph", { status: null, repositoryId: null, page: 1 })).toBe(
      "/ralph",
    );
    expect(ralphRunListHref("/ralph", { status: "running", repositoryId: REPO, page: 3 })).toBe(
      `/ralph?status=running&repository=${REPO}&page=3`,
    );
  });
});

describe("formatting", () => {
  it("derives other issues' Linear URLs from the run's", () => {
    expect(linearIssueUrl("https://linear.app/acme/issue/ENG-1/epic-title", "OPS-2")).toBe(
      "https://linear.app/acme/issue/OPS-2",
    );
    expect(linearIssueUrl(null, "OPS-2")).toBeNull();
    expect(linearIssueUrl("https://example.com/ENG-1", "OPS-2")).toBeNull();
  });

  it("names a run by its Linear issue, or its chat platform and channel", () => {
    const linear = { origin: "linear" as const, linearIdentifier: "ENG-1", chatThread: null };
    expect(runSourceLabel(linear)).toBe("ENG-1");
    const chat = { origin: "chat" as const, linearIdentifier: null };
    expect(
      runSourceLabel({ ...chat, chatThread: { platform: "slack", channelId: "slack:C0123" } }),
    ).toBe("Slack C0123");
    expect(
      runSourceLabel({ ...chat, chatThread: { platform: "discord", channelId: "discord:9:42" } }),
    ).toBe("Discord 42");
    // Its thread is gone.
    expect(runSourceLabel({ ...chat, chatThread: null })).toBe("Chat");
    expect(chatChannelLabel("C0123")).toBe("C0123");
  });

  it("shortens SHAs and truncates text", () => {
    expect(shortSha("a".repeat(40))).toBe("a".repeat(12));
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("0123456789abc", 10)).toBe("012345678…");
  });
});

describe("run detail follow-up", () => {
  it("labels a lane's rounds, or says the loop is off", () => {
    expect(roundsLabel({ done: 1, max: 3 })).toBe("1 / 3");
    expect(roundsLabel({ done: 2, max: null })).toBe("2 (off)");
  });

  it("derives a live message's state from its timestamps and job", () => {
    const at = "2026-10-06T10:00:00.000Z";
    const message = { kind: "guidance" as const, deliveredAt: null, consumedAt: null };
    expect(ralphMessageState({ ...message, jobStatus: "running" })).toBe("waiting");
    expect(ralphMessageState({ ...message, jobStatus: "queued" })).toBe("waiting");
    expect(ralphMessageState({ ...message, jobStatus: "completed" })).toBe("undelivered");
    expect(
      ralphMessageState({ ...message, deliveredAt: at, consumedAt: at, jobStatus: "completed" }),
    ).toBe("delivered");
    expect(ralphMessageState({ ...message, consumedAt: at, jobStatus: "running" })).toBe(
      "guidance",
    );
    expect(
      ralphMessageState({ ...message, kind: "request", consumedAt: at, jobStatus: "running" }),
    ).toBe("undelivered");
  });
});

describe("ralphRunFailure", () => {
  const story = (over: Partial<RalphStoryView> = {}): RalphStoryView => ({
    id: "s1",
    identifier: "FIX-131",
    title: "Upgrade the client",
    status: "exhausted",
    attempts: 3,
    lastFeedback: null,
    commitSha: null,
    lastJobId: "job-2",
    laneId: null,
    elsewhere: null,
    ...over,
  });
  const job = (id: string, status: RalphJobView["status"]): RalphJobView => ({
    id,
    type: "ralph.story",
    status,
    cancelRequested: false,
    deliveryCount: 1,
    error: null,
    agent: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    finishedAt: null,
  });
  const base = {
    status: "failed" as const,
    origin: "linear" as const,
    linearIdentifier: "FIX-130",
    repository: { id: "r1", provider: "gitlab" as const, fullPath: "acme/api" },
    stories: [story()],
    jobs: [job("job-3", "completed"), job("job-2", "failed"), job("job-1", "failed")],
    maxAttemptsPerStory: 3,
  };

  it("names the story that ran out of attempts and links its last job", () => {
    const failure = ralphRunFailure(base);
    expect(failure.title).toBe("FIX-131 ran out of attempts (3/3)");
    expect(failure.job?.id).toBe("job-2");
    expect(failure.resume).toContain("delegate FIX-130 to Omniralph again in Linear");
  });

  it("falls back to the newest failed job without an exhausted story", () => {
    const failure = ralphRunFailure({
      ...base,
      stories: [story({ status: "completed" })],
      jobs: [job("job-3", "expired"), job("job-2", "failed")],
    });
    expect(failure.title).toBe("The ralph.story job expired");
    expect(failure.job?.id).toBe("job-3");
  });

  it("says how to retry a waiting run's PR/MR step", () => {
    const failure = ralphRunFailure({ ...base, status: "waiting", stories: [] });
    expect(failure.title).toBe("The MR step failed");
    expect(failure.resume).toContain("reply in the Linear agent session to retry the MR step");
  });

  it("tells a chat run to start again from the thread", () => {
    const failure = ralphRunFailure({ ...base, origin: "chat", jobs: [], stories: [] });
    expect(failure.title).toBe("The run failed");
    expect(failure.job).toBeNull();
    expect(failure.resume).toContain("ask Omniralph again in the chat thread");
  });
});
