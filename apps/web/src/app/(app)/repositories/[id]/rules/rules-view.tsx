"use client";

import * as React from "react";
import { Link } from "@/components/link";
import { useParams } from "next/navigation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Empty,
  Field,
  Muted,
  Skeleton,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from "@iamthemcmaster/ui";
import {
  IconBulb,
  IconDeviceFloppy,
  IconExternalLink,
  IconGavel,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { MAX_RULE_LENGTH, RuleInput } from "@omniralph/shared";
import { useMutationState } from "@tanstack/react-query";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { Freshness } from "@/components/freshness";
import { PhoneMeta, Timestamp, WIDE_COLUMN } from "@/components/list-table";
import { MonoPath } from "@/components/mono-value";
import { PageHeader } from "@/components/page-header";
import { ProviderIcon } from "@/components/provider-icon";
import { QueryBoundary } from "@/components/query-boundary";
import { useApiMutation } from "@/components/use-api-mutation";
import { api } from "@/lib/api/client";
import type { QueryKeys } from "@/lib/api/keys";
import type { RepositoryRules, RuleChange } from "@/lib/api/rules";
import { mutationResultSchema } from "@/lib/api/schemas";
import type { RuleView } from "@/lib/rules/display";
import { RepositoryNav } from "../repository-nav";
import { useRepositoryRules } from "../repository-queries";

/** What a rule change affects: the repository's Rules tab (rules show nowhere else). */
const rulesChanged = (repositoryId: string) => (keys: QueryKeys) => [
  keys.repositories.part(repositoryId, "rules"),
];

/** Sends a rule's change (`PATCH`): a new text, or switched on or off. */
function patchRule(
  repositoryId: string,
  ruleId: string,
  change: RuleChange,
  organizationId: string,
) {
  return api.patch(`/api/ui/repositories/${repositoryId}/rules/${ruleId}`, mutationResultSchema, {
    body: change,
    organizationId,
  });
}

const ruleSwitchMutationKey = (repositoryId: string) => ["rule-enabled", repositoryId];

/** A rule switched on or off, as sent and as shown before the server answers. */
interface RuleSwitch {
  ruleId: string;
  enabled: boolean;
}

/**
 * Switches the repository's rules on and off (admins): `pendingEnabled` holds the state each
 * rule with a switch in flight shows meanwhile, so the switch moves at once (optimistic) and
 * goes back by itself when the change fails (with the server's error as a toast). The rules
 * refetch before a change settles, so it never flickers back on success.
 */
export function useRuleSwitch(repositoryId: string) {
  const mutation = useApiMutation({
    mutationKey: ruleSwitchMutationKey(repositoryId),
    mutationFn: ({ ruleId, enabled }: RuleSwitch, { organizationId }) =>
      patchRule(repositoryId, ruleId, { enabled }, organizationId),
    invalidate: rulesChanged(repositoryId),
    success: (_, { enabled }) => (enabled ? "Rule enabled" : "Rule disabled"),
  });
  const pending = useMutationState({
    filters: { mutationKey: ruleSwitchMutationKey(repositoryId), status: "pending" },
    select: (m) => m.state.variables as RuleSwitch | undefined,
  });
  const pendingEnabled = new Map<string, boolean>();
  for (const change of pending) {
    if (change) pendingEnabled.set(change.ruleId, change.enabled);
  }
  return { setEnabled: mutation.mutate, pendingEnabled };
}

/** Validates a rule's text like the server does; returns the error message, if any. */
function ruleTextError(text: string): string | undefined {
  const parsed = RuleInput.safeParse({ text });
  return parsed.success ? undefined : parsed.error.issues[0]?.message;
}

function RuleTextField({
  id,
  value,
  error,
  onChange,
  disabled,
}: {
  id: string;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <Field
      label="Rule"
      htmlFor={id}
      description={`${value.length.toLocaleString()} / ${MAX_RULE_LENGTH.toLocaleString()} characters.`}
      error={error}
    >
      <Textarea
        id={id}
        rows={3}
        disabled={disabled}
        error={Boolean(error)}
        aria-invalid={Boolean(error)}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Do not flag missing null checks on values returned by config.get(); it throws on missing keys."
      />
    </Field>
  );
}

function AddRuleCard({ repositoryId }: { repositoryId: string }) {
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();
  const add = useApiMutation({
    mutationFn: (input: RuleInput, { organizationId }) =>
      api.post(`/api/ui/repositories/${repositoryId}/rules`, mutationResultSchema, {
        body: input,
        organizationId,
      }),
    invalidate: rulesChanged(repositoryId),
    success: "Rule added; it applies to the next review",
    onSuccess: () => {
      setText("");
      setError(undefined);
    },
    onError: (failure) => setError(failure.fieldErrors?.text),
  });
  const pending = add.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = ruleTextError(text);
    if (invalid) {
      setError(invalid);
      return;
    }
    add.mutate({ text });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Add a custom rule</CardTitle>
        <CardDescription>
          Tell the reviewer what to flag or leave alone in this repository. Rules apply to the next
          review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Stack asChild gap={3}>
          <form onSubmit={submit} noValidate>
            <RuleTextField
              id="new-rule"
              value={text}
              error={error}
              onChange={setText}
              disabled={pending}
            />
            <div>
              <Button type="submit" variant="primary" disabled={pending}>
                <IconPlus size={14} />
                {pending ? "Adding…" : "Add rule"}
              </Button>
            </div>
          </form>
        </Stack>
      </CardContent>
    </Card>
  );
}

