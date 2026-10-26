import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { RunStepView } from "@/screens/runs/run-step-view";
import RunStepPage from "./page";

describe("the run step page", () => {
  it("renders the step view of the run's step, inside a Suspense boundary", async () => {
    const page = (await RunStepPage({
      params: Promise.resolve({ id: "run-1", stepId: "story-2" }),
    })) as ReactElement<{ children: ReactElement<{ runId: string; stepId: string }> }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(RunStepView);
    expect(page.props.children.props).toEqual({ runId: "run-1", stepId: "story-2" });
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/@iamthemcmaster\/ui/);
  });
});
