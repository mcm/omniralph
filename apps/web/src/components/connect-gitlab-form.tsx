"use client";

import { Button, Field, TextInput } from "@omniralph/ui";
import { IconPlugConnected } from "@tabler/icons-react";
import { useState, type FormEvent } from "react";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import { gitLabTokenResultSchema, type GitLabTokenResult } from "@/lib/api/connections";
import { connectedGitLabSchema, type ScmConnectionListRow } from "@/lib/api/repositories";
import "./connect-gitlab-form.css";

interface ConnectGitLabFormBase {
  /** The organization the connection is for (the user must be an admin there). */
  organizationId: string;
  /**
   * The GitLab URL prefilled (`defaultGitLabUrl` from `GET /api/ui/repositories/setup`), or
   * the connection's instance when replacing its token.
   */
  defaultGitLabUrl: string;
  /** Shows "Cancel", which calls it. */
  onCancel?: () => void;
}

export type ConnectGitLabFormProps = ConnectGitLabFormBase &
  (
    | {
        replaceConnectionId?: undefined;
        /** After GitLab is connected: the connection, as `GET /api/ui/scm-connections` lists it. */
        onConnected: (connection: ScmConnectionListRow) => void;
        onReplaced?: undefined;
      }
    | {
        /**
         * Replaces this connection's bot token instead (`PUT /api/ui/connections/gitlab/{id}`):
         * the instance URL is read-only, and the token must belong to the same GitLab user.
         */
        replaceConnectionId: string;
        onConnected?: undefined;
        /** After the token was replaced: the connection's re-checked health. */
        onReplaced: (result: GitLabTokenResult) => void;
      }
  );

type Submitted =
  | { kind: "connected"; connection: ScmConnectionListRow }
  | { kind: "replaced"; result: GitLabTokenResult };

/**
 * Connects GitLab with a bot's access token (`POST /api/ui/gitlab-connections`): the GitLab
 * URL and token, validated by the server, whose message shows under the form when it refuses
 * them. With `replaceConnectionId`, replaces that connection's token on its instance instead.
 * Built once for every place that connects GitLab.
 */
export function ConnectGitLabForm({
  organizationId,
  defaultGitLabUrl,
  onCancel,
  ...mode
}: ConnectGitLabFormProps) {
  const replacing = mode.replaceConnectionId !== undefined;
  const [baseUrl, setBaseUrl] = useState(defaultGitLabUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const connect = useApiMutation<Submitted, void>({
    // No organization header: the organization may not be the active one.
    mutationFn: async () =>
      mode.replaceConnectionId !== undefined
        ? {
            kind: "replaced",
            result: await api.put(
              `/api/ui/connections/gitlab/${encodeURIComponent(mode.replaceConnectionId)}`,
              gitLabTokenResultSchema,
              { body: { token } },
            ),
          }
        : {
            kind: "connected",
            connection: (
              await api.post("/api/ui/gitlab-connections", connectedGitLabSchema, {
                body: { baseUrl, token, organizationId },
              })
            ).connection,
          },
    // The caller shows the connection from the response; its change event reconciles.
    applyResult: () => undefined,
    invalidate: () => [],
    success: replacing ? "Token replaced" : "GitLab connected",
    onSuccess: (submitted) => {
      setToken("");
      if (submitted.kind === "replaced") mode.onReplaced?.(submitted.result);
      else mode.onConnected?.(submitted.connection);
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
    <form
      className="or-connect-gitlab"
      aria-label={replacing ? "Replace the GitLab token" : "Connect GitLab"}
      onSubmit={submit}
      noValidate
    >
      <Field
        label="GitLab URL"
        description={replacing ? undefined : "gitlab.com or your self-managed instance."}
        stacked
      >
        <TextInput
          type="url"
          value={baseUrl}
          readOnly={replacing}
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
          {replacing
            ? pending
              ? "Replacing…"
              : "Replace token"
            : pending
              ? "Connecting…"
              : "Connect"}
        </Button>
      </div>
    </form>
  );
}
