import { describe, expect, it } from "vitest";
import { parseGitLabConnectForm } from "./gitlab-input";

describe("parseGitLabConnectForm", () => {
  it("normalizes the URL and trims the token", () => {
    expect(
      parseGitLabConnectForm({ baseUrl: "https://gitlab.example.com/api/v4/", token: " glpat-x " }),
    ).toEqual({ ok: true, input: { baseUrl: "https://gitlab.example.com", token: "glpat-x" } });
  });

  it("defaults to gitlab.com and keeps a path prefix", () => {
    const parsed = parseGitLabConnectForm({ baseUrl: "", token: "t" });
    expect(parsed).toMatchObject({ ok: true, input: { baseUrl: "https://gitlab.com" } });
    const prefixed = parseGitLabConnectForm({ baseUrl: "https://example.com/gitlab", token: "t" });
    expect(prefixed).toMatchObject({ ok: true, input: { baseUrl: "https://example.com/gitlab" } });
  });

  it("rejects bad input", () => {
    const base = { baseUrl: "https://gitlab.com", token: "t" };
    expect(parseGitLabConnectForm({ ...base, baseUrl: "http://gitlab.example.com" })).toMatchObject(
      { ok: false },
    );
    expect(parseGitLabConnectForm({ ...base, baseUrl: "http://localhost:8080" })).toMatchObject({
      ok: true,
    });
    expect(parseGitLabConnectForm({ ...base, baseUrl: "not a url" })).toMatchObject({ ok: false });
    expect(parseGitLabConnectForm({ ...base, token: "  " })).toMatchObject({ ok: false });
  });
});
