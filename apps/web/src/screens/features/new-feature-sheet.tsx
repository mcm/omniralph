"use client";

import { Button, Field, Select, Sheet, TextInput } from "@omniralph/ui";
import { useState, type FormEvent } from "react";
import { useCurrentUser } from "@/components/current-user";
import { ApiError } from "@/lib/api/client";
import { FEATURE_NAME_MAX_LENGTH } from "@/lib/api/features";
import { useRepositoryList } from "../repos/queries";
import { useCreateFeature } from "./mutations";

export const NEW_FEATURE = "New feature";
export const FEATURE_NAME_EXPLANATION = "What people call the work, e.g. Invoicing.";
export const FEATURE_REPO_EXPLANATION =
  "The repo its epics build in. Leave it unset when they span repos.";
export const NO_REPO = "No repo";

export interface NewFeatureSheetProps {
  onClose: () => void;
  /** The created feature's ID: the caller opens it to write its PRFAQ. */
  onCreated: (featureId: string) => void;
}

/**
 * New feature (a `Sheet`, the Features list's +): Name and Repo (optional), each with one
 * line on what it's for. Create (`POST /api/ui/features`) makes the feature and opens it; a
 * refusal shows the server's message and keeps what was typed.
 */
export function NewFeatureSheet({ onClose, onCreated }: NewFeatureSheetProps) {
  const { organization } = useCurrentUser();
  const repos = useRepositoryList();
  const create = useCreateFeature();
  const choices = (repos.data?.repositories ?? []).filter(
    (repo) => repo.organization.id === organization.id,
  );
  const [name, setName] = useState("");
  const [repositoryId, setRepositoryId] = useState("");
  const [error, setError] = useState<{ message: string; field: "name" | "repo" | null } | null>(
    null,
  );
  const canCreate = name.trim() !== "" && !create.isPending;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!canCreate) return;
    setError(null);
    create.mutate(
      { name: name.trim(), repositoryId: repositoryId || null },
      {
        onSuccess: (result) => {
          onCreated(result.feature.id);
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
      title={NEW_FEATURE}
      description="Plan a large piece of work as a PRFAQ and a Plan, then shard it into epics."
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
      <form className="or-new-feature" onSubmit={submit} noValidate>
        {error ? (
          <p className="or-feature__error" role="alert">
            {error.message}
          </p>
        ) : null}
        <Field label="Name" description={FEATURE_NAME_EXPLANATION} stacked>
          <TextInput
            value={name}
            required
            maxLength={FEATURE_NAME_MAX_LENGTH}
            invalid={error?.field === "name" || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Repo" description={FEATURE_REPO_EXPLANATION} stacked>
          <Select
            value={repositoryId}
            invalid={error?.field === "repo" || undefined}
            disabled={repos.isPending}
            onChange={(event) => setRepositoryId(event.target.value)}
          >
            <option value="">{repos.isPending ? "Loading repos…" : NO_REPO}</option>
            {choices.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullPath}
              </option>
            ))}
          </Select>
        </Field>
        {repos.isError ? (
          <p className="or-feature__error" role="alert">
            Couldn&apos;t load the repos. {repos.error.message}
          </p>
        ) : null}
      </form>
    </Sheet>
  );
}
