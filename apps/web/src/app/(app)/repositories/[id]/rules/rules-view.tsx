"use client";

import * as React from "react";
import Link from "next/link";
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
  IconListCheck,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { MAX_RULE_LENGTH, RuleInput } from "@omniralph/shared";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { useAction } from "@/components/use-action";
import { formatDateTime } from "@/lib/format-date";
import type { RuleView } from "@/lib/rules/display";
import { ProviderIcon } from "../../repositories-view";
import { RepositoryNav } from "../repository-nav";
import { addCustomRule, deleteRule, editRule, setRuleEnabled } from "./actions";

interface RulesViewProps {
  repository: {
    id: string;
    provider: "github" | "gitlab";
    fullPath: string;
    webUrl: string;
  };
  rules: RuleView[];
}

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
};

const ruleText: React.CSSProperties = {
  margin: 0,
  fontSize: "var(--text-sm)",
  color: "var(--text-primary)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

/** Validates a rule's text like the server action does; returns the error message, if any. */
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
      hint={`${value.length.toLocaleString()} / ${MAX_RULE_LENGTH.toLocaleString()} characters.`}
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
  const { pending, run } = useAction();
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | undefined>();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const invalid = ruleTextError(text);
    if (invalid) {
      setError(invalid);
      return;
    }
    run(
      () => addCustomRule(repositoryId, { text }),
      "Rule added; it applies to the next review",
      () => {
        setText("");
        setError(undefined);
      },
      (result) => setError(result.fieldErrors?.text),
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add a custom rule</CardTitle>
        <CardDescription>
          Tell the reviewer what to flag or leave alone in this repository. Rules apply to the next
          review.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} noValidate style={stack}>
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
      </CardContent>
    </Card>
  );
}

function EditRuleDialog({ repositoryId, rule }: { repositoryId: string; rule: RuleView }) {
  const { pending, run } = useAction();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState(rule.text);
  const [error, setError] = React.useState<string | undefined>();

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
    run(
      () => editRule(repositoryId, rule.id, { text }),
      "Rule saved",
      () => setOpen(false),
      (result) => setError(result.fieldErrors?.text),
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" aria-label="Edit rule">
          <IconPencil size={14} />
          Edit
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
  const { pending, run } = useAction();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="ghost" disabled={pending} aria-label="Delete rule">
          <IconTrash size={14} />
          Delete
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
          <AlertDialogAction
            onClick={() => run(() => deleteRule(repositoryId, rule.id), "Rule deleted")}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EnabledSwitch({
  repositoryId,
  rule,
  isAdmin,
}: {
  repositoryId: string;
  rule: RuleView;
  isAdmin: boolean;
}) {
  const { pending, run } = useAction();
  return (
    <Switch
      checked={rule.enabled}
      disabled={!isAdmin || pending}
      aria-label={rule.enabled ? "Disable rule" : "Enable rule"}
      onCheckedChange={(enabled) =>
        run(
          () => setRuleEnabled(repositoryId, rule.id, enabled),
          enabled ? "Rule enabled" : "Rule disabled",
        )
      }
    />
  );
}

function RulesTable({
  repositoryId,
  rules,
  kind,
  isAdmin,
}: {
  repositoryId: string;
  rules: RuleView[];
  kind: RuleView["kind"];
  isAdmin: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Rule</TableHead>
          <TableHead>Enabled</TableHead>
          <TableHead>{kind === "learned" ? "Learned from" : "Created by"}</TableHead>
          <TableHead>Created</TableHead>
          {isAdmin && <TableHead aria-label="Actions" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id} style={{ opacity: rule.enabled ? 1 : 0.7 }}>
            <TableCell style={{ minWidth: 280 }}>
              <p style={ruleText}>{rule.text}</p>
            </TableCell>
            <TableCell>
              <EnabledSwitch repositoryId={repositoryId} rule={rule} isAdmin={isAdmin} />
            </TableCell>
            <TableCell>
              {kind === "learned" ? (
                rule.sourceFinding ? (
                  <Link
                    href={rule.sourceFinding.href}
                    style={{ color: "var(--text-accent)", fontSize: "var(--text-sm)" }}
                    title={rule.sourceFinding.path}
                  >
                    {rule.sourceFinding.title}
                  </Link>
                ) : (
                  <Muted>Finding deleted</Muted>
                )
              ) : (
                <span style={{ fontSize: "var(--text-sm)" }}>
                  {rule.createdBy ?? "Unknown user"}
                </span>
              )}
            </TableCell>
            <TableCell style={{ whiteSpace: "nowrap" }}>
              <Muted>{formatDateTime(rule.createdAt)}</Muted>
            </TableCell>
            {isAdmin && (
              <TableCell>
                <div style={{ display: "flex", gap: "var(--space-1)", justifyContent: "flex-end" }}>
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

export function RulesView({ repository, rules }: RulesViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const custom = rules.filter((r) => r.kind === "custom");
  const learned = rules.filter((r) => r.kind === "learned");

  return (
    <>
      <AppHeader
        breadcrumbs={[
          { label: "Repositories", href: "/repositories" },
          { label: repository.fullPath },
          { label: "Rules" },
        ]}
      />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-5)",
        }}
      >
        <div style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-4)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "var(--text-2xl)",
                fontWeight: "var(--font-weight-semibold)",
                display: "flex",
                alignItems: "center",
                gap: "var(--space-2)",
              }}
            >
              <ProviderIcon provider={repository.provider} size={20} />
              <span style={{ fontFamily: "var(--font-mono)" }}>{repository.fullPath}</span>
            </h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              Enabled rules are added to every review of this repository, after the review rubric.
              Dismissing a finding as a false positive teaches the reviewer a new rule.
            </Muted>
          </div>
          <Button asChild variant="ghost">
            <a href={repository.webUrl} target="_blank" rel="noreferrer">
              <IconExternalLink size={14} />
              Open on {repository.provider === "github" ? "GitHub" : "GitLab"}
            </a>
          </Button>
        </div>

        <RepositoryNav repositoryId={repository.id} current="rules" />

        {isAdmin && <AddRuleCard repositoryId={repository.id} />}

        <Card>
          <CardHeader>
            <CardTitle>
              Custom rules <Badge variant="neutral">{custom.length}</Badge>
            </CardTitle>
            <CardDescription>Written by admins.</CardDescription>
          </CardHeader>
          <CardContent>
            {custom.length === 0 ? (
              <Empty
                icon={<IconListCheck size={24} />}
                title="No custom rules"
                description={
                  isAdmin
                    ? "Add one above to steer the reviewer."
                    : "An admin hasn't added any custom rules yet."
                }
              />
            ) : (
              <RulesTable
                repositoryId={repository.id}
                rules={custom}
                kind="custom"
                isAdmin={isAdmin}
              />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>
              Learned rules <Badge variant="neutral">{learned.length}</Badge>
            </CardTitle>
            <CardDescription>
              Generated from findings dismissed as false positives, in the control panel or with
              @bot dismiss. Near-duplicates of existing rules aren&apos;t added.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {learned.length === 0 ? (
              <Empty
                icon={<IconBulb size={24} />}
                title="No learned rules yet"
                description="Dismiss a finding as a false positive to teach the reviewer a rule."
              />
            ) : (
              <RulesTable
                repositoryId={repository.id}
                rules={learned}
                kind="learned"
                isAdmin={isAdmin}
              />
            )}
          </CardContent>
        </Card>

        {!isAdmin && <Muted>Only admins can add, edit, disable or delete rules.</Muted>}
      </main>
    </>
  );
}
