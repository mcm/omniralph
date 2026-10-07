import { MAX_REPLY_QUESTION_LENGTH } from "@omniralph/shared";
import { describe, expect, it } from "vitest";
import {
  botHandle,
  connectionBotHandle,
  isOwnComment,
  MAX_DISMISS_NOTE_LENGTH,
  MAX_FIX_TEXT_LENGTH,
  parseBotCommand,
  type BotCommand,
} from "./commands";

const parse = (text: string) => parseBotCommand(text, "omniralph");

describe("parseBotCommand", () => {
  it("returns null without a mention of the handle", () => {
    for (const text of [
      "LGTM",
      "omniralph review",
      "@omniralphx review",
      "@omniralph-bot review",
      "mail me at ops@omniralph review",
      "@other review",
      "",
    ]) {
      expect(parse(text), text).toBeNull();
    }
  });

  it("parses review with and without a profile override", () => {
    const cases: [string, BotCommand][] = [
      ["@omniralph review", { kind: "review", fresh: false, profileId: null }],
      ["@omniralph review quick", { kind: "review", fresh: false, profileId: "quick" }],
      ["@omniralph review standard", { kind: "review", fresh: false, profileId: "standard" }],
      ["@omniralph review deep", { kind: "review", fresh: false, profileId: "deep" }],
      ["@omniralph review.", { kind: "review", fresh: false, profileId: null }],
      ["@omniralph review deep!", { kind: "review", fresh: false, profileId: "deep" }],
      [
        "Could you take another look? @omniralph review",
        { kind: "review", fresh: false, profileId: null },
      ],
      ["@omniralph review deep\n\nThanks!", { kind: "review", fresh: false, profileId: "deep" }],
    ];
    for (const [text, command] of cases) expect(parse(text), text).toEqual(command);
  });

  it("parses review fresh with and without a profile override", () => {
    const cases: [string, BotCommand][] = [
      ["@omniralph review fresh", { kind: "review", fresh: true, profileId: null }],
      ["@omniralph review fresh quick", { kind: "review", fresh: true, profileId: "quick" }],
      ["@omniralph review fresh standard", { kind: "review", fresh: true, profileId: "standard" }],
      ["@omniralph review fresh deep", { kind: "review", fresh: true, profileId: "deep" }],
      ["@omniralph review fresh.", { kind: "review", fresh: true, profileId: null }],
      ["@omniralph review fresh deep!", { kind: "review", fresh: true, profileId: "deep" }],
      ["Rules changed. @omniralph review fresh", { kind: "review", fresh: true, profileId: null }],
      ["@omniralph review fresh\n\nThanks!", { kind: "review", fresh: true, profileId: null }],
      ["@OmniRalph REVIEW FRESH", { kind: "review", fresh: true, profileId: null }],
      ["@omniralph Review Fresh DEEP", { kind: "review", fresh: true, profileId: "deep" }],
      [
        "  @omniralph   review \t fresh   quick  ",
        { kind: "review", fresh: true, profileId: "quick" },
      ],
      ["\n@omniralph\treview\tfresh\r\n", { kind: "review", fresh: true, profileId: null }],
      ["@omniralph[bot] review fresh", { kind: "review", fresh: true, profileId: null }],
    ];
    for (const [text, command] of cases) expect(parse(text), text).toEqual(command);
    expect(parse("`@omniralph review fresh`")).toBeNull();
  });

  it("is case-insensitive and tolerates extra whitespace", () => {
    const cases: [string, BotCommand][] = [
      ["@OmniRalph REVIEW", { kind: "review", fresh: false, profileId: null }],
      ["@omniralph Review DEEP", { kind: "review", fresh: false, profileId: "deep" }],
      [
        "   @omniralph    review \t  quick   ",
        { kind: "review", fresh: false, profileId: "quick" },
      ],
      ["\n\n@omniralph\treview\r\n", { kind: "review", fresh: false, profileId: null }],
      ["@OMNIRALPH   DISMISS   ", { kind: "dismiss", reason: "false_positive", note: null }],
      ["@omniralph  HELP", { kind: "help" }],
    ];
    for (const [text, command] of cases) expect(parse(text), text).toEqual(command);
  });

  it("parses dismiss with the default reason, a named reason and a note", () => {
    const cases: [string, BotCommand][] = [
      ["@omniralph dismiss", { kind: "dismiss", reason: "false_positive", note: null }],
      [
        "@omniralph dismiss the value is validated upstream",
        { kind: "dismiss", reason: "false_positive", note: "the value is validated upstream" },
      ],
      [
        "@omniralph dismiss false positive: checked in load()",
        { kind: "dismiss", reason: "false_positive", note: "checked in load()" },
      ],
      [
        "@omniralph dismiss false_positive",
        { kind: "dismiss", reason: "false_positive", note: null },
      ],
      [
        "@omniralph dismiss won't fix - legacy code",
        { kind: "dismiss", reason: "wont_fix", note: "legacy code" },
      ],
      ["@omniralph dismiss WONTFIX", { kind: "dismiss", reason: "wont_fix", note: null }],
      ["@omniralph dismiss wont_fix", { kind: "dismiss", reason: "wont_fix", note: null }],
      [
        "@omniralph dismiss Not Relevant, generated file",
        { kind: "dismiss", reason: "not_relevant", note: "generated file" },
      ],
      ["@omniralph dismiss other", { kind: "dismiss", reason: "other", note: null }],
      [
        "@omniralph dismiss otherwise fine\nsecond line",
        { kind: "dismiss", reason: "false_positive", note: "otherwise fine\nsecond line" },
      ],
    ];
    for (const [text, command] of cases) expect(parse(text), text).toEqual(command);
  });

  it("caps the dismissal note", () => {
    const command = parse(`@omniralph dismiss ${"x".repeat(MAX_DISMISS_NOTE_LENGTH + 100)}`);
    expect(command).toMatchObject({ kind: "dismiss" });
    expect((command as { note: string }).note).toHaveLength(MAX_DISMISS_NOTE_LENGTH);
  });

  it("parses fix with and without a request, keeping code in the request", () => {
    const cases: [string, BotCommand][] = [
      ["@omniralph fix", { kind: "fix", text: null }],
      ["@omniralph fix.", { kind: "fix", text: null }],
      ["@OmniRalph FIX this please", { kind: "fix", text: "this please" }],
      ["@omniralph fix: rename it", { kind: "fix", text: "rename it" }],
      [
        "Hmm. @omniralph fix rename `foo()` to `bar()`\n\n```ts\nbar();\n```",
        { kind: "fix", text: "rename `foo()` to `bar()`\n\n```ts\nbar();\n```" },
      ],
      ["@omniralph[bot] fix the typo", { kind: "fix", text: "the typo" }],
    ];
    for (const [text, expected] of cases) expect(parse(text), text).toEqual(expected);
    // `fixes` and `fix-up` aren't the command.
    expect(parse("@omniralph fixes are welcome")).toMatchObject({ kind: "question" });
    expect(parse("@omniralph fix-up commits")).toMatchObject({ kind: "question" });
    // A quoted or code `@omniralph fix` isn't one.
    expect(parse("> @omniralph fix\nok")).toBeNull();
    expect(parse("`@omniralph fix`")).toBeNull();
  });

  it("caps the fix request", () => {
    const command = parse(`@omniralph fix ${"x".repeat(MAX_FIX_TEXT_LENGTH + 50)}`);
    expect(command).toEqual({ kind: "fix", text: "x".repeat(MAX_FIX_TEXT_LENGTH) });
  });

  it("treats a bare mention as help", () => {
    expect(parse("@omniralph")).toEqual({ kind: "help" });
    expect(parse("thanks @omniralph!")).toEqual({ kind: "question", text: "thanks @omniralph!" });
  });

  it("treats anything else as a question with the whole comment", () => {
    for (const text of [
      "@omniralph why is this a problem?",
      "Why is this a problem? @omniralph",
      "@omniralph review this function again please",
      "@omniralph review fresh please",
      "@omniralph review fresh deep now",
      "@omniralph review quick fresh",
      "@omniralph reviewing is slow",
      "@omniralph dismissal makes sense?",
    ]) {
      expect(parse(text), text).toEqual({ kind: "question", text });
    }
    expect(parse("  @omniralph is this safe?  \n")).toEqual({
      kind: "question",
      text: "@omniralph is this safe?",
    });
    const long = `@omniralph ${"why ".repeat(2000)}`;
    expect((parse(long) as { text: string }).text).toHaveLength(MAX_REPLY_QUESTION_LENGTH);
  });

  it("ignores mentions in code, quotes and HTML comments", () => {
    for (const text of [
      "Run `@omniralph review` to re-review.",
      "```\n@omniralph review\n```",
      "~~~md\n@omniralph dismiss\n~~~",
      "> @omniralph review\n\nI agree.",
      "<!-- @omniralph review -->",
    ]) {
      expect(parse(text), text).toBeNull();
    }
    expect(parse("> @omniralph review\n@omniralph review deep")).toEqual({
      kind: "review",
      fresh: false,
      profileId: "deep",
    });
  });

  it("accepts the GitHub App's [bot] login and handles with regex characters", () => {
    expect(parse("@omniralph[bot] review")).toEqual({
      kind: "review",
      fresh: false,
      profileId: null,
    });
    expect(parseBotCommand("@review.bot+1 review", "review.bot+1")).toEqual({
      kind: "review",
      fresh: false,
      profileId: null,
    });
    expect(parseBotCommand("@reviewXbot review", "review.bot")).toBeNull();
    expect(parseBotCommand("@project_12_bot_ab12 review quick", "project_12_bot_ab12")).toEqual({
      kind: "review",
      fresh: false,
      profileId: "quick",
    });
  });
});

