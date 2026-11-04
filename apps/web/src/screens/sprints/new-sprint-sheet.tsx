"use client";

import { Button, Field, Select, Sheet, Switch, TextInput } from "@omniralph/ui";
import { useId, useState, type FormEvent } from "react";
import { useCurrentUser } from "@/components/current-user";
import { ApiError } from "@/lib/api/client";
import { SPRINT_NAME_MAX_LENGTH } from "@/lib/api/sprints";
import { useRepositoryList } from "../repos/queries";
import { useCreateSprint } from "./mutations";
import { MERGE_TOGETHER_EXPLANATION, NAME_EXPLANATION } from "./sprint-editor";

export const NEW_SPRINT = "New sprint";
export const REPO_EXPLANATION = "A sprint's epics all come from this repo's backlog.";

export interface NewSprintSheetProps {
  onClose: () => void;
  /** The created draft's ID: the caller opens it to add epics. */
  onCreated: (sprintId: string) => void;
}

/**
 * New sprint (a `Sheet`, the Sprints list's +): Repo (the active organization's repos), Name
 * and Merge together, each with one line on what it does. Create (`POST /api/ui/sprints`)
 * makes an empty draft and opens it; a refusal shows the server's message and keeps what
 * was typed.
 */
export function NewSprintSheet({ onClose, onCreated }: NewSprintSheetProps) {
  const { organization } = useCurrentUser();
  const repos = useRepositoryList();
  const create = useCreateSprint();
  const mergeHintId = useId();
  const choices = (repos.data?.repositories ?? []).filter(
    (repo) => repo.organization.id === organization.id,
  );

  const [picked, setPicked] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [mergeTogether, setMergeTogether] = useState(false);
  const [error, setError] = useState<{ message: string; field: "name" | "repo" | null } | null>(
    null,
  );

  const repositoryId = picked ?? choices[0]?.id ?? "";
  const canCreate = repositoryId !== "" && name.trim() !== "" && !create.isPending;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canCreate) return;
    setError(null);
    create.mutate(
      { repositoryId, name: name.trim(), mergeTogether },
      {
        onSuccess: (result) => {
          onCreated(result.sprint.id);
          onClose();
        },
        onError: (failure) => {
          const fields = failure instanceof ApiError ? failure.fieldErrors : undefined;
          setError({
            message: failure.message,
            field: fields?.name ? "name" : fields?.repositoryId ? "repo" : null,
          });
        },
      },
    );
  };

  return (
    <Sheet
      title={NEW_SPRINT}
      description="Line up epics of one repo for Om to build in order."
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
      <form className="or-new-sprint" onSubmit={submit} noValidate>
        {error ? (
          <p className="or-sprint__error" role="alert">
            {error.message}
          </p>
        ) : null}
        <Field label="Repo" description={REPO_EXPLANATION} stacked>
          <Select
            value={repositoryId}
            invalid={error?.field === "repo" || undefined}
            disabled={repos.isPending || choices.length === 0}
            onChange={(event) => setPicked(event.target.value)}
          >
            {repositoryId === "" ? (
              <option value="" disabled>
                {repos.isPending ? "Loading repos…" : "No repos yet"}
              </option>
            ) : null}
            {choices.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullPath}
              </option>
            ))}
          </Select>
        </Field>
        {repos.isError ? (
          <p className="or-sprint__error" role="alert">
            Couldn&apos;t load the repos. {repos.error.message}
          </p>
        ) : null}
        <Field label="Name" description={NAME_EXPLANATION} stacked>
          <TextInput
            value={name}
            required
            maxLength={SPRINT_NAME_MAX_LENGTH}
            invalid={error?.field === "name" || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="or-sprint__switch">
          <Switch
            label="Merge together"
            checked={mergeTogether}
            aria-describedby={mergeHintId}
            onCheckedChange={setMergeTogether}
          />
          <p id={mergeHintId} className="or-sprint__hint">
            {MERGE_TOGETHER_EXPLANATION}
          </p>
        </div>
      </form>
    </Sheet>
  );
}
