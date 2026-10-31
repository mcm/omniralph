// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunDetail, RunLane } from "@/lib/api/runs";
import { RunFactBadges, RunLanes } from "./run-details";
import { epicRunDetail } from "./test-fixtures";

function run(details: Partial<RunDetail["details"]> = {}): RunDetail {
  const base = epicRunDetail();
  return {
    ...base,
    details: {
      ...base.details,
      repository: { id: "repo-1", provider: "gitlab", fullPath: "acme/portal" },
      branch: "omniralph/tool-42",
      agent: { id: "agent-1", name: "build-01" },
      tokens: { in: 45_200_000, out: 225_000 },
      attemptCount: 7,
      ...details,
    },
  };
}

function lane(id: string, fullPath: string, pr: number | null): RunLane {
  return {
    id,
    repository: { id: `repo-${id}`, provider: "github", fullPath },
    branch: `omniralph/${id}`,
    baseBranch: "main",
    pullRequest:
      pr === null
        ? null
        : {
            provider: "github",
            number: pr,
            url: `https://github.com/${fullPath}/pull/${pr}`,
            merged: false,
            closed: false,
            draft: false,
            reviewState: "none",
          },
  };
}

/** An element's text, with its badges' spacing collapsed. */
const text = (element: Element) => element.textContent!.replace(/\s+/g, " ").trim();

/** The badges' texts, in order. */
function badges(details: Partial<RunDetail["details"]> = {}) {
  const { container } = render(
    <div>
      <RunFactBadges run={run(details)} />
    </div>,
  );
  return [...container.querySelectorAll(".or-ref")].map(text);
}

describe("RunFactBadges", () => {
  it("shows the branch, agent, tokens in and out as two badges, and the attempts", () => {
    expect(badges()).toEqual([
      "omniralph/tool-42",
      "build-01",
      "45.2M in",
      "225k out",
      "7 attempts",
    ]);
    // The agent links to its Fleet page.
    expect(screen.getByRole("link", { name: /build-01/ }).getAttribute("href")).toBe(
      "/fleet/agent-1",
    );
  });

  it("leaves out what the run doesn't have, and the attempts before the first", () => {
    expect(badges({ branch: null, agent: null, attemptCount: 0 })).toEqual([
      "45.2M in",
      "225k out",
    ]);
    // No token badges before any were spent; one side spent still shows both.
    expect(badges({ tokens: { in: 0, out: 0 } })).toEqual([
      "omniralph/tool-42",
      "build-01",
      "7 attempts",
    ]);
    expect(badges({ tokens: { in: 1_200, out: 0 } })).toContain("0 out");
  });

  it("shows the run's list price after its tokens, with what it means, only when priced", () => {
    expect(badges({ costUsd: 312.4 })).toEqual([
      "omniralph/tool-42",
      "build-01",
      "45.2M in",
      "225k out",
      "$312.40",
      "7 attempts",
    ]);
    expect(screen.getByTitle(/API list prices/).textContent).toContain("$312.40");
    expect(badges({ costUsd: 0.004 })).toContain("<$0.01");
    expect(badges({ costUsd: null }).some((badge) => badge.includes("$"))).toBe(false);
  });

  it("leaves a multi-repo epic's branches to its lanes", () => {
    expect(badges({ lanes: [lane("a", "acme/api", 7), lane("b", "acme/web", null)] })).toEqual([
      "build-01",
      "45.2M in",
      "225k out",
      "7 attempts",
    ]);
  });
});

describe("RunLanes", () => {
  it("lists each lane's repo, branch and pull request on a multi-repo epic", () => {
    render(
      <RunLanes run={run({ lanes: [lane("a", "acme/api", 7), lane("b", "acme/web", null)] })} />,
    );
    const lanes = within(screen.getByRole("list", { name: "Repos" })).getAllByRole("listitem");
    const texts = (item: Element) =>
      [...item.querySelectorAll(".or-ref__text")].map((badge) => badge.textContent);
    expect(lanes.map(texts)).toEqual([
      ["acme/api", "omniralph/a", "#7"],
      ["acme/web", "omniralph/b"],
    ]);
    expect(within(lanes[0]!).getByRole("link").getAttribute("href")).toBe(
      "https://github.com/acme/api/pull/7",
    );
  });

  it("shows nothing for a run in one repo", () => {
    const { container } = render(<RunLanes run={run({ lanes: [lane("a", "acme/api", 7)] })} />);
    expect(container.innerHTML).toBe("");
  });
});
