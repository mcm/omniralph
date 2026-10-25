"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Muted,
  NativeSelect,
  Skeleton,
  Stack,
} from "@iamthemcmaster/ui";
import { IconGripVertical, IconLock, IconPlus, IconTrash } from "@tabler/icons-react";
import type { RuleGroupType } from "react-querybuilder";
import { MAX_ROUTING_RULES } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { PageHeader } from "@/components/page-header";
import { QueryBoundary } from "@/components/query-boundary";
import { useQueryKeys } from "@/components/query-provider";
import { SettingsCard } from "@/components/settings-card";
import { useApiAction } from "@/components/use-api-action";
import { api } from "@/lib/api/client";
import {
  routingRulesSchema,
  savedRoutingRulesSchema,
  type RoutingRules,
} from "@/lib/api/routing-rules";
import {
  draftsOf,
  errorCount,
  moveRule,
  newRule,
  NO_ERRORS,
  placeErrors,
  ruleChanges,
  toRuleInputs,
  validateDrafts,
  type DraftErrors,
  type DraftRule,
  type RoutingFieldData,
  type RoutingLinear,
  type RoutingRepository,
} from "./rule-editor";
import { RoutingQueryBuilder } from "./routing-query-builder";
import { RoutingTest } from "./routing-test";

/** The built-in rules, always after the custom ones, in this order. */
export const DEFAULT_RULES = [
  "Follow-up → route as source issue",
  "Sub-issue → route as parent",
  "Ask which repository to use",
] as const;

/** The organization's routing rules and what editing them needs, live (`GET /api/ui/routing-rules`). */
export function useRoutingRules() {
  const keys = useQueryKeys();
  const { organization } = useCurrentUser();
  return useQuery({
    queryKey: keys.settings.detail("routing"),
    queryFn: ({ signal }) =>
      api.get("/api/ui/routing-rules", routingRulesSchema, {
        organizationId: organization.id,
        signal,
      }),
  });
}

// ── Rows ──────────────────────────────────────────────────────────────────────

function CodingOffBadge({ repository }: { repository: RoutingRepository | undefined }) {
  if (!repository || repository.codingEnabled) return null;
  return (
    <Badge variant="warning" size="sm" className="routing-coding-off">
      <span>
        Coding is off for <code>{repository.fullPath}</code>: matching issues are treated as manual.
      </span>
    </Badge>
  );
}

function RepositorySelect({
  number,
  value,
  repositories,
  error,
  disabled,
  onChange,
}: {
  number: number;
  value: string;
  repositories: readonly RoutingRepository[];
  error: string | undefined;
  disabled: boolean;
  onChange: (repositoryId: string) => void;
}) {
  const known = repositories.some((repo) => repo.id === value);
  const errorId = React.useId();
  return (
    <div className="routing-rule-target">
      <NativeSelect
        aria-label={`Rule ${number} repository`}
        value={value}
        disabled={disabled}
        error={Boolean(error)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        {!known && (
          <option value={value}>{value ? "Unknown repository" : "Pick a repository"}</option>
        )}
        {repositories.map((repo) => (
          <option key={repo.id} value={repo.id}>
            {repo.fullPath}
          </option>
        ))}
      </NativeSelect>
      {error && (
        <p id={errorId} role="alert" className="routing-node-error">
          {error}
        </p>
      )}
    </div>
  );
}

interface RuleRowProps {
  rule: DraftRule;
  index: number;
  count: number;
  fields: ReadonlyMap<string, RoutingFieldData>;
  linear: RoutingLinear;
  repositories: readonly RoutingRepository[];
  errors: DraftErrors;
  canEdit: boolean;
  dragging: boolean;
  dropTarget: boolean;
  handleRef: (element: HTMLButtonElement | null) => void;
  onChange: (rule: DraftRule) => void;
  onDelete: () => void;
  onMove: (to: number) => void;
  onDragStart: (event: React.DragEvent) => void;
  onDragOver: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
  onDragEnd: () => void;
}

const EMPTY_ERRORS: ReadonlyMap<string, string> = new Map();

function RuleRow({
  rule,
  index,
  count,
  fields,
  linear,
  repositories,
  errors,
  canEdit,
  dragging,
  dropTarget,
  handleRef,
  onChange,
  onDelete,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: RuleRowProps) {
  const number = index + 1;
  const ruleErrors = errors.rules.get(index);
  const repository = repositories.find((repo) => repo.id === rule.repositoryId);
  const setQuery = React.useCallback(
    (query: RuleGroupType) => onChange({ ...rule, query }),
    [onChange, rule],
  );
  return (
    <li
      aria-label={`Rule ${number}`}
      className="routing-rule"
      data-dragging={dragging || undefined}
      data-drop-target={dropTarget || undefined}
      data-invalid={ruleErrors ? true : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {canEdit ? (
        <Button
          ref={handleRef}
          type="button"
          variant="ghost"
          size="icon"
          className="routing-rule-handle"
          draggable
          aria-label={`Move rule ${number}`}
          title="Drag to reorder, or use the arrow keys"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" && index > 0) {
              e.preventDefault();
              onMove(index - 1);
            } else if (e.key === "ArrowDown" && index < count - 1) {
              e.preventDefault();
              onMove(index + 1);
            }
          }}
        >
          <IconGripVertical size={16} />
        </Button>
      ) : (
        <span className="routing-rule-handle" aria-hidden="true" />
      )}
      <span className="routing-rule-number" aria-hidden="true">
        {number}
      </span>
      <div className="routing-rule-condition">
        <RoutingQueryBuilder
          query={rule.query}
          onChange={setQuery}
          fields={fields}
          linear={linear}
          errors={ruleErrors?.nodes ?? EMPTY_ERRORS}
          disabled={!canEdit}
        />
        {rule.query.rules.length === 0 && (
          <Muted className="routing-rule-hint">
            {rule.query.not
              ? "No conditions, negated: this rule matches no issue."
              : "No conditions: this rule matches every issue."}
          </Muted>
        )}
      </div>
      <div className="routing-rule-target-cell">
        <RepositorySelect
          number={number}
          value={rule.repositoryId}
          repositories={repositories}
          error={ruleErrors?.repository}
          disabled={!canEdit}
          onChange={(repositoryId) => onChange({ ...rule, repositoryId })}
        />
        <CodingOffBadge repository={repository} />
      </div>
      {canEdit ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="routing-rule-delete"
          aria-label={`Delete rule ${number}`}
          title="Delete rule"
          onClick={onDelete}
        >
          <IconTrash size={16} />
        </Button>
      ) : (
        <span aria-hidden="true" />
      )}
    </li>
  );
}

