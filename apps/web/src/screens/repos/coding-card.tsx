"use client";

import type { RalphHistoryRewrite } from "@omniralph/shared";
import {
  BrandMark,
  Button,
  Card,
  Checkbox,
  Field,
  MetaBadge,
  RepoBadge,
  SaveBar,
  SegmentedControl,
  Select,
  Switch,
  Textarea,
  TextLink,
  TokenInput,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useId, useMemo, useState } from "react";
import type { z } from "zod";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useCurrentUser } from "@/components/current-user";
import { useQueryKeys } from "@/components/query-provider";
import { api } from "@/lib/api/client";
import {
  codingCardSaveResultSchema,
  codingMatchCheckSchema,
  codingTrackerOptionsSchema,
  type CodingCard as CodingCardData,
  type CodingCardInput,
  type CodingMatchWarning,
  type CodingTrackerOptions,
  type RepositoryDetail,
  type RepositoryTracker,
} from "@/lib/api/repositories";
import {
  codingEnabledEffect,
  codingInstructionsEffect,
  HISTORY_REWRITE_LABELS,
  historyRewriteEffect,
  openPullRequestEarlyEffect,
  requestAbbreviation,
  requestNoun,
  respondToReviewsAndCiEffect,
  workItemMatchEffect,
  workItemMatchText,
  type CodeHost,
  type WorkItemMatchConditions,
} from "@/lib/repositories/effects";
import { applySavedCard } from "./mutations";
import { reposKeys } from "./queries";
import { saveChangesLabel } from "./reviews-card";

/** Epic 7's Add connection page, where an admin connects a tracker. */
export const CONNECT_TRACKER_HREF = "/settings/connections/new";

/** The API's 409 codes, shown where they belong as well as in the save bar. */
const MATCH_REQUIRED = "work_item_match_required";
const CODING_ENABLED = "coding_enabled";

const MAX_MATCH_LABELS = 50;

/** The Coding card's fields, one key each, as `useStagedCard` stages them. */
export interface CodingDraft {
  enabled: boolean;
  match: WorkItemMatchConditions | null;
  codingInstructions: string;
  openPullRequestEarly: boolean;
  historyRewrite: RalphHistoryRewrite;
  respondToReviewsAndCi: boolean;
}

/** A match's conditions, always built in the same key order so drafts compare by value. */
function conditions(match: WorkItemMatchConditions): WorkItemMatchConditions {
  return {
    tracker: match.tracker,
    team: match.team,
    project: match.withoutProject ? null : match.project,
    withoutProject: match.withoutProject,
    labels: [...match.labels],
  };
}

function toDraft(card: CodingCardData): CodingDraft {
  return {
    enabled: card.enabled,
    match: card.workItemMatch ? conditions(card.workItemMatch) : null,
    codingInstructions: card.codingInstructions,
    openPullRequestEarly: card.openPullRequestEarly,
    historyRewrite: card.historyRewrite,
    respondToReviewsAndCi: card.respondToReviewsAndCi,
  };
}

/** A match as the API takes it. */
function matchInput(match: WorkItemMatchConditions): NonNullable<CodingCardInput["workItemMatch"]> {
  return {
    tracker: match.tracker,
    team: match.team,
    project: match.project,
    withoutProject: match.withoutProject,
    labels: [...match.labels],
  };
}

/** `PUT /api/ui/repositories/{id}/coding`'s body: the whole card. */
export function codingInput(draft: CodingDraft): CodingCardInput {
  return {
    codingEnabled: draft.enabled,
    workItemMatch: draft.match ? matchInput(draft.match) : null,
    codingInstructions: draft.codingInstructions,
    openPullRequestEarly: draft.openPullRequestEarly,
    historyRewrite: draft.historyRewrite,
    respondToReviewsAndCi: draft.respondToReviewsAndCi,
  };
}

