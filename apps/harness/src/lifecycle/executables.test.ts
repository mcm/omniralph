import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentDefinition,
  TaskDefinition,
  type AgentDefinitionInput,
  type TaskDefinitionInput,
} from "@omniralph/tasks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RetryableJobError } from "../capabilities/index.js";
import { execPathBlocked } from "../config.js";
import { installableCacheDir, installablePrCacheDir } from "../installables.js";
import { placeInstallable } from "../test/installables.js";
import { resolveCommand } from "./commands.js";
import {
  installableMcpServerName,
  NO_EXECUTABLES,
  resolveRunExecutables,
  runPrNumber,
  sessionMcpServers,
} from "./executables.js";

const REPO_ID = "6f1c2b9e-3d4a-4e5f-8a7b-9c0d1e2f3a4b";

const GRAPH = {
  name: "@omniralph/graph",
  version: "2.1.0",
  omniralph: {
    commands: [
      { name: "graph-index", bin: "bin/index.js" },
      { name: "opengrep", bin: "bin/not-the-host-tool.js" },
    ],
    mcpServers: [{ name: "graph", command: "bin/server.js", args: ["--stdio"] }],
  },
};

function agent(overrides: Partial<AgentDefinitionInput> = {}) {
  return AgentDefinition.parse({
    id: "builtin:test-agent",
    name: "Agent",
    systemPrompt: "",
    taskTypes: ["query"],
    ...overrides,
  });
}

function task(overrides: Partial<TaskDefinitionInput> = {}) {
  return TaskDefinition.parse({
    id: "builtin:test-task",
    name: "Task",
    taskType: "query",
    agentId: "builtin:test-agent",
    triggers: ["chat.request"],
    promptTemplate: "Hi",
    sink: "chat-thread",
    pool: "short",
    ...overrides,
  });
}

describe("resolveCommand", () => {
  const commands = new Map([
    ["opengrep", "/opt/opengrep/bin/opengrep"],
    ["graph", "/data/it's here/graph.js"],
  ]);

  it("replaces a first word naming an executable with its quoted absolute path", () => {
    expect(resolveCommand("opengrep scan --json .", commands)).toBe(
      "'/opt/opengrep/bin/opengrep' scan --json .",
    );
    expect(resolveCommand("  opengrep", commands)).toBe("  '/opt/opengrep/bin/opengrep'");
    expect(resolveCommand("opengrep|wc -l", commands)).toBe("'/opt/opengrep/bin/opengrep'|wc -l");
    expect(resolveCommand("graph; echo done", commands)).toBe(
      `'/data/it'\\''s here/graph.js'; echo done`,
    );
  });

  it("leaves other commands alone", () => {
    expect(resolveCommand("opengrep2 scan", commands)).toBe("opengrep2 scan");
    expect(resolveCommand("./opengrep scan", commands)).toBe("./opengrep scan");
    expect(resolveCommand("echo opengrep", commands)).toBe("echo opengrep");
    expect(resolveCommand("opengrep scan")).toBe("opengrep scan");
  });
});