function DefaultRow({ label }: { label: string }) {
  return (
    <li aria-label={`Default rule: ${label}`} className="routing-rule routing-rule-default">
      <span className="routing-rule-handle routing-rule-lock" title="Built in: can't be changed">
        <IconLock size={16} aria-hidden="true" />
      </span>
      <span className="routing-rule-number" aria-hidden="true" />
      <span className="routing-rule-condition routing-rule-default-text">{label}</span>
      <Badge variant="neutral" size="sm" className="routing-rule-default-badge">
        Default
      </Badge>
    </li>
  );
}

// ── Editor ────────────────────────────────────────────────────────────────────

function LinearNote({ linear }: { linear: RoutingLinear }) {
  if (linear.status === "connected") return null;
  return (
    <Alert variant="warning">
      <AlertDescription>
        {linear.status === "disconnected"
          ? "Linear isn't connected, so the value pickers can't offer your workspace's teams, projects, labels and people. Type values instead, or connect Linear in Integrations."
          : "Your Linear workspace's values couldn't be loaded, so the value pickers can't offer them. Type values instead, or reload the page to try again."}
      </AlertDescription>
    </Alert>
  );
}

/** Settings › Routing's editor: the rules, in order, then the default rules, with one save. */
export function RoutingRulesEditor({ data, canEdit }: { data: RoutingRules; canEdit: boolean }) {
  const apiAction = useApiAction();
  const saved = React.useMemo(() => draftsOf(data.rules), [data.rules]);
  // The draft while editing; null follows the saved rules.
  const [draft, setDraft] = React.useState<DraftRule[] | null>(null);
  const [errors, setErrors] = React.useState<DraftErrors>(NO_ERRORS);
  const [dragging, setDragging] = React.useState<number | null>(null);
  const [dropTarget, setDropTarget] = React.useState<number | null>(null);
  const [announcement, setAnnouncement] = React.useState("");
  const handles = React.useRef(new Map<string, HTMLButtonElement>());
  // The rule whose handle gets focus back once a keyboard move has rendered.
  const pendingFocus = React.useRef<string | null>(null);
  const rules = draft ?? saved;

  const fields = React.useMemo(
    () => new Map(data.fields.map((field) => [field.id, field])),
    [data.fields],
  );
  const repositories = React.useMemo(
    () => [...data.repositories].sort((a, b) => a.fullPath.localeCompare(b.fullPath)),
    [data.repositories],
  );
  const changes = ruleChanges(rules, saved, data.fields, repositories);

  React.useEffect(() => {
    if (pendingFocus.current === null) return;
    handles.current.get(pendingFocus.current)?.focus();
    pendingFocus.current = null;
  });

  const update = (next: DraftRule[]) => setDraft(next);
  // Errors are placed by index: moving, adding or removing rules leaves them misplaced.
  const reorder = (next: DraftRule[]) => {
    setErrors(NO_ERRORS);
    update(next);
  };

  const change = React.useCallback(
    (index: number, rule: DraftRule) => {
      setDraft((previous) => {
        const list = [...(previous ?? saved)];
        list[index] = rule;
        return list;
      });
      setErrors((previous) => {
        if (!previous.rules.has(index)) return previous;
        const next = new Map(previous.rules);
        next.delete(index);
        return { ...previous, rules: next };
      });
    },
    [saved],
  );

  const move = (from: number, to: number) => {
    const rule = rules[from];
    if (!rule || from === to) return;
    reorder(moveRule(rules, from, to));
    pendingFocus.current = rule.key;
    setAnnouncement(`Moved rule ${from + 1} to position ${to + 1}.`);
  };

  const add = () => reorder([...rules, newRule()]);

  const remove = (index: number) => {
    reorder(rules.filter((_, i) => i !== index));
    setAnnouncement(`Deleted rule ${index + 1}.`);
  };

  const discard = () => {
    setDraft(null);
    setErrors(NO_ERRORS);
  };

  const prepare = () => {
    const invalid = validateDrafts(rules, data.fields);
    if (invalid) {
      setErrors(invalid);
      return null;
    }
    setErrors(NO_ERRORS);
    const body = { rules: toRuleInputs(rules) };
    return {
      action: () =>
        apiAction(
          ({ organizationId }) =>
            api.put("/api/ui/routing-rules", savedRoutingRulesSchema, { body, organizationId }),
          (keys) => [keys.settings.detail("routing")],
        ),
      success: "Saved the routing rules",
      onSuccess: () => setDraft(null),
      onError: (result: { fieldErrors?: Record<string, string> }) =>
        setErrors(placeErrors(result.fieldErrors)),
    };
  };

  const invalid = errorCount(errors);

  return (
    <>
      <SettingsCard
        title="Rules"
        description={
          canEdit
            ? "Checked top to bottom: the first rule an issue matches picks its repository. Drag rules to reorder them. The default rules always come last."
            : "Checked top to bottom: the first rule an issue matches picks its repository. The default rules always come last. Only admins can change them."
        }
        changes={canEdit ? changes : []}
        prepare={prepare}
        onDiscard={discard}
        readOnly={!canEdit}
        contentClassName="routing-rules-content"
        actions={
          canEdit ? (
            <Button
              type="button"
              variant="secondary"
              onClick={add}
              disabled={rules.length >= MAX_ROUTING_RULES}
              className="routing-add-rule"
            >
              <IconPlus size={14} />
              Add rule
            </Button>
          ) : undefined
        }
      >
        <LinearNote linear={data.linear} />
        {invalid > 0 && (
          <Alert variant="danger" role="alert">
            <AlertDescription>
              {errors.rules.size > 0 &&
                (errors.rules.size === 1
                  ? "1 rule needs attention. "
                  : `${errors.rules.size} rules need attention. `)}
              {errors.list.join(" ")}
            </AlertDescription>
          </Alert>
        )}
        {repositories.length === 0 && (
          <Muted>
            Connect a repository first: every rule names the repository its issues build in.
          </Muted>
        )}
        <ol aria-label="Routing rules" className="routing-rules">
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.key}
              rule={rule}
              index={index}
              count={rules.length}
              fields={fields}
              linear={data.linear}
              repositories={repositories}
              errors={errors}
              canEdit={canEdit}
              dragging={dragging === index}
              dropTarget={dropTarget === index && dragging !== index}
              handleRef={(element) => {
                if (element) handles.current.set(rule.key, element);
                else handles.current.delete(rule.key);
              }}
              onChange={(next) => change(index, next)}
              onDelete={() => remove(index)}
              onMove={(to) => move(index, to)}
              onDragStart={(event) => {
                setDragging(index);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", rule.key);
                  const row = event.currentTarget.closest("li");
                  if (row) event.dataTransfer.setDragImage(row, 16, 16);
                }
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                if (dropTarget !== index) setDropTarget(index);
              }}
              onDrop={(event) => {
                if (dragging === null) return;
                event.preventDefault();
                move(dragging, index);
                setDragging(null);
                setDropTarget(null);
              }}
              onDragEnd={() => {
                setDragging(null);
                setDropTarget(null);
              }}
            />
          ))}
          {DEFAULT_RULES.map((label) => (
            <DefaultRow key={label} label={label} />
          ))}
        </ol>
        <p role="status" className="sr-only">
          {announcement}
        </p>
      </SettingsCard>
      <RoutingTest
        rules={rules}
        fields={data.fields}
        defaults={DEFAULT_RULES}
        onInvalid={setErrors}
      />
    </>
  );
}

function RoutingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-2/3" />
      </CardHeader>
      <Stack gap={3} asChild>
        <CardContent>
          {[0, 1, 2, 3].map((row) => (
            <Skeleton key={row} className="h-12 w-full" />
          ))}
        </CardContent>
      </Stack>
    </Card>
  );
}

/** Settings › Routing: every member sees the rules; admins edit them. */
export function RoutingSettingsView() {
  const query = useRoutingRules();
  const { role } = useCurrentUser();
  const isAdmin = role === "admin";
  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Routing" }]} />
      <div className="detail-main">
        <PageHeader
          title="Routing"
          description={
            isAdmin
              ? "Which repository a delegated issue, a triage request, an epic's story or a follow-up builds in."
              : "Which repository a delegated issue, a triage request, an epic's story or a follow-up builds in. Only admins can change the rules."
          }
        />
        <QueryBoundary query={query} skeleton={<RoutingSkeleton />} what="the routing rules">
          {(data) => <RoutingRulesEditor data={data} canEdit={isAdmin} />}
        </QueryBoundary>
      </div>
    </>
  );
}
