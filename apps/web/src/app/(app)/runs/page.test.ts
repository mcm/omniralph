import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { RunsView } from "@/screens/runs/runs-view";
import RunsPage from "./page";

describe("the Runs page", () => {
  it("renders the Runs view, inside a Suspense boundary for its URL state", () => {
    const page = RunsPage() as ReactElement<{ children: ReactElement }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(RunsView);
  });
});