/** Labels are "or"-joined: the same labels in another order are the same match. */
const matchKey = (match: WorkItemMatchConditions | null) =>
  JSON.stringify(match && { ...match, labels: [...match.labels].sort() });

const sameMatch = (a: WorkItemMatchConditions | null, b: WorkItemMatchConditions | null) =>
  matchKey(a) === matchKey(b);

/**
 * The warning a save answers when the saved match conflicts with other repos' matches
 * ("Saved. acme/web matches the same work items, so Om will ask which repo to use."), or
 * none.
 */
export function savedConflictsWarning(
  warnings: readonly Pick<CodingMatchWarning, "fullPath">[],
): string | undefined {
  if (warnings.length === 0) return undefined;
  const paths = warnings.map((warning) => warning.fullPath);
  const names =
    paths.length === 1 ? paths[0] : `${paths.slice(0, -1).join(", ")} and ${paths.at(-1)}`;
  const verb = paths.length === 1 ? "matches" : "match";
  return `Saved. ${names} ${verb} the same work items, so Om will ask which repo to use.`;
}

/** The round limit "up to N rounds each" names: the story playbook's larger one. */
export function roundLimit(card: CodingCardData): number {
  return Math.max(card.roundLimits.review, card.roundLimits.fix);
}

/**
 * The save bar's items: each field that differs, in the card's order, with its effect. A
 * staged match names each repo it conflicts with (`conflicts`, by full path).
 */
export function codingChanges(
  provider: CodeHost,
  rounds: number,
  conflicts: readonly string[],
  saved: CodingDraft,
  draft: CodingDraft,
): StagedChange[] {
  const changes: StagedChange[] = [];
  if (draft.enabled !== saved.enabled) changes.push(codingEnabledEffect(draft.enabled));
  if (!sameMatch(draft.match, saved.match)) {
    changes.push(
      workItemMatchEffect(
        saved.match && workItemMatchText(saved.match),
        draft.match && workItemMatchText(draft.match),
        conflicts,
      ),
    );
  }
  if (draft.codingInstructions !== saved.codingInstructions) {
    changes.push(codingInstructionsEffect());
  }
  if (draft.openPullRequestEarly !== saved.openPullRequestEarly) {
    changes.push(openPullRequestEarlyEffect(provider, draft.openPullRequestEarly));
  }
  if (draft.respondToReviewsAndCi !== saved.respondToReviewsAndCi) {
    changes.push(respondToReviewsAndCiEffect(provider, draft.respondToReviewsAndCi, rounds));
  }
  if (draft.historyRewrite !== saved.historyRewrite) {
    changes.push(historyRewriteEffect(saved.historyRewrite, draft.historyRewrite));
  }
  return changes;
}

/** The changes Save confirms first: Coding off, a match change and Rewrite history. */
export function codingNeedsConfirm(changes: StagedChange[]): StagedChange[] {
  return changes.filter(
    (change) =>
      (change.id === "codingEnabled" && change.to === "Off") ||
      change.id === "workItemMatch" ||
      change.id === "historyRewrite",
  );
}

/** The first field error under `prefix` (`workItemMatch` covers `workItemMatch.team`). */
function errorAt(errors: Readonly<Record<string, string>>, prefix: string): string | undefined {
  return Object.entries(errors).find(
    ([path]) => path === prefix || path.startsWith(`${prefix}.`),
  )?.[1];
}

const NO_WARNINGS: CodingMatchWarning[] = [];

const REWRITE_ORDER: readonly RalphHistoryRewrite[] = ["when-asked", "always", "never"];

/**
 * The conflicts of a staged match (`POST …/coding/match-check`), before Save. Off while the
 * match is the saved one or none. Keyed under the repo's detail, so its change events (and
 * the conflicting repos') check again.
 */
