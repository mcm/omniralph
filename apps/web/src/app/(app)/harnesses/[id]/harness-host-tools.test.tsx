import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { HostToolsCard } from "./harness-detail-view";
import type { HostToolRow } from "./harness-host-tools";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../actions", () => ({}));
vi.mock("../../jobs/actions", () => ({}));
vi.mock("../../repositories/actions", () => ({}));

const harness = { id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f", revoked: false } as HarnessRow;
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
      .replace(/<input[^>]*value="([^"]*)"[^>]*>/g, "[$1]")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

describe("HostToolsCard", () => {
  it("lists every catalog tool with its configured path, report and effective path", () => {
    const html = renderToStaticMarkup(<HostToolsCard harness={harness} hostTools={tools} />);
    const byName = rows(html);
    expect(Object.keys(byName)).toEqual(tools.map((t) => t.name));
    // Tool, configured path (form), configured path exists, discovered path, effective path.
    expect(cells(byName["configured-exists"]!)).toEqual([
      "configured-exists Found where configured",
      "[/opt/ce/bin/ce] Save",
      "Exists",
      "/usr/bin/configured-exists",
      "/opt/ce/bin/ce",
    ]);
    // A configured path wins even when missing: no fallback to the discovered one.
    expect(cells(byName["configured-missing"]!)).toEqual([
      "configured-missing",
      "[/opt/cm/bin/cm] Save",
      "Missing",
      "/usr/bin/configured-missing",
      "unavailable",
    ]);
    expect(cells(byName["configured-unchecked"]!)).toEqual([
      "configured-unchecked",
      "[/opt/cu/bin/cu] Save",
      "Not checked yet",
      "Not found on PATH",
      "unavailable",
    ]);
    expect(cells(byName.discovered!)).toEqual([
      "discovered",
      "[] Save",
      "Not configured",
      "/usr/local/bin/discovered",
      "/usr/local/bin/discovered",
    ]);
    expect(cells(byName["not-found"]!)).toEqual([
      "not-found",
      "[] Save",
      "Not configured",
      "Not found on PATH",
      "unavailable",
    ]);
    expect(cells(byName["never-reported"]!)).toEqual([
      "never-reported",
      "[] Save",
      "Not configured",
      "Not reported yet",
      "unavailable",
    ]);
  });

  it("shows the configured paths without forms on a revoked harness", () => {
    const html = renderToStaticMarkup(
      <HostToolsCard harness={{ ...harness, revoked: true }} hostTools={tools} />,
    );
    expect(html).not.toContain("<form");
    expect(cells(rows(html)["configured-exists"]!)[1]).toBe("/opt/ce/bin/ce");
    expect(cells(rows(html).discovered!)[1]).toBe("Not configured");
  });

  it("points to the catalog when there are no host tools", () => {
    const html = renderToStaticMarkup(<HostToolsCard harness={harness} hostTools={[]} />);
    expect(html).toContain("No host tools");
    expect(html).toContain("Settings › Harnesses");
  });
});
