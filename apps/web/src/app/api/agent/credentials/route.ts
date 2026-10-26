import { getJobForAgent, getRepositoryWithConnection, writeAgentAudit } from "@omniralph/db";
import { CloneCredentialPermissionError, type CloneCredential } from "@omniralph/scm";
import { WORKTREE_CLEANUP_JOB_TYPE, type CloneCredentialResponse } from "@omniralph/shared";
import { clientIp } from "@/lib/agent-auth/request";
import { requireJob, type JobPrincipal } from "@/lib/agent-auth/verify";
import { getDb } from "@/lib/db";
import { scmAdapterFor } from "@/lib/scm/adapters";
import { liveRoute } from "@/lib/live/request";

function forbidden(error: string, message?: string): Response {
  return Response.json(message ? { error, message } : { error }, { status: 403 });
}

/**
 * Whether a job token may get a push credential: it must carry
 * `credentials:write` and be the `lifecycle` token of a `coding` run-spec job
 * or of a `worktree.cleanup` system RPC, or the single token of a legacy
 * `ralph.*` job. A `session` token is always read-only, whatever scopes it
 * claims, and so is every other system RPC's token.
 */
function canPush(
  principal: Pick<JobPrincipal, "scopes" | "kind">,
  job: { type: string; taskType: string; taskId: string | null },
): boolean {
  if (!principal.scopes.includes("credentials:write")) return false;
  switch (principal.kind) {
    case "lifecycle":
      if (job.taskType === "system") return job.type === WORKTREE_CLEANUP_JOB_TYPE;
      return job.taskId !== null && job.taskType === "coding";
    case "legacy":
      return job.taskId === null && job.type.startsWith("ralph.");
    case "session":
      return false;
  }
}

/**
 * The credential broker: a short-lived clone credential for the repository of
 * the job whose token authenticates the request (used by the agent's
 * `git-credential` helper). Only while the job is `running` on the token's
 * agent (else 401); jobs of another organization than the agent's, or
 * without a usable repository (in the job's organization), get 403. The credential
 * is read-only unless the job token has `credentials:write` *and* the job row
 * may push (`canPush`); then it can push. When the code host hasn't granted the
 * connection that access (e.g. the GitHub App installation lacks Contents:
 * Read and write), 403 `scm_permission_missing` with a `message` saying what
 * to change. The request body is ignored. Every issuance is audited as
 * `credential_issued` with its `access` and the token kind
 * (`tokenKind`: `lifecycle`, `session` or `legacy`).
 */
async function post(req: Request): Promise<Response> {
  const principal = await requireJob(req, "credentials:read");
  if (principal instanceof Response) return principal;
  const db = getDb();
  // A job of another organization than the agent's never gets credentials.
  const job = await getJobForAgent(db, principal.jobId, principal.agentId);
  if (!job) return forbidden("wrong_organization");
  if (!job.repositoryId) return forbidden("no_repository");
  const found = await getRepositoryWithConnection(db, job.repositoryId, job.organizationId);
  if (!found || found.repository.disconnectedAt) return forbidden("repository_unavailable");
  const { repository, connection } = found;

  const access = canPush(principal, job) ? "write" : "read";
  const adapter = scmAdapterFor(db, connection);
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  let credential: CloneCredential;
  try {
    credential =
      access === "write"
        ? await adapter.getWriteCloneCredential(repo)
        : await adapter.getReadOnlyCloneCredential(repo);
  } catch (error) {
    if (error instanceof CloneCredentialPermissionError) {
      console.warn(`credential broker: ${error.message}`);
      return forbidden("scm_permission_missing", error.message);
    }
    throw error;
  }
  await writeAgentAudit(db, {
    agentId: principal.agentId,
    event: "credential_issued",
    ip: clientIp(req),
    detail: {
      jobId: job.id,
      repositoryId: repository.id,
      repository: repository.fullPath,
      provider: repository.provider,
      access,
      tokenKind: principal.kind,
      expiresAt: credential.expiresAt.toISOString(),
    },
  });
  return Response.json(
    {
      cloneUrl: credential.cloneUrl,
      username: credential.username,
      password: credential.token,
      expiresAt: credential.expiresAt.toISOString(),
    } satisfies CloneCredentialResponse,
    { headers: { "cache-control": "no-store" } },
  );
}

export const POST = liveRoute(post);
