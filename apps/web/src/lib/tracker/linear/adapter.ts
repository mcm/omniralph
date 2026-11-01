/** The Linear tracker's web adapter (`TrackerWebAdapter`), registered in `../adapters.ts`. */
import "server-only";
import { classifyWebhook, type LinearGateway } from "@omniralph/tracker/linear";
import { fixtureLinearEnabled, fixtureLinearGateway } from "@omniralph/tracker/linear/testing";
import type { TrackerGateway } from "@omniralph/tracker";
import type { TrackerExtras, TrackerWebAdapter } from "../adapter";
import {
  disconnectedLinearGateway,
  getLinearGateway,
  lazyLinearGateway,
  type LinearGatewayOptions,
} from "./client";
import { replayLinearDelivery } from "./ingest";
import { revokeToken, type LinearCredentials } from "./oauth";
import { createLinearIssueWithExtras, isLinearGateway, linearIssuePlacement } from "./placement";

/** Names de-duplicated ignoring case (the first spelling wins), sorted. */
function uniqueNames(names: string[]): string[] {
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = name.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, name);
  }
  return [...byKey.values()].sort((a, b) => a.localeCompare(b));
}

/** Linear's reads beyond the neutral gateway. */
export function linearExtras(gateway: LinearGateway): TrackerExtras {
  return {
    routingIssue: (idOrIdentifier) => gateway.getRoutingFields(idOrIdentifier),
    issuePlacement: (issueId) => linearIssuePlacement(gateway, issueId),
    createIssueWithExtras: (input, extras) => createLinearIssueWithExtras(gateway, input, extras),
    listIssuesWithRouting: (filter) => gateway.listIssues({ ...filter, withRoutingFields: true }),
    async settingsOptions() {
      const [milestones, cycles, users] = await Promise.all([
        gateway.listProjectMilestones(),
        gateway.listCycles(),
        gateway.listUsers(),
      ]);
      return {
        projectMilestones: uniqueNames(milestones.map((m) => m.name)),
        cycles: cycles
          .map((c) => ({ id: c.id, number: c.number, name: c.name, teamKey: c.teamKey }))
          .sort((a, b) => a.teamKey.localeCompare(b.teamKey) || a.number - b.number),
        users: users
          .map((u) => ({ id: u.id, name: u.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      };
    },
  };
}

export const linearWebAdapter: TrackerWebAdapter = {
  provider: "linear",
  name: "Linear",
  getGateway({ db, organizationId, fixtures, refreshTimeoutMs }) {
    const options: LinearGatewayOptions = {
      db,
      organizationId,
      ...(refreshTimeoutMs !== undefined && { refreshTimeoutMs }),
      ...(fixtures && fixtureLinearEnabled() && { createGateway: fixtureLinearGateway }),
    };
    return getLinearGateway(options);
  },
  disconnectedGateway: disconnectedLinearGateway,
  // Its loads are the organization's Linear gateway (or a Linear test fake).
  lazyGateway: (load) => lazyLinearGateway(load as () => Promise<LinearGateway>),
  extras: (gateway: TrackerGateway) => (isLinearGateway(gateway) ? linearExtras(gateway) : null),
  revokeCredentials: (credentials) => revokeToken((credentials as LinearCredentials).accessToken),
  parseDelivery: classifyWebhook,
  replayDelivery: replayLinearDelivery,
};
