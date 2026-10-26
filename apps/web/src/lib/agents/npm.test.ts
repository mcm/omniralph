import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { agentVersionTooOld } = await import("./min-version");
const { AGENT_REGISTRY_URL, latestAgentVersion, NpmRegistryError } = await import("./npm");

/** A registry that answers `body` with `status` and records what was asked. */
function registry(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(body, { status }),
  );
}

describe("latestAgentVersion", () => {
  it("reads @omniralph/agent's latest", async () => {
    const fetchFn = registry(200, { "dist-tags": { latest: "2.0.0" } });
    expect(await latestAgentVersion(fetchFn as typeof fetch)).toBe("2.0.0");
    expect(AGENT_REGISTRY_URL).toBe("https://registry.npmjs.org/@omniralph%2fagent");
    expect(fetchFn.mock.calls[0]![0]).toBe(AGENT_REGISTRY_URL);
  });

  it("counts a latest below 2.0.0 (the deprecated 0.x releases) as a failed read", async () => {
    for (const latest of ["0.8.0", "1.9.9"]) {
      const read = latestAgentVersion(registry(200, { "dist-tags": { latest } }) as typeof fetch);
      await expect(read).rejects.toBeInstanceOf(NpmRegistryError);
      await expect(read).rejects.toThrow(/^No @omniralph\/agent 2\.0\.0 or later on npm yet$/);
    }
  });

  it("reports a package npm doesn't know", async () => {
    const read = latestAgentVersion(registry(404, { error: "Not found" }) as typeof fetch);
    await expect(read).rejects.toBeInstanceOf(NpmRegistryError);
    await expect(read).rejects.toThrow("doesn't know @omniralph/agent (404)");
  });
});

describe("agentVersionTooOld", () => {
  it("rejects versions below 2.0.0 only", () => {
    expect(agentVersionTooOld("1.9.9")).toBe(
      "Agents run @omniralph/agent 2.0.0 or later: enter 2.0.0 or a later version.",
    );
    expect(agentVersionTooOld("0.8.0")).not.toBeNull();
    expect(agentVersionTooOld("2.0.0")).toBeNull();
    expect(agentVersionTooOld("2.0.0-beta.1")).toBeNull();
    expect(agentVersionTooOld("10.0.0")).toBeNull();
  });
});
