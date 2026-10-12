import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readOnlyPermissions } from "@omniralph/engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installableSkillPlugin,
  installableSkillPluginName,
  SKILL_PLUGINS_DIR,
  withInstallableSkills,
} from "./installable-skills.js";

describe("installableSkillPluginName", () => {
  it("makes a package name a plugin name", () => {
    expect(installableSkillPluginName("@omniralph/code-graph")).toBe("omniralph-code-graph");
    expect(installableSkillPluginName("semgrep_rules.x")).toBe("semgrep-rules-x");
  });
});

describe("installableSkillPlugin", () => {
  let dir: string;
  let pkg: string;
  let dataDir: string;

  const write = async (file: string, content: string) => {
    const target = path.join(pkg, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "omniralph-skills-test-"));
    pkg = path.join(dir, "pkg");
    dataDir = path.join(dir, "data");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is null without skills", async () => {
    expect(await installableSkillPlugin(dataDir, "@omniralph/graph", [])).toBeNull();
  });

  it("writes a plugin with only the skills: directories and Markdown files", async () => {
    const usage = path.join(pkg, "skills/usage");
    await write("skills/usage/SKILL.md", "Use it.\n");
    await write("skills/usage/scripts/run.sh", "echo run\n");
    const single = await write("docs/query.md", "Query it.\n");
    const named = await write("extra/indexing/SKILL.md", "Index it.\n");
    await write("hooks/hooks.json", "{}");

    const plugin = await installableSkillPlugin(dataDir, "@omniralph/graph", [
      usage,
      single,
      named,
    ]);
    expect(plugin?.name).toBe("omniralph-graph");
    expect(plugin?.skills).toEqual([
      "omniralph-graph:usage",
      "omniralph-graph:query",
      "omniralph-graph:indexing",
    ]);
    const root = plugin!.path;
    expect(path.dirname(root)).toBe(path.join(dataDir, SKILL_PLUGINS_DIR));
    expect(
      JSON.parse(await readFile(path.join(root, ".claude-plugin/plugin.json"), "utf8")),
    ).toMatchObject({
      name: "omniralph-graph",
    });
    expect((await readdir(root)).sort()).toEqual([".claude-plugin", "skills"]);
    expect(await readFile(path.join(root, "skills/usage/SKILL.md"), "utf8")).toBe("Use it.\n");
    expect(await readFile(path.join(root, "skills/usage/scripts/run.sh"), "utf8")).toBe(
      "echo run\n",
    );
    expect(await readFile(path.join(root, "skills/query/SKILL.md"), "utf8")).toBe("Query it.\n");
    expect(await readFile(path.join(root, "skills/indexing/SKILL.md"), "utf8")).toBe("Index it.\n");
  });

  it("reuses the plugin for the same skills and writes a new one when they change", async () => {
    const skill = await write("skill.md", "v1\n");
    const first = await installableSkillPlugin(dataDir, "@omniralph/graph", [skill]);
    const again = await installableSkillPlugin(dataDir, "@omniralph/graph", [skill]);
    expect(again?.path).toBe(first?.path);

    await write("skill.md", "v2\n");
    const changed = await installableSkillPlugin(dataDir, "@omniralph/graph", [skill]);
    expect(changed?.path).not.toBe(first?.path);
    expect(await readFile(path.join(changed!.path, "skills/skill/SKILL.md"), "utf8")).toBe("v2\n");
    expect(await readFile(path.join(first!.path, "skills/skill/SKILL.md"), "utf8")).toBe("v1\n");
    expect((await readdir(path.join(dataDir, SKILL_PLUGINS_DIR))).length).toBe(2);
  });

  it("refuses paths that aren't skills, invalid names and duplicate names", async () => {
    const plugin = (paths: string[]) => installableSkillPlugin(dataDir, "@omniralph/graph", paths);
    await expect(plugin([path.join(pkg, "missing")])).rejects.toThrow(/does not exist/);
    await write("empty/README.md", "x");
    await expect(plugin([path.join(pkg, "empty")])).rejects.toThrow(/has no SKILL\.md/);
    await expect(plugin([await write("notes.txt", "x")])).rejects.toThrow(/not a Markdown file/);
    await expect(plugin([await write("bad name.md", "x")])).rejects.toThrow(/invalid name/);
    const a = await write("a/dup.md", "x");
    const b = await write("b/dup/SKILL.md", "x");
    await expect(plugin([a, b])).rejects.toThrow(/two skills named dup/);
  });
});

describe("withInstallableSkills", () => {
  const skills = {
    plugins: [{ type: "local" as const, path: "/data/skill-plugins/x", skipMcpDiscovery: true }],
    skills: ["x:usage"],
  };

  it("adds the plugins, the Skill tool and only those skills to a session without settings", () => {
    const permissions = readOnlyPermissions({ cwd: "/w", allowExploration: true });
    const merged = withInstallableSkills(permissions, skills);
    expect(merged.settingSources).toEqual([]);
    expect(merged.plugins).toEqual(skills.plugins);
    expect(merged.skills).toEqual(["x:usage"]);
    expect(merged.tools).toEqual([...(permissions.tools as string[]), "Skill"]);
  });

  it("keeps the CLI's skill defaults for a session that loads settings", () => {
    const merged = withInstallableSkills(
      {
        cwd: "/w",
        tools: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
      },
      skills,
    );
    expect(merged.plugins).toEqual(skills.plugins);
    expect(merged.skills).toBeUndefined();
    expect(merged.tools).toEqual({ type: "preset", preset: "claude_code" });
  });

  it("leaves sessions without tools, and runs without skills, alone", () => {
    const noTools = readOnlyPermissions({ cwd: "/w", allowExploration: false });
    expect(withInstallableSkills(noTools, skills)).toBe(noTools);
    const permissions = readOnlyPermissions({ cwd: "/w", allowExploration: true });
    expect(withInstallableSkills(permissions, null)).toBe(permissions);
  });
});
