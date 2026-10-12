"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Cluster,
  Muted,
  Stack,
} from "@iamthemcmaster/ui";
import { IconWebhook } from "@tabler/icons-react";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import { recreateGitLabWebhook } from "./actions";

/** A problem found by the daily GitLab check (`scm_connections.health`). */
export interface ConnectionProblemRow {
  code: string;
  message: string;
  /** The project the problem is about (webhook problems). */
  repositoryId?: string;
}

/** A GitLab connection's last daily check. */
export interface ConnectionHealthRow {
  /** ISO timestamp. */
  checkedAt: string;
  /** ISO date the bot token expires, when GitLab reports it. */
  tokenExpiresAt: string | null;
  problems: ConnectionProblemRow[];
}

const WEBHOOK_PROBLEMS = new Set(["webhook_missing", "webhook_events_outdated"]);

function expiry(tokenExpiresAt: string | null): string {
  return tokenExpiresAt
    ? `The bot token expires on ${tokenExpiresAt}.`
    : "GitLab doesn't report when the bot token expires.";
}

/** What the connection's admins are told about a problem. */
export function problemText(problem: ConnectionProblemRow, health: ConnectionHealthRow): string {
  switch (problem.code) {
    case "access_token_bot":
      return (
        "The bot token is a group or project access token, so agents' clones and pushes will fail: " +
        "GitLab doesn't let those create the project access tokens agents use. Reconnect GitLab " +
        "with a service account's personal access token (api scope, Maintainer on the projects)."
      );
    case "token_expiring":
      return `${expiry(health.tokenExpiresAt)} Omniralph rotates it daily; if it isn't rotated in time, reconnect GitLab with a new token.`;
    case "rotation_unsupported":
      return `${problem.message} ${expiry(health.tokenExpiresAt)}`;
    default:
      return problem.message;
  }
}

function RecreateWebhookButton({ repositoryId }: { repositoryId: string }) {
  const { pending, run } = useAction();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() => run(() => recreateGitLabWebhook(repositoryId), "Webhook recreated")}
    >
      <IconWebhook size={14} />
      {pending ? "Recreating…" : "Recreate webhook"}
    </Button>
  );
}

/**
 * A GitLab connection's token expiry, last check and problems, with a Recreate webhook
 * button for each project whose webhook is missing or outdated (admins only).
 */
export function ConnectionHealth({
  health,
  isAdmin,
}: {
  health: ConnectionHealthRow | null;
  isAdmin: boolean;
}) {
  if (!health) {
    return <Muted className="text-xs">Not checked yet (checked daily).</Muted>;
  }
  return (
    <Stack gap={2}>
      <Muted className="text-xs">
        {health.tokenExpiresAt ? `Token expires ${health.tokenExpiresAt}` : "Token expiry unknown"}{" "}
        · Last checked {formatDateTime(health.checkedAt)}
      </Muted>
      {health.problems.length > 0 && (
        <Alert variant="warning">
          <AlertTitle as="h3">
            {health.problems.length === 1
              ? "1 problem with this connection"
              : `${health.problems.length} problems with this connection`}
          </AlertTitle>
          <AlertDescription>
            <Stack asChild gap={2} className="m-0 pl-4">
              <ul>
                {health.problems.map((problem, i) => (
                  <li
                    key={`${problem.code}-${problem.repositoryId ?? i}`}
                    data-problem={problem.code}
                  >
                    <Cluster gap={2}>
                      <span className="flex-1">{problemText(problem, health)}</span>
                      {isAdmin && problem.repositoryId && WEBHOOK_PROBLEMS.has(problem.code) && (
                        <RecreateWebhookButton repositoryId={problem.repositoryId} />
                      )}
                    </Cluster>
                  </li>
                ))}
              </ul>
            </Stack>
          </AlertDescription>
        </Alert>
      )}
    </Stack>
  );
}
