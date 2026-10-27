"use client";

import {
  Button,
  Card,
  EmptyState,
  Field,
  IconButton,
  MetaBadge,
  RepoBadge,
  SaveBar,
  Select,
  Sheet,
} from "@omniralph/ui";
import { IconArrowDown, IconArrowUp, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import * as React from "react";
import type { RuleGroupType } from "react-querybuilder";
import { MAX_ROUTING_RULES } from "@omniralph/shared";
import { ChangeHistoryPopover } from "@/components/change-history-popover";
import { useCurrentUser } from "@/components/current-user";
import { useStagedCard } from "@/components/use-staged-card";
import { api } from "@/lib/api/client";
import {
  savedRoutingRulesSchema,
  type RoutingRules,
  type SavedRoutingRules,
} from "@/lib/api/routing-rules";
import { routingRulesKey, useRoutingRules } from "../queries";
import { ConditionBuilder } from "./condition-builder";
import { RoutingTestCard } from "./routing-test-card";
import {
  draftsOf,
  errorCount,
  moveRule,
  newRule,
  NO_ERRORS,
  placeErrors,
  ruleChanges,
  ruleDescription,
  toRuleInputs,
  validateDrafts,
  type DraftErrors,
  type DraftRule,
  type RoutingFieldData,
  type RoutingLinear,
  type RoutingRepository,
  type RuleErrors,
} from "./rule-editor";
import "./routing.css";

/** What the card says about the rules. */
export const ROUTING_RULES_DESCRIPTION =
  "Rules run in order before each repo's work item match; the first rule that matches decides.";

/** The save bar's notice when another admin saved the rules under this user's changes. */
export const ROUTING_RULES_CONFLICT = "Someone else changed these rules.";

/** The built-in rules, after the custom rules and each repo's work item match, in this order. */
export const DEFAULT_RULES = [
  "Follow-up → route as its source",
  "Sub-issue → route as its parent",
  "Ask which repo to use",
] as const;

/** The card's staged value: the whole list, in order. */
interface RoutingDraft {
  rules: DraftRule[];
}

const NO_NODE_ERRORS: ReadonlyMap<string, string> = new Map();

/** A rule's error messages, its repository's first. */
function ruleMessages(errors: RuleErrors | undefined): string[] {
  if (!errors) return [];
  return [...(errors.repository ? [errors.repository] : []), ...errors.nodes.values()];
}

function CodingOff({ repository }: { repository: RoutingRepository | undefined }) {
  if (!repository || repository.codingEnabled) return null;
  return (
    <p className="or-routing__note">
      Coding is off for {repository.fullPath}: matching work items are treated as manual.
    </p>
  );
}

function Target({ repository, id }: { repository: RoutingRepository | undefined; id: string }) {
  if (repository) return <RepoBadge host={repository.provider} name={repository.fullPath} />;
  return <MetaBadge text={id ? "Unknown repo" : "No repo"} />;
}

// ── The rule sheet ────────────────────────────────────────────────────────────

interface RuleSheetProps {
  /** The rule's number in the list (an added rule's, once added). */
  number: number;
  adding: boolean;
  initial: DraftRule;
  /** The rule's errors from the last save or check. */
  errors: RuleErrors | undefined;
  fields: readonly RoutingFieldData[];
  fieldsById: ReadonlyMap<string, RoutingFieldData>;
  linear: RoutingLinear;
  repositories: readonly RoutingRepository[];
  onApply: (rule: DraftRule) => void;
  onClose: () => void;
}

function LinearNote({ linear }: { linear: RoutingLinear }) {
  if (linear.status === "connected") return null;
  return (
    <p className="or-routing__note">
      {linear.status === "disconnected"
        ? "Linear isn't connected, so values can't be suggested from your workspace's teams, projects, labels and people. Type them instead."
        : "Your Linear workspace's values couldn't be loaded, so they can't be suggested. Type values instead, or reload the page to try again."}
    </p>
  );
}

/**
 * Add or Edit: the condition builder and the target repo `Select`, checked the way `PUT`
 * checks it before it's staged. Applying stages the rule in the card; nothing is saved yet.
 */
function RuleSheet({
  number,
  adding,
  initial,
  errors: savedErrors,
  fields,
  fieldsById,
  linear,
  repositories,
  onApply,
  onClose,
}: RuleSheetProps) {
  const [rule, setRule] = React.useState(initial);
  const [errors, setErrors] = React.useState<RuleErrors | undefined>(savedErrors);
  const [listErrors, setListErrors] = React.useState<string[]>([]);
  const repository = repositories.find((repo) => repo.id === rule.repositoryId);
  const known = repository !== undefined;
  const repoId = React.useId();

  const change = (next: DraftRule) => {
    setRule(next);
    setErrors(undefined);
    setListErrors([]);
  };
  const setQuery = (query: RuleGroupType) => change({ ...rule, query });

  const apply = () => {
    const invalid = validateDrafts([rule], fields);
    if (invalid) {
      setErrors(invalid.rules.get(0));
      setListErrors(invalid.list);
      return;
    }
    onApply(rule);
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={adding ? "Add a rule" : `Edit rule ${number}`}
      description="Work items that match the condition go to the repo."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="solid" onClick={apply}>
            {adding ? "Add rule" : "Update rule"}
          </Button>
        </>
      }
    >
      <div className="or-routing-sheet">
        <section className="or-routing-sheet__section" aria-labelledby={`${repoId}-condition`}>
          <h3 id={`${repoId}-condition`} className="or-routing-sheet__heading">
            Condition
          </h3>
          <LinearNote linear={linear} />
          <ConditionBuilder
            query={rule.query}
            onChange={setQuery}
            fields={fieldsById}
            linear={linear}
            errors={errors?.nodes ?? NO_NODE_ERRORS}
          />
          {rule.query.rules.length === 0 ? (
            <p className="or-routing__note">
              {rule.query.not
                ? "No conditions, negated: this rule matches no work item."
                : "No conditions: this rule matches every work item."}
            </p>
          ) : null}
        </section>
        <Field label="Repo" htmlFor={`${repoId}-repo`} stacked>
          <Select
            id={`${repoId}-repo`}
            value={rule.repositoryId}
            errorMessage={errors?.repository}
            onChange={(event) => change({ ...rule, repositoryId: event.target.value })}
          >
            {!known && (
              <option value={rule.repositoryId}>
                {rule.repositoryId ? "Unknown repo" : "Pick a repo"}
              </option>
            )}
            {repositories.map((repo) => (
              <option key={repo.id} value={repo.id}>
                {repo.fullPath}
              </option>
            ))}
          </Select>
        </Field>
        <CodingOff repository={repository} />
        {listErrors.map((message) => (
          <p key={message} role="alert" className="or-routing__error">
            {message}
          </p>
        ))}
      </div>
    </Sheet>
  );
}

