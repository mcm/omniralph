import type { Database } from "@omniralph/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  desired: null as string | null,
  check: null as { version: string | null; error: string | null; checkedAt: Date } | null,
  writes: 0,
  now: new Date("2026-10-09T12:00:00Z"),
}));
vi.mock("@omniralph/db", () => ({
  TRACK_LATEST_AGENT_VERSION: "latest",
  getDesiredAgentVersion: async () => state.desired,
  getLatestAgentVersionCheck: async () => state.check,
  setLatestAgentVersionCheck: async (
    _db: unknown,
    _organizationId: string,
    check: { version: string | null; error: string | null },
  ) => {
    state.writes += 1;
    state.check = { ...check, checkedAt: state.now };
  },
}));

const { LATEST_MAX_AGE_MS, organizationAgentVersion } = await import("./desired-version");
const { latestHarnessVersion, NpmRegistryError } = await import("./npm");

const db = {} as Database;
const later = (ms: number) => new Date(state.now.getTime() + ms);

describe("organizationAgentVersion", () => {
  beforeEach(() => {
    state.desired = null;
    state.check = null;
    state.writes = 0;
    state.now = new Date("2026-10-09T12:00:00Z");
  });

  it("passes an exact version (or none) through without reading npm", async () => {
    const fetchLatest = vi.fn(async () => "9.9.9");
    expect(await organizationAgentVersion(db, "org-1", { fetchLatest })).toEqual({
      version: null,
      tracksLatest: false,
      latestError: null,
      latestCheckedAt: null,
    });
    state.desired = "1.4.0";
    expect(await organizationAgentVersion(db, "org-1", { fetchLatest })).toMatchObject({
      version: "1.4.0",
      tracksLatest: false,
    });
    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("tracks latest: reads npm, then uses the stored version until it's old", async () => {
    state.desired = "latest";
    let latest = "0.4.0";
    const fetchLatest = vi.fn(async () => latest);
    const resolve = (now: Date) => organizationAgentVersion(db, "org-1", { fetchLatest, now });

    expect(await resolve(state.now)).toEqual({
      version: "0.4.0",
      tracksLatest: true,
      latestError: null,
      latestCheckedAt: state.now,
    });
    latest = "0.5.0";
    expect((await resolve(later(LATEST_MAX_AGE_MS - 1))).version).toBe("0.4.0");
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    state.now = later(LATEST_MAX_AGE_MS);
    expect((await resolve(state.now)).version).toBe("0.5.0");
    expect(fetchLatest).toHaveBeenCalledTimes(2);
    expect(state.writes).toBe(2);
  });

  it("keeps the last version when npm can't be read, and retries only once it's old", async () => {
    state.desired = "latest";
    state.check = { version: "0.4.0", error: null, checkedAt: new Date(0) };
    const fetchLatest = vi.fn(async (): Promise<string> => {
      throw new NpmRegistryError("the npm registry answered 503");
    });
    const resolve = (now: Date) => organizationAgentVersion(db, "org-1", { fetchLatest, now });

    expect(await resolve(state.now)).toMatchObject({
      version: "0.4.0",
      latestError: "the npm registry answered 503",
    });
    expect(await resolve(later(1000))).toMatchObject({
      version: "0.4.0",
      latestError: "the npm registry answered 503",
    });
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    // Never read: no version, so harnesses stay where they are.
    state.check = null;
    expect(await resolve(state.now)).toMatchObject({ version: null, tracksLatest: true });
  });

  it("ignores a latest below 2.0.0 on npm: the version stays the last one read, or none", async () => {
    state.desired = "latest";
    let latest = "0.8.0";
    const fetchLatest = () =>
      latestHarnessVersion(async () => Response.json({ "dist-tags": { latest } }));
    const resolve = (now: Date) => organizationAgentVersion(db, "org-1", { fetchLatest, now });

    expect(await resolve(state.now)).toEqual({
      version: null,
      tracksLatest: true,
      latestError: "No @omniralph/agent 2.0.0 or later on npm yet",
      latestCheckedAt: state.now,
    });
    expect(state.check).toMatchObject({ version: null });

    latest = "2.0.0";
    state.now = later(LATEST_MAX_AGE_MS);
    expect(await resolve(state.now)).toMatchObject({ version: "2.0.0", latestError: null });

    // 2.0.0 was read: a later 0.8.0 keeps it.
    latest = "0.8.0";
    state.now = later(LATEST_MAX_AGE_MS);
    expect(await resolve(state.now)).toMatchObject({
      version: "2.0.0",
      latestError: "No @omniralph/agent 2.0.0 or later on npm yet",
    });
  });

  it("doesn't swallow unexpected errors", async () => {
    state.desired = "latest";
    const fetchLatest = async (): Promise<string> => {
      throw new Error("boom");
    };
    await expect(organizationAgentVersion(db, "org-1", { fetchLatest })).rejects.toThrow("boom");
  });
});
