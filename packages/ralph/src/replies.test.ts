import { describe, expect, it } from "vitest";
import {
  asksForPushOrPullRequest,
  eligiblePreparations,
  fenced,
  isRerunPreparationRequest,
  isRunnablePreparation,
  isStartAnywayRequest,
  MAX_PREPARATION_COMMAND_LENGTH,
  MAX_PREPARATION_COMMANDS,
  isStopRequest,
  matchPermissionAnswer,
  matchPreparationAnswer,
  parseContinueRequest,
  parseInstruction,
  parseShipRequest,
  permissionQuestion,
  preparationHash,
  preparationQuestion,
} from "./replies.js";
import { readRequestResult } from "./output.js";
import { buildRequestPrompt, requestSystemAppend } from "./prompt.js";
import type { Story } from "./types.js";

const story = (key: string, over: Partial<Story> = {}): Story => ({
  key,
  storyId: key,
  issueId: key,
  identifier: key,
  title: `Story ${key}`,
  description: "",
  acceptanceCriteria: [],
  priority: 3,
  dependsOn: [],
  status: "open",
  ...over,
});

describe("reply intents", () => {
  it("recognises stop by signal or text", () => {
    expect(isStopRequest({ body: "", signal: "stop" })).toBe(true);
    expect(isStopRequest({ body: "Stop." })).toBe(true);
    expect(isStopRequest({ body: "stop working!" })).toBe(true);
    expect(isStopRequest({ body: "don't stop the tests" })).toBe(false);
  });

  it("parses /continue and the guidance after it", () => {
    expect(parseContinueRequest("/continue")).toBe("");
    expect(parseContinueRequest("  /Continue \n")).toBe("");
    expect(parseContinueRequest("/continue Use the v2 API.\nAnd test it.")).toBe(
      "Use the v2 API.\nAnd test it.",
    );
    expect(parseContinueRequest("/continued")).toBeNull();
    expect(parseContinueRequest("/continue-later")).toBeNull();
    expect(parseContinueRequest("please /continue")).toBeNull();
  });

  it("recognises start anyway", () => {
    expect(isStartAnywayRequest("Please start anyway")).toBe(true);
    expect(isStartAnywayRequest("ignore the blockers")).toBe(true);
    expect(isStartAnywayRequest("start with the API")).toBe(false);
  });

  it("matches preparation answers by value or number", () => {
    expect(matchPreparationAnswer("Run it")).toBe("Run it");
    expect(matchPreparationAnswer("i'll do it MYSELF")).toBe("I'll do it myself");
    expect(matchPreparationAnswer(" 3 ")).toBe("Not yet");
    expect(matchPreparationAnswer("run it later maybe")).toBeUndefined();
    expect(isRerunPreparationRequest("Rerun preparation!")).toBe(true);
    expect(isRerunPreparationRequest("rerun")).toBe(false);
  });

  it("recognises push and PR/MR requests", () => {
    expect(asksForPushOrPullRequest("Please use glab to create an MR")).toBe(true);
    expect(asksForPushOrPullRequest("push the branch")).toBe(true);
    expect(asksForPushOrPullRequest("open a pull request")).toBe(true);
    expect(asksForPushOrPullRequest("Use a smallint column")).toBe(false);
    expect(asksForPushOrPullRequest("pushing back on that idea")).toBe(false);
  });
});

describe("preparation", () => {
  it("hashes the commands", () => {
    expect(preparationHash(["a", "b"])).toMatch(/^[0-9a-f]{64}$/);
    expect(preparationHash(["a", "b"])).not.toBe(preparationHash(["a b"]));
  });

  it("offers open, unblocked, unhandled manual stories with commands, in order", () => {
    const stories = [
      story("A"),
      story("M1", { manual: true, preparation: ["make db"], dependsOn: ["A"] }),
      story("M2", { manual: true, preparation: ["make seed"], priority: 1 }),
      story("M3", { manual: true }),
      story("M4", { manual: true, preparation: ["x"], status: "completed" }),
      story("M5", { manual: true, preparation: ["x"], dependsOn: ["external:e"] }),
      story("M6", { manual: true, preparation: ["y"] }),
    ];
    expect(eligiblePreparations(stories).map((s) => s.key)).toEqual(["M2", "M6"]);
    expect(eligiblePreparations(stories, new Set(["M2"])).map((s) => s.key)).toEqual(["M6"]);
    const done = stories.map((s) => (s.key === "A" ? { ...s, status: "completed" as const } : s));
    expect(eligiblePreparations(done).map((s) => s.key)).toEqual(["M2", "M1", "M6"]);
  });

  it("leaves preparations a job can't run to a person", () => {
    const many = Array.from({ length: MAX_PREPARATION_COMMANDS + 1 }, (_, i) => `echo ${i}`);
    const long = "x".repeat(MAX_PREPARATION_COMMAND_LENGTH + 1);
    const stories = [
      story("M1", { manual: true, preparation: many }),
      story("M2", { manual: true, preparation: [long] }),
      story("M3", { manual: true, preparation: many.slice(0, MAX_PREPARATION_COMMANDS) }),
    ];
    expect(eligiblePreparations(stories).map((s) => s.key)).toEqual(["M3"]);
    expect(isRunnablePreparation([])).toBe(false);
  });

  it("asks with the commands, branch and SHA", () => {
    const body = preparationQuestion({
      story: { storyId: "ENG-5", title: "Set up the DB" },
      branch: "feat/x",
      headSha: "a".repeat(40),
      commands: ["make db", "echo ```"],
      lead: "Lead.",
    });
    expect(body).toContain("Lead.");
    expect(body).toContain("**ENG-5: Set up the DB**");
    expect(body).toContain("`feat/x` at `aaaaaaaaaa`");
    expect(body).toContain("````sh\nmake db\necho ```\n````");
    expect(fenced("x")).toBe("```\nx\n```");
  });
});

