import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RalphLaneView, RalphRunDetailView, RalphStoryView } from "@/lib/ralph/display";
import { RecommendationsCard, RunFacts, StoriesCard } from "./ralph-run-detail-view";

vi.mock("../actions", () => ({ stopRalphRun: vi.fn() }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

function lane(id: string, fullPath: string, main: boolean): RalphLaneView {
  return {
    id,
    repository: { provider: "github", fullPath } as RalphLaneView["repository"],
    main,
    branch: `omniralph/${id}`,
    baseBranch: "main",
    pullRequest: null,
    cleanup: null,
    reviewRounds: { done: 0, max: 3 },
    ciFixRounds: { done: 0, max: 3 },
  };
}

let n = 0;
function story(
  status: RalphStoryView["status"],
  laneId: string | null,
  elsewhere: string | null = null,
): RalphStoryView {
  n += 1;
  return {
    id: `story-${n}`,
    identifier: `FIX-${100 + n}`,
    title: `Story ${n}`,
    status,
    attempts: 1,
    lastFeedback: null,
    commitSha: null,
    lastJobId: null,
    laneId,
    elsewhere,
    recommendations: [],
  };
}

function run(lanes: RalphLaneView[], stories: RalphStoryView[]): RalphRunDetailView {
  return {
    id: "run-1",
    origin: "linear",
    linearIdentifier: "FIX-100",
    linearTitle: "Epic",
    linearUrl: "https://linear.app/fixture/issue/FIX-100/epic",
    chatThread: null,
    repository: lanes[0]?.repository ?? null,
    status: "running",
    branch: lanes[0]?.branch ?? null,
    baseBranch: "main",
    pullRequest: null,
    agent: null,
    error: null,
    updatedAt: "2026-10-13T10:00:00.000Z",
    createdAt: "2026-10-13T09:00:00.000Z",
    kind: "children",
    lanes,
    waitingOn: null,
    guidance: [],
    progress: "",
    iterations: 3,
    maxAttemptsPerStory: 3,
    storyCounts: {
      total: stories.length,
      completed: stories.filter((s) => s.status === "completed").length,
    },
    stories,
    jobs: [],
    pendingRequests: [],
    messages: [],
    messageLimit: 20,
  };
}

/** The rendered markup as plain text. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ");
}

describe("run detail stories-done counts", () => {
  it("states a single-lane run's count once, naming the story outside the repository", () => {
    const main = lane("lane-1", "fixture-labs/api", true);
    const r = run(
      [main],
      [
        story("completed", main.id),
        story("completed", main.id),
        story("running", main.id),
        story("pending", main.id),
        story("pending", null, "Belongs in fixture-labs/website."),
      ],
    );
    const facts = text(renderToStaticMarkup(<RunFacts run={r} isAdmin />));
    const stories = text(renderToStaticMarkup(<StoriesCard run={r} />));

    expect(facts).toContain("Stories done2 / 51 outside this repository");
    // The Stories card lists the four in the repository but doesn't count them again.
    expect(stories).not.toMatch(/\d+ of \d+/);
    expect(stories).not.toMatch(/stor(y|ies) done/);
    expect(stories).toContain("Not in a repository here");
  });

  it("doesn't mention outside stories when every story is in the repository", () => {
    const main = lane("lane-1", "fixture-labs/api", true);
    const r = run([main], [story("completed", main.id), story("pending", main.id)]);
    const facts = text(renderToStaticMarkup(<RunFacts run={r} isAdmin />));
    expect(facts).toContain("Stories done1 / 2");
    expect(facts).not.toContain("outside");
  });

  it("labels each lane's count of a multi-lane run as per repository", () => {
    const main = lane("lane-1", "fixture-labs/api", true);
    const web = lane("lane-2", "fixture-labs/web", false);
    const r = run(
      [main, web],
      [
        story("completed", main.id),
        story("pending", main.id),
        story("completed", web.id),
        story("pending", null, "Belongs in fixture-labs/website."),
      ],
    );
    const facts = text(renderToStaticMarkup(<RunFacts run={r} isAdmin />));
    const stories = text(renderToStaticMarkup(<StoriesCard run={r} />));

    expect(facts).toContain("Stories done2 / 41 outside these repositories");
    expect(stories).toContain("1 of 2 stories done in this repository");
    expect(stories).toContain("1 of 1 story done in this repository");
    expect(stories.match(/stor(y|ies) done/g)).toHaveLength(2);
  });

  it("leaves the count to the fact strip before the run has a repository", () => {
    const r = run([], [story("completed", null), story("pending", null)]);
    const stories = text(renderToStaticMarkup(<StoriesCard run={r} />));
    expect(stories).toContain("In sub-issue order.");
    expect(stories).not.toMatch(/\d+ of \d+/);
    expect(text(renderToStaticMarkup(<RunFacts run={r} isAdmin />))).not.toContain("outside");
  });
});

describe("run detail recommendations", () => {
  it("lists each story's recommendations with the story they came from", () => {
    const main = lane("lane-1", "fixture-labs/api", true);
    const advised = {
      ...story("completed", main.id),
      recommendations: [
        {
          title: "Fix the date parser upstream",
          description: "In fixture-labs/dates: accept offsets, so api can drop its shim.",
          at: "2026-10-14T10:00:00.000Z",
        },
      ],
    };
    const r = run([main], [advised, story("pending", main.id)]);
    const card = text(renderToStaticMarkup(<RecommendationsCard run={r} />));
    expect(card).toContain("Recommendations");
    expect(card).toContain("aren't filed as issues");
    expect(card).toContain("Fix the date parser upstream");
    expect(card).toContain(`From ${advised.identifier}`);
    expect(card).toContain("so api can drop its shim.");
  });

  it("renders nothing without recommendations", () => {
    const main = lane("lane-1", "fixture-labs/api", true);
    const r = run([main], [story("completed", main.id)]);
    expect(renderToStaticMarkup(<RecommendationsCard run={r} />)).toBe("");
  });
});
