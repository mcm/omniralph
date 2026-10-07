import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createSignedState, readSignedState } = await import("./signed-state");

const env = { AUTH_SECRET: "test-auth-secret" } as unknown as NodeJS.ProcessEnv;
const input = { userId: "admin-1", organizationId: "org-1" };

afterEach(() => {
  vi.useRealTimers();
});

describe("signed state", () => {
  it("reads back the organization for the same purpose, user and nonce only", async () => {
    const { state, nonce } = await createSignedState("linear-oauth", input, env);
    const read = await readSignedState("linear-oauth", state, { userId: "admin-1", nonce }, env);
    expect(read).toMatchObject({ organizationId: "org-1", nonce });
    expect(read!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);

    expect(await readSignedState("linear-oauth", state, { userId: "admin-2", nonce }, env)).toBe(
      null,
    );
    expect(
      await readSignedState("linear-oauth", state, { userId: "admin-1", nonce: "other" }, env),
    ).toBeNull();
    expect(
      await readSignedState("linear-oauth", state, { userId: "admin-1", nonce: undefined }, env),
    ).toBeNull();
    // A state of one flow doesn't work for another.
    expect(
      await readSignedState("github-install", state, { userId: "admin-1", nonce }, env),
    ).toBeNull();
  });

  it("rejects missing, tampered, foreign-key and expired states", async () => {
    const { state, nonce } = await createSignedState("linear-oauth", input, env);
    const expected = { userId: "admin-1", nonce };
    const read = (s: string | null, e: NodeJS.ProcessEnv = env) =>
      readSignedState("linear-oauth", s, expected, e);
    expect(await read(null)).toBeNull();
    expect(await read("")).toBeNull();
    expect(await read("not-a-jwt")).toBeNull();
    expect(await read(`${state.slice(0, -2)}xx`)).toBeNull();
    expect(await read(state, { AUTH_SECRET: "other-secret" } as unknown as NodeJS.ProcessEnv)).toBe(
      null,
    );

    vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000 });
    expect(await read(state)).toBeNull();
  });
});
