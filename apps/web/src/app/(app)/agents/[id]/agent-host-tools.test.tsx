import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import type { AgentRow } from "@/lib/agents/rows";
import { HostToolsSection } from "./agent-detail-view";
import type { HostToolRow } from "./agent-host-tools";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** Static markup inside the providers the app shell gives (the user, a query client). */
function markup(ui: React.ReactElement): string {
  const Wrapper = queryWrapper(createTestQueryClient());
  return renderToStaticMarkup(<Wrapper>{ui}</Wrapper>);
}

const agent = { id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f", revoked: false } as AgentRow;
const REPORTED = "2026-10-12T10:00:00.000Z";

function tool(name: string, fields: Partial<HostToolRow>): HostToolRow {
  return {
    hostToolId: `id-${name}`,
    name,
    description: null,
    configuredPath: null,
    configuredPathExists: null,
    discoveredPath: null,
    reportedAt: REPORTED,
    effectivePath: null,
    ...fields,
  };
}

const tools: HostToolRow[] = [
  tool("configured-exists", {
    description: "Found where configured",
    configuredPath: "/opt/ce/bin/ce",
    configuredPathExists: true,
    discoveredPath: "/usr/bin/configured-exists",
    effectivePath: "/opt/ce/bin/ce",
  }),
  tool("configured-missing", {
    configuredPath: "/opt/cm/bin/cm",
    configuredPathExists: false,
    discoveredPath: "/usr/bin/configured-missing",
  }),
  tool("configured-unchecked", { configuredPath: "/opt/cu/bin/cu" }),
  tool("discovered", {
    discoveredPath: "/usr/local/bin/discovered",
    effectivePath: "/usr/local/bin/discovered",
  }),
  tool("not-found", {}),
  tool("never-reported", { reportedAt: null }),
];

/** Each row's markup, by tool name. */
function rows(html: string): Record<string, string> {
  return Object.fromEntries(
    [...html.matchAll(/<tr[^>]*data-host-tool="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [
      m[1]!,
      m[2]!,
    ]),
  );
}

/** The text of each cell of a row. */
function cells(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) =>
    m[1]!
      // The phone meta repeats the hidden columns.
      .replace(/<div class="list-phone-meta">[\s\S]*?<\/div>/g, "")
      .replace(/<input[^>]*value="([^"]*)"[^>]*>/g, "[$1]")
      // A MonoValue's head and tail are one value.
      .replace(/<\/span><span class="mono-value-tail">/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("HostToolsSection", () => {
  it("lists every catalog tool with its configured path, report and effective path", () => {
    const html = markup(<HostToolsSection agent={agent} hostTools={tools} />);
    const byName = rows(html);
    expect(Object.keys(byName)).toEqual(tools.map((t) => t.name));
    // Tool, configured path (form), configured path exists, discovered path, effective path.
    expect(cells(byName["configured-exists"]!)).toEqual([
      "configured-exists Found where configured",
      "[/opt/ce/bin/ce]",
      "Exists",
      "/usr/bin/configured-exists",
      "/opt/ce/bin/ce",
    ]);
    // A configured path wins even when missing: no fallback to the discovered one.
    expect(cells(byName["configured-missing"]!)).toEqual([
      "configured-missing",
      "[/opt/cm/bin/cm]",
      "Missing",
      "/usr/bin/configured-missing",
      "Unavailable",
    ]);
    expect(cells(byName["configured-unchecked"]!)).toEqual([
      "configured-unchecked",
      "[/opt/cu/bin/cu]",
      "Not checked yet",
      "Not found on PATH",
      "Unavailable",
    ]);
    expect(cells(byName.discovered!)).toEqual([
      "discovered",
      "[]",
      "Not configured",
      "/usr/local/bin/discovered",
      "/usr/local/bin/discovered",
    ]);
    expect(cells(byName["not-found"]!)).toEqual([
      "not-found",
      "[]",
      "Not configured",
      "Not found on PATH",
      "Unavailable",
    ]);
    expect(cells(byName["never-reported"]!)).toEqual([
      "never-reported",
      "[]",
      "Not configured",
      "Not reported yet",
      "Unavailable",
    ]);
  });

  it("names each fact in the phone meta, discovered path included", () => {
    const html = markup(<HostToolsSection agent={agent} hostTools={tools} />);
    const meta = (name: string) => {
      const dl = rows(html)[name]!.match(/<dl class="host-tool-facts">([\s\S]*?)<\/dl>/)![1]!;
      return dl
        .replace(/<\/span><span class="mono-value-tail">/g, "")
        .replace(/<\/(dt|dd)>/g, " | ")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
    };
    expect(meta("discovered")).toBe(
      "Configured path | Not configured | Discovered | /usr/local/bin/discovered | Runs from | /usr/local/bin/discovered |",
    );
    expect(meta("configured-missing")).toBe(
      "Configured path | Missing | Discovered | /usr/bin/configured-missing | Runs from | Unavailable |",
    );
  });

  it("saves every changed path with the section's one save", () => {
    const html = markup(<HostToolsSection agent={agent} hostTools={tools} />);
    expect(html.match(/<form/g)).toHaveLength(1);
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(html).toContain("Save host tools");
  });

  it("shows the configured paths without inputs or a save on a revoked agent", () => {
    const html = markup(<HostToolsSection agent={{ ...agent, revoked: true }} hostTools={tools} />);
    expect(html).not.toContain("<input");
    expect(html).not.toContain('type="submit"');
    expect(cells(rows(html)["configured-exists"]!)[1]).toBe("/opt/ce/bin/ce");
    expect(cells(rows(html).discovered!)[1]).toBe("Not configured");
  });

  it("points to the catalog when there are no host tools", () => {
    const html = markup(<HostToolsSection agent={agent} hostTools={[]} />);
    expect(html).toContain("No host tools");
    expect(html).toContain("Settings › Agent defaults");
  });
});
