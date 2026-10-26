import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HookInput, Options } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentProvider, DISALLOWED_TOOLS, EXPLORATION_TOOLS } from "@omniralph/engine";
import { getBuiltinRunSpec, getBuiltinTask } from "@omniralph/tasks";
import { describe, expect, it } from "vitest";
import type { ToolPolicy } from "./index.js";
import { RALPH_TOOL_POLICY } from "./ralph/index.js";
import { queryToolPolicy } from "../lifecycle/tool-policy.js";
import { isReadOnlyCommand, narrowPermissions, ruleTool, sdkPermissions } from "./tool-policy.js";

/** Read-only git commands a read-only session may run. */
const READ_ONLY_GIT_COMMANDS: readonly string[] = [
  "git log",
  "git diff",
  "git show",
  "git status",
  "git rev-parse",
  "git merge-base",
  "git ls-files",
];

/** A read-only policy: Read, Grep and Glob in the worktree, plus read-only git commands. */
const READ_ONLY_GIT_POLICY: ToolPolicy = {
  tools: "allowed",
  allowedTools: EXPLORATION_TOOLS,
  disallowedTools: DISALLOWED_TOOLS,
  fileScope: "worktree",
  permissionMode: "dontAsk",
  settingSources: [],
  writable: false,
  readOnlyCommands: READ_ONLY_GIT_COMMANDS,
};

const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "omniralph-policy-")));
const controller = new AbortController();
const silent = { info() {}, warn() {}, error() {} };

