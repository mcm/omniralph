import { describe, expect, it } from "vitest";
import {
  matchSelection,
  parseRepoTags,
  routeIssue,
  routeStory,
  type RoutableIssue,
  type RoutableRepository,
} from "./routing";

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

describe("matchSelection", () => {
  const api = repo("platform/api");
  const web = repo("group/platform/web");

  it("matches the option value, name, id, or number", () => {
    // The option text (the full path), ignoring case.
    expect(matchSelection("Platform/API", [api, web])).toBe(api);
    expect(matchSelection("group/platform/web", [api, web])).toBe(web);
    // Tag-style: the last segment, or the path with a trailing slash or `.git`.
    expect(matchSelection("web", [api, web])).toBe(web);
    expect(matchSelection("platform/api.git", [api, web])).toBe(api);
    // A 1-based option number.
    expect(matchSelection("2", [api, web])).toBe(web);
    expect(matchSelection(" 1 ", [api, web])).toBe(api);
    // A reply that contains a repository's path.
    expect(matchSelection("the platform/api one please", [api, web])).toBe(api);
    expect(matchSelection("mobile", [api, web])).toBeUndefined();
    expect(matchSelection("3", [api, web])).toBeUndefined();
    expect(matchSelection("0", [api, web])).toBeUndefined();
  });

  it("prefers a number over a repository named like one", () => {
    const numbered = repo("acme/2");
    expect(matchSelection("2", [numbered, api])).toBe(api);
    expect(matchSelection("acme/2", [numbered, api])).toBe(numbered);
  });
});

describe("routeStory (a story of an epic)", () => {
  const repos = [
    repo("platform/api", { linearProjectNames: ["API"], linearTeamKeys: ["BE"] }),
    repo("platform/web", {
      linearProjectNames: ["Web"],
      linearLabels: ["frontend"],
      linearTeamKeys: ["FE"],
    }),
  ];
  const epic = { projectName: "API", teamKey: "BE" };
  const routed = (story: Parameters<typeof routeStory>[1], repositories = repos) => {
    const r = routeStory(repositories, story, epic);
    return r.type === "selected"
      ? `${r.repository.fullPath} by ${r.rule}`
      : r.type === "unroutable"
        ? `unroutable: ${r.reason}`
        : "epic";
  };

  it("stays with the epic without signals of its own", () => {
    expect(routed({})).toBe("epic");
    expect(routed({ projectName: "API", teamKey: "BE", labels: ["bug"] })).toBe("epic");
    expect(routed({ projectName: "api" })).toBe("epic");
  });

  it("follows its own tag, label, project or team, in that order", () => {
    expect(routed({ description: "[repo=platform/web]", projectName: "API" })).toBe(
      "platform/web by tag",
    );
    expect(routed({ labels: ["Frontend"], projectName: "Docs" })).toBe("platform/web by label");
    expect(routed({ projectName: "Web", teamKey: "BE" })).toBe("platform/web by project");
    expect(routed({ teamKey: "FE" })).toBe("platform/web by team");
    // A label or tag can route a story back to the epic's own repository.
    expect(routed({ description: "[repo=platform/api]", projectName: "Web" })).toBe(
      "platform/api by tag",
    );
  });

  it("is unroutable when its own tag or project matches no repository here", () => {
    expect(routed({ projectName: "Docs" })).toBe(
      "unroutable: it's in project Docs, which no repository here is set up for",
    );
    expect(routed({ description: "\\[repo=acme/mobile\\]" })).toBe(
      "unroutable: its `[repo=acme/mobile]` tag names no repository here",
    );
    // Teams and labels span repositories, so an unknown one isn't a reason to give the story away.
    expect(routed({ teamKey: "OPS", labels: ["infra"] })).toBe("epic");
  });

  it("ignores repositories without ralph enabled", () => {
    expect(routed({ projectName: "Web" }, [repos[0]!, { ...repos[1]!, ralphEnabled: false }])).toBe(
      "unroutable: it's in project Web, which no repository here is set up for",
    );
  });
});
