import type * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient, queryWrapper } from "@/components/query-test-utils";
import type { HarnessRow } from "@/lib/harnesses/rows";
import { InstallablesSection } from "./harness-detail-view";
import type { InstallJobRow } from "./harness-installables";

vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** Static markup inside the providers the app shell gives (the user, a query client). */
function markup(ui: React.ReactElement): string {
  const Wrapper = queryWrapper(createTestQueryClient());
  return renderToStaticMarkup(<Wrapper>{ui}</Wrapper>);
}

const harness = { id: "6f1c2a59-2a5c-4a8e-9f0a-1d2b3c4d5e6f", revoked: false } as HarnessRow;

const jobs: InstallJobRow[] = [
  {
    id: "00000000-0000-4000-8000-000000000002",
    status: "failed",
    name: "@acme/graph",
    version: null,
    installedVersion: null,
    error: "@acme/graph isn't allowed by installables.allow",
    createdAt: "2026-10-12T11:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-000000000001",
    status: "completed",
    name: "@omniralph/hello",
    version: "1.0.0",
    installedVersion: "1.0.0",
    error: null,
    createdAt: "2026-10-12T10:00:00.000Z",
  },
];

describe("InstallablesSection", () => {
  it("lists the reported installables and the recent install jobs with status and error", () => {
    const html = markup(
      <InstallablesSection
        harness={harness}
        installables={[
          { name: "@omniralph/code-graph", version: "0.3.1" },
          { name: "@omniralph/hello", version: "1.0.0" },
        ]}
        installJobs={jobs}
      />,
    );
    expect([...html.matchAll(/data-installable="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "@omniralph/code-graph",
      "@omniralph/hello",
    ]);
    expect(html).toContain("0.3.1");
    expect([...html.matchAll(/data-install-job="([^"]+)"/g)].map((m) => m[1])).toEqual(
      jobs.map((job) => job.id),
    );
    expect(html).toContain("@acme/graph@latest");
    expect(html).toContain("Failed");
    expect(html).toContain("@acme/graph isn&#x27;t allowed by installables.allow");
    expect(html).toContain("Completed");
    expect(html).toContain("Installed 1.0.0");
    expect(html).not.toContain("No installables");
  });

  it("shows empty states when nothing is installed or was installed recently", () => {
    const html = markup(
      <InstallablesSection harness={harness} installables={[]} installJobs={[]} />,
    );
    expect(html).toContain("No installables");
    expect(html).toContain("No installs in the last 24 hours.");
    expect(html).not.toContain("data-installable=");
  });

  it("offers an Install form with the version defaulting to latest, unless revoked", () => {
    const html = markup(
      <InstallablesSection harness={harness} installables={[]} installJobs={[]} />,
    );
    expect(html).toMatch(/<input[^>]*id="install-name"/);
    expect(html).toMatch(/<input[^>]*id="install-version"[^>]*value="latest"/);
    expect(html).toContain("Install</button>");

    const revoked = markup(
      <InstallablesSection
        harness={{ ...harness, revoked: true }}
        installables={[]}
        installJobs={[]}
      />,
    );
    expect(revoked).not.toContain('id="install-name"');
  });
});
