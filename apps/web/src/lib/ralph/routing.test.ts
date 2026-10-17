import { describe, expect, it } from "vitest";
import { matchSelection, routeStory, type RoutableRepository } from "./routing";

const repo = (fullPath: string, routing: Partial<RoutableRepository> = {}): RoutableRepository => ({
  fullPath,
  effective: { coding: true },
  linearTeamKeys: [],
  linearProjectNames: [],
  linearLabels: [],
  ...routing,
});

describe("matchSelection", () => {
  const api = repo("platform/api");
  const web = repo("group/platform/web");

  it("matches the option value, name, id, or number", () => {
    // The option text (the full path), ignoring case.
    expect(matchSelection("Platform/API", [api, web])).toBe(api);
    expect(matchSelection("group/platform/web", [api, web])).toBe(web);
    // A repository name: the last segment, or the path with a trailing slash or `.git`.
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

  it("matches a repository's URL, preferring the longest path it contains", () => {
    const nested = repo("group/platform/api");
    const v2 = repo("platform/api-v2");
    const all = [api, nested, v2, web];
    expect(matchSelection("https://github.com/group/platform/api", all)).toBe(nested);
    expect(matchSelection("https://gitlab.example.com/platform/api/", all)).toBe(api);
    expect(matchSelection("https://github.com/platform/api-v2.git", all)).toBe(v2);
    expect(matchSelection("https://github.com/group/platform/web", all)).toBe(web);
    expect(matchSelection("https://github.com/xplatform/api", [api])).toBeUndefined();
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

  it("follows its own label, project or team, in that order", () => {
    expect(routed({ labels: ["Frontend"], projectName: "Docs" })).toBe("platform/web by label");
    expect(routed({ projectName: "Web", teamKey: "BE" })).toBe("platform/web by project");
    expect(routed({ teamKey: "FE" })).toBe("platform/web by team");
  });

  it("ignores [repo=…] tags in its description", () => {
    const story = { description: "[repo=platform/web]" } as Parameters<typeof routeStory>[1];
    expect(routed(story)).toBe("epic");
  });

  it("is unroutable when its own project matches no repository here", () => {
    expect(routed({ projectName: "Docs" })).toBe(
      "unroutable: it's in project Docs, which no repository here is set up for",
    );
    // Teams and labels span repositories, so an unknown one isn't a reason to give the story away.
    expect(routed({ teamKey: "OPS", labels: ["infra"] })).toBe("epic");
  });

  it("ignores repositories without ralph enabled", () => {
    expect(
      routed({ projectName: "Web" }, [repos[0]!, { ...repos[1]!, effective: { coding: false } }]),
    ).toBe("unroutable: it's in project Web, which no repository here is set up for");
  });
});
