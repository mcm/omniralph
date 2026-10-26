import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { ReposView } from "@/screens/repos/repos-view";
import ReposPage from "./page";

describe("the Repos page", () => {
  it("renders the Repos view without a repo, inside a Suspense boundary for its URL state", () => {
    const page = ReposPage() as ReactElement<{ children: ReactElement<{ repositoryId?: string }> }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(ReposView);
    expect(page.props.children.props.repositoryId).toBeUndefined();
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/@iamthemcmaster\/ui/);
  });
});