function useMatchConflicts(
  repositoryId: string,
  match: WorkItemMatchConditions | null,
  enabled: boolean,
) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: [...reposKeys(keys).detail(repositoryId), "match-check", match],
    queryFn: ({ signal }) =>
      api.post(
        `/api/ui/repositories/${encodeURIComponent(repositoryId)}/coding/match-check`,
        codingMatchCheckSchema,
        {
          body: { workItemMatch: match && matchInput(match) },
          organizationId: organization.id,
          signal,
        },
      ),
    enabled: enabled && match !== null,
  });
}

/**
 * The repo's organization's Linear teams, projects and labels for the match editor (`GET
 * …/coding/tracker-options`), while the editor is open. Keyed under the connections area, so
 * connecting or disconnecting a tracker loads them again.
 */
function useTrackerOptions(repositoryId: string, organizationId: string, enabled: boolean) {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery<CodingTrackerOptions>({
    queryKey: keys.connections.part(organizationId, "tracker-options", { repositoryId }),
    queryFn: ({ signal }) =>
      api.get(
        `/api/ui/repositories/${encodeURIComponent(repositoryId)}/coding/tracker-options`,
        codingTrackerOptionsSchema,
        { organizationId: organization.id, signal },
      ),
    enabled,
  });
}

/**
 * The match as a sentence of badges: the tracker's mark and workspace, "team" and the team,
 * "in project" and the project (or "with no project"), "and label" and the labels joined by
 * "or".
 */
function MatchSentence({
  match,
  tracker,
}: {
  match: WorkItemMatchConditions;
  tracker: RepositoryTracker | undefined;
}) {
  return (
    <p className="or-repo-match__sentence" aria-label={workItemMatchText(match)}>
      <span className="or-repo-match__tracker">
        <BrandMark brand={match.tracker} />
        {tracker?.workspaceName ?? null}
      </span>
      <span>team</span>
      <MetaBadge text={match.team} mono />
      {match.withoutProject ? (
        <span>with no project</span>
      ) : match.project !== null ? (
        <>
          <span>in project</span>
          <MetaBadge text={match.project} />
        </>
      ) : null}
      {match.labels.length > 0 ? (
        <>
          <span>and label</span>
          {match.labels.map((label, index) => (
            <span key={label} className="or-repo-match__label">
              {index > 0 ? <span>or</span> : null}
              <MetaBadge text={label} />
            </span>
          ))}
        </>
      ) : null}
    </p>
  );
}

const ANY_PROJECT = "any";
const NO_PROJECT = "none";
const projectValue = (project: string) => `project:${project}`;

/** Options with `current` kept (a saved value the tracker no longer lists), sorted as given. */
function withCurrent(options: readonly string[], current: string | null): string[] {
  if (!current || options.some((option) => option.toLowerCase() === current.toLowerCase())) {
    return [...options];
  }
  return [current, ...options];
}

/**
 * The inline match editor: tracker, team (required), project ("Any project", "No project" or
 * one) and labels. "Done" stages the edited match, "Remove match" stages none.
 */
