"use client";

import { Button, StatusText, type StatusTone } from "@omniralph/ui";
import { IconWebhook } from "@tabler/icons-react";
import type { z } from "zod";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { ScmConnectionListRow } from "@/lib/api/repositories";
import { mutationResultSchema } from "@/lib/api/schemas";
import { WEBHOOK_PROBLEM_CODES, type ConnectionHealthSummary } from "@/lib/connections/health";
import "./connection-health.css";

export type { ConnectionHealthSummary };

/** "Expires Nov 2": the bot token's expiry date, month and day. */
function expiryLabel(expiresAt: string | undefined): string {
  if (!expiresAt) return "Expires soon";
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt);
  const date = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: dateOnly ? "UTC" : undefined,
  });
  return `Expires ${date}`;
}

/** The token-health line of each state: its words and tone. */
export function healthLine(health: ConnectionHealthSummary): { label: string; tone: StatusTone } {
  switch (health.state) {
    case "healthy":
      return { label: "Healthy", tone: "good" };
    case "expiring":
      return { label: expiryLabel(health.expiresAt), tone: "neutral" };
    case "needs_attention":
      return { label: "Needs attention", tone: "fail" };
    case "not_checked":
      return { label: "Not checked yet", tone: "neutral" };
    case "connected":
      return { label: "Connected", tone: "neutral" };
  }
}

function RecreateWebhookButton({
  repositoryId,
  onRecreated,
}: {
  repositoryId: string;
  onRecreated?: ConnectionHealthProps["onWebhookRecreated"];
}) {
  const recreate = useApiMutation<z.infer<typeof mutationResultSchema>, void>({
    // No organization header: the repo may belong to another of the user's organizations.
    mutationFn: () =>
      api.post(
        `/api/ui/repositories/${encodeURIComponent(repositoryId)}/webhook`,
        mutationResultSchema,
      ),
    applyResult: (_result, cache) => onRecreated?.(repositoryId, cache),
    // The connection and repository change events reconcile the views.
    invalidate: () => [],
    success: "Webhook recreated",
  });
  return (
    <Button
      variant="outline"
      size="sm"
      icon={IconWebhook}
      disabled={recreate.isPending}
      onClick={() => recreate.mutate()}
    >
      {recreate.isPending ? "Recreating…" : "Recreate webhook"}
    </Button>
  );
}

export interface ConnectionHealthProps {
  /** `connectionHealth(connection)`, as `GET /api/ui/scm-connections` answers it. */
  health: ScmConnectionListRow["health"];
  /** Offers "Recreate webhook" for each repo-specific webhook problem (admins). */
  canRecreateWebhook?: boolean;
  /**
   * After a webhook was recreated: write the view without the problem into the cache
   * (`withoutWebhookProblems`), so it goes at once.
   */
  onWebhookRecreated?: (repositoryId: string, cache: MutationCache) => Promise<void> | void;
  className?: string;
}

/**
 * A code-host connection's health: the token-health line ("Healthy", "Expires Nov 2",
 * "Needs attention", "Not checked yet", or "Connected" for GitHub) and, when it needs
 * attention, each problem's sentence, with "Recreate webhook" for a repo's webhook problem.
 */
export function ConnectionHealth({
  health,
  canRecreateWebhook = false,
  onWebhookRecreated,
  className,
}: ConnectionHealthProps) {
  const { label, tone } = healthLine(health);
  const problems = health.state === "needs_attention" ? health.problems : [];
  return (
    <div className={["or-connection-health", className].filter(Boolean).join(" ")}>
      <StatusText tone={tone}>{label}</StatusText>
      {problems.length > 0 ? (
        <ul className="or-connection-health__problems">
          {problems.map((problem, index) => (
            <li
              key={`${problem.code}-${problem.repositoryId ?? index}`}
              className="or-connection-health__problem"
              data-problem={problem.code}
            >
              <span className="or-connection-health__sentence">{problem.sentence}</span>
              {canRecreateWebhook &&
              problem.repositoryId &&
              WEBHOOK_PROBLEM_CODES.includes(problem.code) ? (
                <RecreateWebhookButton
                  repositoryId={problem.repositoryId}
                  onRecreated={onWebhookRecreated}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