describe("resolveRunExecutables", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "omniralph-executables-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("has nothing for a run without requirements", async () => {
    expect(await resolveRunExecutables({ task: task(), agent: agent() }, {})).toBe(NO_EXECUTABLES);
  });

  it("resolves host tools by their negotiated paths, ahead of installable commands", async () => {
    const dir = await placeInstallable(dataDir, GRAPH);
    const executables = await resolveRunExecutables(
      {
        task: task({
          requires: { installables: ["@omniralph/graph"], hostTools: ["opengrep"] },
        }),
        agent: agent(),
      },
      {
        dataDir,
        hostToolPath: (name) => (name === "opengrep" ? "/opt/opengrep/bin/opengrep" : null),
      },
    );
    expect(Object.fromEntries(executables.commands)).toEqual({
      opengrep: "/opt/opengrep/bin/opengrep",
      "graph-index": path.join(dir, "bin/index.js"),
    });
    expect(executables.mcpServers).toBeNull();
  });

  it("attaches the installable MCP servers the agent lists", async () => {
    const dir = await placeInstallable(dataDir, GRAPH);
    const executables = await resolveRunExecutables(
      {
        task: task(),
        agent: agent({ tools: { mcpServers: ["@omniralph/graph:graph", "other"] } }),
      },
      { dataDir },
    );
    expect(executables.mcpServers).toEqual({
      servers: {
        omniralph_graph_graph: {
          type: "stdio",
          command: path.join(dir, "bin/server.js"),
          args: ["--stdio"],
        },
      },
      allowedTools: ["mcp__omniralph_graph_graph"],
    });
    expect(executables.commands.get("graph-index")).toBe(path.join(dir, "bin/index.js"));
  });

  it("loads the skills of required installables only", async () => {
    await placeInstallable(
      dataDir,
      { ...GRAPH, omniralph: { ...GRAPH.omniralph, skills: ["skills/graph-usage"] } },
      { "skills/graph-usage/SKILL.md": "---\nname: graph-usage\n---\nUse the graph.\n" },
    );
    await placeInstallable(
      dataDir,
      { name: "@omniralph/other", version: "1.0.0", omniralph: { skills: ["other.md"] } },
      { "other.md": "Other skill.\n" },
    );
    const executables = await resolveRunExecutables(
      { task: task({ requires: { installables: ["@omniralph/graph"] } }), agent: agent() },
      { dataDir },
    );
    expect(executables.skills?.skills).toEqual(["omniralph-graph:graph-usage"]);
    expect(executables.skills?.plugins).toHaveLength(1);
    const plugin = executables.skills!.plugins[0]!;
    expect(plugin).toMatchObject({ type: "local", skipMcpDiscovery: true });
    expect(plugin.path.startsWith(path.join(dataDir, "skill-plugins", "omniralph-graph-"))).toBe(
      true,
    );
    expect(await readFile(path.join(plugin.path, "skills/graph-usage/SKILL.md"), "utf8")).toBe(
      "---\nname: graph-usage\n---\nUse the graph.\n",
    );

    const withoutSkills = await resolveRunExecutables(
      { task: task({ requires: { installables: [], hostTools: ["opengrep"] } }), agent: agent() },
      { dataDir, hostToolPath: () => "/opt/opengrep" },
    );
    expect(withoutSkills.skills).toBeNull();
  });

  it("fails a run whose required installable declares a skill that isn't one", async () => {
    await placeInstallable(
      dataDir,
      { ...GRAPH, omniralph: { ...GRAPH.omniralph, skills: ["skills/empty"] } },
      { "skills/empty/README.md": "Not a skill.\n" },
    );
    await expect(
      resolveRunExecutables(
        { task: task({ requires: { installables: ["@omniralph/graph"] } }), agent: agent() },
        { dataDir },
      ),
    ).rejects.toThrow(/skills\/empty of the installable @omniralph\/graph has no SKILL\.md/);
  });

  it("gives installable commands and MCP servers the repository cache", async () => {
    await placeInstallable(dataDir, GRAPH);
    const executables = await resolveRunExecutables(
      {
        task: task({ requires: { installables: ["@omniralph/graph"], hostTools: [] } }),
        agent: agent({ tools: { mcpServers: ["@omniralph/graph:graph"] } }),
        trigger: { kind: "chat.request", context: { pr: { number: 7 } } },
        repositoryId: REPO_ID,
      },
      { dataDir },
    );
    const cacheDir = path.join(dataDir, "cache", "@omniralph", "graph", REPO_ID);
    const env = { OMNIRALPH_CACHE_DIR: cacheDir };
    expect(executables.commandEnv.get("graph-index")).toEqual(env);
    expect(executables.commandEnv.get("opengrep")).toEqual(env);
    expect(executables.mcpServers?.servers.omniralph_graph_graph?.env).toEqual(env);
    const created = await stat(cacheDir);
    expect(created.isDirectory()).toBe(true);
    expect(created.mode & 0o777).toBe(0o700);
    await expect(stat(path.join(dataDir, "pr-cache"))).rejects.toThrow();
  });

  it("gives a PR run's installables a PR cache outside the repository cache", async () => {
    await placeInstallable(dataDir, GRAPH);
    const executables = await resolveRunExecutables(
      {
        task: task({ requires: { installables: ["@omniralph/graph"], hostTools: ["opengrep"] } }),
        agent: agent({ tools: { mcpServers: ["@omniralph/graph:graph"] } }),
        trigger: { kind: "pr.updated", context: { pr: { number: 42 } } },
        repositoryId: REPO_ID,
      },
      { dataDir, hostToolPath: () => "/opt/opengrep/bin/opengrep" },
    );
    const cacheDir = path.join(dataDir, "cache", "@omniralph", "graph", REPO_ID);
    const prCacheDir = path.join(dataDir, "pr-cache", "@omniralph", "graph", REPO_ID, "42");
    const env = { OMNIRALPH_CACHE_DIR: cacheDir, OMNIRALPH_PR_CACHE_DIR: prCacheDir };
    expect(executables.commandEnv.get("graph-index")).toEqual(env);
    expect(executables.mcpServers?.servers.omniralph_graph_graph?.env).toEqual(env);
    expect(path.relative(cacheDir, prCacheDir).startsWith("..")).toBe(true);
    expect(prCacheDir.startsWith(cacheDir + path.sep)).toBe(false);
    expect(cacheDir.startsWith(prCacheDir + path.sep)).toBe(false);
    expect((await stat(prCacheDir)).isDirectory()).toBe(true);
    // The host tool keeps its name and gets no installable cache.
    expect(executables.commandEnv.has("opengrep")).toBe(false);
  });

  it("gives no cache to a run without a repository", async () => {
    await placeInstallable(dataDir, GRAPH);
    const executables = await resolveRunExecutables(
      {
        task: task(),
        agent: agent({ tools: { mcpServers: ["@omniralph/graph:graph"] } }),
        trigger: { kind: "pr.updated", context: { pr: { number: 42 } } },
        repositoryId: null,
      },
      { dataDir },
    );
    expect(executables.commandEnv.get("graph-index")).toEqual({});
    expect(executables.mcpServers?.servers.omniralph_graph_graph).not.toHaveProperty("env");
    await expect(stat(path.join(dataDir, "cache"))).rejects.toThrow();
  });

  it("retries a run whose host tool is unavailable", async () => {
    const spec = {
      task: task({ requires: { installables: [], hostTools: ["opengrep"] } }),
      agent: agent(),
    };
    await expect(resolveRunExecutables(spec, { hostToolPath: () => null })).rejects.toThrow(
      new RetryableJobError("the host tool opengrep is not available on this harness", 60),
    );
    await expect(resolveRunExecutables(spec, {})).rejects.toBeInstanceOf(RetryableJobError);
  });

  it("retries a run whose installable isn't installed", async () => {
    const spec = {
      task: task({ requires: { installables: ["@omniralph/graph"], hostTools: [] } }),
      agent: agent(),
    };
    await expect(resolveRunExecutables(spec, { dataDir })).rejects.toThrow(
      new RetryableJobError(
        "the installable @omniralph/graph is not installed on this harness",
        60,
      ),
    );
    await expect(resolveRunExecutables(spec, {})).rejects.toBeInstanceOf(RetryableJobError);
  });

  it("fails a run whose agent lists an MCP server the installable doesn't have", async () => {
    await placeInstallable(dataDir, GRAPH);
    await expect(
      resolveRunExecutables(
        { task: task(), agent: agent({ tools: { mcpServers: ["@omniralph/graph:search"] } }) },
        { dataDir },
      ),
    ).rejects.toThrow("the installable @omniralph/graph 2.1.0 has no MCP server search");
  });

  it("fails a run whose required installables provide the same command", async () => {
    await placeInstallable(dataDir, GRAPH);
    await placeInstallable(dataDir, {
      name: "@omniralph/other",
      version: "1.0.0",
      omniralph: { commands: [{ name: "graph-index", bin: "bin/index.js" }] },
    });
    await expect(
      resolveRunExecutables(
        {
          task: task({
            requires: { installables: ["@omniralph/graph", "@omniralph/other"], hostTools: [] },
          }),
          agent: agent(),
        },
        { dataDir },
      ),
    ).rejects.toThrow(
      "the installables @omniralph/graph and @omniralph/other both provide the command graph-index",
    );
  });

  it("fails a run whose MCP servers share a session name", async () => {
    await placeInstallable(dataDir, {
      name: "@acme/a.b",
      version: "1.0.0",
      omniralph: { mcpServers: [{ name: "srv", command: "bin/a.js" }] },
    });
    await placeInstallable(dataDir, {
      name: "@acme/a_b",
      version: "1.0.0",
      omniralph: { mcpServers: [{ name: "srv", command: "bin/b.js" }] },
    });
    await expect(
      resolveRunExecutables(
        {
          task: task(),
          agent: agent({ tools: { mcpServers: ["@acme/a.b:srv", "@acme/a_b:srv"] } }),
        },
        { dataDir },
      ),
    ).rejects.toThrow(
      "the MCP servers @acme/a.b:srv and @acme/a_b:srv both have the session name acme_a_b_srv",
    );
  });

  it("refuses host tools, installable commands and MCP servers under blockedExecPaths", async () => {
    const dir = await placeInstallable(dataDir, GRAPH);
    const blockedIn = (prefix: string) => ({
      dataDir,
      hostToolPath: () => "/opt/opengrep/bin/opengrep",
      execPathBlocked: (file: string) => execPathBlocked({ blockedExecPaths: [prefix] }, file),
    });
    const hostTool = {
      task: task({ requires: { installables: [], hostTools: ["opengrep"] } }),
      agent: agent(),
    };
    await expect(resolveRunExecutables(hostTool, blockedIn("/opt/opengrep"))).rejects.toThrow(
      "/opt/opengrep/bin/opengrep (the host tool opengrep) is blocked by blockedExecPaths",
    );
    await expect(
      resolveRunExecutables(hostTool, blockedIn("/opt/opengrep2")),
    ).resolves.toBeTruthy();

    const command = {
      task: task({ requires: { installables: ["@omniralph/graph"], hostTools: [] } }),
      agent: agent(),
    };
    await expect(resolveRunExecutables(command, blockedIn(path.join(dir, "bin")))).rejects.toThrow(
      `${path.join(dir, "bin/index.js")} (the command graph-index of @omniralph/graph) is blocked`,
    );

    const server = {
      task: task(),
      agent: agent({ tools: { mcpServers: ["@omniralph/graph:graph"] } }),
    };
    await expect(
      resolveRunExecutables(server, blockedIn(path.join(dir, "bin/server.js"))),
    ).rejects.toThrow(
      `${path.join(dir, "bin/server.js")} (the MCP server @omniralph/graph:graph) is blocked`,
    );
    await expect(resolveRunExecutables(server, blockedIn(dataDir))).rejects.toThrow("is blocked");
  });
});

