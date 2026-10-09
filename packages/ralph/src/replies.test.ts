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
  matchPreparationAnswer,
  parseContinueRequest,
  preparationHash,
  preparationQuestion,
} from "./replies.js";
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
