import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { sessionPermissions } from "../session/session.js";
import { QUERY_TOOLS, queryToolPolicy } from "./tool-policy.js";

const ALL_BUILTIN = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "WebSearch",
  "WebFetch",
  "Edit",
  "Write",
  "Task",
];

// `harness`: the run spec's tools key until TOOL-584 renames it.
const agent = (builtin: string[]) => ({
  tools: { builtin, harness: [], linear: [], mcpServers: [] },
});

const permissions = (
  builtin: string[],
  settings: { shell: boolean; network: boolean },
  options: {
    files?: boolean;
    tools?: { allowedTools: string[]; disallowedTools: string[] };
  } = {},
) =>
  sessionPermissions({
    policy: queryToolPolicy(agent(builtin), settings, { files: options.files }),
    cwd: "/work/tree",
    tools: options.tools,
  });

const toolsOf = (p: ReturnType<typeof permissions>) => (Array.isArray(p.tools) ? p.tools : []);

describe("queryToolPolicy", () => {
  const combinations = [false, true].flatMap((shell) =>
    [false, true].flatMap((network) => [false, true].map((files) => ({ shell, network, files }))),
  );

  it.each(combinations)("offers only what the settings allow: %o", ({ shell, network, files }) => {
    const p = permissions(ALL_BUILTIN, { shell, network }, { files });
    const expected = [
      ...(files ? ["Read", "Grep", "Glob"] : []),
      ...(files && shell ? ["Bash"] : []),
      ...(network ? ["WebSearch", "WebFetch"] : []),
    ];
    expect([...toolsOf(p)].sort()).toEqual([...expected].sort());
    expect([...(p.allowedTools ?? [])].sort()).toEqual([...expected].sort());
    // Never write tools, subagents or anything else, whatever the agent asks for.
    for (const tool of ["Edit", "Write", "Task"]) {
      expect(toolsOf(p)).not.toContain(tool);
      expect(p.disallowedTools).toContain(tool);
    }
    for (const tool of QUERY_TOOLS.filter((t) => !expected.includes(t))) {
      expect(p.disallowedTools).toContain(tool);
    }
    expect(p.permissionMode).toBe("dontAsk");
    expect(p.allowDangerouslySkipPermissions).toBeUndefined();
    expect(p.settingSources).toEqual([]);
    expect(p).toMatchObject({ skills: [], plugins: [], mcpServers: {}, strictMcpConfig: true });
  });

  it("only offers the agent's own tools", () => {
    const p = permissions(["Read", "WebFetch"], { shell: true, network: true });
    expect(toolsOf(p)).toEqual(["Read", "WebFetch"]);
    expect(p.disallowedTools).toEqual(expect.arrayContaining(["Bash", "WebSearch"]));
  });

  it("confines Read/Grep/Glob to the working directory", async () => {
    const p = permissions(["Read", "Grep", "Glob"], { shell: false, network: false });
    const [matcher] = p.hooks?.PreToolUse ?? [];
    expect(matcher?.matcher).toBe("Read|Grep|Glob");
    const guard = matcher?.hooks[0] as HookCallback;
    const decision = await guard(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "/etc/passwd" },
      } as Parameters<HookCallback>[0],
      undefined,
      { signal: new AbortController().signal },
    );
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });

  it("gives no tools at all when nothing is allowed", () => {
    const p = permissions(ALL_BUILTIN, { shell: true, network: false }, { files: false });
    expect(toolsOf(p)).toEqual([]);
    expect(p.allowedTools).toEqual([]);
    expect(p.hooks).toEqual({});
  });

  describe("the repository's narrowing", () => {
    const narrowings = [
      { allowedTools: [], disallowedTools: [] },
      { allowedTools: ["Read"], disallowedTools: [] },
      { allowedTools: ["Read", "Edit", "Bash(git log:*)"], disallowedTools: [] },
      { allowedTools: [], disallowedTools: ["Grep", "WebFetch"] },
      { allowedTools: ["Write", "Task"], disallowedTools: [] },
    ];
    const settings = [
      { shell: false, network: false },
      { shell: true, network: true },
    ];

    it.each(narrowings.flatMap((tools) => settings.map((s) => ({ tools, s }))))(
      "never widens: %o",
      ({ tools, s }) => {
        const wide = permissions(ALL_BUILTIN, s);
        const narrowed = permissions(ALL_BUILTIN, s, { tools });
        for (const tool of toolsOf(narrowed)) expect(toolsOf(wide)).toContain(tool);
        for (const tool of wide.disallowedTools ?? []) {
          expect(narrowed.disallowedTools).toContain(tool);
        }
        for (const tool of tools.disallowedTools) expect(narrowed.disallowedTools).toContain(tool);
        for (const rule of narrowed.allowedTools ?? []) {
          expect(toolsOf(wide)).toContain(rule.replace(/\(.*$/, ""));
        }
        expect(narrowed.permissionMode).toBe("dontAsk");
        expect(narrowed.settingSources).toEqual([]);
      },
    );

    it("keeps only the repository's allowed tools", () => {
      const p = permissions(
        ALL_BUILTIN,
        { shell: false, network: true },
        {
          tools: { allowedTools: ["Read", "WebSearch", "Edit"], disallowedTools: [] },
        },
      );
      expect(toolsOf(p)).toEqual(["Read", "WebSearch"]);
    });
  });
});
