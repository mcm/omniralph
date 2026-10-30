import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { BacklogView } from "@/screens/backlog/backlog-view";
import BacklogItemPage from "./page";

describe("the work item page", () => {
  it("renders the Backlog view with the work item open, inside a Suspense boundary", async () => {
    const page = (await BacklogItemPage({
      params: Promise.resolve({ id: "linear-issue-1" }),
    })) as ReactElement<{ children: ReactElement<{ workItemId: string }> }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(BacklogView);
    expect(page.props.children.props.workItemId).toBe("linear-issue-1");
  });
});
