import { isValidElement, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AnalyticsView } from "./analytics-view";

const session = vi.hoisted(() => ({
  requirePageUser: vi.fn(),
  getOrganizationScope: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => session);

const { default: AnalyticsPage, metadata } = await import("./page");

const ORG = { id: "11111111-1111-4111-8111-111111111111", name: "NETbuilder" };

beforeEach(() => {
  session.requirePageUser.mockReset().mockResolvedValue({ organization: ORG, role: "member" });
  session.getOrganizationScope.mockReset();
});

async function view() {
  const page = (await AnalyticsPage()) as ReactElement<{
    children: ReactElement<{ scope: string }>;
  }>;
  expect(isValidElement(page)).toBe(true);
  const child = page.props.children;
  expect(child.type).toBe(AnalyticsView);
  return child.props;
}

describe("the Analytics page", () => {
  it("is titled Analytics · Omniralph", () => {
    expect(metadata.title).toBe("Analytics · Omniralph");
  });

  it("requires a member and renders the view for the active organization", async () => {
    session.getOrganizationScope.mockResolvedValue({
      kind: "single",
      organization: { ...ORG, role: "member" },
    });
    expect(await view()).toEqual({ scope: ORG.id });
    expect(session.requirePageUser).toHaveBeenCalledWith();
  });

  it("covers all of the user's organizations under All organizations", async () => {
    session.getOrganizationScope.mockResolvedValue({ kind: "all", organizations: [] });
    expect(await view()).toEqual({ scope: "all" });
  });
});
