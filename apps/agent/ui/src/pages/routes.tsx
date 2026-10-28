/**
 * Which page a path shows. Each section's page fills its `AgentPage`; an attempt opens from
 * Overview, so Overview stays the active nav entry there.
 */
import { EmptyState, TextLink } from "@omniralph/ui";
import type { ReactNode } from "react";
import { AGENT_SECTIONS, INDEX_PATH, type AgentSectionKey } from "../nav.js";
import { AgentPage } from "./page.js";

export interface AgentRoute {
  /** The nav entry it belongs to; null for an unknown path. */
  section: AgentSectionKey | null;
  page: ReactNode;
  /** The link back to the section list at narrow widths; none where the page has its own. */
  backLink?: { label: string; href: string };
}

const BACK_TO_AGENT = { label: "Agent", href: INDEX_PATH };

function sectionPage(section: AgentSectionKey): ReactNode {
  return <AgentPage title={AGENT_SECTIONS[section].label} />;
}

export function routeFor(path: string): AgentRoute {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (trimmed === INDEX_PATH) return { section: "overview", page: sectionPage("overview") };
  const attempt = /^\/attempts\/([^/]+)$/.exec(trimmed);
  if (attempt) {
    return {
      section: "overview",
      page: (
        <AgentPage title="Attempt">
          <TextLink href={AGENT_SECTIONS.overview.href}>‹ Overview</TextLink>
        </AgentPage>
      ),
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
