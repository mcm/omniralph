import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The ID parsing needs no session; `item.ts` imports the module for its types and scope checks.
vi.mock("@/lib/auth/session", () => ({}));

const { parseWorkItemId } = await import("./item");

describe("parseWorkItemId", () => {
  it("reads a work item URL ID's tracker and its ID there", () => {
    expect(parseWorkItemId("linear-a1b2_c3-d4")).toEqual({
      tracker: "linear",
      externalId: "a1b2_c3-d4",
    });
  });

  it("isn't one for a tracker there's no adapter for, or a malformed ID", () => {
    expect(parseWorkItemId("jira-ABC-1")).toBeNull();
    expect(parseWorkItemId("linear-")).toBeNull();
    expect(parseWorkItemId("linear-a/b")).toBeNull();
    expect(parseWorkItemId("a1b2")).toBeNull();
  });
});
