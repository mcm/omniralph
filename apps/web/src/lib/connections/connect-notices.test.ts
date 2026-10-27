import { describe, expect, it } from "vitest";
import {
  CONNECT_NOTICE_TEXT,
  CONNECT_NOTICES,
  connectedPath,
  connectNotice,
  connectNoticePath,
  connectNoticeToast,
  OAUTH_PROVIDERS,
} from "./connect-notices";

describe("connect notices", () => {
  it("has a title and description for every provider and code", () => {
    for (const provider of OAUTH_PROVIDERS) {
      for (const notice of CONNECT_NOTICES) {
        const { title, description } = CONNECT_NOTICE_TEXT[provider][notice];
        expect(title.length, `${provider} ${notice}`).toBeGreaterThan(0);
        expect(description, `${provider} ${notice}`).toMatch(/\.$/);
        expect(`${title} ${description}`).not.toMatch(/harness|\bralph\b/i);
      }
    }
  });

  it("parses only known codes", () => {
    expect(connectNotice("connected")).toBe("connected");
    expect(connectNotice("other_organization")).toBe("other_organization");
    expect(connectNotice("bogus")).toBeNull();
    expect(connectNotice("toString")).toBeNull();
    expect(connectNotice(null)).toBeNull();
  });

  it("is a success toast only when connected", () => {
    expect(connectNoticeToast("slack", "connected")).toEqual({
      message: "Slack connected. Mention the Omniralph app in a channel to start a conversation.",
      variant: "success",
    });
    for (const notice of CONNECT_NOTICES.filter((code) => code !== "connected")) {
      expect(connectNoticeToast("discord", notice).variant).toBe("danger");
    }
  });

  it("lands on the new connection when connected, else on Add connection", () => {
    expect(connectedPath("linear", "abc")).toBe(
      "/settings/connections/linear/abc?linear=connected",
    );
    expect(connectNoticePath("discord", "denied")).toBe("/settings/connections/new?discord=denied");
  });
});