/** The policy of `builtin:review-pr` sessions (agent `builtin:reviewer`), as the review lifecycle builds it. */
const REVIEW_TOOL_POLICY = queryToolPolicy(
  getBuiltinRunSpec("builtin:review-pr")!.agent,
  getBuiltinTask("builtin:review-pr")!.toolSettings,
);

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
    const provider = new ClaudeAgentProvider({
      logger: silent,
      permissions: sdkPermissions(REVIEW_TOOL_POLICY),
    });
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

  it("gives ralph story sessions Claude Code's tools without prompts, with user and project settings, in the worktree", () => {
    const permissions = sdkPermissions(RALPH_TOOL_POLICY)({ cwd, allowExploration: true });
    expect(permissions).toStrictEqual({
      cwd,
      tools: { type: "preset", preset: "claude_code" },
      allowedTools: [],
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      hooks: {},
    });
  });

  it("keeps read-only sessions read-only, with read-only git commands", async () => {
    const permissions = sdkPermissions(READ_ONLY_GIT_POLICY)({
      cwd,
      allowExploration: true,
    });
    expect(permissions.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(permissions.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob", "Bash(git log:*)", "Bash(git diff:*)"]),
    );
    expect((permissions.allowedTools ?? []).filter((t) => t.startsWith("Bash"))).toHaveLength(
      READ_ONLY_GIT_COMMANDS.length,
    );
    expect(permissions.permissionMode).toBe("dontAsk");
    expect(permissions.allowDangerouslySkipPermissions).toBeUndefined();
    expect(permissions.disallowedTools).toEqual(
      expect.arrayContaining(["Write", "Edit", "MultiEdit", "NotebookEdit"]),
    );
    expect(permissions.disallowedTools).not.toContain("Bash");
    expect(permissions.settingSources).toEqual([]);
    const [files, shell] = permissions.hooks?.PreToolUse ?? [];
    expect(files?.matcher).toBe("Read|Grep|Glob");
    expect(shell?.matcher).toBe("Bash");

    const decide = async (command: string) => {
      const output = await shell!.hooks[0]!(
        {
          hook_event_name: "PreToolUse",
          tool_name: "Bash",
          tool_input: { command },
        } as unknown as HookInput,
        undefined,
        { signal: new AbortController().signal },
      );
      return (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
        ?.permissionDecision;
    };
    expect(await decide("git log --reverse --format='%s%n%b' origin/main..HEAD")).toBeUndefined();
    expect(await decide("git diff origin/main...HEAD")).toBeUndefined();
    expect(await decide("rm -rf src")).toBe("deny");
    expect(await decide("git commit -am x")).toBe("deny");
    expect(await decide("git diff --output=/tmp/x")).toBe("deny");
  });

  it("only accepts the read-only commands with plain arguments", () => {
    const git = ["git log", "git diff", "git show"];
    expect(isReadOnlyCommand("git log", git)).toBe(true);
    expect(isReadOnlyCommand("  git  show HEAD~1:src/a.ts ", git)).toBe(true);
    expect(isReadOnlyCommand("git diff --stat origin/main...HEAD", git)).toBe(true);
    for (const command of [
      "git logs",
      "git push origin HEAD",
      "git log; rm -rf .",
      "git log && touch x",
      "git log | sh",
      "git log > out.txt",
      "git show $(whoami)",
      "git show `id`",
      "git diff -o out.patch",
      "git diff --output out.patch",
      "git diff --ext-diff",
      "git diff --no-index /etc/passwd a",
      "git log\nrm x",
      "",
    ]) {
      expect(isReadOnlyCommand(command, git), command).toBe(false);
    }
  });

  it("refuses read-only commands for a write-capable policy", () => {
    expect(() => sdkPermissions({ ...RALPH_TOOL_POLICY, readOnlyCommands: ["git log"] })).toThrow(
      /read-only/,
    );
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

describe("sdkPermissions additional directories", () => {
  it("lets worktree-scoped file tools into the additional directories too", async () => {
    const extra = realpathSync(mkdtempSync(path.join(tmpdir(), "omniralph-policy-extra-")));
    const permissions = sdkPermissions(REVIEW_TOOL_POLICY)({
      cwd,
      allowExploration: true,
      additionalDirectories: [extra],
    });
    const options = permissions as Options;
    expect(await guardDecision(options, path.join(cwd, "a.ts"))).toBeUndefined();
    expect(await guardDecision(options, path.join(extra, "a.png"))).toBeUndefined();
    expect(await guardDecision(options, path.join(tmpdir(), "elsewhere.txt"))).toBe("deny");
    expect(await guardDecision(options, `${extra}/../escape.txt`)).toBe("deny");
  });
});

describe("narrowPermissions", () => {
  const story = () => sdkPermissions(RALPH_TOOL_POLICY)({ cwd, allowExploration: true });
  const readOnly = () =>
    sdkPermissions(READ_ONLY_GIT_POLICY)({ cwd, allowExploration: true });

  it("reads the tool of a permission rule", () => {
    expect(ruleTool("Read")).toBe("Read");
    expect(ruleTool("Bash(pnpm test:*)")).toBe("Bash");
  });

  it("leaves the permissions alone without repository tool settings", () => {
    expect(narrowPermissions(story(), undefined)).toEqual(story());
    expect(narrowPermissions(story(), { allowedTools: null, disallowedTools: [] })).toEqual(
      story(),
    );
  });

  it("adds the repository's disallowed tools to the policy's", () => {
    const narrowed = narrowPermissions(readOnly(), { disallowedTools: ["WebFetch", "Task"] });
    expect(narrowed.disallowedTools).toEqual(
      expect.arrayContaining([...readOnly().disallowedTools!, "WebFetch", "Task"]),
    );
  });

  it("can only take tools away from a policy with an explicit tool list", () => {
    const base = readOnly();
    const narrowed = narrowPermissions(base, {
      allowedTools: ["Read", "Write", "Edit", "Bash(rm -rf:*)", "Bash(git log:*)"],
    });
    // Write and Edit aren't the policy's, so they stay unavailable; Grep and Glob are taken away.
    expect(narrowed.tools).toEqual(["Read", "Bash"]);
    expect(narrowed.allowedTools).toEqual(["Read", "Bash(git log:*)"]);
    expect(narrowed.permissionMode).toBe(base.permissionMode);
    for (const tool of narrowed.tools as string[]) expect(base.tools).toContain(tool);
    for (const rule of narrowed.allowedTools!) expect(base.allowedTools).toContain(rule);
    expect(narrowed.hooks).toEqual(base.hooks);
  });

  it("stops a bypassing policy from approving anything the repository doesn't list", () => {
    const narrowed = narrowPermissions(story(), { allowedTools: ["Read", "Bash(pnpm test:*)"] });
    expect(narrowed).toMatchObject({
      tools: ["Read", "Bash"],
      allowedTools: ["Read", "Bash(pnpm test:*)"],
      permissionMode: "dontAsk",
    });
    expect(narrowed.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("gives a session without tools none", () => {
    const none = sdkPermissions(RALPH_TOOL_POLICY)({ cwd, allowExploration: false });
    expect(narrowPermissions(none, { allowedTools: ["Read"] }).tools).toEqual([]);
  });
});
