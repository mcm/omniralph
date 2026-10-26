"use client";

import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  MetaBadge,
  Switch,
  Textarea,
  TextLink,
} from "@omniralph/ui";
import { MAX_RULE_LENGTH, RuleInput } from "@omniralph/shared";
import { IconPencil, IconTrash } from "@tabler/icons-react";
import { useMutationState } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { z } from "zod";
import { useApiMutation, type MutationCache } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { RepositoryDetail } from "@/lib/api/repositories";
import { ruleSaveResultSchema, type RepositoryRules, type RuleSaveResult } from "@/lib/api/rules";
import { mutationResultSchema } from "@/lib/api/schemas";
import type { RuleView } from "@/lib/rules/display";
import { reposKeys, useRepositoryRules } from "./queries";

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

/** A rule switched on or off. */
interface RuleSwitch {
  ruleId: string;
  enabled: boolean;
}

const ruleSwitchKey = (repositoryId: string) => ["repo-rule-enabled", repositoryId];

/**
 * "Use this rule": `PATCH { enabled }`, shown at once (optimistic) and rolled back with the
 * server's error as a toast when it fails. `switching` holds the rules with a change in
 * flight, so two changes of one rule never race.
 */
function useRuleSwitch(repositoryId: string) {
  const mutation = useApiMutation<RuleSaveResult, RuleSwitch>({
    mutationKey: ruleSwitchKey(repositoryId),
    mutationFn: ({ ruleId, enabled }, { organizationId }) =>
      api.patch(rulePath(repositoryId, ruleId), ruleSaveResultSchema, {
        body: { enabled },
        organizationId,
      }),
    optimistic: ({ ruleId, enabled }, cache) =>
      updateRules(cache, repositoryId, (rules) =>
        rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule)),
      ),
    applyResult: (result, cache) => putRule(cache, repositoryId, result.rule),
    invalidate: () => [],
    success: (_result, { enabled }) => (enabled ? "Rule on" : "Rule off"),
  });
  const pending = useMutationState({
    filters: { mutationKey: ruleSwitchKey(repositoryId), status: "pending" },
    select: (entry) => (entry.state.variables as RuleSwitch | undefined)?.ruleId,
  });
  return { setEnabled: mutation.mutate, switching: new Set(pending) };
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
  canEdit,
  switching,
  onSwitch,
  onDelete,
}: {
  repositoryId: string;
  rule: RuleView;
  canEdit: boolean;
  switching: boolean;
  onSwitch: (change: RuleSwitch) => void;
  onDelete: (rule: RuleView) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="or-repo-rules__row" data-enabled={rule.enabled}>
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
          aria-label="Use this rule"
          checked={rule.enabled}
          disabled={!canEdit || switching}
          onCheckedChange={(enabled) => onSwitch({ ruleId: rule.id, enabled })}
        />
        {canEdit ? (
          <>
            <IconButton
              label="Edit rule"
              icon={IconPencil}
              size="sm"
              disabled={editing}
              onClick={() => setEditing(true)}
            />
            <IconButton
              label="Delete rule"
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
  const { setEnabled, switching } = useRuleSwitch(repository.id);
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
            canEdit={canEdit}
            switching={switching.has(rule.id)}
            onSwitch={setEnabled}
            onDelete={setDeleting}
          />
        ))}
      </ul>
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
 * marked as false positives. Rules are records: each add, edit, switch and delete saves on
 * its own (`/api/ui/repositories/{id}/rules`) and shows at once from the response (or
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
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
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
