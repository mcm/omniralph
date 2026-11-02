import {
  findingVerifierProblem,
  playbookRunSpec,
  taskVerifierProblem,
  type Playbook,
} from "@omniralph/tasks";

/**
 * Which `verifier` playbooks each loop can apply. A verifier's output is read
 * by the run that invokes it, so a story run needs a task verifier
 * (`{ criteria, summary }`) and a looped review needs a finding verifier
 * (`{ verdicts, unreached, summary }`); the playbook editor offers each picker
 * only the verifiers that pass its check, and saving checks them again.
 */

/** Why a story playbook can't verify its tasks with `verifier`, or null when it can. */
export function storyVerifierProblem(verifier: Playbook): string | null {
  return taskVerifierProblem(playbookRunSpec(verifier).task);
}

/** Why a review playbook's loop can't verify its findings with `verifier`, or null when it can. */
export function reviewLoopVerifierProblem(verifier: Playbook): string | null {
  return findingVerifierProblem(playbookRunSpec(verifier).task);
}
