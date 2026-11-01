import "server-only";
import { getDb } from "@/lib/db";
import { getLinearGatewayOrDisconnected, LinearNotConnectedError } from "./client";
import { fixtureLinearEnabled, fixtureLinearGateway } from "@omniralph/tracker/linear/testing";
import type { LinearGateway } from "@omniralph/tracker/linear";
import type { LinearSettingsOptions } from "./settings-values";

export type { LinearSettingsOptions } from "./settings-values";

/** How long an organization's options are reused before Linear is asked again. */
export const LINEAR_SETTINGS_OPTIONS_TTL_MS = 5 * 60 * 1000;

/** Loads in flight or loaded, by organization ID. Failed loads are dropped. */
const cache = new Map<string, { expiresAt: number; options: Promise<LinearSettingsOptions> }>();

export interface LinearSettingsOptionsDeps {
  /**
   * The organization's workspace gateway (default: its connected one, else disconnected; with
   * `OMNIRALPH_FIXTURE_LINEAR=1` a connected workspace reads the fixture one).
   */
  gateway?: (organizationId: string) => Promise<LinearGateway>;
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

async function load(linear: LinearGateway): Promise<LinearSettingsOptions> {
  const [teams, labels, projects, milestones, cycles, users] = await Promise.all([
    linear.listTeams(),
    linear.listLabels(),
    linear.listProjects(),
    linear.listProjectMilestones(),
    linear.listCycles(),
    linear.listUsers(),
  ]);
  const states = await Promise.all(teams.map((t) => linear.getWorkflowStates(t.id)));
  return {
    teams: teams
      .map((t) => ({ key: t.key, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    labels: uniqueNames(labels.map((l) => l.name)),
    projects: uniqueNames(projects.map((p) => p.name)),
    states: uniqueNames(states.flat().map((s) => s.name)),
    projectMilestones: uniqueNames(milestones.map((m) => m.name)),
    cycles: cycles
      .map((c) => ({ id: c.id, number: c.number, name: c.name, teamKey: c.teamKey }))
      .sort((a, b) => a.teamKey.localeCompare(b.teamKey) || a.number - b.number),
    users: users
      .map((u) => ({ id: u.id, name: u.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * The organization's connected Linear teams, labels, projects, workflow
 * states, project milestones, cycles and users for the settings pickers, or null when no workspace is connected.
 * Reused for 5 minutes per organization; a disconnected workspace or a failed
 * load isn't cached.
 */
export async function getLinearSettingsOptions(
  organizationId: string,
  deps: LinearSettingsOptionsDeps = {},
): Promise<LinearSettingsOptions | null> {
  const now = (deps.now ?? Date.now)();
  let entry = cache.get(organizationId);
  if (!entry || entry.expiresAt <= now) {
    const gateway =
      deps.gateway ??
      ((id: string) =>
        getLinearGatewayOrDisconnected({
          db: getDb(),
          organizationId: id,
          ...(fixtureLinearEnabled() && { createGateway: fixtureLinearGateway }),
        }));
    const options = gateway(organizationId).then(load);
    entry = { expiresAt: now + LINEAR_SETTINGS_OPTIONS_TTL_MS, options };
    cache.set(organizationId, entry);
    const loading = entry;
    options.catch(() => {
      if (cache.get(organizationId) === loading) cache.delete(organizationId);
    });
  }
  try {
    return await entry.options;
  } catch (error) {
    if (error instanceof LinearNotConnectedError) return null;
    throw error;
  }
}

/** Forgets every cached organization's options (tests). */
export function clearLinearSettingsOptionsCache(): void {
  cache.clear();
}