describe("installable cache directories", () => {
  it("rejects a repository ID or PR number that isn't valid in a path", () => {
    expect(installableCacheDir("/data", "@omniralph/graph", REPO_ID)).toBe(
      path.join("/data/cache/@omniralph/graph", REPO_ID),
    );
    expect(() => installableCacheDir("/data", "@omniralph/graph", "../../etc")).toThrow(
      "invalid repository ID",
    );
    expect(() => installableCacheDir("/data", "../x", REPO_ID)).toThrow("invalid installable name");
    expect(installablePrCacheDir("/data", "graph", REPO_ID, 3)).toBe(
      path.join("/data/pr-cache/graph", REPO_ID, "3"),
    );
    for (const pr of [0, -1, 1.5, Number.NaN]) {
      expect(() => installablePrCacheDir("/data", "graph", REPO_ID, pr)).toThrow(
        "invalid PR number",
      );
    }
    expect(() => installablePrCacheDir("/data", "graph", "not-a-uuid", 3)).toThrow(
      "invalid repository ID",
    );
  });
});

describe("runPrNumber", () => {
  it("reads pr.number of the PR triggers", () => {
    for (const kind of [
      "pr.updated",
      "pr.mention",
      "review.rerun",
      "finding.mention",
      "pr.review-findings",
      "pr.ci-failed",
      "pr.fix-command",
    ] as const) {
      expect(runPrNumber({ kind, context: { pr: { number: 12 } } })).toBe(12);
    }
  });

  it("is null for other triggers and invalid numbers", () => {
    expect(runPrNumber(undefined)).toBeNull();
    expect(runPrNumber({ kind: "chat.request", context: { pr: { number: 12 } } })).toBeNull();
    expect(runPrNumber({ kind: "run.invoked", context: { pr: { number: 12 } } })).toBeNull();
    for (const pr of [undefined, null, 12, { number: "12" }, { number: 0 }, { number: 1.5 }]) {
      expect(runPrNumber({ kind: "pr.updated", context: { pr } })).toBeNull();
    }
  });
});

