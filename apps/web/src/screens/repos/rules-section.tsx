"use client";

import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  MetaBadge,
  SaveBar,
  Switch,
  Textarea,
  TextLink,
  useStagedCard,
  type StagedChange,
} from "@omniralph/ui";
import { MAX_RULE_LENGTH, RuleInput } from "@omniralph/shared";
import { IconPencil, IconPlus, IconTrash } from "@tabler/icons-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import type { z } from "zod";
import { useStagedSave, useUnsavedCard } from "@/components/staged-card";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { RepositoryDetail } from "@/lib/api/repositories";
import { ruleSaveResultSchema, type RepositoryRules, type RuleSaveResult } from "@/lib/api/rules";
import { mutationResultSchema } from "@/lib/api/schemas";
import { ruleEnabledEffect, ruleExcerpt } from "@/lib/repositories/effects";
import type { RuleView } from "@/lib/rules/display";
import { reposKeys, useRepositoryRules } from "./queries";
import { saveChangesLabel } from "./reviews-card";

type Provider = RepositoryDetail["repository"]["provider"];

const requestNoun = (provider: Provider) =>
  provider === "gitlab" ? "merge request" : "pull request";

/** The Rules section's empty state description (provider-worded). */
export const noRulesDescription = (provider: Provider) =>
  `Om learns a rule when someone marks a finding as a false positive on a ${requestNoun(provider)}.`;

const rulesPath = (repositoryId: string) =>
  `/api/ui/repositories/${encodeURIComponent(repositoryId)}/rules`;
const rulePath = (repositoryId: string, ruleId: string) =>
  `${rulesPath(repositoryId)}/${encodeURIComponent(ruleId)}`;

/** Rewrites the repo's cached rules with `update`. */
function updateRules(
  cache: MutationCache,
  repositoryId: string,
  update: (rules: RuleView[]) => RuleView[],
) {
  return cache.set<RepositoryRules>(reposKeys(cache.keys).rules(repositoryId), (previous) =>
    previous ? { ...previous, rules: update(previous.rules) } : previous,
  );
}

/** Puts a saved rule in the cached list: in its place, or at the end when it is new. */
function putRule(cache: MutationCache, repositoryId: string, rule: RuleView) {
  return updateRules(cache, repositoryId, (rules) =>
    rules.some((entry) => entry.id === rule.id)
      ? rules.map((entry) => (entry.id === rule.id ? rule : entry))
      : [...rules, rule],
  );
}

