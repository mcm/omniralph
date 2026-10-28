/**
 * The page: the shell, or, once any request answered 401 (the agent restarted, so its
 * token changed, or the page was opened without it), only "Open this page again".
 */
import { EmptyState } from "@omniralph/ui";
import { useUnauthorized } from "./api.js";
import { AgentShell } from "./shell.js";

export function App() {
  if (useUnauthorized()) {
    return (
      <main className="agent-reopen">
        <EmptyState
          title="Open this page again"
          headingLevel={1}
          description={
            <>
              The agent restarted, so this page&apos;s link no longer works. Run{" "}
              <code className="or-mono">omniralph-agent ui</code> on the machine to get a new one.
            </>
          }
        />
      </main>
    );
  }
  return <AgentShell />;
}
