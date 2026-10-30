import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ReposView } from "@/screens/repos/repos-view";
import ReposPage from "./page";

// The view imports the "Show advanced settings" server action, which is server-only.
vi.mock("@/lib/theme-actions", () => ({ saveShowAdvancedPreference: vi.fn() }));

describe("the Repos page", () => {
  it("renders the Repos view without a repo, inside a Suspense boundary for its URL state", () => {
    const page = ReposPage() as ReactElement<{ children: ReactElement<{ repositoryId?: string }> }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(ReposView);
    expect(page.props.children.props.repositoryId).toBeUndefined();
  });
});
