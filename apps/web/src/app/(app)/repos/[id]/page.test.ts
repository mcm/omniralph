import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { ReposView } from "@/screens/repos/repos-view";
import RepoPage from "./page";

describe("the repo page", () => {
  it("renders the Repos view with the repo open, inside a Suspense boundary", async () => {
    const page = (await RepoPage({ params: Promise.resolve({ id: "repo-1" }) })) as ReactElement<{
      children: ReactElement<{ repositoryId: string }>;
    }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.props.children.type).toBe(ReposView);
    expect(page.props.children.props.repositoryId).toBe("repo-1");
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/@iamthemcmaster\/ui/);
  });
});
