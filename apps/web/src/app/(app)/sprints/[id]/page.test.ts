import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { SprintsView } from "@/screens/sprints/sprints-view";
import SprintPage from "./page";

describe("the sprint page", () => {
  it("renders the Sprints view with the sprint open, inside a Suspense boundary", async () => {
    const page = (await SprintPage({
      params: Promise.resolve({ id: "sprint-1" }),
    })) as ReactElement<{
      children: ReactElement<{ sprintId: string }>;
    }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(SprintsView);
    expect(page.props.children.props.sprintId).toBe("sprint-1");
  });
});
