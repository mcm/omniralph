import { describe, expect, it, vi } from "vitest";
import type { Database } from "@omniralph/db";

vi.mock("server-only", () => ({}));

import { heartbeatClaimable } from "./claimable";

const db = {} as Database;
const harness = {
  id: "harness-1",
  organizationId: "org-1",
  acceptedTaskTypes: ["review", "coding"],
  reportedVersion: "1.2.3",
};

describe("heartbeatClaimable", () => {
  it("is omitted without claimablePools and never checks the queue", async () => {
    const check = vi.fn();
    expect(await heartbeatClaimable(db, harness, undefined, check)).toBeUndefined();
    expect(check).not.toHaveBeenCalled();
  });

  it("checks the queue for the pools with the harness's accepted task types and version", async () => {
    const check = vi.fn().mockResolvedValue(true);
    expect(await heartbeatClaimable(db, harness, ["short"], check)).toBe(true);
    expect(check).toHaveBeenCalledWith(db, {
      agentId: "harness-1",
      organizationId: "org-1",
      acceptedTaskTypes: ["review", "coding"],
      pools: ["short"],
      agentVersion: "1.2.3",
    });
    check.mockResolvedValue(false);
    expect(await heartbeatClaimable(db, harness, [], check)).toBe(false);
  });
});
