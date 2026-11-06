/**
 * Claude (`/claude`): whether Claude is signed in on this machine, with which account and
 * credentials, the models it can run and when that was last checked. "Check again"
 * (`POST /api/claude/check`) reads it at once; any new read (also the hourly one) arrives
 * as a `claude` event. "Refresh sign-in…" signs the machine's `claude` login in again
 * from the page: it opens Claude's sign-in in a new tab (`POST /api/claude/sign-in`), and
 * the code that page shows is pasted back (`POST /api/claude/sign-in/complete`).
 */
import {
  Button,
  Card,
  EmptyState,
  Field,
  MetaBadge,
  Sheet,
  StatusText,
  TextInput,
} from "@omniralph/ui";
import { IconExternalLink, IconKey, IconRefresh } from "@tabler/icons-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ClaudeStatus } from "../../../../src/claude-status.js";
import type {
  ClaudeCheckResult,
  ClaudeSignInCompleteResult,
  ClaudeSignInStartResult,
} from "../../../../src/ui/machine-routes.js";
import { localRequest } from "../../api.js";
import { relativeTime, useNow } from "../../format.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation } from "../../live/use-local-mutation.js";
import { useAgentState, type AgentUiState } from "../../state.js";
import { AgentPage } from "../page.js";
import { NO_MODELS, SOURCE_LABELS, canRefreshSignIn, loginHeadline } from "./model.js";

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

function useStartSignIn() {
  return useLocalMutation<ClaudeSignInStartResult, void>({
    mutationFn: () =>
      localRequest<ClaudeSignInStartResult>("/api/claude/sign-in", { method: "POST", body: {} }),
    invalidate: () => [],
    success: null,
  });
}

function useCompleteSignIn() {
  return useLocalMutation<ClaudeSignInCompleteResult, string>({
    mutationFn: (code) =>
      localRequest<ClaudeSignInCompleteResult>("/api/claude/sign-in/complete", {
        method: "POST",
        body: { code },
      }),
    invalidate: () => [agentKeys.state],
    success: ({ claude }) =>
      claude.status === "signed_in"
        ? "Claude is signed in again"
        : "Signed in, but Claude still can't be used: see the login card",
    applyResult: ({ claude }, cache) =>
      cache.set<AgentUiState>(cache.keys.state, (state) => state && { ...state, claude }, {
        exact: true,
      }),
  });
}

export function ClaudePage() {
  const state = useAgentState();
  const check = useCheckAgain();
  const [signingIn, setSigningIn] = useState(false);
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
            onRefreshSignIn={() => setSigningIn(true)}
          />
          <ModelsCard claude={data.claude} />
        </>
      ) : state.isError ? (
        <EmptyState title="Can't load Claude's state" description={state.error.message} />
      ) : null}
      <Sheet title="Refresh sign-in" open={signingIn} onOpenChange={setSigningIn}>
        {signingIn ? <SignInForm onDone={() => setSigningIn(false)} /> : null}
      </Sheet>
    </AgentPage>
  );
}

function LoginCard({
  claude,
  user,
  checking,
  onCheck,
  onRefreshSignIn,
}: {
  claude: ClaudeStatus | null;
  user: string | null;
  checking: boolean;
  onCheck: () => void;
  onRefreshSignIn: () => void;
}) {
  const now = useNow();
  const headline = loginHeadline(claude);
  const needsSignIn = claude?.status === "signed_out";
  return (
    <Card
      title="Login"
      actions={
        <div className="agent-row-actions">
          {canRefreshSignIn(claude) ? (
            <Button
              size="sm"
              icon={IconKey}
              variant={needsSignIn ? "solid" : "outline"}
              onClick={onRefreshSignIn}
            >
              Refresh sign-in…
            </Button>
          ) : null}
          <Button size="sm" icon={IconRefresh} disabled={checking} onClick={onCheck}>
            {checking ? "Checking…" : "Check again"}
          </Button>
        </div>
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
      {claude?.status === "signed_out" && claude.expired && claude.error ? (
        <p className="agent-card-description">{claude.error}.</p>
      ) : null}
      {claude?.status === "signed_out" ? (
        <p className="agent-card-description">
          Use <strong>Refresh sign-in…</strong>, or sign in on this machine
          {user === null ? "" : ` as ${user}`} by running <code className="or-mono">claude</code>{" "}
          and then check again.
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

/**
 * The sign-in sheet: starts a sign-in when it opens, links to Claude's sign-in page
 * (a new tab), and takes the code that page shows.
 */
function SignInForm({ onDone }: { onDone: () => void }) {
  const start = useStartSignIn();
  const complete = useCompleteSignIn();
  const [code, setCode] = useState("");
  const [codeMessage, setCodeMessage] = useState<string | null>(null);
  const started = useRef(false);
  const startMutate = start.mutate;

  useEffect(() => {
    // Once per sheet: a second start would make the first link's code useless.
    if (started.current) return;
    started.current = true;
    startMutate();
  }, [startMutate]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (value.length === 0) {
      setCodeMessage("Paste the code the sign-in page shows");
      return;
    }
    complete.mutate(value, {
      onSuccess: onDone,
      onError: (error) => setCodeMessage(error.message),
    });
  };

  if (start.isError) {
    return (
      <div className="agent-install">
        <p role="alert" className="agent-alert">
          {start.error.message}
        </p>
        <div className="agent-install__actions">
          <Button type="button" onClick={() => startMutate()}>
            Try again
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const link = start.data;
  return (
    <form className="agent-install" onSubmit={onSubmit} noValidate>
      <ol className="agent-sign-in__steps">
        <li>
          <p className="agent-sign-in__step-title">Sign in to Claude</p>
          <p className="agent-card-description">
            Opens Claude in a new tab. Sign in with the account this agent should use, and Claude
            shows a code to paste here.
          </p>
          {link ? (
            <Button
              href={link.authorizeUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="solid"
              icon={IconExternalLink}
            >
              Open Claude sign-in
            </Button>
          ) : (
            <Button type="button" variant="solid" icon={IconExternalLink} disabled>
              Preparing sign-in…
            </Button>
          )}
        </li>
        <li>
          <p className="agent-sign-in__step-title">Paste the code</p>
          <Field
            label="Code"
            stacked
            description={
              link
                ? `Works until ${new Date(link.expiresAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}. Saving can take up to 2 minutes.`
                : undefined
            }
          >
            <TextInput
              mono
              value={code}
              placeholder="Paste the code from Claude"
              autoComplete="off"
              spellCheck={false}
              disabled={!link}
              onChange={(event) => {
                setCode(event.target.value);
                setCodeMessage(null);
              }}
              errorMessage={codeMessage ?? undefined}
            />
          </Field>
        </li>
      </ol>
      <div className="agent-install__actions">
        <Button type="submit" variant="solid" disabled={!link || complete.isPending}>
          {complete.isPending ? "Signing in…" : "Save sign-in"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
