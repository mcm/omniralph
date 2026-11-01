import "server-only";
import type { TrackerGateway } from "@omniralph/tracker";
import { getDb } from "@/lib/db";
import { trackerExtras } from "./adapters";
import { getTrackerGatewayOrDisconnected } from "./client";
import { TrackerNotConnectedError } from "./errors";
import type { TrackerSettingsOptions } from "./settings-values";

export type { TrackerSettingsOptions } from "./settings-values";

/** How long an organization's options are reused before the tracker is asked again. */
export const TRACKER_SETTINGS_OPTIONS_TTL_MS = 5 * 60 * 1000;

/** Loads in flight or loaded, by organization ID. Failed loads are dropped. */
const cache = new Map<string, { expiresAt: number; options: Promise<TrackerSettingsOptions> }>();

export interface TrackerSettingsOptionsDeps {
  /**
   * The organization's tracker gateway (default: its connected one, else disconnected; in
   * the provider's fixture mode a connected tracker reads the fixture workspace).
   */
  gateway?: (organizationId: string) => Promise<TrackerGateway>;
  now?: () => number;
}

/** Names de-duplicated ignoring case (the first spelling wins), sorted. */
function uniqueNames(names: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

async function load(tracker: TrackerGateway): Promise<TrackerSettingsOptions> {
  const extras = trackerExtras(tracker);
  const [teams, labels, projects, more] = await Promise.all([
    tracker.listTeams(),
    tracker.listLabels(),
    tracker.listProjects(),
    extras ? extras.settingsOptions() : { projectMilestones: [], cycles: [], users: [] },
  ]);
  const states = await Promise.all(teams.map((t) => tracker.getWorkflowStates(t.id)));
  return {
    teams: teams
      .map((t) => ({ key: t.key, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    labels: uniqueNames(labels.map((l) => l.name)),
    projects: uniqueNames(projects.map((p) => p.name)),
    states: uniqueNames(states.flat().map((s) => s.name)),
    ...more,
  };
}

/**
 * The organization's connected tracker's teams, labels, projects, workflow states and (where
 * the tracker has them) project milestones, cycles and users for the settings pickers, or
 * null when no tracker is connected. Reused for 5 minutes per organization; a disconnected
 * tracker or a failed load isn't cached.
 */
export async function getTrackerSettingsOptions(
  organizationId: string,
  deps: TrackerSettingsOptionsDeps = {},
): Promise<TrackerSettingsOptions | null> {
  const now = (deps.now ?? Date.now)();
  let entry = cache.get(organizationId);
  if (!entry || entry.expiresAt <= now) {
    const gateway =
      deps.gateway ??
      ((id: string) =>
        getTrackerGatewayOrDisconnected({ db: getDb(), organizationId: id, fixtures: true }));
    const options = gateway(organizationId).then(load);
    entry = { expiresAt: now + TRACKER_SETTINGS_OPTIONS_TTL_MS, options };
    cache.set(organizationId, entry);
    const loading = entry;
    options.catch(() => {
      if (cache.get(organizationId) === loading) cache.delete(organizationId);
    });
  }
  try {
    return await entry.options;
  } catch (error) {
    if (error instanceof TrackerNotConnectedError) return null;
    throw error;
  }
}

/** Forgets every cached organization's options (tests). */
export function clearTrackerSettingsOptionsCache(): void {
  cache.clear();
}
