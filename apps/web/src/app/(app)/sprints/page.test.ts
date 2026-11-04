import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { SprintsView } from "@/screens/sprints/sprints-view";
import SprintsPage from "./page";

describe("the Sprints page", () => {
  it("renders the Sprints view with no sprint open, inside a Suspense boundary", () => {
    const page = SprintsPage() as ReactElement<{ children: ReactElement<{ sprintId?: string }> }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(SprintsView);
    expect(page.props.children.props.sprintId).toBeUndefined();
  });
});
