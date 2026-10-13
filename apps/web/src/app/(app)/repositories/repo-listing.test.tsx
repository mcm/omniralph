// The GitHub and GitLab selection pages render before the code host answers: the list
// streams in behind a loading state.
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RepoSelectionView, type SelectableRepoRow } from "./repo-selection-view";

const CONNECTION_ID = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  connection: null as Record<string, unknown> | null,
  getInstallation: vi.fn(),
  listInstallationRepos: vi.fn(),
  listProjects: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({ saveGitHubRepositories: vi.fn(), saveGitLabProjects: vi.fn() }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
vi.mock("@/lib/auth/resource-page", () => ({ enterResourceOrganization: async () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requirePageUser: async () => ({ id: "user", organization: { id: "org" }, role: "admin" }),
}));
vi.mock("@/lib/scm/github-app", () => ({ getGitHubAppAuth: () => ({}) }));
vi.mock("@omniralph/db", () => ({
  getScmConnection: async () => mocks.connection,
  listConnectionRepositories: async () => [
    { externalId: "1", disconnectedAt: null, effective: { review: true } },
  ],
  connectionCredentials: () => ({ token: "glpat-test" }),
}));
vi.mock("@omniralph/scm", () => ({
  getInstallation: mocks.getInstallation,
  listInstallationRepos: mocks.listInstallationRepos,
  MAX_LISTED_GITLAB_PROJECTS: 100,
  GitLabSetupClient: class {
    listProjects = mocks.listProjects;
  },
}));

const { default: GitHubInstallationPage } = await import("./github/[connectionId]/page");
const { default: GitLabConnectionPage } = await import("./gitlab/[connectionId]/page");

const params = { params: Promise.resolve({ connectionId: CONNECTION_ID }) };
const never = () => new Promise<never>(() => {});

type Props = Record<string, unknown>;

/** The page's Suspense boundary: its fallback's props, and its streamed child rendered. */
function boundary(page: ReactElement) {
  const { fallback, children } = page.props as { fallback: ReactElement; children: ReactElement };
  const streamed = children.type as (props: unknown) => Promise<ReactElement>;
  return {
    fallback: fallback.props as Props,
    resolve: async () => (await streamed(children.props)).props as Props,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GitHub installation page", () => {
  beforeEach(() => {
    mocks.connection = {
      id: CONNECTION_ID,
      provider: "github",
      externalId: "42",
      name: "acme",
      baseUrl: "https://api.github.com",
    };
  });

  it("renders a loading list without waiting for GitHub", async () => {
    mocks.getInstallation.mockImplementation(never);
    mocks.listInstallationRepos.mockImplementation(never);
    const { fallback } = boundary(await GitHubInstallationPage(params));
    expect(fallback).toMatchObject({ account: "acme", repos: null, error: null });
    expect(mocks.listInstallationRepos).not.toHaveBeenCalled();
  });

  it("streams in the installation's repositories", async () => {
    mocks.getInstallation.mockResolvedValue({ account: "acme", htmlUrl: "https://gh/acme" });
    mocks.listInstallationRepos.mockResolvedValue([
      { id: 1, fullPath: "acme/api", private: true, htmlUrl: "https://gh/acme/api" },
      { id: 2, fullPath: "acme/web", private: false, htmlUrl: "https://gh/acme/web" },
    ]);
    const props = await boundary(await GitHubInstallationPage(params)).resolve();
    expect(props).toMatchObject({ manageUrl: "https://gh/acme", error: null });
    expect((props.repos as SelectableRepoRow[]).map((repo) => repo.enabled)).toEqual([true, false]);
  });

  it("streams in a listing failure as the error", async () => {
    mocks.getInstallation.mockRejectedValue(new Error("fetch failed"));
    mocks.listInstallationRepos.mockResolvedValue([]);
    const props = await boundary(await GitHubInstallationPage(params)).resolve();
    expect(props).toMatchObject({ account: "acme", repos: [], error: "fetch failed" });
  });
});

describe("GitLab connection page", () => {
  beforeEach(() => {
    mocks.connection = {
      id: CONNECTION_ID,
      provider: "gitlab",
      externalId: null,
      name: "bot @ gitlab.example.com",
      baseUrl: "https://gitlab.example.com",
    };
  });

  it("renders a loading list without waiting for GitLab", async () => {
    mocks.listProjects.mockImplementation(never);
    const { fallback } = boundary(await GitLabConnectionPage(params));
    expect(fallback).toMatchObject({ projects: null, truncated: false, error: null });
    expect(mocks.listProjects).not.toHaveBeenCalled();
  });

  it("streams in the bot's projects", async () => {
    mocks.listProjects.mockResolvedValue([
      { id: 1, fullPath: "group/api", visibility: "private", webUrl: "https://gl/group/api" },
    ]);
    const props = await boundary(await GitLabConnectionPage(params)).resolve();
    expect(props).toMatchObject({
      projects: [{ id: 1, fullPath: "group/api", private: true, enabled: true }],
      truncated: false,
      error: null,
    });
  });
});

describe("RepoSelectionView", () => {
  const render = (repos: SelectableRepoRow[] | null) =>
    renderToStaticMarkup(
      <RepoSelectionView
        breadcrumb="GitHub · acme"
        title="acme"
        intro="Pick repositories."
        listedDescription="Listed."
        emptyIcon={null}
        emptyDescription="None."
        describeError={() => ({ title: "Failed", cause: "Cause" })}
        repos={repos}
        error={null}
        save={vi.fn()}
        savedMessage="Saved"
      />,
    );

  it("shows a busy placeholder and disables Save while the list loads", () => {
    const html = render(null);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading repositories…");
    expect(html).not.toContain("No repositories");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Save<\/button>/);
  });

  it("lists the repositories once loaded", () => {
    const html = render([
      { id: 1, fullPath: "acme/api", private: false, htmlUrl: "", enabled: true },
    ]);
    expect(html).toContain("acme/api");
    expect(html).not.toContain("aria-busy");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>.*?Save<\/button>/);
  });
});
