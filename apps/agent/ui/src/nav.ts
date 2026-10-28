/**
 * The agent page's sections, in the section nav's three groups. A section gets a coral dot
 * only for its problem in `/api/state` (Design rules 9 and 15), with the reason in its
 * accessible name ("Claude, not signed in").
 */
import type { SectionNavGroup, SectionNavItem } from "@omniralph/ui";
import type { NavProblem, NavProblemSection } from "./state.js";

/** The section list at narrow widths; Overview beside the nav when both fit. */
export const INDEX_PATH = "/";

export interface AgentSection {
  label: string;
  href: string;
  group: "Agent" | "Settings" | "Machine";
  /** The problem that puts a dot on its nav entry. */
  problem?: NavProblemSection;
}

export const AGENT_SECTIONS = {
  // Overview has its own path: at narrow widths `/` is the section list.
  overview: { label: "Overview", href: "/overview", group: "Agent", problem: "overview" },
  logs: { label: "Logs", href: "/logs", group: "Agent" },
  capacity: { label: "Capacity", href: "/capacity", group: "Settings" },
  packages: { label: "Packages", href: "/packages", group: "Settings" },
  hostTools: { label: "Host tools", href: "/host-tools", group: "Settings", problem: "host_tools" },
  version: { label: "Version", href: "/version", group: "Settings", problem: "version" },
  claude: { label: "Claude", href: "/claude", group: "Machine", problem: "claude" },
  storage: { label: "Storage", href: "/storage", group: "Machine", problem: "storage" },
} as const satisfies Record<string, AgentSection>;

export type AgentSectionKey = keyof typeof AGENT_SECTIONS;

const GROUPS: readonly AgentSection["group"][] = ["Agent", "Settings", "Machine"];

export function agentNavGroups(problems: readonly NavProblem[]): SectionNavGroup[] {
  const sections: readonly AgentSection[] = Object.values(AGENT_SECTIONS);
  return GROUPS.map((group) => ({
    label: group,
    items: sections
      .filter((section) => section.group === group)
      .map((section): SectionNavItem => {
        const problem = problems.find((entry) => entry.section === section.problem);
        return {
          label: section.label,
          href: section.href,
          ...(problem && { indicator: { tone: "fail", label: problem.reason } }),
        };
      }),
  }));
}
