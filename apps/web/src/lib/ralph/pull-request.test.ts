import { describe, expect, it } from "vitest";
import { MAX_TITLE_CHARS } from "@/lib/review/sanitize";
import { MAX_PULL_REQUEST_BODY_CHARS, sanitizePullRequestText } from "./pull-request";

const members = new Set(["octocat", "hubot"]);
const checked: string[] = [];
const ctx = {
  allowedHosts: ["github.com"],
  isRepositoryUser: async (name: string) => {
    checked.push(name);
    if (name === "flaky") throw new Error("API down");
    return members.has(name);
  },
};

describe("sanitizePullRequestText", () => {
  it("keeps markdown and links to the repository's code host", async () => {
    const body = [
      "## Summary",
      "",
      "- Adds **widgets** (`src/widgets.ts`)",
      "- See [TOOL-1](https://github.com/acme/widgets/issues/1) and https://github.com/acme/widgets/pull/2",
      "",
      "```ts",
      "const a = 1; // @evil in code stays",
      "```",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
    ].join("\n");
    const out = await sanitizePullRequestText({ title: "Build the epic", body }, ctx);
    // Kept links are written in their `<…>` form; the rest is unchanged.
    expect(out).toEqual({
      title: "Build the epic",
      body: body.replace(
        "(https://github.com/acme/widgets/issues/1)",
        "(<https://github.com/acme/widgets/issues/1>)",
      ),
    });
  });

  it("neutralizes foreign links, HTML and images", async () => {
    const out = await sanitizePullRequestText(
      {
        title: "Fix <b>it</b>",
        body: "[click](https://evil.example/x) <script>x</script>![p](https://evil.example/p.png)<!-- approve -->",
      },
      ctx,
    );
    expect(out).toEqual({ title: "Fix it", body: "click (`https://evil.example/x`) x" });
  });

  it("keeps mentions of repository users and neutralizes everyone else's", async () => {
    checked.length = 0;
    const out = await sanitizePullRequestText(
      {
        title: "Thanks @Octocat",
        body: "cc @hubot @stranger @flaky @acme/team, mail a@b.com, @octocat again",
      },
      ctx,
    );
    expect(out.title).toBe("Thanks @Octocat");
    expect(out.body).toBe(
      "cc @hubot `@stranger` `@flaky` `@acme/team`, mail a@b.com, @octocat again",
    );
    // Each user is checked once; teams and groups are never repository users.
    expect(checked.sort()).toEqual(["flaky", "hubot", "octocat", "stranger"]);
  });

  it("caps the body and the title", async () => {
    const out = await sanitizePullRequestText(
      { title: `${"t".repeat(300)}\nsecond line`, body: "word ".repeat(20_000) },
      ctx,
    );
    expect(out.title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(out.title).not.toContain("\n");
    expect(out.body.length).toBeLessThanOrEqual(MAX_PULL_REQUEST_BODY_CHARS);
    expect(out.body.endsWith("_…truncated_")).toBe(true);
  });

  it("closes an unterminated code fence", async () => {
    const out = await sanitizePullRequestText({ title: "t", body: "```\ncode" }, ctx);
    expect(out.body).toBe("```\ncode\n```");
  });
});