function EditRuleDialog({ repositoryId, rule }: { repositoryId: string; rule: RuleView }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState(rule.text);
  const [error, setError] = React.useState<string | undefined>();
  const edit = useApiMutation({
    mutationFn: (input: RuleInput, { organizationId }) =>
      patchRule(repositoryId, rule.id, input, organizationId),
    invalidate: rulesChanged(repositoryId),
    success: "Rule saved",
    onSuccess: () => setOpen(false),
    onError: (failure) => setError(failure.fieldErrors?.text),
  });
  const pending = edit.isPending;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setText(rule.text);
      setError(undefined);
    }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = ruleTextError(text);
    if (invalid) {
      setError(invalid);
      return;
    }
    edit.mutate({ text });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Edit rule">
          <IconPencil size={14} />
          <span className="list-label-wide">Edit</span>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>Edit {rule.kind} rule</DialogTitle>
            <DialogDescription>The change applies to the next review.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <RuleTextField id={`rule-${rule.id}`} value={text} error={error} onChange={setText} />
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={pending}>
              <IconDeviceFloppy size={14} />
              {pending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteRuleButton({ repositoryId, rule }: { repositoryId: string; rule: RuleView }) {
  const remove = useApiMutation({
    mutationFn: (_: void, { organizationId }) =>
      api.delete(`/api/ui/repositories/${repositoryId}/rules/${rule.id}`, mutationResultSchema, {
        organizationId,
      }),
    invalidate: rulesChanged(repositoryId),
    success: "Rule deleted",
  });
  const pending = remove.isPending;
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={pending} aria-label="Delete rule">
          <IconTrash size={14} />
          <span className="list-label-wide">Delete</span>
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this rule?</AlertDialogTitle>
          <AlertDialogDescription>
            {rule.kind === "learned"
              ? "Later reviews may raise the same kind of finding again. Disable it instead to keep it for later."
              : "This can't be undone. Disable it instead to keep it for later."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="danger" onClick={() => remove.mutate()}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * A rule's switch: `rule.enabled` already shows a change in flight (`useRuleSwitch`); it is
 * held (disabled) until the change settles, so two changes of one rule never race.
 */
function EnabledSwitch({
  rule,
  isAdmin,
  switching,
  onSwitch,
}: {
  rule: RuleView;
  isAdmin: boolean;
  switching: boolean;
  onSwitch: (change: RuleSwitch) => void;
}) {
  return (
    <Switch
      checked={rule.enabled}
      disabled={!isAdmin || switching}
      aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
      onCheckedChange={(enabled) => onSwitch({ ruleId: rule.id, enabled })}
    />
  );
}

/** Where a rule came from: the finding it was learned from, or who wrote it. */
function RuleSource({ rule, kind }: { rule: RuleView; kind: RuleView["kind"] }) {
  if (kind !== "learned") {
    return <span className="text-sm">{rule.createdBy ?? "Unknown user"}</span>;
  }
  if (!rule.sourceFinding) return <Muted>Finding deleted</Muted>;
  // A finding of a review from before review runs has no page to link to.
  return rule.sourceFinding.href ? (
    <Link
      href={rule.sourceFinding.href}
      className="text-sm text-text-accent"
      title={rule.sourceFinding.path}
    >
      {rule.sourceFinding.title}
    </Link>
  ) : (
    <span className="text-sm" title={rule.sourceFinding.path}>
      {rule.sourceFinding.title}
    </span>
  );
}

function RulesTable({
  repositoryId,
  rules,
  kind,
  isAdmin,
  pendingEnabled,
  onSwitch,
}: {
  repositoryId: string;
  rules: RuleView[];
  kind: RuleView["kind"];
  isAdmin: boolean;
  pendingEnabled: ReadonlyMap<string, boolean>;
  onSwitch: (change: RuleSwitch) => void;
}) {
  return (
    <Table className="list-table">
      <TableHeader>
        <TableRow>
          <TableHead>Rule</TableHead>
          <TableHead>Enabled</TableHead>
          <TableHead className={WIDE_COLUMN}>
            {kind === "learned" ? "Learned from" : "Created by"}
          </TableHead>
          <TableHead className={WIDE_COLUMN}>Created</TableHead>
          {isAdmin && <TableHead aria-label="Actions" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id}>
            <TableCell className="repo-rule-cell">
              <Stack gap={1} align="start">
                {/* Disabled rules are marked by a badge and secondary text, never by opacity:
                    dimming the row would also dim its working controls. */}
                {!rule.enabled && (
                  <Badge variant="neutral" size="sm">
                    Disabled
                  </Badge>
                )}
                <p
                  className={
                    rule.enabled ? "repo-rule-text" : "repo-rule-text repo-rule-text-disabled"
                  }
                >
                  {rule.text}
                </p>
              </Stack>
              <PhoneMeta>
                <RuleSource rule={rule} kind={kind} />
                <Timestamp iso={rule.createdAt} />
              </PhoneMeta>
            </TableCell>
            <TableCell>
              <EnabledSwitch
                rule={rule}
                isAdmin={isAdmin}
                switching={pendingEnabled.has(rule.id)}
                onSwitch={onSwitch}
              />
            </TableCell>
            <TableCell className={WIDE_COLUMN}>
              <RuleSource rule={rule} kind={kind} />
            </TableCell>
            <TableCell className={`${WIDE_COLUMN} list-nowrap`}>
              <Timestamp iso={rule.createdAt} />
            </TableCell>
            {isAdmin && (
              <TableCell className="list-actions">
                <div className="list-actions-group">
                  <EditRuleDialog repositoryId={repositoryId} rule={rule} />
                  <DeleteRuleButton repositoryId={repositoryId} rule={rule} />
                </div>
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RulesSkeleton() {
  return (
    <>
      {[3, 2].map((rows, card) => (
        <Card key={card}>
          <CardHeader>
            <Skeleton width="10rem" height="1.25rem" />
            <Skeleton width="16rem" />
          </CardHeader>
          <CardContent>
            <Stack gap={3}>
              {Array.from({ length: rows }, (_, index) => (
                <Skeleton key={index} width={`${50 + (((index + card) * 17) % 40)}%`} />
              ))}
            </Stack>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

/**
 * The custom and learned rules of a repository, with an add form and per-rule edit, switch and
 * delete for admins (members read them). A switch moves at once (`useRuleSwitch`).
 */
export function RulesContent({ repositoryId, rules }: { repositoryId: string; rules: RuleView[] }) {
  const isAdmin = useCurrentUser().role === "admin";
  const { setEnabled, pendingEnabled } = useRuleSwitch(repositoryId);
  const shown = rules.map((rule) => {
    const enabled = pendingEnabled.get(rule.id);
    return enabled === undefined ? rule : { ...rule, enabled };
  });
  const custom = shown.filter((r) => r.kind === "custom");
  const learned = shown.filter((r) => r.kind === "learned");

  return (
    <>
      {isAdmin && <AddRuleCard repositoryId={repositoryId} />}

      <Card>
        <CardHeader>
          <CardTitle as="h2">
            Custom rules <Badge variant="neutral">{custom.length}</Badge>
          </CardTitle>
          <CardDescription>Written by admins.</CardDescription>
        </CardHeader>
        <CardContent>
          {custom.length === 0 ? (
            <Empty
              titleAs="h3"
              icon={<IconGavel size={24} />}
              title="No custom rules"
              description={
                isAdmin
                  ? "Add one above to steer the reviewer."
                  : "An admin hasn't added any custom rules yet."
              }
            />
          ) : (
            <RulesTable
              repositoryId={repositoryId}
              rules={custom}
              kind="custom"
              isAdmin={isAdmin}
              pendingEnabled={pendingEnabled}
              onSwitch={setEnabled}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle as="h2">
            Learned rules <Badge variant="neutral">{learned.length}</Badge>
          </CardTitle>
          <CardDescription>
            Generated from findings dismissed as false positives with @bot dismiss in their thread
            on the PR. Near-duplicates of existing rules aren&apos;t added.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {learned.length === 0 ? (
            <Empty
              titleAs="h3"
              icon={<IconBulb size={24} />}
              title="No learned rules yet"
              description="Reply @bot dismiss in a finding's thread on the PR to teach the reviewer a rule."
            />
          ) : (
            <RulesTable
              repositoryId={repositoryId}
              rules={learned}
              kind="learned"
              isAdmin={isAdmin}
              pendingEnabled={pendingEnabled}
              onSwitch={setEnabled}
            />
          )}
        </CardContent>
      </Card>

      {!isAdmin && <Muted>Only admins can add, edit, disable or delete rules.</Muted>}
    </>
  );
}

/**
 * Repository › Rules, live (`GET /api/ui/repositories/{id}/rules`): rules added, edited,
 * switched or learned anywhere show up through the repository's live change events.
 */
export function RulesView() {
  const { id } = useParams<{ id: string }>();
  const rules = useRepositoryRules(id);
  const repository = rules.data?.repository;

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository?.fullPath ?? "Repository" },
          { label: "Rules" },
        ]}
      />
      <div className="detail-main">
        <PageHeader
          title={
            repository ? (
              <>
                <ProviderIcon provider={repository.provider} size={20} />
                <MonoPath value={repository.fullPath} />
              </>
            ) : (
              <Skeleton width="14rem" height="1.75rem" />
            )
          }
          description="Enabled rules are added to every review of this repository, after the review rubric. Dismissing a finding as a false positive teaches the reviewer a new rule."
          meta={rules.data && <Freshness query={rules} />}
          actions={
            repository && (
              <Button asChild variant="ghost" className="page-header-ghost">
                <a href={repository.webUrl} target="_blank" rel="noreferrer">
                  <IconExternalLink size={14} />
                  Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
                </a>
              </Button>
            )
          }
        />

        <RepositoryNav repositoryId={id} current="rules" />

        <QueryBoundary query={rules} skeleton={<RulesSkeleton />} what="the rules">
          {(data: RepositoryRules) => <RulesContent repositoryId={id} rules={data.rules} />}
        </QueryBoundary>
      </div>
    </>
  );
}
