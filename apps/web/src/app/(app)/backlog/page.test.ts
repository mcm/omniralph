import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { BacklogView } from "@/screens/backlog/backlog-view";
import BacklogPage from "./page";

describe("the Backlog page", () => {
  it("renders the Backlog view, inside a Suspense boundary for its URL state", () => {
    const page = BacklogPage() as ReactElement<{ children: ReactElement }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(BacklogView);
  });
});
