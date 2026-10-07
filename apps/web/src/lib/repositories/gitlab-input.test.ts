import { describe, expect, it } from "vitest";
import { parseGitLabConnectForm } from "./gitlab-input";

describe("parseGitLabConnectForm", () => {
  it("normalizes the URL and splits project paths", () => {
    expect(
      parseGitLabConnectForm({
        baseUrl: "https://gitlab.example.com/api/v4/",
        token: " glpat-x ",
        projectPaths: "group/a\n https://gitlab.example.com/group/sub/b.git , group/a\n",
      }),
    ).toEqual({
      ok: true,
      input: {
        baseUrl: "https://gitlab.example.com",
        token: "glpat-x",
        projectPaths: ["group/a", "group/sub/b"],
      },
    });
  });

  it("defaults to gitlab.com and keeps a path prefix", () => {
    const parsed = parseGitLabConnectForm({ baseUrl: "", token: "t", projectPaths: "a/b" });
    expect(parsed).toMatchObject({ ok: true, input: { baseUrl: "https://gitlab.com" } });
    const prefixed = parseGitLabConnectForm({
      baseUrl: "https://example.com/gitlab",
      token: "t",
      projectPaths: "a/b",
    });
    expect(prefixed).toMatchObject({ ok: true, input: { baseUrl: "https://example.com/gitlab" } });
  });

  it("allows connecting without project paths, to pick them from a list", () => {
    expect(
      parseGitLabConnectForm({ baseUrl: "https://gitlab.com", token: "t", projectPaths: " \n" }),
    ).toMatchObject({ ok: true, input: { projectPaths: [] } });
  });

  it("rejects bad input", () => {
    const base = { baseUrl: "https://gitlab.com", token: "t", projectPaths: "a/b" };
    expect(parseGitLabConnectForm({ ...base, baseUrl: "http://gitlab.example.com" })).toMatchObject(
      { ok: false },
    );
    expect(parseGitLabConnectForm({ ...base, baseUrl: "http://localhost:8080" })).toMatchObject({
      ok: true,
    });
    expect(parseGitLabConnectForm({ ...base, baseUrl: "not a url" })).toMatchObject({ ok: false });
    expect(parseGitLabConnectForm({ ...base, token: "  " })).toMatchObject({ ok: false });
    expect(parseGitLabConnectForm({ ...base, projectPaths: "justaname" })).toMatchObject({
      ok: false,
    });
    expect(parseGitLabConnectForm({ ...base, projectPaths: "a/../b" })).toMatchObject({
      ok: false,
    });
  });
});
