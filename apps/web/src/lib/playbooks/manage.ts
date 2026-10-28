import "server-only";
import { randomUUID } from "node:crypto";
import {
  countActivePlaybookJobs,
  deletePlaybook as deletePlaybookRow,
  getStoredPlaybook,
  insertPlaybook,
  listHostToolSuggestions,
  listReportedInstallables,
  listReportedModels,
  updatePlaybook as updatePlaybookRow,
  type Database,
} from "@omniralph/db";
import { CLAUDE_CODE_TOOLS } from "@omniralph/shared";
import {
  AGENT_TOOLS,
  CUSTOM_PLAYBOOK_ROLES,
  INSTALLABLE_MCP_SERVER_SEPARATOR,
  isBuiltinId,
  LINEAR_TOOLS,
  playbookRequirements,
  playbookTaskType,
  type Playbook,
} from "@omniralph/tasks";
import type { ActionResult } from "@/lib/action-result";
import { ApiRouteError } from "@/lib/api/handler";
import type {
  PlaybookDetail,
  PlaybookFormOptions,
  PlaybookList,
  PlaybookSummary,
  SavedPlaybook,
} from "@/lib/api/playbooks";
import { bumpOrganizationHeartbeat } from "@/lib/agents/heartbeat-cache";
import type { OrgUser } from "@/lib/auth/session";
import { getPlaybook, listPlaybookChoices, listPlaybooks } from "./index";
import { hasNoReferrers, loadPlaybookUsage, type PlaybookReferrers } from "./referrers";
import { validateOrganizationPlaybook } from "./validation";

/**
 * Playbooks: what the `/api/ui/playbooks/**` handlers load and change. Every
 * function is scoped to the user's active organization; the handlers check the
 * role. Built-in playbooks are read-only: clone one to change it.
 */

const MAX_NAME_LENGTH = 200;
const INVALID = { ok: false, error: "Fix the highlighted fields." } as const;
const BUILTIN_READ_ONLY = "Built-in playbooks can't be changed; clone one to make your own.";
const NOT_FOUND = "That playbook doesn't exist.";

const REPOSITORY_ROLE_NAMES: Record<
  PlaybookReferrers["repositories"][number]["roles"][number],
  string
> = {
  review: "review",
  correlation: "correlation",
  story: "story",
  request: "request",
};

const CHAT_PLAYBOOK_NAMES: Record<PlaybookReferrers["chatPlaybooks"][number], string> = {
  ask: "ask about code",
  startWork: "start work",
};

/** What a row stores: the playbook without the ID, name and role its columns hold. */
function storedDefinition(playbook: Playbook): Record<string, unknown> {
  const { id: _id, name: _name, role: _role, ...stored } = playbook;
  return stored;
}

/** A submitted playbook (the body: any JSON) with the row's ID; non-objects fail validation. */
function withId(input: unknown, id: string): Record<string, unknown> {
  const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
  return { ...fields, id };
}

