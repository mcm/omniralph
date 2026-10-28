// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunDetail, RunLane } from "@/lib/api/runs";
import { RunDetails } from "./run-details";
import { epicRunDetail } from "./test-fixtures";

function run(details: Partial<RunDetail["details"]> = {}): RunDetail {
  const base = epicRunDetail();
  return {
    ...base,
    details: {
      ...base.details,
      repository: { id: "repo-1", provider: "gitlab", fullPath: "acme/portal" },
      branch: "omniralph/tool-42",
      routedBy: "team `SOC` and label `product:portal`",
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

/** Each row's term and its value's text. */
const rows = (section: HTMLElement) =>
  [...section.querySelectorAll(".or-run-details__row")].map((row) => [
    text(row.querySelector("dt")!),
    text(row.querySelector("dd")!),
  ]);

describe("RunDetails", () => {
  it("lists the run's repo, branch, route, agent, tokens and attempts, collapsed", () => {
    const { container } = render(<RunDetails run={run()} />);
    const section = container.querySelector("details")!;
    expect(section.open).toBe(false);
    expect(section.querySelector("summary")!.textContent).toBe("Details");
    expect(rows(section)).toEqual([
      ["Repo", "GitLab acme/portal"],
      ["Branch", "omniralph/tool-42"],
      ["Routed by", "SOC and product:portal"],
      ["Agent", "build-01"],
      ["Tokens", "45.2M in · 225k out"],
      ["Attempts", "7"],
    ]);
    // The route's team and label are badges; the agent links to its Fleet page.
    const routed = section.querySelectorAll(".or-run-details__row")[2]!;
    expect(routed.querySelectorAll(".or-ref")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /build-01/ }).getAttribute("href")).toBe(
      "/fleet/agent-1",
    );
  });

  it("leaves out what the run doesn't have", () => {
    const { container } = render(
      <RunDetails
        run={run({ repository: null, branch: null, routedBy: null, agent: null, attemptCount: 0 })}
      />,
    );
    expect(rows(container.querySelector("details")!)).toEqual([
      ["Tokens", "45.2M in · 225k out"],
      ["Attempts", "0"],
    ]);
  });

  it("shows the run's list price after its tokens, with what it means", () => {
    const { container } = render(<RunDetails run={run({ costUsd: 312.4 })} />);
    const section = container.querySelector("details")!;
    expect(rows(section).map(([term]) => term)).toEqual([
      "Repo",
      "Branch",
      "Routed by",
      "Agent",
      "Tokens",
      "Cost",
      "Attempts",
    ]);
    expect(rows(section)[5]).toEqual(["Cost", "$312.40"]);
    const figure = within(section).getByText("$312.40");
    expect(figure.classList.contains("or-mono")).toBe(true);
    expect(figure.getAttribute("title")).toBe(
      "What these tokens would cost at Anthropic's API list prices, not what was billed.",
    );
  });

  it("shows a list price under a cent as <$0.01, and no Cost row without one", () => {
    const { container, rerender } = render(<RunDetails run={run({ costUsd: 0.004 })} />);
    expect(rows(container.querySelector("details")!)).toContainEqual(["Cost", "<$0.01"]);
    rerender(<RunDetails run={run({ costUsd: null })} />);
    expect(rows(container.querySelector("details")!).map(([term]) => term)).not.toContain("Cost");
    expect(container.textContent).not.toContain("$");
    expect(container.textContent).not.toContain("n/a");
  });

  it("lists each lane's repo, branch and pull request on a multi-repo epic", () => {
    const { container } = render(
      <RunDetails run={run({ lanes: [lane("a", "acme/api", 7), lane("b", "acme/web", null)] })} />,
    );
    const section = container.querySelector("details")!;
    expect(rows(section).map(([term]) => term)).toEqual([
      "Repos",
      "Routed by",
      "Agent",
      "Tokens",
      "Attempts",
    ]);
    const lanes = within(within(section).getByRole("list", { name: "Repos" })).getAllByRole(
      "listitem",
    );
    expect(lanes.map(text)).toEqual([
      "GitHub acme/api omniralph/a #7",
      "GitHub acme/web omniralph/b",
    ]);
    expect(within(lanes[0]!).getByRole("link").getAttribute("href")).toBe(
      "https://github.com/acme/api/pull/7",
    );
  });
});
