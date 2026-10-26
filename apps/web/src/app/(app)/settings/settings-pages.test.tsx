// @vitest-environment jsdom
import { UiProvider } from "@omniralph/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CurrentUserProvider } from "@/components/current-user";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  testUser,
} from "@/components/query-test-utils";
import type { Connection } from "@/lib/api/connections";
import { ConnectionSettings } from "@/screens/settings/connection-settings";
import { settingsNavGroups } from "@/screens/settings/settings-nav";
import ConnectionSettingsPage from "./connections/[provider]/[id]/page";
import GeneralSettingsPage from "./general/page";
import SettingsIndexPage from "./page";

const navigation = vi.hoisted(() => ({
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
vi.mock("next/navigation", () => ({ notFound: navigation.notFound }));

const SETTINGS_DIR = __dirname;

/** Every `page.tsx` under `settings`, by the URL path it serves. */
function settingsPages(dir = SETTINGS_DIR, segments = ["settings"]): Map<string, string> {
  const pages = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const [route, file] of settingsPages(full, [...segments, name])) pages.set(route, file);
    } else if (name === "page.tsx") {
      pages.set(`/${segments.join("/")}`, full);
    }
  }
  return pages;
}

const gitlab: Connection = {
  provider: "gitlab",
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "om @ gitlab.netbuilder.io",
  host: "gitlab.netbuilder.io",
  account: "om",
};

beforeEach(() => {
  mockFetch({ "GET /api/ui/connections": () => jsonResponse({ connections: [gitlab] }) });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Settings pages", () => {
  it("render General on the index", () => {
    const page = SettingsIndexPage() as ReactElement;
    expect(isValidElement(page)).toBe(true);
    expect(page.type).toBe(GeneralSettingsPage);
  });

  it("exist for every entry of the section nav, Advanced included", () => {
    const pages = settingsPages();
    const hrefs = settingsNavGroups({ connections: [gitlab], showAdvanced: true }).flatMap(
      (group) => group.items.map((item) => item.href),
    );
    for (const href of hrefs) {
      const route = href.replace(
        /^\/settings\/connections\/[^/]+\/[^/]+$/,
        "/settings/connections/[provider]/[id]",
      );
      expect(pages.get(route), href).toBeDefined();
    }
    expect(pages.get("/settings")).toBeDefined();
  });
});

describe("a connection's page", () => {
  it("renders the connection by its provider and ID", async () => {
    const page = (await ConnectionSettingsPage({
      params: Promise.resolve({ provider: "gitlab", id: gitlab.id }),
    })) as ReactElement<{ provider: string; connectionId: string }>;
    expect(page.type).toBe(ConnectionSettings);
    expect(page.props).toEqual({ provider: "gitlab", connectionId: gitlab.id });
  });

  it("is not found for an unknown provider", async () => {
    await expect(
      ConnectionSettingsPage({ params: Promise.resolve({ provider: "bitbucket", id: gitlab.id }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  function renderConnection(provider: Connection["provider"], connectionId: string) {
    render(
      <CurrentUserProvider user={testUser}>
        <QueryClientProvider client={createTestQueryClient()}>
          <UiProvider>
            <ConnectionSettings provider={provider} connectionId={connectionId} />
          </UiProvider>
        </QueryClientProvider>
      </CurrentUserProvider>,
    );
  }

  it("is titled as its nav entry", async () => {
    renderConnection("gitlab", gitlab.id);
    expect(await screen.findByRole("heading", { level: 2, name: "GitLab" })).toBeTruthy();
  });

  it("says a connection the organization doesn't have doesn't exist", async () => {
    renderConnection("github", gitlab.id);
    expect(
      await screen.findByRole("heading", { name: "That connection doesn't exist" }),
    ).toBeTruthy();
  });
});
