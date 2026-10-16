import { GitLabSetupClient } from "@omniralph/scm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FAKE_GITLAB_PROJECTS, FAKE_GITLAB_TOKEN, FAKE_GITLAB_USER } from "../../e2e/fake-gitlab";
import { startFakeGitLab, type FakeGitLab } from "./fake-gitlab";

describe("the e2e runner's fake GitLab", () => {
  let gitlab: FakeGitLab;
  beforeAll(async () => {
    gitlab = await startFakeGitLab();
  });
  afterAll(() => gitlab.close());

  it("answers Connect GitLab and the project picker like GitLab does", async () => {
    const client = new GitLabSetupClient({ baseUrl: gitlab.url, token: FAKE_GITLAB_TOKEN });
    expect(await client.validateToken()).toMatchObject({
      userId: FAKE_GITLAB_USER.id,
      username: FAKE_GITLAB_USER.username,
    });
    const projects = await client.listProjects();
    expect(projects.map((project) => project.fullPath).sort()).toEqual(
      FAKE_GITLAB_PROJECTS.map((project) => project.path_with_namespace).sort(),
    );
    const hookId = await client.createProjectHook(projects[0]!.id, {
      url: "https://omniralph.example.com/api/webhooks/gitlab",
      secret: "s",
    });
    expect(hookId).toEqual(expect.any(Number));
    await client.deleteProjectHook(projects[0]!.id, hookId);
    expect(gitlab.requests).toContain(`POST /api/v4/projects/${projects[0]!.id}/hooks`);
  });

  it("refuses another token", async () => {
    const client = new GitLabSetupClient({ baseUrl: gitlab.url, token: "glpat-wrong" });
    await expect(client.validateToken()).rejects.toThrow();
  });
});