/** Validates a rule's text like the server does; returns the error message, if any. */
function ruleTextError(text: string): string | undefined {
  const parsed = RuleInput.safeParse({ text });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

/**
 * Sends a rule's text (`POST …/rules` for a new rule, `PATCH …/rules/{id}` for an edit). The
 * saved rule from the response goes into the list at once; the repo's change event then
 * reconciles it (no refetch is awaited). A refusal's field error shows on the form.
 */
function useRuleTextSave(repositoryId: string, ruleId: string | null, onSaved: () => void) {
  const [error, setError] = useState<string | undefined>();
  const mutation = useApiMutation<RuleSaveResult, RuleInput>({
    mutationFn: (input, { organizationId }) =>
      ruleId
        ? api.patch(rulePath(repositoryId, ruleId), ruleSaveResultSchema, {
            body: input,
            organizationId,
          })
        : api.post(rulesPath(repositoryId), ruleSaveResultSchema, { body: input, organizationId }),
    applyResult: (result, cache) => putRule(cache, repositoryId, result.rule),
    invalidate: () => [],
    success: ruleId ? "Rule saved" : "Rule added",
    onSuccess: () => {
      setError(undefined);
      onSaved();
    },
    onError: (failure) => setError(failure.fieldErrors?.text ?? failure.message),
  });
  const submit = (text: string) => {
    const invalid = ruleTextError(text);
    if (invalid) {
      setError(invalid);
      return;
    }
    mutation.mutate({ text });
  };
  return { submit, error, saving: mutation.isPending };
}

/** A rule's text being written: a `Textarea` with Save and Cancel. */
function RuleForm({
  initial,
  error,
  saving,
  onSubmit,
  onCancel,
  className,
}: {
  initial: string;
  error: string | undefined;
  saving: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const [text, setText] = useState(initial);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(text);
  };
  return (
    <form
      className={["or-repo-rule-form", className].filter(Boolean).join(" ")}
      onSubmit={submit}
      noValidate
    >
      <Field
        label="Rule"
        stacked
        description={`${text.length.toLocaleString()} / ${MAX_RULE_LENGTH.toLocaleString()} characters.`}
      >
        <Textarea
          rows={3}
          value={text}
          disabled={saving}
          autoFocus
          onChange={(event) => setText(event.target.value)}
          errorMessage={error}
        />
      </Field>
      <div className="or-repo-rule-form__actions">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="solid" disabled={saving} aria-busy={saving || undefined}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

function AddRuleForm({ repositoryId, onDone }: { repositoryId: string; onDone: () => void }) {
  const save = useRuleTextSave(repositoryId, null, onDone);
  return (
    <RuleForm
      className="or-repo-rule-form--add"
      initial=""
      error={save.error}
      saving={save.saving}
      onSubmit={save.submit}
      onCancel={onDone}
    />
  );
}

function EditRuleForm({
  repositoryId,
  rule,
  onDone,
}: {
  repositoryId: string;
  rule: RuleView;
  onDone: () => void;
}) {
  const save = useRuleTextSave(repositoryId, rule.id, onDone);
  return (
    <RuleForm
      initial={rule.text}
      error={save.error}
      saving={save.saving}
      onSubmit={save.submit}
      onCancel={onDone}
    />
  );
}

/** The rules' "Use rule" switches as the Rules card stages them: on or off, by rule ID. */
export interface RulesDraft {
  enabled: Record<string, boolean>;
}

const NO_RULES: RuleView[] = [];

function toDraft(rules: readonly RuleView[]): RulesDraft {
  return { enabled: Object.fromEntries(rules.map((rule) => [rule.id, rule.enabled])) };
}

/** The rules whose switch the draft changes, in the list's order (deleted rules drop out). */
function switchedRules(rules: readonly RuleView[], draft: RulesDraft): RuleView[] {
  return rules.filter(
    (rule) => draft.enabled[rule.id] !== undefined && draft.enabled[rule.id] !== rule.enabled,
  );
}

/** The save bar's items: each rule switched on or off, with what that does. */
export function rulesChanges(rules: readonly RuleView[], draft: RulesDraft): StagedChange[] {
  return switchedRules(rules, draft).map((rule) => ruleEnabledEffect(rule, !rule.enabled));
}

/**
 * The rules' switches as a staged card (the Repos save model): a switch only stages its
 * change in the card's save bar; Save sends each switched rule's `PATCH { enabled }` in turn
 * and writes the saved rules into the list.
 */
function useRuleSwitches(repositoryId: string, rules: readonly RuleView[]) {
  const saved = useMemo(() => toDraft(rules), [rules]);
  const toChanges = useCallback(
    (_saved: RulesDraft, draft: RulesDraft) => rulesChanges(rules, draft),
    [rules],
  );
  return useStagedCard<RulesDraft, RuleSaveResult[]>({
    label: "Rules",
    saved,
    toChanges,
    save: useStagedSave({
      request: async (draft, { organizationId }) => {
        const results: RuleSaveResult[] = [];
        for (const rule of switchedRules(rules, draft)) {
          results.push(
            await api.patch(rulePath(repositoryId, rule.id), ruleSaveResultSchema, {
              body: { enabled: draft.enabled[rule.id] },
              organizationId,
            }),
          );
        }
        return results;
      },
      applyResult: async (results, cache) => {
        for (const result of results) await putRule(cache, repositoryId, result.rule);
      },
    }),
    onDirtyChange: useUnsavedCard("Rules"),
  });
}

/** `DELETE …/rules/{id}`: the row leaves at once (back, with the error, if it fails). */
function useDeleteRule(repositoryId: string) {
  return useApiMutation<z.infer<typeof mutationResultSchema>, RuleView>({
    mutationFn: (rule, { organizationId }) =>
      api.delete(rulePath(repositoryId, rule.id), mutationResultSchema, { organizationId }),
    optimistic: (rule, cache) =>
      updateRules(cache, repositoryId, (rules) => rules.filter((entry) => entry.id !== rule.id)),
    invalidate: () => [],
    success: "Rule deleted",
  });
}

/** Where a rule came from: the finding a learned rule was learned from, or who wrote it. */
function RuleSource({ rule }: { rule: RuleView }) {
  if (rule.kind === "custom") {
    return <span>Written by {rule.createdBy ?? "a deleted user"}</span>;
  }
  const finding = rule.sourceFinding;
  return (
    <span>
      Learned by Om
      {finding ? (
        <>
          {" from "}
          {finding.href ? (
            <TextLink href={finding.href} title={finding.path}>
              {finding.title}
            </TextLink>
          ) : (
            <span title={finding.path}>{finding.title}</span>
          )}
        </>
      ) : (
        " from a finding that was deleted"
      )}
    </span>
  );
}

function RuleRow({
  repositoryId,
  rule,
  enabled,
  canEdit,
  saving,
  onSwitch,
  onDelete,
}: {
  repositoryId: string;
  rule: RuleView;
  /** The switch's state in the draft. */
  enabled: boolean;
  canEdit: boolean;
  saving: boolean;
  onSwitch: (enabled: boolean) => void;
  onDelete: (rule: RuleView) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Every control names its rule (WCAG 2.4.6), as "Unpin build-01" names its agent.
  const name = `rule “${ruleExcerpt(rule.text)}”`;
  return (
    <li className="or-repo-rules__row" data-enabled={enabled}>
      <div className="or-repo-rules__body">
        <MetaBadge text={rule.kind === "learned" ? "Learned" : "Written"} />
        {editing ? (
          <EditRuleForm repositoryId={repositoryId} rule={rule} onDone={() => setEditing(false)} />
        ) : (
          <p className="or-repo-rules__text">{rule.text}</p>
        )}
        <p className="or-repo-rules__source">
          <RuleSource rule={rule} />
        </p>
      </div>
      <div className="or-repo-rules__controls">
        <Switch
          aria-label={`Use ${name}`}
          checked={enabled}
          disabled={!canEdit || saving}
          onCheckedChange={onSwitch}
        />
        {canEdit ? (
          <>
            <IconButton
              label={`Edit ${name}`}
              icon={IconPencil}
              size="sm"
              disabled={editing}
              onClick={() => setEditing(true)}
            />
            <IconButton
              label={`Delete ${name}`}
              icon={IconTrash}
              size="sm"
              onClick={() => onDelete(rule)}
            />
          </>
        ) : null}
      </div>
    </li>
  );
}

function RulesBody({
  detail,
  adding,
  onAdding,
}: {
  detail: RepositoryDetail;
  adding: boolean;
  onAdding: (adding: boolean) => void;
}) {
  const { repository, canEdit } = detail;
  const rules = useRepositoryRules(repository.id);
  const card = useRuleSwitches(repository.id, rules.data?.rules ?? NO_RULES);
  const remove = useDeleteRule(repository.id);
  const [deleting, setDeleting] = useState<RuleView | null>(null);

  if (rules.isPending) {
    return (
      <div className="or-repo-skeleton" aria-busy="true" aria-label="Loading the rules">
        <div className="or-repo-skeleton__line" />
        <div className="or-repo-skeleton__line or-repo-skeleton__line--short" />
      </div>
    );
  }
  if (rules.isError) {
    return (
      <p className="or-repo-error" role="alert">
        Couldn&apos;t load the rules
        <Button variant="outline" size="sm" onClick={() => void rules.refetch()}>
          Retry
        </Button>
      </p>
    );
  }

  const list = rules.data.rules;
  const form = adding ? (
    <AddRuleForm repositoryId={repository.id} onDone={() => onAdding(false)} />
  ) : null;
  if (list.length === 0) {
    return (
      form ?? (
        <EmptyState
          title="No rules yet"
          headingLevel={3}
          description={noRulesDescription(repository.provider)}
          action={
            canEdit ? (
              <Button variant="outline" onClick={() => onAdding(true)}>
                Add rule
              </Button>
            ) : undefined
          }
        />
      )
    );
  }
  return (
    <>
      {form}
      <ul className="or-repo-rules" aria-label="Rules">
        {list.map((rule) => (
          <RuleRow
            key={rule.id}
            repositoryId={repository.id}
            rule={rule}
            enabled={card.draft.enabled[rule.id] ?? rule.enabled}
            canEdit={canEdit}
            saving={card.saving}
            onSwitch={(enabled) =>
              card.set("enabled", { ...card.draft.enabled, [rule.id]: enabled })
            }
            onDelete={setDeleting}
          />
        ))}
      </ul>
      {canEdit ? (
        <SaveBar
          changes={card.changes}
          onSave={card.submit}
          onDiscard={card.discard}
          saving={card.saving}
          error={card.error}
          saveLabel={saveChangesLabel(card.changes.length)}
        />
      ) : null}
      {canEdit ? (
        <ConfirmDialog
          open={deleting !== null}
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          title="Delete this rule?"
          description="Om stops following it in new reviews."
          confirmLabel="Delete rule"
          destructive
          onConfirm={() => {
            if (deleting) remove.mutate(deleting);
          }}
        />
      ) : null}
    </>
  );
}

/**
 * The Rules section: the repo's review rules, written by admins or learned from findings
 * marked as false positives. The rules' switches are staged like every Repos card: they show
 * in the card's save bar with their effect and save together. Adding, editing (each a form
 * with its own Save) and deleting (after a confirm) save the rule on its own
 * (`/api/ui/repositories/{id}/rules`) and show at once from the response (or
 * optimistically); the repo's change events refetch the list, so a rule learned from a pull
 * request appears without a refresh. Members see the rules read-only.
 */
export function RulesSection({ detail, titleId }: { detail: RepositoryDetail; titleId: string }) {
  const { repository, canEdit } = detail;
  const [adding, setAdding] = useState(false);
  const rules = useRepositoryRules(repository.id);
  // With no rules the empty state offers "Add rule" itself.
  const showAdd = canEdit && !adding && (rules.data?.rules.length ?? 0) > 0;
  return (
    <Card
      title="Rules"
      titleId={titleId}
      className="or-repo-card"
      actions={
        showAdd ? (
          <Button variant="outline" size="sm" icon={IconPlus} onClick={() => setAdding(true)}>
            Add rule
          </Button>
        ) : null
      }
    >
      <p className="or-repo-card__help">Om follows these rules when it reviews this repo.</p>
      <RulesBody detail={detail} adding={adding} onAdding={setAdding} />
    </Card>
  );
}
