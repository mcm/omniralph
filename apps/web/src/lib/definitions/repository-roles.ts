import type { RepositoryTaskReference } from "@omniralph/db";

/** What a repository uses a task as, e.g. `review task, correlation task`. */
export function repositoryTaskRoles(repo: RepositoryTaskReference): string {
  return [
    repo.reviewTask && "review task",
    repo.correlationTask && "correlation task",
    repo.storyTask && "story task",
    repo.requestTask && "request task",
  ]
    .filter(Boolean)
    .join(", ");
}