// ── The card ──────────────────────────────────────────────────────────────────

/** Which rule the sheet edits: null adds one at the end. */
type Editing = { index: number | null; session: number } | null;

interface RuleRowProps {
  rule: DraftRule;
  index: number;
  count: number;
  fields: readonly RoutingFieldData[];
  repositories: readonly RoutingRepository[];
  errors: RuleErrors | undefined;
  canEdit: boolean;
  disabled: boolean;
  onMove: (to: number) => void;
  onEdit: () => void;
  onDelete: () => void;
}

function RuleRow({
  rule,
  index,
  count,
  fields,
  repositories,
  errors,
  canEdit,
  disabled,
  onMove,
  onEdit,
  onDelete,
}: RuleRowProps) {
  const number = index + 1;
  const repository = repositories.find((repo) => repo.id === rule.repositoryId);
  const messages = ruleMessages(errors);
  return (
    <li
      aria-label={`Rule ${number}`}
      className="or-routing__rule"
      data-rule={rule.key}
      data-invalid={messages.length > 0 ? true : undefined}
    >
      <span className="or-routing__number" aria-hidden="true">
        {number}
      </span>
      <div className="or-routing__body">
        <p className="or-routing__description">{ruleDescription(rule.query, fields)}</p>
        <div className="or-routing__target">
          <Target repository={repository} id={rule.repositoryId} />
        </div>
        <CodingOff repository={repository} />
        {messages.map((message) => (
          <p key={message} role="alert" className="or-routing__error">
            {message}
          </p>
        ))}
      </div>
      {canEdit ? (
        <div className="or-routing__actions">
          <IconButton
            size="sm"
            icon={IconArrowUp}
            label={`Move rule ${number} up`}
            data-move="up"
            disabled={disabled || index === 0}
            onClick={() => onMove(index - 1)}
          />
          <IconButton
            size="sm"
            icon={IconArrowDown}
            label={`Move rule ${number} down`}
            data-move="down"
            disabled={disabled || index === count - 1}
            onClick={() => onMove(index + 1)}
          />
          <IconButton
            size="sm"
            icon={IconPencil}
            label={`Edit rule ${number}`}
            disabled={disabled}
            onClick={onEdit}
          />
          <IconButton
            size="sm"
            icon={IconTrash}
            label={`Delete rule ${number}`}
            disabled={disabled}
            onClick={onDelete}
          />
        </div>
      ) : null}
    </li>
  );
}

