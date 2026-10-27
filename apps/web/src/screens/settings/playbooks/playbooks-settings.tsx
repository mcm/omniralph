"use client";

import {
  Button,
  DataTable,
  EmptyState,
  MetaBadge,
  RepoBadge,
  type DataTableColumn,
} from "@omniralph/ui";
import { IconMessageCircle } from "@tabler/icons-react";
import type { PlaybookSummary, PlaybookUsedBy } from "@/lib/api/playbooks";
import { modelLabel, PLAYBOOK_ROLE_LABELS, playbookHref, usedBySummary } from "./labels";
import { usePlaybooks } from "./queries";
import "./playbooks.css";

/** The list's "Used by": repo badges ("+N" past two), a "Chat" badge, or "Not used". */
export function PlaybookUsedByBadges({ usedBy }: { usedBy: PlaybookUsedBy }) {
  const { shown, more, chat } = usedBySummary(usedBy);
  if (shown.length === 0 && !chat) {
    return <span className="or-playbooks__none">Not used</span>;
  }
  return (
    <span className="or-playbooks__used-by">
      {shown.map((repo) => (
        <RepoBadge key={repo.id} host={repo.provider} name={repo.fullPath} />
      ))}
      {more > 0 ? <MetaBadge text={`+${more}`} mono /> : null}
      {chat ? <MetaBadge icon={IconMessageCircle} text="Chat" /> : null}
    </span>
  );
}

/** The table's columns: Name (the link, with "Built-in"), Role, Model and Used by. */
export function playbookColumns(): DataTableColumn<PlaybookSummary>[] {
  return [
    {
      id: "name",
      header: "Name",
      card: "title",
      cell: (playbook) => playbook.name,
    },
    {
      id: "builtin",
      header: <span className="or-sr-only">Source</span>,
      card: "status",
      cell: (playbook) => (playbook.builtin ? <MetaBadge text="Built-in" /> : null),
    },
    { id: "role", header: "Role", cell: (playbook) => PLAYBOOK_ROLE_LABELS[playbook.role] },
    {
      id: "model",
      header: "Model",
      cell: (playbook) =>
        playbook.model === null ? (
          <span className="or-playbooks__default">{modelLabel(playbook.role, playbook.model)}</span>
        ) : (
          <span className="or-mono">{playbook.model}</span>
        ),
    },
    {
      id: "used-by",
      header: "Used by",
      cell: (playbook) => <PlaybookUsedByBadges usedBy={playbook.usedBy} />,
    },
  ];
}

/**
 * Advanced › Playbooks: every built-in and custom playbook of the organization (built-ins
 * first) with its role, model and what uses it; each opens its page. Every member may look.
 * Live: a playbook saved or deleted, or a repo's bindings changed, by anyone, shows at once.
 */
export function PlaybooksSettings() {
  const query = usePlaybooks();
  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    return (
      <EmptyState
        title="Couldn't load the playbooks"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return (
    <DataTable
      caption="Playbooks"
      className="or-playbooks"
      rows={query.data.playbooks}
      getRowId={(playbook) => playbook.id}
      getRowHref={(playbook) => playbookHref(playbook.id)}
      columns={playbookColumns()}
    />
  );
}
