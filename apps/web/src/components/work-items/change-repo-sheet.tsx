"use client";

import { Button, Field, Select, Sheet } from "@omniralph/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import { repositoryListSchema, type RepositoryList } from "@/lib/api/repositories";
import type { WorkItemDetail } from "@/lib/api/work-items";
import { useChangeWorkItemRepository } from "./use-work-item-actions";
import "./change-repo-sheet.css";

/** The Select's value for "Use the routing rules again". */
const ROUTING_RULES = "rules";

export const CHANGE_REPO = "Change repo…";
export const USE_ROUTING_RULES = "Use the routing rules again";

/** "Om will build SOC-412 in customer-portal when it starts." */
export function willBuildIn(identifier: string, repositoryName: string): string {
  return `Om will build ${identifier} in ${repositoryName} when it starts.`;
}

/** What going back to the routing rules causes. */
export function willRoute(identifier: string): string {
  return `Om will route ${identifier} with the routing rules when it starts.`;
}

export interface ChangeRepoSheetProps {
  item: WorkItemDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Change repo… (a `Sheet`): the repo this one work item builds in when it starts, from its
 * organization's repos with Coding on (live, `GET /api/ui/repositories?organization=`), the
 * current one selected, plus "Use the routing rules again" while a choice is saved. It says
 * what the change causes. Saving closes the sheet; the routes line changes at once.
 */
export function ChangeRepoSheet({ item, open, onOpenChange }: ChangeRepoSheetProps) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  const repositories = useQuery<RepositoryList>({
    queryKey: keys.repositories.list({ organization: item.organization.id }),
    queryFn: ({ signal }) =>
      api.get("/api/ui/repositories", repositoryListSchema, {
        params: { organization: item.organization.id },
        organizationId: organization.id,
        signal,
      }),
    enabled: open,
  });
  const change = useChangeWorkItemRepository();

  const choices = (repositories.data?.repositories ?? []).filter(
    (repository) => repository.organization.id === item.organization.id && repository.codingEnabled,
  );
  const chosen = item.route.via?.kind === "choice";
  const current = item.route.repository?.id ?? "";
  const [selected, setSelected] = useState(current);

  const repository = choices.find((choice) => choice.id === selected) ?? null;
  const resetting = selected === ROUTING_RULES;
  const changed = selected !== current && (resetting || repository !== null);

  const save = () => {
    if (!changed) return;
    change.mutate({
      target: item,
      repository: repository
        ? { id: repository.id, provider: repository.provider, fullPath: repository.fullPath }
        : null,
    });
    onOpenChange(false);
  };

  return (
    <Sheet
      title={CHANGE_REPO.replace("…", "")}
      description={`The repo ${item.identifier} builds in. This changes this work item only.`}
      open={open}
      onOpenChange={onOpenChange}
      footer={
        <>
          <Button variant="solid" disabled={!changed} onClick={save}>
            Change repo
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
        </>
      }
    >
      <form
        className="or-wi-change-repo"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <Field label="Repo" stacked>
          <Select
            value={selected}
            disabled={repositories.isPending}
            onChange={(event) => setSelected(event.target.value)}
          >
            {current === "" || !choices.some((choice) => choice.id === current) ? (
              <option value={current} disabled>
                {repositories.isPending ? "Loading repos…" : "Choose a repo"}
              </option>
            ) : null}
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.fullPath}
              </option>
            ))}
            {chosen ? <option value={ROUTING_RULES}>{USE_ROUTING_RULES}</option> : null}
          </Select>
        </Field>
        {repositories.isError ? (
          <p className="or-wi-change-repo__note" role="alert">
            Couldn&apos;t load the repos. {repositories.error.message}
          </p>
        ) : repository ? (
          <p className="or-wi-change-repo__note">{willBuildIn(item.identifier, repository.name)}</p>
        ) : resetting ? (
          <p className="or-wi-change-repo__note">{willRoute(item.identifier)}</p>
        ) : null}
      </form>
    </Sheet>
  );
}
