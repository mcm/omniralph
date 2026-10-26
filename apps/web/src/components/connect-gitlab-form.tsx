"use client";

import { Button, Field, TextInput } from "@omniralph/ui";
import { IconPlugConnected } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import type { z } from "zod";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { connectedGitLabSchema, type ScmConnectionListRow } from "@/lib/api/repositories";
import "./connect-gitlab-form.css";

export interface ConnectGitLabFormProps {
  /** The organization the connection is for (the user must be an admin there). */
  organizationId: string;
  /** The GitLab URL prefilled (`defaultGitLabUrl` from `GET /api/ui/repositories/setup`). */
  defaultGitLabUrl: string;
  /** After GitLab is connected: the connection, as `GET /api/ui/scm-connections` lists it. */
  onConnected: (connection: ScmConnectionListRow) => void;
  /** Shows "Cancel", which calls it. */
  onCancel?: () => void;
}

/**
 * Connects GitLab with a bot's access token (`POST /api/ui/gitlab-connections`): the GitLab
 * URL and token, validated by the server, whose message shows under the form when it refuses
 * them. Built once for every place that connects GitLab.
 */
export function ConnectGitLabForm({
  organizationId,
  defaultGitLabUrl,
  onConnected,
  onCancel,
}: ConnectGitLabFormProps) {
  const [baseUrl, setBaseUrl] = useState(defaultGitLabUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connect = useApiMutation<z.infer<typeof connectedGitLabSchema>, void>({
    // No organization header: the organization may not be the active one.
    mutationFn: () =>
      api.post("/api/ui/gitlab-connections", connectedGitLabSchema, {
        body: { baseUrl, token, organizationId },
      }),
    // The caller shows the connection from the response; its change event reconciles.
    applyResult: () => undefined,
    invalidate: () => [],
    success: "GitLab connected",
    onSuccess: (result) => {
      setToken("");
      onConnected(result.connection);
    },
    onError: (failure) => setError(failure.message),
  });
  const pending = connect.isPending;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    connect.mutate();
  };

  return (
    <form className="or-connect-gitlab" aria-label="Connect GitLab" onSubmit={submit} noValidate>
      <Field label="GitLab URL" description="gitlab.com or your self-managed instance." stacked>
        <TextInput
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="https://gitlab.com"
          autoComplete="url"
          required
        />
      </Field>
      <Field
        label="Access token"
        description="A service account's personal access token with the api scope and the Maintainer role on the projects."
        stacked
      >
        <TextInput
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="glpat-…"
          autoComplete="off"
          required
        />
      </Field>
      {error ? (
        <p role="alert" className="or-connect-gitlab__error">
          {error}
        </p>
      ) : null}
      <div className="or-connect-gitlab__actions">
        {onCancel ? (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        ) : null}
        <Button type="submit" variant="solid" icon={IconPlugConnected} disabled={pending}>
          {pending ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </form>
  );
}
