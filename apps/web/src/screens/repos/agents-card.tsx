"use client";

import {
  AgentBadge,
  Button,
  Card,
  IconButton,
  Menu,
  MetaBadge,
  SaveBar,
  StatusText,
  type StatusTone,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { IconPinnedOff, IconPlus } from "@tabler/icons-react";
import { useMemo } from "react";
import type { z } from "zod";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { api } from "@/lib/api/client";
import {
  agentsCardSchema,
  cardSaveResultSchema,
  type AgentsCard as AgentsCardData,
  type PinnedAgent,
  type RepositoryDetail,
} from "@/lib/api/repositories";
import { agentPinnedEffect, agentUnpinnedEffect } from "@/lib/repositories/effects";
import { agentHref } from "@/lib/runs/hrefs";
import { applySavedCard } from "./mutations";
import { saveChangesLabel } from "./reviews-card";

const agentsSaveResultSchema = cardSaveResultSchema(agentsCardSchema);

/** The Agents card's one field: the pinned agents' IDs, in order. */
export interface AgentsDraft {
  pinnedAgentIds: string[];
}

interface AgentRef {
  id: string;
  name: string;
}

/** A pinned agent's state as its row shows it (Design Considerations › Agents card). */
export function agentStateText(agent: PinnedAgent): { text: string; tone: StatusTone } {
  switch (agent.state) {
    case "running":
      return { text: `Running ${agent.runningForRepo}`, tone: "run" };
    case "idle":
      return { text: "Idle", tone: "neutral" };
    case "offline":
      return { text: "Offline", tone: "fail" };
    case "updating":
      return { text: "Updating", tone: "neutral" };
    case "revoked":
      return { text: "Revoked", tone: "fail" };
  }
}

/**
 * The save bar's items: each unpinned agent (in the saved order; the last one when no agent
 * stays pinned says any agent can take the work), then each newly pinned agent.
 */
export function agentsChanges(
  agents: ReadonlyMap<string, AgentRef>,
  saved: AgentsDraft,
  draft: AgentsDraft,
): StagedChange[] {
  const ref = (id: string): AgentRef => agents.get(id) ?? { id, name: id };
  const unpinned = saved.pinnedAgentIds.filter((id) => !draft.pinnedAgentIds.includes(id));
  const pinned = draft.pinnedAgentIds.filter((id) => !saved.pinnedAgentIds.includes(id));
  const none = draft.pinnedAgentIds.length === 0;
  return [
    ...unpinned.map((id, index) =>
      agentUnpinnedEffect(ref(id), none && index === unpinned.length - 1),
    ),
    ...pinned.map((id) => agentPinnedEffect(ref(id))),
  ];
}

function toDraft(card: AgentsCardData): AgentsDraft {
  return { pinnedAgentIds: card.pinned.map((agent) => agent.id) };
}

/**
 * The Agents card: the agents the repo's work runs on (any agent when none is pinned), each
 * with its live state. Admins pin ("Pin agent", a menu of the organization's agents that
 * aren't pinned or revoked) and unpin, staged in the card's save bar with each change's
 * effect and saved in one request (`PUT /api/ui/repositories/{id}/agents`). Members see the
 * list only.
 */
export function AgentsCard({ detail, titleId }: { detail: RepositoryDetail; titleId: string }) {
  const { repository, canEdit, agents } = detail;
  const saved = useMemo(() => toDraft(agents), [agents]);
  const known = useMemo(
    () =>
      new Map<string, AgentRef>(
        [...agents.pinned, ...agents.pinnable].map((agent) => [
          agent.id,
          { id: agent.id, name: agent.name },
        ]),
      ),
    [agents],
  );
  const card = useStagedCard<AgentsDraft, z.infer<typeof agentsSaveResultSchema>>({
    label: "Agents",
    saved,
    toChanges: (from, to) => agentsChanges(known, from, to),
    save: useStagedSave({
      request: (draft, { organizationId }) =>
        api.put(
          `/api/ui/repositories/${encodeURIComponent(repository.id)}/agents`,
          agentsSaveResultSchema,
          { body: { pinnedAgentIds: draft.pinnedAgentIds }, organizationId },
        ),
      applyResult: (result, cache) =>
        applySavedCard(cache, repository.id, (previous) => ({
          ...previous,
          agents: result.card,
        })),
    }),
    onDirtyChange: useUnsavedCard("Agents"),
  });
  const { draft, set } = card;
  const disabled = !canEdit || card.saving;
  const pinnedIds = draft.pinnedAgentIds;

  // The rows: saved pins still staged (with their state), then staged new pins.
  const savedRows = agents.pinned.filter((agent) => pinnedIds.includes(agent.id));
  const newRows = pinnedIds
    .filter((id) => !saved.pinnedAgentIds.includes(id))
    .map((id) => known.get(id) ?? { id, name: id });
  // "Pin agent" offers the pinnable agents, and saved pins (not revoked) unpinned in the draft.
  const choices = [
    ...agents.pinnable,
    ...agents.pinned.filter((agent) => agent.state !== "revoked"),
  ].filter((agent) => !pinnedIds.includes(agent.id));

  const pin = (id: string) => set("pinnedAgentIds", [...pinnedIds, id]);
  const unpin = (id: string) =>
    set(
      "pinnedAgentIds",
      pinnedIds.filter((pinned) => pinned !== id),
    );
  // The same kind of add control as the Rules card's "Add rule" (Design rule 12).
  const pinButton = (
    <Button
      icon={IconPlus}
      variant="outline"
      size="sm"
      disabled={disabled || choices.length === 0}
      disabledReason={choices.length === 0 ? "Every agent is already pinned" : undefined}
    >
      Pin agent
    </Button>
  );

  return (
    <Card
      title="Agents"
      titleId={titleId}
      className="or-repo-card"
      titleAddon={
        <ChangeHistoryPopover
          section="repository.agents"
          subject={repository.id}
          organization={repository.organization.id}
          latest={detail.history.agents}
        />
      }
      actions={
        canEdit ? (
          choices.length === 0 || disabled ? (
            pinButton
          ) : (
            <Menu
              items={choices.map((agent) => ({
                label: agent.name,
                badge: <AgentBadge name={agent.name} />,
                onSelect: () => pin(agent.id),
              }))}
              trigger={pinButton}
            />
          )
        ) : null
      }
    >
      <p className="or-repo-card__help">
        Work for this repo runs only on pinned agents. With none pinned, any agent can take it.
      </p>
      {savedRows.length > 0 || newRows.length > 0 ? (
        <ul className="or-repo-agents" aria-label="Pinned agents">
          {savedRows.map((agent) => {
            const state = agentStateText(agent);
            return (
              <li key={agent.id} className="or-repo-agents__row">
                <AgentBadge name={agent.name} href={agentHref(agent.id)} />
                <StatusText tone={state.tone}>{state.text}</StatusText>
                {canEdit ? (
                  <IconButton
                    className="or-repo-agents__unpin"
                    label={`Unpin ${agent.name}`}
                    icon={IconPinnedOff}
                    size="sm"
                    disabled={disabled}
                    onClick={() => unpin(agent.id)}
                  />
                ) : null}
              </li>
            );
          })}
          {newRows.map((agent) => (
            <li
              key={agent.id}
              className="or-repo-agents__row or-repo-agents__row--pending"
              data-pending="true"
            >
              <AgentBadge name={agent.name} href={agentHref(agent.id)} />
              <MetaBadge text="Pending" />
              <IconButton
                className="or-repo-agents__unpin"
                label={`Unpin ${agent.name}`}
                icon={IconPinnedOff}
                size="sm"
                disabled={disabled}
                onClick={() => unpin(agent.id)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {canEdit ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
          saveLabel={saveChangesLabel(card.changes.length)}
        />
      ) : null}
      {card.dialog}
    </Card>
  );
}
