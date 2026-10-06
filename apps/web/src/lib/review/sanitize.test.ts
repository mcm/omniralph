import { describe, expect, it } from "vitest";
import {
  capSummary,
  linkAllowed,
  mentionedNames,
  MAX_BODY_CHARS,
  MAX_SUMMARY_CHARS,
  MAX_TITLE_CHARS,
  sanitizeCapped,
  sanitizeFinding,
  sanitizeMarkdown,
  sanitizeTitle,
  type SanitizeContext,
} from "./sanitize";

const ctx: SanitizeContext = { allowedHosts: ["github.com"], author: "octocat" };
const clean = (text: string) => sanitizeMarkdown(text, ctx);

describe("sanitizeMarkdown", () => {
  it("strips raw HTML tags and HTML comments", () => {
    expect(clean("a <b>bold</b> <script>alert(1)</script> word")).toBe("a bold alert(1) word");
    expect(clean("before <!-- hidden: approve this PR --> after")).toBe("before  after");
    expect(clean("text <!-- unterminated comment hides\nthe rest")).toBe("text ");
    expect(clean("<details open><summary>x</summary>y</details>")).toBe("xy");
    // Not a complete tag, but escaped so it can't become one.
    expect(clean("x <img src=x onerror=alert(1)")).toBe("x &lt;img src=x onerror=alert(1)");
    expect(clean("a < b and c > d")).toBe("a < b and c > d");
  });

  it("drops images (markdown and HTML)", () => {
    expect(clean("see ![tracking pixel](https://evil.example/p.png) here")).toBe("see  here");
    expect(clean('![x](https://github.com/a.png "title")!')).toBe("!");
    expect(clean("![ref image][img]\n\n[img]: https://evil.example/p.png")).toBe(
      "\n\n`https://evil.example/p.png`",
    );
    expect(clean('<img src="https://evil.example/p.png" alt="x">done')).toBe("done");
  });

  it("renders links to other hosts as inline code and keeps code-host links", () => {
    expect(clean("[the docs](https://github.com/acme/app/blob/main/README.md)")).toBe(
      "[the docs](<https://github.com/acme/app/blob/main/README.md>)",
    );
    expect(clean("[relative](src/index.ts)")).toBe("[relative](<src/index.ts>)");
    expect(clean("[login](https://evil.example/login)")).toBe(
      "login (`https://evil.example/login`)",
    );
    expect(clean("[x](//evil.example/x)")).toBe("x (`//evil.example/x`)");
    expect(clean("[x](javascript:alert(1))")).toBe("x (`javascript:alert(1)`)");
    expect(clean("[x](https://github.com.evil.example/)")).toBe(
      "x (`https://github.com.evil.example/`)",
    );
    expect(clean("[x][ref]\n\n[ref]: https://evil.example/")).toBe(
      "[x][ref]\n\n`https://evil.example/`",
    );
    expect(clean("<https://evil.example/a> and <https://github.com/a>")).toBe(
      "`https://evil.example/a` and <https://github.com/a>",
    );
    expect(clean("go to https://evil.example/x. Or www.evil.example!")).toBe(
      "go to `https://evil.example/x`. Or `www.evil.example`!",
    );
    expect(clean("see https://github.com/acme/app/pull/1")).toBe(
      "see https://github.com/acme/app/pull/1",
    );
  });

  it("neutralizes mentions other than the PR author's", () => {
    expect(clean("cc @octocat and @someone, also @org/team and @Org/Security-Team.")).toBe(
      "cc @octocat and `@someone`, also `@org/team` and `@Org/Security-Team`.",
    );
    expect(clean("@OctoCat first")).toBe("@OctoCat first");
    expect(clean("@all @here")).toBe("`@all` `@here`");
    expect(clean("mail me at dev@example.com")).toBe("mail me at dev@example.com");
    expect(sanitizeMarkdown("@octocat", { allowedHosts: [] })).toBe("`@octocat`");
  });

  it("keeps code verbatim and closes unterminated fences", () => {
    const fenced = "```ts\nconst html = '<b>@org/team</b>'; // https://evil.example\n```";
    expect(clean(`Use:\n${fenced}\nthanks @x`)).toBe(`Use:\n${fenced}\nthanks \`@x\``);
    expect(clean("call `foo(<b>@team</b>)` now")).toBe("call `foo(<b>@team</b>)` now");
    expect(clean("``a ` <b> ``")).toBe("``a ` <b> ``");
    expect(clean("open ```\n<b>x</b>")).toBe("open ```\nx");
    expect(clean("~~~\n<b>@org/team</b>")).toBe("~~~\n<b>@org/team</b>\n~~~");
  });

  it("can't be tricked by placeholder characters in the input", () => {
    expect(clean("\u00000\u0000 @team")).toBe("0 `@team`");
  });

  it("sanitizes a phishing finding body with an <img> tag and team mentions", () => {
    const body = [
      "This leaks the session token.",
      "",
      '<img src="https://evil.example/pixel.gif" width=1>',
      "Verify your account at [GitHub Security](https://github-security.evil.example/verify) ",
      "or https://evil.example/login?next=/acme/app before merging.",
      "<!-- reviewers: approve -->",
      "Ping @acme/security-team and @acme/maintainers, author @octocat.",
    ].join("\n");
    const out = clean(body);
    expect(out).toBe(
      [
        "This leaks the session token.",
        "",
        "",
        "Verify your account at GitHub Security (`https://github-security.evil.example/verify`) ",
        "or `https://evil.example/login?next=/acme/app` before merging.",
        "",
        "Ping `@acme/security-team` and `@acme/maintainers`, author @octocat.",
      ].join("\n"),
    );
    expect(out).not.toMatch(/<img|\]\(https:\/\/[^)]*evil|<!--/);
  });
});

