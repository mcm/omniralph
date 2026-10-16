import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ReviewRow } from "@/lib/reviews/display";
import { ReviewsView } from "./reviews-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/current-user", () => ({ useCurrentUser: () => ({ role: "admin" }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/reviews",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("./actions", () => ({ rerunReview: vi.fn() }));

const ERROR = "The harness lost its session (exit code 137) while cloning the repository.";

function review(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    repository: {
      id: "22222222-2222-4222-8222-222222222222",
      provider: "github",
      fullPath: "fixture-labs/legacy-dashboard",
    },
    prNumber: 335,
    prTitle: "Move analytics queries to the db package",
    prUrl: "https://github.com/fixture-labs/legacy-dashboard/pull/335",
    trigger: "webhook",
    status: "completed",
    profileName: "Deep",
    agent: { id: "33333333-3333-4333-8333-333333333333", name: "build-01" },
    findingCounts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
    tokensUsed: 1000,
    budget: 2000,
    durationMs: 60_000,
    error: null,
    createdAt: "2026-10-09T00:42:00.000Z",
    ...overrides,
  };
}

function render(reviews: ReviewRow[]) {
  return renderToStaticMarkup(
    <ReviewsView
      repository={null}
      reviews={reviews}
      params={{ status: null, trigger: null, page: 1 }}
      total={reviews.length}
      pageSize={25}
      year={2026}
    />,
  );
}

/** The `<tr>` elements of the table body. */
function bodyRows(html: string): string[] {
  const body = html.slice(html.indexOf("<tbody"), html.indexOf("</tbody>"));
  return body.split(/(?=<tr)/).filter((part) => part.startsWith("<tr"));
}

describe("ReviewsView", () => {
  it("puts a failed review's reason in its own full-width row, not the status cell", () => {
    const rows = bodyRows(render([review({ status: "failed", error: ERROR })]));
    expect(rows).toHaveLength(2);
    const [row, errorRow] = rows;
    expect(row).toContain("data-has-error");
    expect(row).not.toContain(ERROR);
    expect(errorRow).toContain("list-error-row");
    expect(errorRow).toContain('colSpan="7"');
    expect(errorRow).toContain(`>${ERROR}</span>`);
    expect(errorRow).not.toContain("title=");
  });

  it("adds no error row for a review that didn't fail", () => {
    const rows = bodyRows(render([review({ error: ERROR }), review({ status: "failed" })]));
    expect(rows).toHaveLength(2);
    expect(rows.join("")).not.toContain("list-error-row");
    expect(rows.join("")).not.toContain("data-has-error");
  });

  it("renders the repository path through MonoValue, keeping its tail whole", () => {
    const [row] = bodyRows(render([review()]));
    expect(row).toContain(
      '<span class="mono-value text-numeric" title="fixture-labs/legacy-dashboard"><span class="mono-value-head">fixture-labs</span><span class="mono-value-tail">/legacy-dashboard</span></span>',
    );
  });

  it("shows severity words when they fit the column, else initials", () => {
    const [fits, tooLong] = bodyRows(
      render([
        review({ findingCounts: { critical: 1, high: 1, medium: 0, low: 0, info: 0 } }),
        review({ findingCounts: { critical: 0, high: 0, medium: 1, low: 1, info: 1 } }),
      ]),
    );
    expect(fits).toContain('class="severity-counts"');
    expect(tooLong).toContain('class="severity-counts severity-counts-short"');
    expect(tooLong).toContain('<span class="sr-only">medium</span>');
  });

  it("drops the current year from Created", () => {
    const [row] = bodyRows(render([review()]));
    expect(row).not.toMatch(/<time[^>]*>[^<]*2026/);
  });
});
