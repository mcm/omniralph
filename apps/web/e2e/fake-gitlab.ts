// What the fake GitLab instance the e2e runner starts (../scripts/e2e/fake-gitlab.ts) knows:
// its bot token and the projects the bot maintains. Specs connect it with Connect GitLab at
// `E2E_FAKE_GITLAB_URL` (the URL the panel reaches it on).

export const FAKE_GITLAB_TOKEN = "glpat-e2e-fake-gitlab-bot";

/** The bot token's user. */
export const FAKE_GITLAB_USER = { id: 4242, username: "e2e-bot", name: "E2E bot" };

/** Projects the bot maintains, as GitLab lists them. */
export const FAKE_GITLAB_PROJECTS = [
  { id: 9101, path_with_namespace: "e2e-group/picked-project", visibility: "private" },
  { id: 9102, path_with_namespace: "e2e-group/other-project", visibility: "public" },
] as const;
