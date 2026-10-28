/**
 * Claude (`/claude`): whether Claude is signed in on this machine, with which account and
 * credentials, the models it can run and when that was last checked. "Check again"
 * (`POST /api/claude/check`) reads it at once; any new read (also the hourly one) arrives
 * as a `claude` event. Signing in stays on the machine (`claude`), so a signed-out agent
 * says how.
 */
import { Button, Card, EmptyState, MetaBadge, StatusText } from "@omniralph/ui";
import { IconRefresh } from "@tabler/icons-react";
import type { ClaudeStatus } from "../../../../src/claude-status.js";
import type { ClaudeCheckResult } from "../../../../src/ui/machine-routes.js";
import { localRequest } from "../../api.js";
import { relativeTime, useNow } from "../../format.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation } from "../../live/use-local-mutation.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import { NO_MODELS, SOURCE_LABELS, loginHeadline } from "./model.js";

function useCheckAgain() {
  return useLocalMutation<ClaudeCheckResult, void>({
    // A body, so the request carries the JSON content type every change needs.
    mutationFn: () =>
      localRequest<ClaudeCheckResult>("/api/claude/check", { method: "POST", body: {} }),
    invalidate: () => [agentKeys.state],
    success: null,
    applyResult: ({ claude }, cache) =>
      cache.set<AgentUiState>(cache.keys.state, (state) => state && { ...state, claude }, {
        exact: true,
      }),
  });
}

export function ClaudePage() {
  const state = useAgentState();
  const check = useCheckAgain();
  const data = state.data;
  return (
    <AgentPage title="Claude">
      {data ? (
        <>
          <LoginCard
            claude={data.claude}
            user={data.agent.user}
            checking={check.isPending}
            onCheck={() => check.mutate()}
          />
          <ModelsCard claude={data.claude} />
        </>
      ) : state.isError ? (
        <EmptyState title="Can't load Claude's state" description={state.error.message} />
      ) : null}
    </AgentPage>
  );
}

function LoginCard({
  claude,
  user,
  checking,
  onCheck,
}: {
  claude: ClaudeStatus | null;
  user: string | null;
  checking: boolean;
  onCheck: () => void;
}) {
  const now = useNow();
  const headline = loginHeadline(claude);
  return (
    <Card
      title="Login"
      actions={
        <Button size="sm" icon={IconRefresh} disabled={checking} onClick={onCheck}>
          {checking ? "Checking…" : "Check again"}
        </Button>
      }
    >
      <p className="agent-claude__headline">
        {headline.tone ? (
          <StatusText tone={headline.tone}>{headline.text}</StatusText>
        ) : (
          headline.text
        )}
      </p>
      {claude?.status === "signed_in" && claude.source !== null ? (
        <p className="agent-card-description">{SOURCE_LABELS[claude.source]}</p>
      ) : null}
      {claude?.status === "signed_out" ? (
        <p className="agent-card-description">
          Sign in on this machine{user === null ? "" : ` as ${user}`} by running{" "}
          <code className="or-mono">claude</code>, then check again.
        </p>
      ) : null}
      {claude?.status === "unknown" && claude.error ? (
        <p className="agent-card-description">{claude.error}</p>
      ) : null}
      {claude !== null ? (
        <p className="agent-card-description">
          Last checked{" "}
          <time dateTime={claude.checkedAt}>{relativeTime(claude.checkedAt, now)}</time>
        </p>
      ) : null}
    </Card>
  );
}

function ModelsCard({ claude }: { claude: ClaudeStatus | null }) {
  const models = claude?.models ?? [];
  return (
    <Card title="Models">
      {models.length > 0 ? (
        <ul className="agent-badges" aria-label="Models">
          {models.map((model) => (
            <li key={model.value}>
              <MetaBadge text={model.displayName} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="agent-card-description">{NO_MODELS}</p>
      )}
    </Card>
  );
}
