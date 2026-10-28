import { readFileSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { AskChatPage } from "@/components/ask/ask-pages";
import AskChatRoute from "./page";

describe("the chat page", () => {
  it("renders the chat", async () => {
    const page = (await AskChatRoute({
      params: Promise.resolve({ chatId: "chat-1" }),
    })) as ReactElement<{ chatId: string }>;
    expect(isValidElement(page)).toBe(true);
    expect(page.type).toBe(AskChatPage);
    expect(page.props.chatId).toBe("chat-1");
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/@iamthemcmaster\/ui/);
  });
});
