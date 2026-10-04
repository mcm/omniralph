"use server";

import { unpinRepositoryFromAgent } from "@omniralph/db";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-result";
import { pinRepository as pinRepositoryWithSync } from "@/lib/agents/pins";
import { runAdminAction } from "@/lib/auth/admin-action";
import { getDb } from "@/lib/db";
import { getDispatcher } from "@/lib/dispatch";

function revalidate(): void {
  revalidatePath("/agents");
  revalidatePath("/repositories");
}

/** Pins a repository to an agent; the agent pre-clones it via a `repo.sync` job. */
export async function pinRepository(agentId: string, repositoryId: string): Promise<ActionResult> {
  return runAdminAction(async () => {
    const { result } = await pinRepositoryWithSync(getDb(), getDispatcher(), {
      agentId,
      repositoryId,
    });
    if (result === "unknown_agent")
      return { ok: false, error: "That agent doesn't exist or was revoked." };
    if (result === "unknown_repository")
      return { ok: false, error: "That repository isn't connected." };
    revalidate();
  });
}

/** Unpins a repository from an agent (any agent may then serve it, unless other pins remain). */
export async function unpinRepository(
  agentId: string,
  repositoryId: string,
): Promise<ActionResult> {
  return runAdminAction(async () => {
    if (!(await unpinRepositoryFromAgent(getDb(), { agentId, repositoryId }))) {
      return { ok: false, error: "That repository isn't pinned to this agent." };
    }
    revalidate();
  });
}