describe("/ship", () => {
  it("parses `/ship` at the start of a reply, with or without notes", () => {
    expect(parseShipRequest("/ship")).toBe("");
    expect(parseShipRequest("  /ship  and bump the version\nplease")).toBe(
      "and bump the version\nplease",
    );
    expect(parseShipRequest("/shipit")).toBeNull();
    expect(parseShipRequest("/ship-it")).toBeNull();
    expect(parseShipRequest("please /ship")).toBeNull();
  });

  it("reads the session's commit message", () => {
    expect(readRequestResult({ summary: "x", commit: { message: "  Fix it\n\nBody.  " } })).toEqual(
      {
        result: { summary: "x", commit: { message: "Fix it\n\nBody." } },
      },
    );
    expect(readRequestResult({ summary: "x", commit: { message: "  " } })).toEqual({
      result: { summary: "x" },
    });
  });

  it("tells a ship session to prepare the commit, not make it", () => {
    const prompt = buildRequestPrompt({
      epic: {
        kind: "single",
        issueId: "",
        identifier: "ENG-1",
        title: "Fix",
        description: "",
        branchName: "eng-1",
        qualityGates: [],
        stories: [],
      },
      requests: ["/ship"],
      branch: "eng-1",
      baseBranch: "main",
      remoteUrl: "https://example.com/r.git",
      progressFile: "/tmp/p.md",
      qualityGates: ["pnpm test"],
      ship: {
        stashes: [
          {
            sha: "a".repeat(40),
            label: "omniralph ralph r request unfinished",
            date: "2026-10-10",
          },
        ],
      },
    });
    expect(prompt).toContain("This is `/ship`");
    expect(prompt).toContain(`git stash apply <sha>`);
    expect(prompt).toContain("a".repeat(40));
    expect(prompt).toContain("set `pullRequest` to `open`");
    expect(prompt).not.toContain("You may commit");
    expect(requestSystemAppend("when-asked", "tracker", { ship: true })).toContain(
      "Don't run `git commit`",
    );
    expect(requestSystemAppend("when-asked")).toContain("You may use git (commit, push)");
  });
});

describe("permission questions", () => {
  it("matches Allow/Deny answers, including the picker's values and yes/no", () => {
    expect(matchPermissionAnswer("Allow")).toBe("Allow");
    expect(matchPermissionAnswer("yes")).toBe("Allow");
    expect(matchPermissionAnswer("1")).toBe("Allow");
    expect(matchPermissionAnswer("Deny.")).toBe("Deny");
    expect(matchPermissionAnswer("no")).toBe("Deny");
    expect(matchPermissionAnswer("allow it but only once")).toBeUndefined();
  });

  it("shows the call, the reason and the timeout", () => {
    const text = permissionQuestion({
      tool: "Bash",
      detail: "git commit -m '```'",
      reason: "It matches `Bash(git commit:*)`.",
      timeoutMinutes: 30,
    });
    expect(text).toContain("**Bash**");
    expect(text).toContain("git commit -m 'ˋˋˋ'");
    expect(text).toContain("It matches `Bash(git commit:*)`.");
    expect(text).toContain("with no answer in 30 minutes I'll take it as Deny");
  });
});

describe("parseInstruction", () => {
  it("strips a leading @name and keeps plain text as a request", () => {
    expect(parseInstruction("@omniralph, fix the typo")).toEqual({
      text: "fix the typo",
      wantsLoop: false,
      wantsTriage: false,
    });
    expect(parseInstruction(undefined)).toEqual({ text: "", wantsLoop: false, wantsTriage: false });
  });

  it("recognizes /coding and strips it", () => {
    expect(parseInstruction("@omniralph /coding keep it small")).toEqual({
      text: "keep it small",
      wantsLoop: true,
      wantsTriage: false,
    });
    expect(parseInstruction("/CODING").wantsLoop).toBe(true);
    expect(parseInstruction("see a/coding path").wantsLoop).toBe(false);
    expect(parseInstruction("/codings").wantsLoop).toBe(false);
  });

  it("still recognizes /ralph (and /label-based-prompt) and strips it", () => {
    expect(parseInstruction("@omniralph /ralph keep it small")).toEqual({
      text: "keep it small",
      wantsLoop: true,
      wantsTriage: false,
    });
    expect(parseInstruction("/LABEL-BASED-PROMPT")).toEqual({
      text: "",
      wantsLoop: true,
      wantsTriage: false,
    });
    expect(parseInstruction("see a/ralph path").wantsLoop).toBe(false);
  });

  it("recognizes /triage anywhere and strips it", () => {
    expect(parseInstruction("@omniralph /triage")).toEqual({
      text: "",
      wantsLoop: false,
      wantsTriage: true,
    });
    expect(parseInstruction("@omniralph it's for the API /Triage")).toEqual({
      text: "it's for the API",
      wantsLoop: false,
      wantsTriage: true,
    });
    expect(parseInstruction("see docs/triage.md").wantsTriage).toBe(false);
    expect(parseInstruction("/triaged").wantsTriage).toBe(false);
  });
});
