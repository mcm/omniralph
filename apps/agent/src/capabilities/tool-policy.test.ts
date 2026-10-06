import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider } from "@omniralph/engine";
import { describe, expect, it } from "vitest";
import type { ToolPolicy } from "./index.js";
import { RALPH_DESCRIBE_PR_TOOL_POLICY, RALPH_TOOL_POLICY } from "./ralph.js";
import { REVIEW_TOOL_POLICY, reviewSessionProvider } from "./review.js";
import { sdkPermissions } from "./tool-policy.js";

const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "omniralph-policy-")));
const controller = new AbortController();
const silent = { info() {}, warn() {}, error() {} };

function optionsFor(provider: ClaudeAgentProvider, allowExploration: boolean): Options {
  return provider.buildOptions({ cwd, model: "claude-x", allowExploration }, controller, 7, "SYS");
}

/** The permission options review sessions have always had (before tool policies built them). */
function todaysReviewOptions(allowExploration: boolean): Options {
  const tools = allowExploration ? ["Read", "Grep", "Glob"] : [];
  return {
    cwd,
    model: "claude-x",
    abortController: controller,
    systemPrompt: "SYS",
    tools,
    allowedTools: tools,
    disallowedTools: [
      "Bash",
      "BashOutput",
      "KillShell",
      "PowerShell",
      "Monitor",
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
      "Skill",
      "SlashCommand",
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
    ],
    permissionMode: "dontAsk",
    settingSources: [],
    skills: [],
    plugins: [],
    mcpServers: {},
    strictMcpConfig: true,
    persistSession: false,
    maxTurns: 7,
    hooks: allowExploration
      ? { PreToolUse: [{ matcher: "Read|Grep|Glob", hooks: [expect.any(Function)] }] }
      : {},
    env: expect.objectContaining({ CLAUDE_AGENT_SDK_CLIENT_APP: "omniralph-agent" }),
  };
}

async function guardDecision(options: Options, filePath: string): Promise<unknown> {
  const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
  const output = await hook(
    {
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: { file_path: filePath },
    } as unknown as HookInput,
    undefined,
    { signal: new AbortController().signal },
  );
  return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision;
}

describe("sdkPermissions", () => {
  it("gives review sessions exactly today's SDK options", async () => {
    const provider = reviewSessionProvider(silent);
    const engineDefault = new ClaudeAgentProvider({ logger: silent });
    for (const allowExploration of [true, false]) {
      const options = optionsFor(provider, allowExploration);
      expect(options).toStrictEqual(todaysReviewOptions(allowExploration));
      expect(options.allowDangerouslySkipPermissions).toBeUndefined();
      // Same as the engine's built-in read-only permissions, hooks aside (fresh closures).
      const { hooks, ...rest } = options;
      const { hooks: defaultHooks, ...defaultRest } = optionsFor(engineDefault, allowExploration);
      expect(rest).toStrictEqual(defaultRest);
      expect(Object.keys(hooks!)).toEqual(Object.keys(defaultHooks!));
    }

    const exploring = optionsFor(provider, true);
    expect(await guardDecision(exploring, path.join(cwd, "src/a.ts"))).toBeUndefined();
    expect(await guardDecision(exploring, "/etc/passwd")).toBe("deny");
  });

  it("gives ralph story sessions Claude Code's tools without prompts, with project settings, in the worktree", () => {
    const permissions = sdkPermissions(RALPH_TOOL_POLICY)({ cwd, allowExploration: true });
    expect(permissions).toStrictEqual({
      cwd,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: [],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project", "local"],
      hooks: {},
    });
  });

  it("keeps ralph describe-pr sessions read-only", () => {
    const permissions = sdkPermissions(RALPH_DESCRIBE_PR_TOOL_POLICY)({
      cwd,
      allowExploration: true,
    });
    expect(permissions.tools).toEqual(["Read", "Grep", "Glob"]);
    expect(permissions.permissionMode).toBe("dontAsk");
    expect(permissions.allowDangerouslySkipPermissions).toBeUndefined();
    expect(permissions.disallowedTools).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(permissions.settingSources).toEqual([]);
    expect(permissions.hooks?.PreToolUse?.[0]?.matcher).toBe("Read|Grep|Glob");
  });

  it("gives no tools to a session that may not explore", () => {
    const permissions = sdkPermissions(RALPH_TOOL_POLICY)({ cwd, allowExploration: false });
    expect(permissions.tools).toEqual([]);
    expect(permissions.allowedTools).toEqual([]);
  });

  it("refuses to bypass permissions for a read-only policy", () => {
    const policy: ToolPolicy = { ...REVIEW_TOOL_POLICY, permissionMode: "bypassPermissions" };
    expect(() => sdkPermissions(policy)).toThrow(/write-capable/);
  });
});
