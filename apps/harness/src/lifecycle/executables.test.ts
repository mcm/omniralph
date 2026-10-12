import { mkdtemp, rm } from "node:fs/promises";
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
import { placeInstallable } from "../test/installables.js";
import { resolveCommand } from "./commands.js";
import {
  installableMcpServerName,
  NO_EXECUTABLES,
  resolveRunExecutables,
  sessionMcpServers,
} from "./executables.js";

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
