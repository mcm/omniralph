import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import { formatDate } from "@/lib/format-date";
import { ConnectionHealth, type ConnectionHealthRow as Health } from "./connection-health";

const EXPIRY = formatDate("2026-10-09");

function health(
  problems: Health["problems"],
  tokenExpiresAt: string | null = "2026-10-09",
): Health {
  return { checkedAt: "2026-10-07T04:45:00.000Z", tokenExpiresAt, problems };
}

function render(value: Health | null, isAdmin = true): string {
  const Wrapper = queryWrapper(createTestQueryClient());
  return renderToStaticMarkup(
    <Wrapper>
      <ConnectionHealth health={value} isAdmin={isAdmin} />
    </Wrapper>,
  );
}

/** The text of the `<li>` of a problem code. */
function problemItem(html: string, code: string): string {
  const match = new RegExp(`<li[^>]*data-problem="${code}"[^>]*>(.*?)</li>`).exec(html);
  expect(match, `no ${code} problem in ${html}`).not.toBeNull();
  return match![1]!.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'");
}

describe("ConnectionHealth", () => {
  it("shows the token expiry and the last check, without a warning when all is well", () => {
    const html = render(health([]));
    expect(html).toContain(
      `Token expires <time dateTime="2026-10-09" class="mono-time text-numeric">${EXPIRY}</time>`,
    );
    expect(html).toContain("Last checked");
    expect(html).toContain("2026");
    expect(html).not.toContain("problem");
  });

  it("says when a connection hasn't been checked yet or GitLab doesn't report the expiry", () => {
    expect(render(null)).toContain("Not checked yet");
    expect(render(health([], null))).toContain("Token expiry unknown");
  });

  it("lists each problem's message", () => {
    const html = render(
      health([
        { code: "token_invalid", message: "GitLab rejects the bot token." },
        { code: "missing_api_scope", message: "The bot token needs the api scope." },
        { code: "rotation_failed", message: "Rotating the bot token failed: boom" },
      ]),
    );
    expect(html).toContain("3 problems with this connection");
    expect(problemItem(html, "token_invalid")).toBe("GitLab rejects the bot token.");
    expect(problemItem(html, "missing_api_scope")).toBe("The bot token needs the api scope.");
    expect(problemItem(html, "rotation_failed")).toBe("Rotating the bot token failed: boom");
  });

  it("explains that an access token bot's clones fail and to reconnect with a service account", () => {
    const text = problemItem(
      render(health([{ code: "access_token_bot", message: "group or project access token" }])),
      "access_token_bot",
    );
    expect(text).toContain("clones and pushes will fail");
    expect(text).toContain("Reconnect GitLab with a service account's personal access token");
  });

  it("states when the token expires for token_expiring and rotation_unsupported", () => {
    const html = render(
      health([
        {
          code: "rotation_unsupported",
          message: "This GitLab instance can't rotate the bot token.",
        },
        { code: "token_expiring", message: "The bot token expires on 2026-10-09." },
      ]),
    );
    expect(problemItem(html, "rotation_unsupported")).toBe(
      `This GitLab instance can't rotate the bot token. The bot token expires on ${EXPIRY}.`,
    );
    expect(problemItem(html, "token_expiring")).toContain(`The bot token expires on ${EXPIRY}.`);
    expect(
      problemItem(
        render(health([{ code: "rotation_unsupported", message: "Can't rotate." }], null)),
        "rotation_unsupported",
      ),
    ).toContain("GitLab doesn't report when the bot token expires");
  });

  it("offers admins a Recreate webhook button for missing and outdated webhooks only", () => {
    const problems: Health["problems"] = [
      {
        code: "webhook_missing",
        message: "acme/api has no Omniralph webhook.",
        repositoryId: "r1",
      },
      {
        code: "webhook_events_outdated",
        message: "The webhook of acme/web lacks pipeline events.",
        repositoryId: "r2",
      },
      { code: "token_invalid", message: "GitLab rejects the bot token." },
    ];
    const html = render(health(problems));
    expect(problemItem(html, "webhook_missing")).toBe(
      "acme/api has no Omniralph webhook.Recreate webhook",
    );
    expect(problemItem(html, "webhook_events_outdated")).toBe(
      "The webhook of acme/web lacks pipeline events.Recreate webhook",
    );
    expect(problemItem(html, "token_invalid")).not.toContain("Recreate webhook");
    expect(render(health(problems), false)).not.toContain("Recreate webhook");
  });
});