/**
 * The "Routing rules" card: the organization's rules in order, each with its plain
 * description and target repo, then the built-in rules. Admins add, edit (in a `Sheet`),
 * reorder and delete rules; every change is staged in the card's `SaveBar` and saved in one
 * `PUT /api/ui/routing-rules`, whose answer is written into the cache. Another admin's save
 * arrives through the live query; under staged changes the bar says so and offers Discard
 * or Keep editing instead of overwriting it silently. Below it, "Test where an issue would go"
 * routes work items by the saved rules, or by the staged ones while there are changes.
 */
export function RoutingRulesCard({ data, isAdmin }: { data: RoutingRules; isAdmin: boolean }) {
  const saved = React.useMemo<RoutingDraft>(() => ({ rules: draftsOf(data.rules) }), [data.rules]);
  const fieldsById = React.useMemo(
    () => new Map(data.fields.map((field) => [field.id, field])),
    [data.fields],
  );
  const repositories = React.useMemo(
    () => [...data.repositories].sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    [data.repositories],
  );
  const toChanges = React.useCallback(
    (from: RoutingDraft, to: RoutingDraft) =>
      ruleChanges(to.rules, from.rules, data.fields, repositories),
    [data.fields, repositories],
  );
  const card = useStagedCard<RoutingDraft, SavedRoutingRules>({
    label: "Routing rules",
    anchorId: "routing-rules",
    saved,
    toChanges,
    save: {
      request: (draft, { organizationId }) =>
        api.put("/api/ui/routing-rules", savedRoutingRulesSchema, {
          body: { rules: toRuleInputs(draft.rules) },
          organizationId,
        }),
      applyResult: (result, cache) =>
        cache.set<RoutingRules>(
          routingRulesKey(cache.keys),
          (previous) => previous && { ...previous, rules: result.rules },
          { exact: true },
        ),
      success: "Saved the routing rules",
    },
    conflictMessage: ROUTING_RULES_CONFLICT,
  });
  const rules = card.draft.rules;
  // The pre-save check's errors; the save's own come from the card.
  const [checked, setChecked] = React.useState<DraftErrors>(NO_ERRORS);
  const saveErrors = React.useMemo(() => placeErrors(card.fieldErrors), [card.fieldErrors]);
  const errors = errorCount(checked) > 0 ? checked : saveErrors;
  const [editing, setEditing] = React.useState<Editing>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const list = React.useRef<HTMLOListElement>(null);
  // The rule whose move button gets focus back once a move has rendered.
  const pendingFocus = React.useRef<{ key: string; direction: "up" | "down" } | null>(null);

  React.useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const row = list.current?.querySelector(`[data-rule="${CSS.escape(pending.key)}"]`);
    const buttons = [pending.direction, pending.direction === "up" ? "down" : "up"].map((move) =>
      row?.querySelector<HTMLButtonElement>(`[data-move="${move}"]`),
    );
    buttons.find((button) => button && !button.disabled)?.focus();
  });

  const setRules = (next: DraftRule[]) => {
    setChecked(NO_ERRORS);
    card.set("rules", next);
  };

  const move = (from: number, to: number) => {
    const rule = rules[from];
    if (!rule || to < 0 || to >= rules.length) return;
    pendingFocus.current = { key: rule.key, direction: to < from ? "up" : "down" };
    setRules(moveRule(rules, from, to));
    setAnnouncement(`Moved rule ${from + 1} to position ${to + 1}.`);
  };

  const remove = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
    setAnnouncement(`Deleted rule ${index + 1}.`);
  };

  const apply = (rule: DraftRule) => {
    if (!editing) return;
    if (editing.index === null) {
      setRules([...rules, rule]);
      setAnnouncement(`Added rule ${rules.length + 1}.`);
    } else {
      setRules(rules.map((current, i) => (i === editing.index ? rule : current)));
    }
    setEditing(null);
  };

  const open = (index: number | null) =>
    setEditing((current) => ({ index, session: (current?.session ?? 0) + 1 }));

  const save = () => {
    const invalid = validateDrafts(rules, data.fields);
    if (invalid) {
      setChecked(invalid);
      return;
    }
    card.submit();
  };

  const discard = () => {
    setChecked(NO_ERRORS);
    card.discard();
  };

  const invalid = errors.rules.size;
  const full = rules.length >= MAX_ROUTING_RULES;

  return (
    <>
      <Card
        title="Routing rules"
        titleId="routing-rules"
        titleAddon={<ChangeHistoryPopover section="routing_rules" latest={data.history} />}
        actions={
          isAdmin ? (
            <Button
              icon={IconPlus}
              size="sm"
              className="or-routing__add"
              disabled={full || card.saving}
              disabledReason={full ? `At most ${MAX_ROUTING_RULES} rules.` : undefined}
              onClick={() => open(null)}
            >
              Add rule
            </Button>
          ) : undefined
        }
      >
        <p className="or-routing__lead">{ROUTING_RULES_DESCRIPTION}</p>
        {isAdmin && repositories.length === 0 ? (
          <p className="or-routing__note">
            Connect a repo first: every rule names the repo its work items build in.
          </p>
        ) : null}
        {invalid > 0 || errors.list.length > 0 ? (
          <p role="alert" className="or-routing__error">
            {[
              invalid === 1
                ? "1 rule needs attention."
                : invalid > 1
                  ? `${invalid} rules need attention.`
                  : null,
              ...errors.list,
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}
        {rules.length === 0 ? (
          <p className="or-routing__note">
            No rules yet: each repo&apos;s work item match decides.
          </p>
        ) : null}
        <ol ref={list} aria-label="Routing rules" className="or-routing__rules">
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.key}
              rule={rule}
              index={index}
              count={rules.length}
              fields={data.fields}
              repositories={repositories}
              errors={errors.rules.get(index)}
              canEdit={isAdmin}
              disabled={card.saving}
              onMove={(to) => move(index, to)}
              onEdit={() => open(index)}
              onDelete={() => remove(index)}
            />
          ))}
        </ol>
        <h3 className="or-routing__subheading" id="routing-built-in">
          After each repo&apos;s work item match
        </h3>
        <ul aria-labelledby="routing-built-in" className="or-routing__rules">
          {DEFAULT_RULES.map((label) => (
            <li
              key={label}
              aria-label={`Default rule: ${label}`}
              className="or-routing__rule or-routing__rule--default"
            >
              <span className="or-routing__number" aria-hidden="true" />
              <div className="or-routing__body">
                <p className="or-routing__description">{label}</p>
              </div>
              <MetaBadge text="Default" />
            </li>
          ))}
        </ul>
        <p role="status" className="or-routing__announce">
          {announcement}
        </p>
        {isAdmin ? (
          <SaveBar
            changes={card.changes}
            onSave={save}
            onDiscard={discard}
            saving={card.saving}
            error={card.error}
            conflict={card.conflict}
          />
        ) : null}
        {editing ? (
          <RuleSheet
            key={editing.session}
            number={editing.index === null ? rules.length + 1 : editing.index + 1}
            adding={editing.index === null}
            initial={editing.index === null ? newRule() : rules[editing.index]!}
            errors={editing.index === null ? undefined : errors.rules.get(editing.index)}
            fields={data.fields}
            fieldsById={fieldsById}
            linear={data.linear}
            repositories={repositories}
            onApply={apply}
            onClose={() => setEditing(null)}
          />
        ) : null}
      </Card>
      <RoutingTestCard staged={card.dirty ? rules : null} fields={data.fields} />
    </>
  );
}

/**
 * Advanced › Routing rules: every member sees the rules; admins change them. A live query:
 * another admin's save arrives through the `settings` event (section `routing_rules`).
 */
export function RoutingRulesSettings() {
  const query = useRoutingRules();
  const { role } = useCurrentUser();
  if (query.isPending) return <p aria-busy="true">Loading…</p>;
  if (query.isError) {
    return (
      <EmptyState
        title="Couldn't load the routing rules"
        description={query.error.message}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }
  return <RoutingRulesCard data={query.data} isAdmin={role === "admin"} />;
}
