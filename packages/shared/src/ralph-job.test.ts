import { describe, expect, it } from "vitest";
import { CODING_DEFAULTS, CODING_MAX_FIX_ROUNDS } from "@omniralph/tasks";
import { z } from "zod";
import {
  GitBranch,
  MAX_ATTEMPTS_PER_STORY,
  RALPH_JOB_TYPES,
  RalphActivity,
  RalphCleanupPayload,
  RalphCleanupResult,
  ralphStashBranch,
  ralphStashPrefix,
  RalphDescribePrPayload,
  RalphDescribePrResult,
  RalphPreparePayload,
  RalphPrepareResult,
  RalphRequestPayload,
  RalphRequestResult,
  RalphStoryPayload,
  RalphStoryResult,
} from "./ralph-job.js";
import { MAX_FIX_ROUNDS } from "./settings.js";

const sha = "a".repeat(40);
const base = {
  runId: "00000000-0000-4000-8000-000000000001",
  repositoryId: "00000000-0000-4000-8000-000000000002",
  repository: {
    provider: "github",
    fullPath: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
  },
  branch: "steve/tool-32-ralph",
  baseBranch: "main",
  settings: { model: null, setupCommand: "pnpm install" },
};

const storyPayload = {
  ...base,
  storyId: "00000000-0000-4000-8000-000000000003",
  attempt: 1,
  epic: { identifier: "TOOL-32", title: "Ralph core", prd: "# PRD" },
  story: {
    identifier: "TOOL-83",
    title: "Add the ralph capability",
    linearIssueId: "30ed0e14-6d6a-4dba-8962-4c010fca69af",
    description: "As a developer...",
  },
  commitMessage: "feat(TOOL-83): Add the ralph capability",
  qualityGates: ["pnpm typecheck", "pnpm test"],
  progress: "",
  lastFeedback: null,
  guidance: [],
};

const storyResult = {
  status: "complete",
  summary: "Added the capability.",
  commitSha: sha,
  followUps: [{ title: "Fix the flaky test", description: "- [ ] it passes", manual: false }],
  feedback: null,
  usage: { inputTokens: 1000, outputTokens: 200 },
  durationMs: 60_000,
};

describe("ralph jobs", () => {
  it("have the ralph.* job types", () => {
    expect(RALPH_JOB_TYPES).toEqual([
      "ralph.story",
      "ralph.describe-pr",
      "ralph.prepare",
      "ralph.request",
      "ralph.cleanup",
    ]);
  });

  it("parses ralph.cleanup payloads and results", () => {
    const cleanup = { ...base, epic: { identifier: "ENG-1" } };
    expect(
      RalphCleanupPayload.parse({ ...cleanup, action: { kind: "cleanup", mergedSha: sha } }).action,
    ).toEqual({ kind: "cleanup", mergedSha: sha, stashes: [] });
    expect(
      RalphCleanupPayload.safeParse({
        ...cleanup,
        action: { kind: "stashes", push: true, shas: [] },
      }).success,
    ).toBe(false);
    expect(
      RalphCleanupPayload.safeParse({ ...cleanup, action: { kind: "cleanup", mergedSha: "head" } })
        .success,
    ).toBe(false);
    expect(RalphCleanupResult.parse({ durationMs: 1 })).toEqual({
      error: null,
      removedWorktree: false,
      hadBranch: false,
      stashed: null,
      unmerged: 0,
      stashes: [],
      handled: 0,
      durationMs: 1,
    });
    expect(ralphStashPrefix("r")).toBe("omniralph ralph r ");
    expect(ralphStashBranch("ENG-1")).toBe("ralph/stash/eng-1");
  });

  it("validates ralph.request payloads and results", () => {
    const { storyId: _s, attempt: _a, story: _t, commitMessage: _c, ...base } = storyPayload;
    const payload = RalphRequestPayload.parse({
      ...base,
      requests: [{ id: "8b0b4a2e-7a0b-4f5e-9c43-2f1a5d1f2e3c", text: "push this" }],
    });
    expect(payload).toMatchObject({
      prUrl: null,
      historyRewrite: "when-asked",
      resumeSessionId: null,
      // An older control panel's payload (no source) is a Linear request.
      source: "linear",
    });
    expect(RalphRequestPayload.safeParse({ ...base, requests: [] }).success).toBe(false);
    const chat = { ...base, source: "chat", requests: payload.requests };
    expect(RalphRequestPayload.parse(chat).source).toBe("chat");
    expect(RalphRequestPayload.safeParse({ ...chat, source: "email" }).success).toBe(false);
    // Older agents parse with the schema minus `source`: the extra key doesn't break them.
    const { source: _source, ...olderSchema } = RalphRequestPayload.shape;
    expect(z.object(olderSchema).safeParse(chat).success).toBe(true);
    expect(
      RalphRequestResult.parse({
        summary: "Opened it.",
        sessionId: "claude-1",
        pullRequest: { action: "open", title: "Add it" },
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 5,
      }),
    ).toMatchObject({ error: null, pullRequest: { action: "open", title: "Add it" } });
    expect(
      RalphRequestResult.safeParse({
        summary: "x",
        sessionId: null,
        pullRequest: { action: "merge" },
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 5,
      }).success,
    ).toBe(false);
  });
});

