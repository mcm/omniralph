import { readFileSync } from "node:fs";
import { TRACKER_IGNORE_REASONS } from "@omniralph/tracker";
import { describe, expect, it } from "vitest";
import {
  describeIgnoreReason,
  failureReason,
  isWebhookIgnoreReason,
  WEBHOOK_IGNORE_REASONS,
  type WebhookIgnoreReason,
} from "./reasons";

/** Where deliveries are ignored, and how each names its reason code. */
const SOURCES: Array<{ file: string; patterns: RegExp[] }> = [
  {
    file: "./ingest.ts",
    patterns: [
      /\bignored\("([a-z_]+)"/g,
      /\bskipped\("([a-z_]+)"/g,
      /reasonCode: "([a-z_]+)"/g,
      /reason: "([a-z_]+)"/g,
    ],
  },
  {
    file: "../tracker/linear/ingest.ts",
    patterns: [/reasonCode: "([a-z_]+)"/g, /reason: "([a-z_]+)"/g],
  },
];

function codesIn(file: string, patterns: RegExp[]): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((m) => m[1]!));
}

const codes = Object.keys(WEBHOOK_IGNORE_REASONS) as WebhookIgnoreReason[];

describe("webhook ignore reasons", () => {
  it("maps every reason code the webhook handlers use to a sentence", () => {
    for (const { file, patterns } of SOURCES) {
      const used = codesIn(file, patterns);
      expect(used.length, file).toBeGreaterThan(0);
      for (const code of used) {
        expect(isWebhookIgnoreReason(code), `${code} (${file}) has no sentence`).toBe(true);
      }
    }
    // The tracker webhook parsers' reasons.
    for (const code of TRACKER_IGNORE_REASONS) {
      expect(isWebhookIgnoreReason(code), `${code} (tracker) has no sentence`).toBe(true);
    }
    // The ones the PRD lists, plus Om's own reviews.
    for (const code of [
      "unknown_repository",
      "repository_disabled",
      "trigger_disabled",
      "draft",
      "no_review_tasks",
      "unsupported_event",
      "own_comment",
      "no_mention",
      "ci_not_failed",
      "ralph_disabled",
      "not_ralph",
      "own_review",
      "unknown_workspace",
    ]) {
      expect(isWebhookIgnoreReason(code), code).toBe(true);
    }
  });

  it("doesn't know other codes", () => {
    expect(isWebhookIgnoreReason("something_new")).toBe(false);
    expect(isWebhookIgnoreReason("constructor")).toBe(false);
    expect(isWebhookIgnoreReason("toString")).toBe(false);
  });

  it("writes plain sentences in the product's terms", () => {
    for (const code of codes) {
      for (const provider of ["github", "gitlab", "linear"] as const) {
        const sentence = describeIgnoreReason(code, provider);
        expect(sentence, code).toMatch(/^[A-Z]/);
        expect(sentence, code).not.toMatch(/\.$/);
        expect(sentence, code).not.toMatch(/harness|\bralph|_/i);
        if (provider === "gitlab") expect(sentence, code).not.toMatch(/pull request/);
        if (provider === "github") expect(sentence, code).not.toMatch(/merge request/);
      }
    }
    expect(describeIgnoreReason("not_ralph", "github")).toBe("Om didn't open this pull request");
    expect(describeIgnoreReason("not_ralph", "gitlab")).toBe("Om didn't open this merge request");
  });

  it("keeps a failure's message short", () => {
    expect(failureReason(new Error("database unavailable"))).toBe("database unavailable");
    expect(failureReason("plain")).toBe("plain");
    expect(failureReason(new Error(""))).toBe("The delivery couldn't be processed");
    expect(failureReason(new Error("x".repeat(2000)))).toHaveLength(500);
  });
});
