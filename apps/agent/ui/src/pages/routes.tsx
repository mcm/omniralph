/**
 * Which page a path shows. Each section's page fills its `AgentPage`; an attempt opens from
 * Overview, so Overview stays the active nav entry there.
 */
import { EmptyState, TextLink } from "@omniralph/ui";
import type { ReactNode } from "react";
import { AGENT_SECTIONS, INDEX_PATH, type AgentSectionKey } from "../nav.js";
import { CapacityPage } from "./capacity/capacity-page.js";
import { ClaudePage } from "./claude/claude-page.js";
import { HostToolsPage } from "./host-tools/host-tools-page.js";
import { LogsPage } from "./logs/logs-page.js";
import { AttemptPage } from "./overview/attempt-page.js";
import { OverviewPage } from "./overview/overview-page.js";
import { PackagesPage } from "./packages/packages-page.js";
import { StoragePage } from "./storage/storage-page.js";
import { VersionPage } from "./version/version-page.js";

export interface AgentRoute {
  /** The nav entry it belongs to; null for an unknown path. */
  section: AgentSectionKey | null;
  page: ReactNode;
  /** The link back to the section list at narrow widths; none where the page has its own. */
  backLink?: { label: string; href: string };
}

const BACK_TO_AGENT = { label: "Agent", href: INDEX_PATH };

function sectionPage(section: AgentSectionKey): ReactNode {
  if (section === "overview") return <OverviewPage />;
  if (section === "logs") return <LogsPage />;
  if (section === "capacity") return <CapacityPage />;
  if (section === "packages") return <PackagesPage />;
  if (section === "hostTools") return <HostToolsPage />;
  if (section === "version") return <VersionPage />;
  if (section === "claude") return <ClaudePage />;
  return <StoragePage />;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function routeFor(path: string): AgentRoute {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (trimmed === INDEX_PATH) return { section: "overview", page: sectionPage("overview") };
  const attempt = /^\/attempts\/([^/]+)$/.exec(trimmed);
  if (attempt) {
    return { section: "overview", page: <AttemptPage id={decodeSegment(attempt[1]!)} /> };
  }
  // An install's output opens over Packages.
  const install = /^\/packages\/history\/([^/]+)$/.exec(trimmed);
  if (install) {
    return {
      section: "packages",
      page: <PackagesPage historyId={decodeSegment(install[1]!)} />,
      backLink: BACK_TO_AGENT,
    };
  }
  const entry = (Object.entries(AGENT_SECTIONS) as [AgentSectionKey, { href: string }][]).find(
    ([, section]) => section.href === trimmed,
  );
  if (entry) return { section: entry[0], page: sectionPage(entry[0]), backLink: BACK_TO_AGENT };
  return {
    section: null,
    page: (
      <EmptyState
        title="Page not found"
        description="This page isn't part of the agent page."
        action={<TextLink href={AGENT_SECTIONS.overview.href}>Open Overview</TextLink>}
      />
    ),
    backLink: BACK_TO_AGENT,
  };
}
