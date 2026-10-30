import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { RunsView } from "@/screens/runs/runs-view";
import RunPage from "./page";

describe("the run page", () => {
  it("renders the Runs view with the run open, inside a Suspense boundary", async () => {
    const page = (await RunPage({ params: Promise.resolve({ id: "run-1" }) })) as ReactElement<{
      children: ReactElement<{ runId: string }>;
    }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(RunsView);
    expect(page.props.children.props.runId).toBe("run-1");
  });
});
