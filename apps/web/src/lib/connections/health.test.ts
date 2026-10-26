import { describe, expect, it } from "vitest";
import type { ConnectionHealthRow } from "@/lib/api/repositories";
import { formatDate } from "@/lib/format-date";
import { connectionHealth, problemText } from "./health";

const NOW = new Date("2026-10-26T12:00:00.000Z");

function gitlab(problems: ConnectionHealthRow["problems"], tokenExpiresAt: string | null) {
  return {
    provider: "gitlab" as const,
    health: { checkedAt: "2026-10-26T04:45:00.000Z", tokenExpiresAt, problems },
  };
}

describe("connectionHealth", () => {
  it("says a GitHub connection is connected: GitHub isn't checked", () => {
    expect(connectionHealth({ provider: "github", health: null }, NOW)).toEqual({
      state: "connected",
      problems: [],
    });
  });

  it("says a GitLab connection before its first check isn't checked yet", () => {
    expect(connectionHealth({ provider: "gitlab", health: null }, NOW)).toEqual({
      state: "not_checked",
      problems: [],
    });
  });

  it("is healthy with no problems and a token far from expiring", () => {
    expect(connectionHealth(gitlab([], "2027-06-01"), NOW)).toEqual({
      state: "healthy",
      expiresAt: "2027-06-01",
      problems: [],
    });
    expect(connectionHealth(gitlab([], null), NOW)).toEqual({ state: "healthy", problems: [] });
  });

  it("is expiring with a GitLab token expiring in 5 days", () => {
    expect(connectionHealth(gitlab([], "2026-10-31"), NOW)).toEqual({
      state: "expiring",
      expiresAt: "2026-10-31",
      problems: [],
    });
  });

  it("is expiring, not needing attention, when the check reports the token expiring", () => {
    const summary = connectionHealth(
      gitlab(
        [{ code: "token_expiring", message: "The bot token expires on 2026-10-28." }],
        "2026-10-28",
      ),
      NOW,
    );
    expect(summary.state).toBe("expiring");
    expect(summary.problems).toEqual([
      {
        code: "token_expiring",
        sentence: `The bot token expires on ${formatDate("2026-10-28")}. Omniralph rotates it daily; if it isn't rotated in time, reconnect GitLab with a new token.`,
      },
    ]);
  });

  it("needs attention with a bot-token problem, explaining it", () => {
    const summary = connectionHealth(
      gitlab(
        [{ code: "access_token_bot", message: "group or project access token" }],
        "2027-06-01",
      ),
      NOW,
    );
    expect(summary.state).toBe("needs_attention");
    expect(summary.expiresAt).toBe("2027-06-01");
    expect(summary.problems).toHaveLength(1);
    expect(summary.problems[0]!.code).toBe("access_token_bot");
    expect(summary.problems[0]!.sentence).toContain("clones and pushes will fail");
    expect(summary.problems[0]!.sentence).toContain(
      "Reconnect GitLab with a service account's personal access token",
    );
    expect(summary.problems[0]).not.toHaveProperty("repositoryId");
  });

  it("needs attention with a repo-specific webhook problem, keeping the repo", () => {
    const summary = connectionHealth(
      gitlab(
        [
          {
            code: "webhook_missing",
            message: "acme/api has no Omniralph webhook.",
            repositoryId: "repo-1",
          },
        ],
        "2027-06-01",
      ),
      NOW,
    );
    expect(summary).toEqual({
      state: "needs_attention",
      expiresAt: "2027-06-01",
      problems: [
        {
          code: "webhook_missing",
          sentence: "acme/api has no Omniralph webhook.",
          repositoryId: "repo-1",
        },
      ],
    });
  });

  it("needs attention when an expiring token comes with another problem", () => {
    expect(
      connectionHealth(
        gitlab(
          [
            { code: "token_expiring", message: "Expires soon." },
            { code: "rotation_failed", message: "Rotating the bot token failed: boom" },
          ],
          "2026-10-28",
        ),
        NOW,
      ).state,
    ).toBe("needs_attention");
  });
});

describe("problemText", () => {
  const health = (tokenExpiresAt: string | null): ConnectionHealthRow => ({
    checkedAt: "2026-10-07T04:45:00.000Z",
    tokenExpiresAt,
    problems: [],
  });
  const EXPIRY = formatDate("2026-10-09");

  it("uses a problem's message as it is", () => {
    for (const problem of [
      { code: "token_invalid", message: "GitLab rejects the bot token." },
      { code: "missing_api_scope", message: "The bot token needs the api scope." },
      { code: "rotation_failed", message: "Rotating the bot token failed: boom" },
    ]) {
      expect(problemText(problem, health("2026-10-09"))).toBe(problem.message);
    }
  });

  it("explains that an access token bot's clones fail and to reconnect with a service account", () => {
    const text = problemText(
      { code: "access_token_bot", message: "group or project access token" },
      health("2026-10-09"),
    );
    expect(text).toContain("clones and pushes will fail");
    expect(text).toContain("Reconnect GitLab with a service account's personal access token");
  });

  it("states when the token expires for token_expiring and rotation_unsupported", () => {
    expect(
      problemText(
        {
          code: "rotation_unsupported",
          message: "This GitLab instance can't rotate the bot token.",
        },
        health("2026-10-09"),
      ),
    ).toBe(`This GitLab instance can't rotate the bot token. The bot token expires on ${EXPIRY}.`);
    expect(
      problemText(
        { code: "token_expiring", message: "The bot token expires on 2026-10-09." },
        health("2026-10-09"),
      ),
    ).toContain(`The bot token expires on ${EXPIRY}.`);
    expect(
      problemText({ code: "rotation_unsupported", message: "Can't rotate." }, health(null)),
    ).toContain("GitLab doesn't report when the bot token expires");
  });
});