/** `name` as a copy's name ("<name> copy"), within the name limit. */
function copyName(name: string): string {
  const suffix = " copy";
  return `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
}

/** A refusal that isn't about the form: 409 with `code`. */
function conflict(message: string, code: string): ApiRouteError {
  return new ApiRouteError(409, message, code);
}

/** The token budget in words, as the API labels it. */
export function tokenBudgetLabel(playbook: Playbook): string {
  if (playbookTaskType(playbook) === "review") return "Set by the review depth";
  if (playbook.tokenBudget === null) return "No limit";
  return `${playbook.tokenBudget.tokens.toLocaleString("en-US")} tokens`;
}

/** Each setting or playbook using a playbook, for error messages. */
function referrerNames(referrers: PlaybookReferrers): string[] {
  return [
    ...referrers.repositories.map(
      (repo) =>
        `repo ${repo.fullPath} (${repo.roles.map((role) => REPOSITORY_ROLE_NAMES[role]).join(", ")})`,
    ),
    ...referrers.chatPlaybooks.map((role) => `the chat ${CHAT_PLAYBOOK_NAMES[role]} playbook`),
    ...referrers.chatChannels.map(
      (channel) =>
        `chat channel ${channel.connectionName} › ${channel.channelId} (${channel.roles
          .map((role) => CHAT_PLAYBOOK_NAMES[role])
          .join(", ")})`,
    ),
    ...referrers.playbooks.map((playbook) => `playbook ${playbook.name} (PR description)`),
  ];
}

/** The organization's playbooks (built-ins first, then its own) with their role, model and users. */
export async function loadPlaybookList(db: Database, user: OrgUser): Promise<PlaybookList> {
  const organizationId = user.organization.id;
  const [playbooks, usage] = await Promise.all([
    listPlaybooks(db, organizationId),
    loadPlaybookUsage(db, organizationId),
  ]);
  return {
    playbooks: playbooks.map(({ playbook, builtin }) =>
      playbookSummary(playbook, builtin, usage.get(playbook.id)),
    ),
  };
}

/** A playbook's row in the list. */
function playbookSummary(
  playbook: Playbook,
  builtin: boolean,
  usedBy: PlaybookReferrers,
): PlaybookSummary {
  return {
    id: playbook.id,
    name: playbook.name,
    description: playbook.description,
    role: playbook.role,
    builtin,
    model: playbook.model,
    usedBy,
  };
}

/** The answer to a create, clone or save: the playbook's ID, detail and list row. */
async function savedPlaybook(db: Database, user: OrgUser, id: string): Promise<SavedPlaybook> {
  const detail = await loadPlaybookDetail(db, user, id);
  if (!detail) throw ApiRouteError.notFound(NOT_FOUND);
  return {
    ok: true,
    id,
    detail,
    summary: playbookSummary(detail.playbook, detail.builtin, detail.usedBy),
  };
}

/**
 * What the playbook editor offers: the roles a custom playbook can take, the models the
 * organization's non-revoked agents report, the built-in, agent and Linear tool names, the
 * MCP servers of the installables its agents report (`<package>:<server>`), the PR
 * description playbooks a story or request playbook can name and the host tool names to
 * suggest (those its agents report with a path and those its playbooks require).
 */
export async function loadPlaybookFormOptions(
  db: Database,
  user: OrgUser,
): Promise<PlaybookFormOptions> {
  const organizationId = user.organization.id;
  const [models, installables, prDescriptionPlaybooks, hostTools] = await Promise.all([
    listReportedModels(db, organizationId),
    listReportedInstallables(db, organizationId),
    listPlaybookChoices(db, organizationId, { roles: ["pr-description"] }),
    listHostToolSuggestions(db, organizationId),
  ]);
  return {
    roles: [...CUSTOM_PLAYBOOK_ROLES],
    models: models.map(({ value, displayName }) => ({ value, displayName })),
    tools: { builtin: [...CLAUDE_CODE_TOOLS], agent: [...AGENT_TOOLS], linear: [...LINEAR_TOOLS] },
    mcpServers: installables.flatMap(({ name, mcpServers }) =>
      mcpServers.map((server) => `${name}${INSTALLABLE_MCP_SERVER_SEPARATOR}${server}`),
    ),
    prDescriptionPlaybooks,
    hostTools,
  };
}

/**
 * Playbook `id` of the organization, what its runs need and what uses it; null when unknown
 * (another organization's too). The version is stored with a custom playbook when it was
 * saved (a built-in's is derived from the code).
 */
export async function loadPlaybookDetail(
  db: Database,
  user: OrgUser,
  id: string,
): Promise<PlaybookDetail | null> {
  const organizationId = user.organization.id;
  const [resolved, usage] = await Promise.all([
    getPlaybook(db, organizationId, id),
    loadPlaybookUsage(db, organizationId),
  ]);
  if (!resolved) return null;
  const { playbook } = resolved;
  const derived = playbookRequirements(playbook);
  return {
    playbook,
    builtin: resolved.builtin,
    tokenBudgetLabel: tokenBudgetLabel(playbook),
    requirements: {
      ...derived,
      minAgentVersion: resolved.requirements?.minAgentVersion ?? derived.minAgentVersion,
    },
    usedBy: usage.get(playbook.id),
  };
}

/**
 * Creates one of the admin's organization's playbooks after validating it
 * against the organization's playbooks and the real sinks; stores the
 * requirements its runs need with it. Returns its new ID.
 */
export async function createPlaybook(
  db: Database,
  admin: OrgUser,
  input: unknown,
): Promise<ActionResult | SavedPlaybook> {
  const organizationId = admin.organization.id;
  const id = randomUUID();
  const validation = await validateOrganizationPlaybook(db, organizationId, withId(input, id));
  if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
  const { playbook } = validation;
  await insertPlaybook(db, organizationId, {
    id,
    name: playbook.name,
    role: playbook.role,
    definition: storedDefinition(playbook),
    requirements: validation.requirements,
    createdBy: admin.id,
  });
  // Its host tools join the heartbeat's `requiredHostTools`.
  await bumpOrganizationHeartbeat(organizationId);
  return savedPlaybook(db, admin, id);
}

/**
 * Replaces one of the organization's playbooks and its requirements. Refused
 * (409) for built-ins and, for a change of role, while anything uses the
 * playbook (whatever uses it picked it for its role; the error names them).
 */
export async function updatePlaybook(
  db: Database,
  admin: OrgUser,
  id: string,
  input: unknown,
): Promise<ActionResult | SavedPlaybook> {
  if (isBuiltinId(id)) throw conflict(BUILTIN_READ_ONLY, "builtin_read_only");
  const organizationId = admin.organization.id;
  const current = await getStoredPlaybook(db, organizationId, id);
  if (!current) throw ApiRouteError.notFound(NOT_FOUND);
  const validation = await validateOrganizationPlaybook(db, organizationId, withId(input, id));
  if (!validation.ok) return { ...INVALID, fieldErrors: validation.fieldErrors };
  const { playbook } = validation;

  if (current.role !== playbook.role) {
    const usage = await loadPlaybookUsage(db, organizationId);
    const users = referrerNames(usage.get(id));
    if (users.length > 0) {
      const error = `The role can't change while it's used by ${users.join(", ")}.`;
      return { ok: false, error, fieldErrors: { role: error } };
    }
  }

  const row = await updatePlaybookRow(db, organizationId, id, {
    name: playbook.name,
    role: playbook.role,
    definition: storedDefinition(playbook),
    requirements: validation.requirements,
    updatedBy: admin.id,
  });
  if (!row) throw ApiRouteError.notFound(NOT_FOUND);
  await bumpOrganizationHeartbeat(organizationId);
  return savedPlaybook(db, admin, id);
}

/**
 * Copies a playbook (a built-in or one of the organization's) into a new row of
 * the organization, named as a copy; its requirements are derived again. A
 * built-in-only role (triage, learn-rule, reply-to-finding) can't be copied.
 * Returns the new ID.
 */
export async function clonePlaybook(
  db: Database,
  admin: OrgUser,
  id: string,
): Promise<ActionResult | SavedPlaybook> {
  const organizationId = admin.organization.id;
  const source = await getPlaybook(db, organizationId, id);
  if (!source) throw ApiRouteError.notFound(NOT_FOUND);
  const name = copyName(source.playbook.name);
  const cloneId = randomUUID();
  const validation = await validateOrganizationPlaybook(db, organizationId, {
    ...source.playbook,
    id: cloneId,
    name,
  });
  if (!validation.ok) {
    const problems = [...new Set(Object.values(validation.fieldErrors))];
    return {
      ok: false,
      error: `${source.playbook.name} can't be cloned: ${problems.join(" ")}`,
    };
  }
  await insertPlaybook(db, organizationId, {
    id: cloneId,
    name,
    role: validation.playbook.role,
    definition: storedDefinition(validation.playbook),
    requirements: validation.requirements,
    createdBy: admin.id,
  });
  await bumpOrganizationHeartbeat(organizationId);
  return savedPlaybook(db, admin, cloneId);
}

