import { describe, expect, it } from "vitest";
import { agentUpdateStatus } from "./update";

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

describe("agentUpdateStatus", () => {
  it("is up to date on the desired version, or when none is chosen", () => {
    expect(agentUpdateStatus({ ...base, version: "1.1.0" })).toBe("up_to_date");
    expect(agentUpdateStatus({ ...base, desiredVersion: null })).toBe("up_to_date");
  });

  it("is updating while the agent will update, drains, installs or confirms", () => {
    expect(agentUpdateStatus(base)).toBe("updating");
    expect(agentUpdateStatus({ ...base, update: update("draining") })).toBe("updating");
    expect(agentUpdateStatus({ ...base, update: update("installing") })).toBe("updating");
    expect(agentUpdateStatus({ ...base, version: "1.1.0", update: update("confirming") })).toBe(
      "updating",
    );
  });

  it("is failed when the desired version failed on the agent", () => {
    expect(agentUpdateStatus({ ...base, failedVersions: ["1.1.0"] })).toBe("failed");
  });

  it("says to update manually when the agent can't update itself", () => {
    expect(agentUpdateStatus({ ...base, selfUpdate: "unsupported" })).toBe("manual");
    expect(agentUpdateStatus({ ...base, selfUpdate: null })).toBe("manual");
    expect(agentUpdateStatus({ ...base, selfUpdate: null, version: "1.1.0" })).toBe("up_to_date");
  });
});
