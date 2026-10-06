import { describe, expect, it } from "vitest";
import { parseRepoTags, routeIssue, type RoutableIssue, type RoutableRepository } from "./routing";

const repo = (fullPath: string, routing: Partial<RoutableRepository> = {}): RoutableRepository => ({
  fullPath,
  ralphEnabled: true,
  linearTeamKeys: [],
  linearProjectNames: [],
  linearLabels: [],
  ...routing,
});

const issue = (overrides: Partial<RoutableIssue> = {}): RoutableIssue => ({
  description: "",
  labels: [],
  projectName: null,
  teamKey: null,
  ...overrides,
});

describe("parseRepoTags", () => {
  it("finds plain and Linear-escaped tags, without duplicates", () => {
    expect(
      parseRepoTags(
        "Build it in [repo=acme/api].\n\\[repo=group/sub/my\\_project\\] and [REPO=Acme/API] again",
      ),
    ).toEqual(["acme/api", "group/sub/my_project"]);
    expect(parseRepoTags(null)).toEqual([]);
    expect(parseRepoTags("repo=acme/api without brackets, [repo=] or [repo=a b]")).toEqual([]);
  });
});

describe("routeIssue", () => {
  const api = repo("acme/api", {
    linearTeamKeys: ["ENG"],
    linearProjectNames: ["Platform"],
    linearLabels: ["backend"],
  });
  const web = repo("acme/web", {
    linearTeamKeys: ["WEB"],
    linearProjectNames: ["Storefront"],
    linearLabels: ["frontend"],
  });
  const repos = [web, api];

  it("routes by a [repo=<fullPath>] tag, ignoring case and a .git suffix", () => {
    expect(routeIssue(issue({ description: "Do it.\n\n[repo=Acme/Web.git]" }), repos)).toEqual({
      repository: web,
      rule: "tag",
      value: "Acme/Web.git",
    });
    expect(routeIssue(issue({ description: "\\[repo=acme/api\\]" }), repos)).toMatchObject({
      repository: api,
      rule: "tag",
    });
  });

  it("uses the first tag that names an enabled repository", () => {
    expect(
      routeIssue(issue({ description: "[repo=acme/other] [repo=acme/api]" }), repos),
    ).toMatchObject({ repository: api, rule: "tag", value: "acme/api" });
  });

  it("routes by label", () => {
    expect(routeIssue(issue({ labels: ["Bug", "Frontend"] }), repos)).toEqual({
      repository: web,
      rule: "label",
      value: "Frontend",
    });
  });

  it("routes by project name", () => {
    expect(routeIssue(issue({ labels: ["Bug"], projectName: "platform" }), repos)).toEqual({
      repository: api,
      rule: "project",
      value: "platform",
    });
  });

  it("routes by team key", () => {
    expect(routeIssue(issue({ projectName: "Unrelated", teamKey: "web" }), repos)).toEqual({
      repository: web,
      rule: "team",
      value: "web",
    });
  });

  it("applies the rules in order: tag, label, project, team", () => {
    const everything = issue({
      description: "[repo=acme/web]",
      labels: ["backend"],
      projectName: "Platform",
      teamKey: "ENG",
    });
    expect(routeIssue(everything, repos)?.rule).toBe("tag");
    expect(routeIssue(everything, repos)?.repository).toBe(web);

    // Label beats project and team.
    expect(
      routeIssue(issue({ labels: ["frontend"], projectName: "Platform", teamKey: "ENG" }), repos),
    ).toMatchObject({ repository: web, rule: "label" });
    // Project beats team.
    expect(routeIssue(issue({ projectName: "Storefront", teamKey: "ENG" }), repos)).toMatchObject({
      repository: web,
      rule: "project",
    });
  });

  it("breaks ties by full path", () => {
    const zeta = repo("zeta/app", { linearTeamKeys: ["ENG"], linearLabels: ["shared"] });
    const alpha = repo("alpha/app", { linearTeamKeys: ["ENG"], linearLabels: ["shared"] });
    expect(routeIssue(issue({ teamKey: "ENG" }), [zeta, alpha])?.repository).toBe(alpha);
    expect(routeIssue(issue({ labels: ["shared"] }), [zeta, alpha])?.repository).toBe(alpha);
  });

  it("considers only ralph-enabled repositories", () => {
    const disabled = repo("aaa/first", { ralphEnabled: false, linearTeamKeys: ["ENG"] });
    expect(routeIssue(issue({ teamKey: "ENG" }), [disabled, api])?.repository).toBe(api);
    expect(routeIssue(issue({ description: "[repo=aaa/first]" }), [disabled, api])).toBeNull();
    expect(routeIssue(issue({ teamKey: "ENG" }), [disabled])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(routeIssue(issue({ labels: ["x"], projectName: "y", teamKey: "Z" }), repos)).toBeNull();
    expect(routeIssue(issue({ teamKey: "ENG" }), [])).toBeNull();
  });

  it("treats a tag as authoritative: unmatched tags don't fall through to other rules", () => {
    expect(
      routeIssue(issue({ description: "[repo=acme/elsewhere]", teamKey: "ENG" }), repos),
    ).toBeNull();
  });
});
