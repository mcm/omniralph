import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AskChatsPage } from "@/components/ask/ask-chats-page";
import AskPage from "./page";

describe("the Ask page", () => {
  it("renders the chats list page", () => {
    const page = AskPage() as ReactElement;
    expect(isValidElement(page)).toBe(true);
    expect(page.type).toBe(AskChatsPage);
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/@iamthemcmaster\/ui/);
  });
});
