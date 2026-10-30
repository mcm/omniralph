import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AskNewChatPage } from "@/components/ask/ask-pages";
import AskNewChatRoute from "./page";

type Page = ReactElement<{ repositoryId: string | null }>;

describe("the New chat page", () => {
  it("renders New chat, preselecting ?repository=", async () => {
    const page = (await AskNewChatRoute({
      searchParams: Promise.resolve({ repository: "repo-1" }),
    })) as Page;
    expect(isValidElement(page)).toBe(true);
    expect(page.type).toBe(AskNewChatPage);
    expect(page.props.repositoryId).toBe("repo-1");
  });

  it("takes the first of a repeated ?repository=, and none without one", async () => {
    const repeated = (await AskNewChatRoute({
      searchParams: Promise.resolve({ repository: ["repo-2", "repo-3"] }),
    })) as Page;
    expect(repeated.props.repositoryId).toBe("repo-2");
    for (const repository of [undefined, ""]) {
      const page = (await AskNewChatRoute({
        searchParams: Promise.resolve({ repository }),
      })) as Page;
      expect(page.props.repositoryId).toBeNull();
    }
  });
});
