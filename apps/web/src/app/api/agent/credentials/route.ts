import { getJobForAgent, getRepositoryWithConnection, writeAgentAudit } from "@omniralph/db";
import type { CloneCredentialResponse } from "@omniralph/shared";
import { clientIp } from "@/lib/agent-auth/request";
import { requireJob } from "@/lib/agent-auth/verify";
import { getDb } from "@/lib/db";
import { scmAdapterFor } from "@/lib/scm/adapters";

function forbidden(error: string): Response {
  return Response.json({ error }, { status: 403 });
}

/**
 * The credential broker: a short-lived clone credential for the repository of
 * the job whose token authenticates the request (used by the agent's
 * `git-credential` helper). Only while the job is `running` on the token's
 * agent (else 401); jobs of another organization than the agent's, or
 * without a usable repository (in the job's organization), get 403. The credential
 * is read-only unless the job token has `credentials:write` *and* the job row
 * is a `ralph` job; then it can push. The request body is ignored. Every
 * issuance is audited as `credential_issued` with its `access`.
 */
export async function POST(req: Request): Promise<Response> {
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

  const access =
    principal.scopes.includes("credentials:write") && job.capability === "ralph" ? "write" : "read";
  const adapter = scmAdapterFor(db, connection);
  const repo = { fullPath: repository.fullPath, externalId: repository.externalId };
  const credential =
    access === "write"
      ? await adapter.getWriteCloneCredential(repo)
      : await adapter.getReadOnlyCloneCredential(repo);
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