/**
 * Deletes one of the organization's playbooks. Refused (409) for built-ins,
 * while a repo binding, chat setting or coding playbook uses it (the error
 * names each), and while one of its jobs is queued or running.
 */
export async function deletePlaybook(
  db: Database,
  admin: OrgUser,
  id: string,
): Promise<ActionResult> {
  if (isBuiltinId(id)) throw conflict(BUILTIN_READ_ONLY, "builtin_read_only");
  const organizationId = admin.organization.id;
  const playbook = await getStoredPlaybook(db, organizationId, id);
  if (!playbook) throw ApiRouteError.notFound(NOT_FOUND);
  const referrers = (await loadPlaybookUsage(db, organizationId)).get(id);
  if (!hasNoReferrers(referrers)) {
    throw conflict(
      `${playbook.name} can't be deleted while it's used by ${referrerNames(referrers).join(", ")}.`,
      "playbook_in_use",
    );
  }
  const activeJobs = await countActivePlaybookJobs(db, organizationId, id);
  if (activeJobs > 0) {
    throw conflict(
      `${playbook.name} can't be deleted while ${activeJobs === 1 ? "a run of it is" : `${activeJobs} runs of it are`} queued or running.`,
      "playbook_in_use",
    );
  }
  if (!(await deletePlaybookRow(db, organizationId, id))) throw ApiRouteError.notFound(NOT_FOUND);
  await bumpOrganizationHeartbeat(organizationId);
  return { ok: true };
}