function MatchEditor({
  repositoryId,
  organizationId,
  trackers,
  canEdit,
  initial,
  onDone,
  onRemove,
}: {
  repositoryId: string;
  organizationId: string;
  trackers: RepositoryTracker[];
  canEdit: boolean;
  initial: WorkItemMatchConditions | null;
  onDone: (match: WorkItemMatchConditions) => void;
  onRemove: () => void;
}) {
  const ids = useId();
  const [trackerId, setTrackerId] = useState(
    () => (trackers.find((entry) => entry.tracker === initial?.tracker) ?? trackers[0])?.id ?? "",
  );
  const [team, setTeam] = useState(initial?.team ?? "");
  const [project, setProject] = useState(
    initial?.withoutProject
      ? NO_PROJECT
      : initial?.project != null
        ? projectValue(initial.project)
        : ANY_PROJECT,
  );
  const [labels, setLabels] = useState<string[]>(initial ? [...initial.labels] : []);
  const [teamError, setTeamError] = useState<string | undefined>();
  const tracker = trackers.find((entry) => entry.id === trackerId);
  const options = useTrackerOptions(repositoryId, organizationId, tracker !== undefined);
  const connected = options.data?.status === "connected" ? options.data : null;
  const teams = connected?.teams ?? [];
  const teamKeys = teams.map((entry) => entry.key);
  const shownTeams = withCurrent(teamKeys, initial?.team ?? null);
  const initialProject = initial && !initial.withoutProject ? initial.project : null;
  const projects = withCurrent(connected?.projects ?? [], initialProject);
  const optionsFailed =
    options.isError || options.data?.status === "unavailable"
      ? "Couldn't load the tracker's teams and projects."
      : options.data?.status === "disconnected"
        ? "The tracker isn't connected anymore."
        : undefined;

  const done = () => {
    if (!tracker) return;
    if (!team) {
      setTeamError("Choose a team.");
      return;
    }
    onDone(
      conditions({
        tracker: tracker.tracker,
        team,
        project: project.startsWith("project:") ? project.slice("project:".length) : null,
        withoutProject: project === NO_PROJECT,
        labels,
      }),
    );
  };

  return (
    <div className="or-repo-match__editor" role="group" aria-label="Work item match">
      {trackers.length === 0 ? (
        <p className="or-repo-match__none">
          No tracker connected.
          {canEdit ? <TextLink href={CONNECT_TRACKER_HREF}>Connect a tracker</TextLink> : null}
        </p>
      ) : (
        <>
          <Field label="Tracker" stacked>
            <Select value={trackerId} onChange={(event) => setTrackerId(event.target.value)}>
              {trackers.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {`Linear · ${entry.workspaceName}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Team" stacked>
            <Select
              value={team}
              onChange={(event) => {
                setTeam(event.target.value);
                setTeamError(undefined);
              }}
              errorMessage={teamError}
            >
              <option value="" disabled>
                {options.isPending ? "Loading teams…" : "Choose a team"}
              </option>
              {shownTeams.map((key) => {
                const name = teams.find((entry) => entry.key === key)?.name;
                return (
                  <option key={key} value={key}>
                    {name ? `${key} · ${name}` : key}
                  </option>
                );
              })}
            </Select>
          </Field>
          <Field label="Project" stacked>
            <Select value={project} onChange={(event) => setProject(event.target.value)}>
              <option value={ANY_PROJECT}>Any project</option>
              <option value={NO_PROJECT}>No project</option>
              {projects.map((name) => (
                <option key={name} value={projectValue(name)}>
                  {name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Labels" description="Any of these labels; none matches any." stacked>
            <TokenInput
              values={labels}
              onChange={setLabels}
              mono={false}
              placeholder="Add a label…"
              list={connected ? `${ids}-labels` : undefined}
              validate={(value) =>
                labels.length >= MAX_MATCH_LABELS
                  ? `Pick at most ${MAX_MATCH_LABELS} labels.`
                  : value.length > 200
                    ? "That's too long for a label name."
                    : null
              }
            />
            {connected ? (
              <datalist id={`${ids}-labels`}>
                {connected.labels.map((label) => (
                  <option key={label} value={label} />
                ))}
              </datalist>
            ) : null}
          </Field>
          {optionsFailed ? <p className="or-repo-match__note">{optionsFailed}</p> : null}
        </>
      )}
      <div className="or-repo-match__actions">
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Remove match
        </Button>
        <Button variant="outline" size="sm" disabled={!tracker} onClick={done}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * The Coding card (Design rule 12): its switch, the work item match as a sentence of badges
 * with its inline editor and conflicts, the routing rules that also send work here (Design
 * rule 14), extra instructions, pull request handling and Rewrite history. Every field stages
 * in its save bar with its effect; Coding off, a match change or a Rewrite history change is
 * confirmed first; Save sends one request (`PUT /api/ui/repositories/{id}/coding`). Members
 * see it read-only.
 */
export function CodingCard({ detail, titleId }: { detail: RepositoryDetail; titleId: string }) {
  const { repository, canEdit } = detail;
  const provider = repository.provider;
  const ids = useId();
  const [editing, setEditing] = useState(false);
  const saved = useMemo(() => toDraft(detail.coding), [detail.coding]);
  const rounds = roundLimit(detail.coding);
  const [stagedMatch, setStagedMatch] = useState<WorkItemMatchConditions | null>(saved.match);
  const matchStaged = !sameMatch(stagedMatch, saved.match);
  const conflicts = useMatchConflicts(repository.id, stagedMatch, canEdit && matchStaged);
  const warnings: CodingMatchWarning[] =
    (matchStaged ? conflicts.data?.warnings : undefined) ?? NO_WARNINGS;
  const conflictPaths = useMemo(() => warnings.map((warning) => warning.fullPath), [warnings]);
  const toChanges = useCallback(
    (from: CodingDraft, to: CodingDraft) =>
      codingChanges(provider, rounds, conflictPaths, from, to),
    [provider, rounds, conflictPaths],
  );
  const card = useStagedCard<
    CodingDraft,
    z.infer<typeof codingCardSaveResultSchema> & { warning?: string }
  >({
    label: "Coding",
    saved,
    toChanges,
    needsConfirm: codingNeedsConfirm,
    save: useStagedSave({
      request: async (draft, { organizationId }) => {
        const result = await api.put(
          `/api/ui/repositories/${encodeURIComponent(repository.id)}/coding`,
          codingCardSaveResultSchema,
          { body: codingInput(draft), organizationId },
        );
        // The saved match's conflicts replace the "Saved" toast, as a warning toast.
        return { ...result, warning: savedConflictsWarning(result.warnings) };
      },
      applyResult: (result, cache) =>
        applySavedCard(
          cache,
          repository.id,
          (previous) => ({ ...previous, coding: result.card }),
          (row) => ({ ...row, codingEnabled: result.card.enabled }),
        ),
    }),
    onDirtyChange: useUnsavedCard("Coding", "coding"),
  });
  const { draft, set, fieldErrors } = card;
  // The conflicts query follows the draft's match (discard, a save or a live update move it).
  if (!sameMatch(stagedMatch, draft.match)) setStagedMatch(draft.match);
  const disabled = !canEdit || card.saving;
  const tracker = detail.trackers.find((entry) => entry.tracker === draft.match?.tracker);
  const request = requestNoun(provider);
  const abbreviation = requestAbbreviation(provider);
  const requestsLabelId = `${ids}-requests`;
  const rewriteLabelId = `${ids}-rewrite`;
  const switchError =
    card.errorCode === MATCH_REQUIRED ? card.error : errorAt(fieldErrors, "codingEnabled");
  const matchError =
    card.errorCode === CODING_ENABLED ? card.error : errorAt(fieldErrors, "workItemMatch");

  return (
    <Card
      title="Coding"
      titleId={titleId}
      className="or-repo-card"
      titleAddon={
        <ChangeHistoryPopover
          section="repository.coding"
          subject={repository.id}
          organization={repository.organization.id}
          latest={detail.history.coding}
        />
      }
      actions={
        <Switch
          aria-label="Coding"
          checked={draft.enabled}
          disabled={disabled}
          onCheckedChange={(checked) => set("enabled", checked)}
        />
      }
    >
      <p className="or-repo-card__help">
        Om builds work items that match below, story by story, ending in a {request}.
      </p>
      {switchError ? <p className="or-field-error">{switchError}</p> : null}
      <div className="or-repo-card__fields">
        <div className="or-repo-match">
          <h3 className="or-repo-match__title">Work item match</h3>
          {draft.match ? (
            <div className="or-repo-match__row">
              <MatchSentence match={draft.match} tracker={tracker} />
              {canEdit && !editing ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={card.saving}
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="or-repo-match__row">
              <p className="or-repo-match__empty">No work item match</p>
              {canEdit && !editing ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={card.saving}
                  onClick={() => setEditing(true)}
                >
                  Add match
                </Button>
              ) : null}
            </div>
          )}
          <p className="or-repo-match__help">Most specific match wins across repos.</p>
          {editing ? (
            <MatchEditor
              repositoryId={repository.id}
              organizationId={repository.organization.id}
              trackers={detail.trackers}
              canEdit={canEdit}
              initial={draft.match}
              onDone={(match) => {
                set("match", match);
                setEditing(false);
              }}
              onRemove={() => {
                set("match", null);
                setEditing(false);
              }}
            />
          ) : null}
          {warnings.length > 0 ? (
            <ul className="or-repo-match__conflicts" aria-label="Match conflicts">
              {warnings.map((warning) => (
                <li key={warning.id} className="or-repo-match__conflict">
                  <RepoBadge host={warning.provider} name={warning.fullPath} />
                  <span>matches the same work items, so Om will ask which repo to use.</span>
                </li>
              ))}
            </ul>
          ) : null}
          {matchError ? <p className="or-field-error">{matchError}</p> : null}
          {detail.coding.routingRules.length > 0 ? (
            <div className="or-repo-match__rules">
              <p className="or-repo-match__help">
                Routing rules also send work here (they run before matches):
              </p>
              <ul className="or-repo-match__rule-list">
                {detail.coding.routingRules.map((rule) => (
                  <li key={rule.position} className="or-repo-match__rule">
                    <MetaBadge text={`Rule ${rule.position}`} />
                    <span>{rule.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <Field
          label="Extra instructions"
          description="Om follows these in every story and request."
        >
          <Textarea
            value={draft.codingInstructions}
            disabled={disabled}
            onChange={(event) => set("codingInstructions", event.target.value)}
            errorMessage={errorAt(fieldErrors, "codingInstructions")}
          />
        </Field>
        <div className="or-field">
          <div className="or-field__head">
            <span id={requestsLabelId} className="or-field__label">
              {provider === "gitlab" ? "Merge requests" : "Pull requests"}
            </span>
          </div>
          <div className="or-field__control">
            <div role="group" aria-labelledby={requestsLabelId} className="or-repo-checks">
              <Checkbox
                label={`Open a draft ${abbreviation} after the first story`}
                checked={draft.openPullRequestEarly}
                disabled={disabled}
                onCheckedChange={(checked) => set("openPullRequestEarly", checked)}
              />
              <Checkbox
                label={`Fix review comments and CI failures (up to ${rounds} rounds each)`}
                checked={draft.respondToReviewsAndCi}
                disabled={disabled}
                onCheckedChange={(checked) => set("respondToReviewsAndCi", checked)}
              />
            </div>
          </div>
        </div>
        <div className="or-field">
          <div className="or-field__head">
            <span id={rewriteLabelId} className="or-field__label">
              Rewrite history
            </span>
          </div>
          <div className="or-field__control">
            <SegmentedControl<RalphHistoryRewrite>
              aria-labelledby={rewriteLabelId}
              options={REWRITE_ORDER.map((value) => ({
                value,
                label: HISTORY_REWRITE_LABELS[value],
                disabled,
              }))}
              value={draft.historyRewrite}
              onValueChange={(value) => set("historyRewrite", value)}
            />
            {errorAt(fieldErrors, "historyRewrite") ? (
              <p className="or-field-error">{errorAt(fieldErrors, "historyRewrite")}</p>
            ) : null}
          </div>
        </div>
      </div>
      {canEdit ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={() => {
            card.discard();
            setEditing(false);
          }}
          saving={card.saving}
          error={card.error}
          saveLabel={saveChangesLabel(card.changes.length)}
        />
      ) : null}
      {card.dialog}
    </Card>
  );
}