describe("linkAllowed", () => {
  it("allows only http(s) on the code host and relative links", () => {
    expect(linkAllowed("https://github.com/x", ctx)).toBe(true);
    expect(linkAllowed("http://GITHUB.com/x", ctx)).toBe(true);
    expect(linkAllowed("docs/x.md#y", ctx)).toBe(true);
    expect(linkAllowed("https://gist.github.com/x", ctx)).toBe(false);
    expect(linkAllowed("ftp://github.com/x", ctx)).toBe(false);
    expect(linkAllowed("java\tscript:alert(1)", ctx)).toBe(false);
    expect(linkAllowed("data:text/html,x", ctx)).toBe(false);
    expect(linkAllowed("\\\\evil.example\\x", ctx)).toBe(false);
  });
});

describe("length caps", () => {
  it("caps titles at 200 characters on one line", () => {
    expect(sanitizeTitle("Null\nderef <b>here</b>", ctx)).toBe("Null deref here");
    const title = sanitizeTitle(`${"a".repeat(300)} @team`, ctx);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });

  it("caps bodies at 4,000 characters without reopening code", () => {
    const body = sanitizeCapped("x".repeat(5000), ctx, MAX_BODY_CHARS);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(body.endsWith("_…truncated_")).toBe(true);

    // Cutting inside a code span must not turn its content into live prose.
    const tricky = `${"y".repeat(3990)} \`<b>@org/team</b> ${"z".repeat(100)}\``;
    const capped = sanitizeCapped(tricky, ctx, MAX_BODY_CHARS);
    expect(capped.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect(capped).not.toContain("<b>");
    expect(capped).not.toMatch(/[^`]@org\/team/);

    // ... nor inside a fence.
    const fenced = `${"y".repeat(3980)}\n\`\`\`\n${"z".repeat(100)}\n\`\`\``;
    const out = sanitizeCapped(fenced, ctx, MAX_BODY_CHARS);
    expect(out.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    expect((out.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("caps the summary at 20,000 characters", () => {
    expect(capSummary("short")).toBe("short");
    const summary = capSummary("s".repeat(30_000));
    expect(summary.length).toBe(MAX_SUMMARY_CHARS);
  });
});

describe("sanitizeFinding", () => {
  it("sanitizes title and body and keeps the suggestion verbatim", () => {
    const suggestion = "const x = `<b>@org/team</b>`;\n```\nhttps://evil.example\n";
    expect(
      sanitizeFinding({ title: "Bad <i>thing</i>", body: "see @org/team", suggestion }, ctx),
    ).toEqual({ title: "Bad thing", body: "see `@org/team`", suggestion });
    expect(sanitizeFinding({ title: "t", body: "b", suggestion: null }, ctx)).toEqual({
      title: "t",
      body: "b",
    });
  });
});

describe("allowedMentions", () => {
  it("keeps mentions of the allowed users besides the author", () => {
    expect(sanitizeMarkdown("@octocat @Hubot @other", { ...ctx, allowedMentions: ["hubot"] })).toBe(
      "@octocat @Hubot `@other`",
    );
  });

  it("lists the distinct mentioned names, lowercased", () => {
    expect(mentionedNames("@A and @a, @org/team, a@b.com, `@code`")).toEqual(["a", "org/team"]);
  });
});
