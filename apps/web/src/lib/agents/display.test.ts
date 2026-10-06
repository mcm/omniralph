import { describe, expect, it } from "vitest";
import { auditDetailSummary, enrollCommand, isAgentOnline, jobTarget } from "./display";

describe("isAgentOnline", () => {
  const now = new Date("2026-10-05T12:00:00Z");
  it("is online while the last heartbeat is under 60s old", () => {
    expect(isAgentOnline(new Date("2026-10-05T11:59:01Z"), now)).toBe(true);
    expect(isAgentOnline(new Date("2026-10-05T11:59:00Z"), now)).toBe(false);
    expect(isAgentOnline(null, now)).toBe(false);
  });
});

describe("enrollCommand", () => {
  it("builds the command and quotes only when needed", () => {
    expect(enrollCommand("https://omniralph.example.com", "ore_abc-DEF_1")).toBe(
      "omniralph-agent enroll --server https://omniralph.example.com --token ore_abc-DEF_1",
    );
    expect(enrollCommand("https://x.example/it's here", "t")).toBe(
      `omniralph-agent enroll --server 'https://x.example/it'\\''s here' --token t`,
    );
  });
});

describe("jobTarget", () => {
  const github = {
    id: "r",
    provider: "github" as const,
    fullPath: "acme/web",
    baseUrl: "https://api.github.com",
  };
  it("links review jobs to their PR/MR and other jobs to the repository", () => {
    expect(jobTarget({ payload: { prNumber: 12 }, repository: github })).toEqual({
      label: "acme/web#12",
      url: "https://github.com/acme/web/pull/12",
    });
    expect(
      jobTarget({
        payload: { prNumber: 3 },
        repository: { ...github, provider: "gitlab", baseUrl: "https://gitlab.example.com" },
      }),
    ).toEqual({
      label: "acme/web!3",
      url: "https://gitlab.example.com/acme/web/-/merge_requests/3",
    });
    expect(jobTarget({ payload: {}, repository: github })).toEqual({
      label: "acme/web",
      url: "https://github.com/acme/web",
    });
    expect(jobTarget({ payload: { prNumber: 1 }, repository: null })).toBeNull();
  });
});

describe("auditDetailSummary", () => {
  it("says whether an issued credential was read-only or write", () => {
    expect(
      auditDetailSummary("credential_issued", { repository: "acme/api", jobId: "abcdef12-0" }),
    ).toBe("Read-only token for acme/api, job abcdef12");
    expect(
      auditDetailSummary("credential_issued", {
        repository: "acme/api",
        jobId: "abcdef12-0",
        access: "write",
      }),
    ).toBe("Write token for acme/api, job abcdef12");
  });
});
