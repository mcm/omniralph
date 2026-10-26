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
import { Timestamp } from "@/components/list-table";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { ConnectionHealthRow, ConnectionProblemRow } from "@/lib/api/repositories";
import { mutationResultSchema } from "@/lib/api/schemas";
import { problemText, WEBHOOK_PROBLEM_CODES } from "@/lib/connections/health";

export type { ConnectionHealthRow, ConnectionProblemRow };

function RecreateWebhookButton({ repositoryId }: { repositoryId: string }) {
  const recreate = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.post(`/api/ui/repositories/${repositoryId}/webhook`, mutationResultSchema, {
        organizationId,
      }),
    // The connection's health (on the repositories list) loses the problem.
    invalidate: (keys) => [keys.repositories.lists],
    success: "Webhook recreated",
  });
  const pending = recreate.isPending;
  return (
    <Button variant="secondary" size="sm" disabled={pending} onClick={() => recreate.mutate()}>
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
        {health.tokenExpiresAt ? (
          <>
            Token expires <Timestamp iso={health.tokenExpiresAt} date inline />
          </>
        ) : (
          "Token expiry unknown"
        )}{" "}
        · Last checked <Timestamp iso={health.checkedAt} inline />
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
                      {isAdmin &&
                        problem.repositoryId &&
                        WEBHOOK_PROBLEM_CODES.includes(problem.code) && (
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
