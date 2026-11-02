import "server-only";
import {
  CODING_FIELD_NAMES,
  correlationProblem,
  Playbook,
  PLAYBOOK_ROLES,
  playbookRunSpec,
  prDescriptionProblem,
  validateTaskDefinition,
  type SinkKind,
  type SinkOutput,
  type TaskDefinition,
  type TaskRequirements,
  type TaskValidationContext,
} from "@omniralph/tasks";
import { z } from "zod";
import { allSinks, type Sink } from "@/lib/sinks";
import { listPlaybooks } from "./index";

/**
 * Save-time validation of an organization's playbooks: the `Playbook` schema,
 * then the validators of `@omniralph/tasks` on the run spec it becomes, with
 * what only the control panel knows (the organization's playbooks and the
 * output each sink accepts). Errors are keyed by the playbook's dotted field
 * paths, so forms show them inline.
 */

type Queryable = Parameters<typeof listPlaybooks>[0];

/** What `sink` accepts, for `validateTaskDefinition`: its structured output as a JSON schema. */
export function sinkOutput(sink: Sink): SinkOutput {
  if (sink.taskType !== "query") return { taskType: sink.taskType };
  if (sink.anyOutput) return { taskType: "query", output: "any" };
  if (sink.outputSchema === null) return { taskType: "query", output: "answer" };
  // What a task's output must satisfy is the input side of the sink's schema.
  const schema = z.toJSONSchema(sink.outputSchema, { io: "input", unrepresentable: "any" });
  return { taskType: "query", output: { schema } };
}

/** What every implemented sink accepts, by kind. */
export function sinkOutputs(): Partial<Record<SinkKind, SinkOutput>> {
  return Object.fromEntries(allSinks().map((sink) => [sink.kind, sinkOutput(sink)]));
}

/** A validated playbook with the requirements its runs need, or its errors by field. */
export type PlaybookValidation =
  | { ok: true; playbook: Playbook; requirements: TaskRequirements }
  | { ok: false; fieldErrors: Record<string, string> };

/** Run spec task fields as the playbook field that sets them. */
const PLAYBOOK_FIELD: Record<string, string> = {
  ...Object.fromEntries(CODING_FIELD_NAMES.map((name) => [name, `coding.${name}`])),
  prDescriptionTaskId: "coding.prDescriptionPlaybookId",
  verifierTaskId: "coding.verifierPlaybookId",
  auditTaskId: "coding.auditPlaybookId",
  // The agent half of the run spec is the playbook's own tools.
  agentId: "tools.agent",
  // The role fixes both.
  triggers: "role",
  sink: "role",
};

function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    errors[issue.path.map(String).join(".") || "form"] ??= issue.message;
  }
  return errors;
}

/**
 * The parsed custom playbook with the requirements derived from it, or its
 * errors by field: the schema's (`Playbook`), then
 * - `role`: a built-in-only role, or output its role's sink doesn't accept;
 * - `outputSchema`: a correlation or PR description playbook whose output isn't
 *   the fixed `{ findings, summary }` / `{ title, body }`;
 * - what `validateTaskDefinition` finds in its run spec (template, variable
 *   limits, output schema, coding settings, its PR description and task verifier
 *   playbooks among `playbooks`);
 * - `coding.verifierPlaybookId`: a playbook that isn't a `verifier` playbook.
 * - `coding.auditPlaybookId`: a playbook that isn't an `audit` playbook.
 * - `loop.verifierPlaybookId`: a playbook that doesn't exist or isn't a `verifier` playbook.
 */
export function validatePlaybookAgainst(
  input: unknown,
  playbooks: readonly Playbook[],
): PlaybookValidation {
  const parsed = Playbook.safeParse(input);
  if (!parsed.success) return { ok: false, fieldErrors: zodFieldErrors(parsed.error) };
  const playbook = parsed.data;
  if (PLAYBOOK_ROLES[playbook.role].builtinOnly) {
    return {
      ok: false,
      fieldErrors: { role: `Only a built-in playbook can be a ${playbook.role} playbook.` },
    };
  }

  const spec = playbookRunSpec(playbook);
  const tasks = new Map<string, TaskDefinition>(
    playbooks.map((other) => [other.id, playbookRunSpec(other).task]),
  );
  tasks.set(playbook.id, spec.task);
  const context: TaskValidationContext = {
    getAgent: (id) => (id === spec.agent.id ? spec.agent : null),
    getTask: (id) => tasks.get(id) ?? null,
    sinks: sinkOutputs(),
  };
  const errors: Record<string, string> = {};
  const add = (field: string, message: string) => {
    errors[field] ??= message;
  };
  if (playbook.role === "correlation") {
    const problem = correlationProblem(spec.task);
    if (problem) add("outputSchema", problem);
  }
  if (playbook.role === "pr-description") {
    const problem = prDescriptionProblem(spec.task);
    if (problem) add("outputSchema", problem);
  }
  const verifierId = playbook.coding?.verifierPlaybookId;
  if (verifierId !== undefined) {
    const verifier = playbooks.find((other) => other.id === verifierId);
    if (verifier && verifier.role !== "verifier") {
      add("coding.verifierPlaybookId", `${verifierId} isn't a verifier playbook.`);
    }
  }
  const loopVerifierId = playbook.loop?.verifierPlaybookId;
  if (loopVerifierId !== undefined) {
    const verifier = playbooks.find((other) => other.id === loopVerifierId);
    if (!verifier) add("loop.verifierPlaybookId", `There is no playbook ${loopVerifierId}.`);
    else if (verifier.role !== "verifier") {
      add("loop.verifierPlaybookId", `${loopVerifierId} isn't a verifier playbook.`);
    }
  }
  const auditId = playbook.coding?.auditPlaybookId;
  if (auditId !== undefined) {
    const audit = playbooks.find((other) => other.id === auditId);
    if (audit && audit.role !== "audit") {
      add("coding.auditPlaybookId", `${auditId} isn't an audit playbook.`);
    }
  }
  const validation = validateTaskDefinition(spec.task, context);
  if (!validation.ok) {
    for (const [field, message] of Object.entries(validation.fieldErrors)) {
      add(PLAYBOOK_FIELD[field] ?? field, message);
    }
  }
  if (Object.keys(errors).length > 0 || !validation.ok) return { ok: false, fieldErrors: errors };
  return { ok: true, playbook, requirements: validation.requirements };
}

/** `validatePlaybookAgainst` the organization's playbooks (built-ins included). */
export async function validateOrganizationPlaybook(
  db: Queryable,
  organizationId: string,
  input: unknown,
): Promise<PlaybookValidation> {
  const playbooks = await listPlaybooks(db, organizationId);
  return validatePlaybookAgainst(
    input,
    playbooks.map((resolved) => resolved.playbook),
  );
}
