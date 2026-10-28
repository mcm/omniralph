// The control panel's machine settings (an agent's slots, pool limits, version override, its
// "Update now" request and the host tool catalog) were dropped by migration 0116: each agent's
// settings.json is their only source. Nothing outside the migrations may name them again.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as db from "./index.js";
import * as schema from "./schema.js";

const root = path.resolve(import.meta.dirname, "../../..");

// Built by joining, so this file doesn't match itself.
const words = (...parts: string[][]) => parts.map((p) => p.join("_"));
const DROPPED_COLUMNS = words(
  ["max", "concurrency"],
  ["pool", "limits"],
  ["desired", "version"],
  ["update", "request", "id"],
  ["update", "request", "version"],
  ["update", "requested", "at"],
);
const DROPPED_TABLES = words(["host", "tools"], ["agent", "host", "tools"]);
const DROPPED_EXPORTS = ["host" + "Tools", "agent" + "HostTools"];
const DROPPED_KEY = ["agent", "maxConcurrency"].join(".");

/** `git grep` (tracked and new files) over apps/ and packages/, outside the migrations. */
function grep(args: string[], exclude: string[] = []): string {
  const result = spawnSync(
    "git",
    [
      "grep",
      "--untracked",
      "-n",
      ...args,
      "--",
      "apps",
      "packages",
      // Migrations name them, as history.
      ":!packages/db/drizzle",
      ...exclude.map((path) => `:!${path}`),
    ],
    { cwd: root, encoding: "utf8" },
  );
  // `git grep` exits 1 when nothing matches.
  expect(result.status, result.stderr || result.stdout).toBe(1);
  return result.stdout;
}

const escape = (s: string) => s.replace(/[.]/g, "\\.");

describe("dropped machine settings", () => {
  it("no code names a dropped column or table as a whole identifier", () => {
    // `-w`: `reported_max_concurrency`, `reported_pool_limits` and `required_host_tools` are
    // other identifiers and stay allowed.
    expect(grep(["-wE", DROPPED_COLUMNS.join("|")])).toBe("");
    // The agent's own page names its live resource and nav section after the catalog table
    // too: not the dropped table, which the agent never had.
    expect(grep(["-wE", DROPPED_TABLES.join("|")], ["apps/agent"])).toBe("");
  });

  it("no code names the dropped schema exports or the organization slot key", () => {
    const [table, link] = DROPPED_EXPORTS as [string, string];
    // The catalog's name is also a heartbeat and settings field, so only its use as the
    // schema table counts; the link table's export names nothing else.
    expect(
      grep([
        "-E",
        [
          `\\b${link}\\b`,
          `schema\\.${table}\\b`,
          `export const ${table}\\b`,
          `(^|[^A-Za-z0-9_])${escape(DROPPED_KEY)}([^A-Za-z0-9_]|$)`,
        ].join("|"),
      ]),
    ).toBe("");
    for (const name of DROPPED_EXPORTS) {
      expect(schema).not.toHaveProperty(name);
      expect(db).not.toHaveProperty(name);
    }
  });

  it("the agents table has none of the dropped columns", () => {
    const columns = Object.values(getTableColumns(schema.agents)).map((column) => column.name);
    for (const name of DROPPED_COLUMNS) expect(columns).not.toContain(name);
  });
});