describe("connectionBotHandle", () => {
  it("is a GitLab connection's bot username, otherwise the fallback", () => {
    const gitlab = { provider: "gitlab", botUsername: "service_account_group_12_bot" };
    expect(connectionBotHandle(gitlab, "omniralph")).toBe("service_account_group_12_bot");
    expect(connectionBotHandle({ provider: "gitlab", botUsername: null }, "reviewbot")).toBe(
      "reviewbot",
    );
    expect(connectionBotHandle({ provider: "gitlab", botUsername: " " }, "reviewbot")).toBe(
      "reviewbot",
    );
    // GitHub keeps BOT_HANDLE.
    expect(connectionBotHandle({ provider: "github", botUsername: "someone" }, "reviewbot")).toBe(
      "reviewbot",
    );
  });
});

describe("botHandle", () => {
  it("reads BOT_HANDLE without a leading @ and defaults to omniralph", () => {
    expect(botHandle({})).toBe("omniralph");
    expect(botHandle({ BOT_HANDLE: "  " })).toBe("omniralph");
    expect(botHandle({ BOT_HANDLE: "@reviewbot" })).toBe("reviewbot");
    expect(botHandle({ BOT_HANDLE: "project_1_bot_x" })).toBe("project_1_bot_x");
  });
});

describe("isOwnComment", () => {
  it("matches the bot's own account and any bot account", () => {
    expect(isOwnComment({ username: "omniralph[bot]", isBot: true }, "omniralph")).toBe(true);
    expect(isOwnComment({ username: "dependabot[bot]", isBot: true }, "omniralph")).toBe(true);
    expect(isOwnComment({ username: "OmniRalph", isBot: false }, "omniralph")).toBe(true);
    expect(isOwnComment({ username: "omniralph[bot]", isBot: false }, "omniralph")).toBe(true);
    expect(isOwnComment({ username: "octocat", isBot: false }, "omniralph")).toBe(false);
  });
});
