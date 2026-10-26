import { describe, expect, it } from "vitest";
import { inboxKeys, QUERY_AREAS, queryKeys } from "./keys";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("queryKeys", () => {
  it("starts every key with the organization id", () => {
    const keys = queryKeys(ORG);
    expect(keys.all).toEqual([ORG]);
    for (const area of QUERY_AREAS) {
      const generated = [
        keys[area].all,
        keys[area].lists,
        keys[area].list({ page: 2 }),
        keys[area].detail("x"),
        keys[area].part("x", "runs", { page: 1 }),
      ];
      for (const key of generated) expect(key[0]).toBe(ORG);
    }
  });

  it("nests lists and parts under their area's prefix, so invalidating the area reaches them", () => {
    const { agents } = queryKeys(ORG);
    const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
      prefix.every((part, i) => key[i] === part);
    expect(startsWith(agents.list({ status: "online" }), agents.lists)).toBe(true);
    expect(startsWith(agents.lists, agents.all)).toBe(true);
    expect(startsWith(agents.part("h1", "jobs"), agents.detail("h1"))).toBe(true);
    expect(startsWith(agents.detail("h1"), agents.all)).toBe(true);
    expect(startsWith(agents.detail("h1"), agents.lists)).toBe(false);
  });

  it("keeps organizations apart", () => {
    expect(queryKeys("a").jobs.list()).not.toEqual(queryKeys("b").jobs.list());
  });
});

describe("inboxKeys", () => {
  const keys = queryKeys(ORG);
  const inbox = inboxKeys(keys);
  const startsWith = (key: readonly unknown[], prefix: readonly unknown[]) =>
    prefix.every((part, i) => key[i] === part);

  it("keys each feed by tab and scope, under the Inbox's lists", () => {
    expect(inbox.feed("needs-you", "all")).toEqual([
      ORG,
      "inbox",
      "list",
      { tab: "needs-you", organization: "all" },
    ]);
    expect(inbox.feed("problems", ORG)).not.toEqual(inbox.feed("problems", "all"));
    expect(startsWith(inbox.feed("running", ORG), inbox.feeds)).toBe(true);
  });

  it("keys the counts by scope, outside the feeds but under the Inbox", () => {
    expect(inbox.counts("all")).toEqual([ORG, "inbox", "counts", { organization: "all" }]);
    expect(startsWith(inbox.counts("all"), inbox.feeds)).toBe(false);
    for (const key of [inbox.counts(ORG), inbox.feed("needs-you", ORG)]) {
      expect(startsWith(key, inbox.all)).toBe(true);
      expect(startsWith(key, keys.inbox.all)).toBe(true);
    }
  });
});
