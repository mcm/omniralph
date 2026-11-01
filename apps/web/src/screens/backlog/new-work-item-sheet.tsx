"use client";

import { Button, Field, Select, Sheet, TextInput, Textarea } from "@omniralph/ui";
import { useState, type FormEvent } from "react";
import { useCurrentUser } from "@/components/current-user";
import { TriageNowCheckbox } from "@/components/work-items/triage-now-checkbox";
import {
  useCreateWorkItem,
  useWorkItemTargets,
} from "@/components/work-items/use-create-work-item";
import { ApiError } from "@/lib/api/client";
import { trackerLabel } from "@/lib/api/trackers";
import type { WorkItemRow, WorkItemTarget } from "@/lib/api/work-items";
import "./new-work-item-sheet.css";

export const NEW_WORK_ITEM = "New work item";

/**
 * "Creates a Linear work item in the SOC team, Portal project.": where the chosen repo's work
 * item match creates the item (without a project for a match of items with none), naming
 * the target's tracker.
 */
export function createsIn(target: Pick<WorkItemTarget, "tracker" | "team" | "project">): string {
  const tracker = trackerLabel(target.tracker);
  return target.project === null
    ? `Creates a ${tracker} work item in the ${target.team} team.`
    : `Creates a ${tracker} work item in the ${target.team} team, ${target.project} project.`;
}

export interface NewWorkItemSheetProps {
  /** Ends the flow (Cancel, Escape, or after a create). */
  onClose: () => void;
  /** The created item's row, already in the Backlog: the caller selects it. */
  onCreated: (item: WorkItemRow) => void;
  /** The repo chosen at first, when it's one of the choices (the Backlog's Repo filter). */
  defaultRepositoryId?: string | null;
}

/** The targets by organization, in the answer's order (organization name, then path). */
function byOrganization(targets: readonly WorkItemTarget[]) {
  const groups = new Map<string, { name: string; targets: WorkItemTarget[] }>();
  for (const target of targets) {
    const group = groups.get(target.organization.id) ?? {
      name: target.organization.name,
      targets: [],
    };
    group.targets.push(target);
    groups.set(target.organization.id, group);
  }
  return [...groups.values()];
}

/**
 * New work item (a `Sheet`, the Backlog's +): Repo (repos with Coding on and a work item
 * match, by organization under "All organizations"), Title (required), Description
 * (Markdown, optional) and Triage now (on by default). It says where the item is created.
 * Create (`POST /api/ui/work-items`) adds the returned row to the Backlog without a refetch,
 * selects it and closes; a refusal shows the server's message and keeps what was typed.
 */
export function NewWorkItemSheet({
  onClose,
  onCreated,
  defaultRepositoryId = null,
}: NewWorkItemSheetProps) {
  const user = useCurrentUser();
  const targets = useWorkItemTargets();
  const create = useCreateWorkItem();
  const choices = targets.data?.targets ?? [];

  const [picked, setPicked] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [triageNow, setTriageNow] = useState(true);
  const [error, setError] = useState<{ message: string; title: boolean } | null>(null);

  // Until the user picks one: the Repo filter's repo when it's a choice, else the first.
  const repositoryId =
    picked ??
    choices.find((target) => target.repository.id === defaultRepositoryId)?.repository.id ??
    choices[0]?.repository.id ??
    "";
  const target = choices.find((choice) => choice.repository.id === repositoryId) ?? null;
  const canCreate = target !== null && title.trim() !== "" && !create.isPending;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canCreate) return;
    setError(null);
    create.mutate(
      { repositoryId: target.repository.id, title, description, triageNow },
      {
        onSuccess: (data) => {
          onCreated(data.item);
          onClose();
        },
        onError: (failure) =>
          setError({
            message: failure.message,
            title: failure instanceof ApiError && failure.fieldErrors?.title !== undefined,
          }),
      },
    );
  };

  const option = (choice: WorkItemTarget) => (
    <option key={choice.repository.id} value={choice.repository.id}>
      {choice.repository.fullPath}
    </option>
  );

  return (
    <Sheet
      title={NEW_WORK_ITEM}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      footer={
        <>
          <Button variant="solid" disabled={!canCreate} onClick={() => submit()}>
            {create.isPending ? "Creating…" : "Create"}
          </Button>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      <form className="or-new-work-item" onSubmit={submit} noValidate>
        {error ? (
          <p className="or-new-work-item__error" role="alert">
            {error.message}
          </p>
        ) : null}
        <Field label="Repo" stacked>
          <Select
            value={repositoryId}
            disabled={targets.isPending || choices.length === 0}
            onChange={(event) => setPicked(event.target.value)}
          >
            {target === null ? (
              <option value="" disabled>
                {targets.isPending ? "Loading repos…" : "No repo picks up work items yet"}
              </option>
            ) : null}
            {user.scope === "all"
              ? byOrganization(choices).map((group) => (
                  <optgroup key={group.name} label={group.name}>
                    {group.targets.map(option)}
                  </optgroup>
                ))
              : choices.map(option)}
          </Select>
        </Field>
        {targets.isError ? (
          <p className="or-new-work-item__note" role="alert">
            Couldn&apos;t load the repos. {targets.error.message}
          </p>
        ) : target ? (
          <p className="or-new-work-item__note">{createsIn(target)}</p>
        ) : null}
        <Field label="Title" stacked>
          <TextInput
            value={title}
            required
            invalid={error?.title || undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label="Description" description="Optional. Markdown." stacked>
          <Textarea
            value={description}
            mono
            rows={8}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <TriageNowCheckbox checked={triageNow} onChange={setTriageNow} />
      </form>
    </Sheet>
  );
}
