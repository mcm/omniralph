import {
  getChatPlaybookDefaults,
  listChatChannelPlaybookBindings,
  listRepositoryPlaybookBindings,
  listStoredPlaybooks,
  type ChatPlaybooks,
  type Database,
} from "@omniralph/db";
import { DEFAULT_PR_DESCRIPTION_TASK_ID } from "@omniralph/tasks";
import { listPlaybooks, type RepositoryBinding } from "./index";

/** A repository binding one or more of its roles to the playbook. */
export interface RepositoryPlaybookReference {
  id: string;
  fullPath: string;
  /** The repository roles bound to it, in `REPOSITORY_BINDING_ROLES` order. */
  roles: RepositoryBinding[];
}

/** A chat channel override running the playbook. */
export interface ChatChannelPlaybookReference {
  connectionId: string;
  connectionName: string;
  channelId: string;
  /** The channel's chat playbooks it is. */
  roles: (keyof ChatPlaybooks)[];
}

/** A story or request playbook naming the playbook as its PR description playbook. */
export interface CodingPlaybookReference {
  id: string;
  name: string;
  builtin: boolean;
}

/** What runs a playbook: settings and other playbooks of the organization naming it. */
export interface PlaybookReferrers {
  repositories: RepositoryPlaybookReference[];
  /** The organization's chat playbooks (`chat.playbooks`, or the built-in defaults) it is. */
  chatPlaybooks: (keyof ChatPlaybooks)[];
  /** Chat channel overrides (`chat_channel_task_settings`) running it. */
  chatChannels: ChatChannelPlaybookReference[];
  /** Story and request playbooks with it as their PR description playbook. */
  playbooks: CodingPlaybookReference[];
}

/** Whether nothing uses the playbook. */
export function hasNoReferrers(referrers: PlaybookReferrers): boolean {
  return (
    referrers.repositories.length === 0 &&
    referrers.chatPlaybooks.length === 0 &&
    referrers.chatChannels.length === 0 &&
    referrers.playbooks.length === 0
  );
}

function noReferrers(): PlaybookReferrers {
  return { repositories: [], chatPlaybooks: [], chatChannels: [], playbooks: [] };
}

/** The PR description playbook a stored playbook's raw definition names, if any. */
function storedPrDescriptionPlaybookId(definition: Record<string, unknown>): unknown {
  const coding = definition.coding;
  return typeof coding === "object" && coding !== null
    ? (coding as Record<string, unknown>).prDescriptionPlaybookId
    : undefined;
}

/** Each playbook ID's referrers in the organization; `get` answers an empty set for an unused one. */
export interface PlaybookUsage {
  get(playbookId: string): PlaybookReferrers;
}

/**
 * What uses each playbook in the organization: repository bindings, chat
 * settings and story and request playbooks naming it as their PR description
 * playbook (built-ins without one name the default). Stored playbooks that no
 * longer resolve still count when their raw definition names one, so deleting
 * it can't leave them pointing nowhere.
 */
export async function loadPlaybookUsage(
  db: Database,
  organizationId: string,
): Promise<PlaybookUsage> {
  const [repositories, chatDefaults, chatChannels, codingPlaybooks, storedRows] = await Promise.all(
    [
      listRepositoryPlaybookBindings(db, organizationId),
      getChatPlaybookDefaults(db, organizationId),
      listChatChannelPlaybookBindings(db, organizationId),
      listPlaybooks(db, organizationId, { taskType: "coding" }),
      listStoredPlaybooks(db, organizationId),
    ],
  );
  const usage = new Map<string, PlaybookReferrers>();
  const of = (id: string) => {
    let referrers = usage.get(id);
    if (!referrers) usage.set(id, (referrers = noReferrers()));
    return referrers;
  };

  for (const repository of repositories) {
    const bound: [RepositoryBinding, string][] = [
      ...repository.reviewPlaybookIds.map((id): [RepositoryBinding, string] => ["review", id]),
      ["correlation", repository.correlationPlaybookId],
      ["story", repository.storyPlaybookId],
      ["request", repository.requestPlaybookId],
    ];
    for (const id of new Set(bound.map(([, id]) => id))) {
      of(id).repositories.push({
        id: repository.id,
        fullPath: repository.fullPath,
        roles: bound.filter(([, bindingId]) => bindingId === id).map(([role]) => role),
      });
    }
  }
  for (const role of Object.keys(chatDefaults) as (keyof ChatPlaybooks)[]) {
    of(chatDefaults[role]).chatPlaybooks.push(role);
  }
  for (const channel of chatChannels) {
    const bound: [keyof ChatPlaybooks, string | null][] = [
      ["ask", channel.askPlaybookId],
      ["startWork", channel.startWorkPlaybookId],
    ];
    for (const id of new Set(bound.flatMap(([, id]) => id ?? []))) {
      of(id).chatChannels.push({
        connectionId: channel.connectionId,
        connectionName: channel.connectionName,
        channelId: channel.channelId,
        roles: bound.filter(([, bindingId]) => bindingId === id).map(([role]) => role),
      });
    }
  }
  const counted = new Set<string>();
  for (const { playbook, builtin } of codingPlaybooks) {
    const describer = playbook.coding?.prDescriptionPlaybookId ?? DEFAULT_PR_DESCRIPTION_TASK_ID;
    of(describer).playbooks.push({ id: playbook.id, name: playbook.name, builtin });
    counted.add(playbook.id);
  }
  for (const row of storedRows) {
    const describer = storedPrDescriptionPlaybookId(row.definition);
    if (counted.has(row.id) || typeof describer !== "string") continue;
    of(describer).playbooks.push({ id: row.id, name: row.name, builtin: false });
  }

  return { get: (id) => usage.get(id) ?? noReferrers() };
}

/** What uses playbook `playbookId` in the organization (`loadPlaybookUsage`). */
export async function findPlaybookReferrers(
  db: Database,
  organizationId: string,
  playbookId: string,
): Promise<PlaybookReferrers> {
  return (await loadPlaybookUsage(db, organizationId)).get(playbookId);
}