describe("installableMcpServerName", () => {
  it("keeps letters, digits, _ and -", () => {
    expect(installableMcpServerName("@omniralph/code-graph", "graph.v2")).toBe(
      "omniralph_code-graph_graph_v2",
    );
    expect(installableMcpServerName("semgrep", "scan")).toBe("semgrep_scan");
  });
});

describe("sessionMcpServers", () => {
  const installable = {
    commands: new Map(),
    commandEnv: new Map(),
    skills: null,
    mcpServers: {
      servers: { semgrep_scan: { type: "stdio" as const, command: "/x/scan.js", args: [] } },
      allowedTools: ["mcp__semgrep_scan"],
    },
  };
  const harness = {
    config: { type: "stdio" as const, command: "/harness" },
    allowedTools: ["mcp__omniralph__ship"],
  };

  it("combines the harness server and the installable ones", () => {
    expect(sessionMcpServers(null, NO_EXECUTABLES)).toBeUndefined();
    expect(sessionMcpServers(harness, NO_EXECUTABLES)).toEqual({
      servers: { omniralph: harness.config },
      allowedTools: ["mcp__omniralph__ship"],
    });
    expect(sessionMcpServers(harness, installable)).toEqual({
      servers: {
        semgrep_scan: installable.mcpServers.servers.semgrep_scan,
        omniralph: harness.config,
      },
      allowedTools: ["mcp__omniralph__ship", "mcp__semgrep_scan"],
    });
  });
});
