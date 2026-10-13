import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TaskTypeBadges, type RepositoryRow } from "./repositories-view";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/current-user", () => ({ useCurrentUser: () => ({ role: "admin" }) }));
vi.mock("@/components/use-action", () => ({
  useAction: () => ({ pending: false, run: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/repositories",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("./actions", () => ({
  connectGitLab: vi.fn(),
  disconnectRepository: vi.fn(),
  removeScmConnection: vi.fn(),
  recreateGitLabWebhook: vi.fn(),
}));

function render(taskTypes: RepositoryRow["taskTypes"]): string {
  return renderToStaticMarkup(<TaskTypeBadges taskTypes={taskTypes} />);
}

describe("TaskTypeBadges", () => {
  it("shows each task type's effective value and whether it's the organization's default", () => {
    const html = render({
      query: { on: true, inherited: true },
      review: { on: false, inherited: true },
      coding: { on: true, inherited: false },
    });
    expect(html).toContain('aria-label="Query: On (organization default)"');
    expect(html).toContain('aria-label="Reviews: Off (organization default)"');
    expect(html).toContain('aria-label="Coding: On (set for this repository)"');
    // Overrides say so in the badge itself.
    expect(html.replace(/<[^>]+>/g, "")).toBe("QueryReviewsCoding on");
  });

  it("shows an explicit off", () => {
    const html = render({
      query: { on: false, inherited: false },
      review: { on: true, inherited: false },
      coding: { on: false, inherited: true },
    });
    expect(html).toContain('aria-label="Query: Off (set for this repository)"');
    expect(html).toContain('aria-label="Reviews: On (set for this repository)"');
    expect(html).toContain('aria-label="Coding: Off (organization default)"');
    expect(html.replace(/<[^>]+>/g, "")).toBe("Query offReviews onCoding");
  });
});