describe("GitBranch", () => {
  it("accepts branch names and rejects unsafe refs", () => {
    for (const ok of ["main", "steve/tool-83-x", "release/1.2", "a_b-c"]) {
      expect(GitBranch.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of [
      "",
      "-x",
      "/x",
      "x/",
      "a..b",
      "a//b",
      "x.lock",
      "a/.hidden",
      "a b",
      "a@{1}",
    ]) {
      expect(GitBranch.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("RalphStoryPayload", () => {
  it("accepts a story attempt and rejects an invalid branch or attempt", () => {
    expect(RalphStoryPayload.safeParse(storyPayload).success).toBe(true);
    expect(
      RalphStoryPayload.safeParse({ ...storyPayload, lastFeedback: "gates failed", attempt: 2 })
        .success,
    ).toBe(true);
    expect(RalphStoryPayload.safeParse({ ...storyPayload, branch: "../x" }).success).toBe(false);
    expect(RalphStoryPayload.safeParse({ ...storyPayload, attempt: 0 }).success).toBe(false);
    expect(RalphStoryPayload.safeParse({ ...storyPayload, storyId: "x" }).success).toBe(false);
  });

  it("defaults the epic kind, URLs and the story list", () => {
    const parsed = RalphStoryPayload.parse(storyPayload);
    expect(parsed.epic).toMatchObject({ kind: "children", url: null });
    expect(parsed.story.url).toBeNull();
    expect(parsed.stories).toEqual([]);
    const listed = RalphStoryPayload.parse({
      ...storyPayload,
      epic: { ...storyPayload.epic, kind: "single" },
      stories: [{ identifier: "TOOL-83", title: "Add", status: "in_progress" }],
    });
    expect(listed.epic.kind).toBe("single");
    expect(listed.stories).toEqual([
      {
        identifier: "TOOL-83",
        title: "Add",
        status: "in_progress",
        manual: false,
        dependsOn: [],
        repository: null,
      },
    ]);
    expect(
      RalphStoryPayload.safeParse({
        ...storyPayload,
        stories: [{ identifier: "TOOL-83", title: "Add", status: "done" }],
      }).success,
    ).toBe(false);
  });
});

describe("RalphStoryResult", () => {
  it("accepts every status, with or without a commit", () => {
    expect(RalphStoryResult.safeParse(storyResult).success).toBe(true);
    for (const status of ["incomplete", "blocked", "failed"]) {
      const { commitSha: _, ...rest } = storyResult;
      expect(
        RalphStoryResult.safeParse({ ...rest, status, feedback: "pnpm test failed" }).success,
      ).toBe(true);
    }
    expect(
      RalphStoryResult.parse({ ...storyResult, progress: "# Ralph Progress Log\n" }).progress,
    ).toBe("# Ralph Progress Log\n");
  });

  it("rejects unknown statuses, bad SHAs and incomplete follow-ups", () => {
    expect(RalphStoryResult.safeParse({ ...storyResult, status: "done" }).success).toBe(false);
    expect(RalphStoryResult.safeParse({ ...storyResult, commitSha: "abc" }).success).toBe(false);
    expect(
      RalphStoryResult.safeParse({ ...storyResult, followUps: [{ title: " ", description: "" }] })
        .success,
    ).toBe(false);
    expect(
      RalphStoryResult.safeParse({ ...storyResult, usage: { inputTokens: -1, outputTokens: 0 } })
        .success,
    ).toBe(false);
  });
});

describe("RalphDescribePrPayload / RalphDescribePrResult", () => {
  const payload = {
    ...base,
    epic: { identifier: "TOOL-32", title: "Ralph core", url: null, prd: "# PRD" },
    stories: [{ identifier: "TOOL-83", title: "Story", status: "completed", commitSha: sha }],
    progress: "## TOOL-83\n- done",
  };

  it("accepts a finished run and a title and body", () => {
    expect(RalphDescribePrPayload.parse(payload).qualityGates).toEqual([]);
    expect(
      RalphDescribePrResult.safeParse({
        title: "Ralph core",
        body: "## Summary\n...",
        usage: { inputTokens: 1, outputTokens: 1 },
      }).success,
    ).toBe(true);
  });

  it("rejects an empty title or body", () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    expect(RalphDescribePrResult.safeParse({ title: " ", body: "x", usage }).success).toBe(false);
    expect(RalphDescribePrResult.safeParse({ title: "x", body: "", usage }).success).toBe(false);
    expect(
      RalphDescribePrResult.safeParse({ title: "x".repeat(73), body: "x", usage }).success,
    ).toBe(false);
  });
});

describe("RalphPreparePayload / RalphPrepareResult", () => {
  const payload = {
    ...base,
    story: { identifier: "TOOL-90", title: "Create the bucket" },
    commands: ["terraform apply"],
    commandsHash: "f".repeat(64),
    approvedHeadSha: sha,
  };

  it("accepts approved commands and their outcome", () => {
    expect(RalphPreparePayload.safeParse(payload).success).toBe(true);
    for (const status of ["completed", "failed", "stale"]) {
      expect(
        RalphPrepareResult.safeParse({
          status,
          commands: status === "stale" ? [] : [{ command: "x", exitCode: 0, output: "ok" }],
          headSha: sha,
          durationMs: 5,
        }).success,
      ).toBe(true);
    }
  });

  it("rejects no commands or a malformed hash", () => {
    expect(RalphPreparePayload.safeParse({ ...payload, commands: [] }).success).toBe(false);
    expect(RalphPreparePayload.safeParse({ ...payload, commandsHash: "abc" }).success).toBe(false);
  });
});

describe("RalphActivity", () => {
  it("accepts thoughts and actions, non-ephemeral by default", () => {
    expect(RalphActivity.parse({ type: "thought", body: "Reading the PRD" })).toEqual({
      type: "thought",
      body: "Reading the PRD",
      ephemeral: false,
    });
    expect(
      RalphActivity.safeParse({ type: "action", body: "Bash: pnpm test", ephemeral: true }).success,
    ).toBe(true);
    expect(
      RalphActivity.parse({
        type: "action",
        body: "Bash",
        parameter: "pnpm test",
        ephemeral: true,
      }),
    ).toEqual({ type: "action", body: "Bash", parameter: "pnpm test", ephemeral: true });
  });

  it("rejects other types and empty bodies", () => {
    expect(RalphActivity.safeParse({ type: "response", body: "Done" }).success).toBe(false);
    expect(RalphActivity.safeParse({ type: "thought", body: "  " }).success).toBe(false);
  });
});

describe("the coding tasks' limits", () => {
  it("default to ralph's", () => {
    expect(CODING_DEFAULTS.maxAttemptsPerStory).toBe(MAX_ATTEMPTS_PER_STORY);
    expect(CODING_MAX_FIX_ROUNDS).toBe(MAX_FIX_ROUNDS);
    expect(CODING_DEFAULTS.maxReviewRounds).toBe(MAX_FIX_ROUNDS);
    expect(CODING_DEFAULTS.maxFixRounds).toBe(MAX_FIX_ROUNDS);
  });
});
