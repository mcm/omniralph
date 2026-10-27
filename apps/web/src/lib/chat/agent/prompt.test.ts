import { describe, expect, it } from "vitest";
import { systemPrompt, type SystemPromptInput } from "./prompt";

const base: SystemPromptInput = {
  organizationName: "Acme",
  platform: "web",
  userName: "Ada Lovelace",
  actor: { kind: "member", userId: "ada", role: "member", name: "Ada Lovelace" },
  appUrl: "https://omniralph.example.com",
  now: new Date("2026-10-27T12:00:00Z"),
};

describe("systemPrompt", () => {
  it("names the web app, the chat's repo and branch, and defaults code questions to it", () => {
    const prompt = systemPrompt({
      ...base,
      webChat: { repository: "acme/customer-portal", branch: "main" },
    });
    expect(prompt).toContain("You are Om, Omniralph's AI, in Omniralph");
    expect(prompt).toContain(
      "started this chat in the Omniralph web app, about the repository acme/customer-portal (branch main)",
    );
    expect(prompt).toContain("ask_about_code defaults to acme/customer-portal");
  });

  it("names all of the organization's repos for a chat without one", () => {
    const prompt = systemPrompt({ ...base, webChat: { repository: null, branch: null } });
    expect(prompt).toContain("about all of the organization's repositories");
    expect(prompt).not.toContain("ask_about_code defaults to");
  });

  it("says nothing about a web chat on Slack or Discord", () => {
    for (const platform of ["slack", "discord"] as const) {
      const prompt = systemPrompt({ ...base, platform });
      expect(prompt).not.toContain("Omniralph web app");
    }
    expect(systemPrompt({ ...base, platform: "slack" })).toContain("in Slack");
  });

  it("drafts a request when an answer needs a code change, on every platform", () => {
    for (const platform of ["web", "slack", "discord"] as const) {
      const prompt = systemPrompt({ ...base, platform });
      expect(prompt).toContain(
        "When the answer to a question is a code change (a fix, a missing feature, a refactor the code needs), draft the request with draft_request",
      );
      expect(prompt).toContain(
        "Use start_work instead when a member explicitly asks you to make a change, and draft_linear_issue when they ask to file an issue.",
      );
      expect(prompt).toContain("I drafted the request from this conversation:");
    }
  });
});
