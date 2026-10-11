import { describe, expect, it } from "vitest";
import { harnessUpdateStatus } from "./update";

const base = {
  version: "1.0.0",
  desiredVersion: "1.1.0" as string | null,
  selfUpdate: "supported" as const,
  update: null,
  failedVersions: [] as string[],
};
const update = (state: "idle" | "draining" | "installing" | "confirming") => ({
  state,
  version: "1.1.0",
  previous: "1.0.0",
  startsSincePending: 0,
  error: null,
});

describe("harnessUpdateStatus", () => {
  it("is up to date on the desired version, or when none is chosen", () => {
    expect(harnessUpdateStatus({ ...base, version: "1.1.0" })).toBe("up_to_date");
    expect(harnessUpdateStatus({ ...base, desiredVersion: null })).toBe("up_to_date");
  });

  it("is updating while the harness will update, drains, installs or confirms", () => {
    expect(harnessUpdateStatus(base)).toBe("updating");
    expect(harnessUpdateStatus({ ...base, update: update("draining") })).toBe("updating");
    expect(harnessUpdateStatus({ ...base, update: update("installing") })).toBe("updating");
    expect(harnessUpdateStatus({ ...base, version: "1.1.0", update: update("confirming") })).toBe(
      "updating",
    );
  });

  it("is failed when the desired version failed on the harness", () => {
    expect(harnessUpdateStatus({ ...base, failedVersions: ["1.1.0"] })).toBe("failed");
  });

  it("is updating once an admin asked for an update, even of a failed version", () => {
    const requested = { ...base, updateRequested: true };
    expect(harnessUpdateStatus({ ...requested, failedVersions: ["1.1.0"] })).toBe("updating");
    expect(harnessUpdateStatus({ ...requested, desiredVersion: null })).toBe("updating");
    expect(harnessUpdateStatus({ ...requested, selfUpdate: "unsupported" })).toBe("manual");
  });

  it("says to update manually when the harness can't update itself", () => {
    expect(harnessUpdateStatus({ ...base, selfUpdate: "unsupported" })).toBe("manual");
    expect(harnessUpdateStatus({ ...base, selfUpdate: null })).toBe("manual");
    expect(harnessUpdateStatus({ ...base, selfUpdate: null, version: "1.1.0" })).toBe("up_to_date");
  });
});
