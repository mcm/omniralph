import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { RepoCache } from "../../workspace/repoCache.js";
import { sessionGitAccess } from "./git-access.js";

describe("sessionGitAccess", () => {
  it("keeps the token file current with the job's refreshed token, then removes it", async () => {
    let token = "token-1";
    const access = await sessionGitAccess(
      {
        env: () => ({ PATH: "/usr/bin", OMNIRALPH_JOB_TOKEN: token, OMNIRALPH_JOB_ID: "job-1" }),
        jobToken: () => token,
        server: "https://omniralph.example.com",
        repos: new RepoCache({ workspaceRoot: "/nonexistent", credentialHelper: "!helper" }),
      },
      { refreshMs: 5 },
    );
    const file = access.env.OMNIRALPH_JOB_TOKEN_FILE!;
    expect(access.env.OMNIRALPH_JOB_TOKEN).toBeUndefined();
    expect(access.env.OMNIRALPH_JOB_ID).toBeUndefined();
    expect(access.env.GIT_CONFIG_VALUE_1).toBe("!helper");
    expect(await readFile(file, "utf8")).toBe("token-1");

    token = "token-2";
    await expect.poll(() => readFile(file, "utf8")).toBe("token-2");

    await access.close();
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });
});
