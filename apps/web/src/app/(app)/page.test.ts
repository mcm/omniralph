import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { InboxUpNext } from "@/screens/backlog/up-next";
import { InboxView } from "@/screens/inbox/inbox-view";
import InboxPage from "./page";

describe("the home page", () => {
  it("renders the Inbox with Up next, inside a Suspense boundary for its URL state", () => {
    const page = InboxPage() as ReactElement<{ children: ReactElement<{ upNext: ReactElement }> }>;
    expect(isValidElement(page)).toBe(true);
    const child = page.props.children;
    expect(isValidElement(child)).toBe(true);
    expect(child.type).toBe(InboxView);
    expect(isValidElement(child.props.upNext)).toBe(true);
    expect(child.props.upNext.type).toBe(InboxUpNext);
  });

  it("no longer redirects anywhere", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/\bredirect\(/);
  });
});
