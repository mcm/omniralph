"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Cluster,
  Field,
  Input,
  Muted,
} from "@iamthemcmaster/ui";
import { IconPlayerPlay } from "@tabler/icons-react";
import { useCurrentUser } from "@/components/current-user";
import { api } from "@/lib/api/client";
import { routingTestResultSchema, type RoutingTestResult } from "@/lib/api/routing-rules";
import {
  toRuleInputs,
  validateDrafts,
  type DraftErrors,
  type DraftRule,
  type RoutingFieldData,
} from "./rule-editor";

/** The default rules' labels, by number (1–3). */
type DefaultLabels = readonly [string, string, string];

/** Fix the rules before testing: the endpoint validates them as a save does. */
export const INVALID_RULES_MESSAGE = "Fix the rules' errors to test an issue against them.";

function Outcome({ result }: { result: RoutingTestResult }) {
  if (result.outcome === "ask" || !result.repository) {
    return <Badge variant="neutral">Would ask which repository to use</Badge>;
  }
  const path = <code>{result.repository.fullPath}</code>;
  return result.outcome === "manual" ? (
    <Badge variant="warning">
      <span>{path}: manual (coding off)</span>
    </Badge>
  ) : (
    <Badge variant="success">{path}</Badge>
  );
}

function Result({ result, defaults }: { result: RoutingTestResult; defaults: DefaultLabels }) {
  const { rule } = result;
  const matched =
    rule === null
      ? "Work item match"
      : rule.kind === "custom"
        ? `Rule ${rule.number}: ${rule.summary}`
        : `Default rule: ${defaults[rule.number - 1]}`;
  return (
    <dl className="routing-test-result" aria-label={`Route of ${result.issue.identifier}`}>
      <dt>Issue</dt>
      <dd>
        <strong>{result.issue.identifier}</strong> {result.issue.title}
      </dd>
      <dt>Matched</dt>
      <dd>{matched}</dd>
      <dt>Route</dt>
      <dd>
        {result.by ? (
          <>
            {result.by} → {result.repository ? <code>{result.repository.fullPath}</code> : null}
          </>
        ) : (
          "No rule routes it, so Omniralph would ask."
        )}
      </dd>
      <dt>Result</dt>
      <dd>
        <Outcome result={result} />
      </dd>
    </dl>
  );
}

/**
 * Settings › Routing's "Test an issue": where an issue would route under the rules as they
 * are in the editor (unsaved), with the matched rule and the chain of "route as" steps.
 */
export function RoutingTest({
  rules,
  fields,
  defaults,
  onInvalid,
}: {
  rules: readonly DraftRule[];
  fields: readonly RoutingFieldData[];
  defaults: DefaultLabels;
  /** The rules don't validate: show their errors in the editor. */
  onInvalid: (errors: DraftErrors) => void;
}) {
  const { organization } = useCurrentUser();
  const [identifier, setIdentifier] = React.useState("");
  const [inputError, setInputError] = React.useState<string | undefined>();
  const [tested, setTested] = React.useState<{
    rules: readonly DraftRule[];
    result: RoutingTestResult;
  } | null>(null);
  const test = useMutation({
    mutationFn: (body: { identifier: string; rules: ReturnType<typeof toRuleInputs> }) =>
      api.post("/api/ui/routing-rules/test", routingTestResultSchema, {
        body,
        organizationId: organization.id,
      }),
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = identifier.trim();
    if (!trimmed) {
      setInputError("Enter an issue identifier, e.g. ENG-12.");
      return;
    }
    const invalid = validateDrafts(rules, fields);
    if (invalid) {
      onInvalid(invalid);
      setInputError(INVALID_RULES_MESSAGE);
      return;
    }
    setInputError(undefined);
    const snapshot = rules;
    test.mutate(
      { identifier: trimmed, rules: toRuleInputs(rules) },
      {
        onSuccess: (result) => setTested({ rules: snapshot, result }),
        onError: () => setTested(null),
      },
    );
  };

  const error = inputError ?? (test.isError ? test.error.message : undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Test an issue</CardTitle>
        <CardDescription>
          Where an issue would route under the rules above, including changes you haven&apos;t
          saved. Nothing is saved or sent to Linear.
        </CardDescription>
      </CardHeader>
      <CardContent className="routing-test">
        <Cluster gap={3} align="end" asChild>
          <form onSubmit={submit}>
            <Field
              label="Issue"
              htmlFor="routing-test-issue"
              error={error}
              className="routing-test-field"
            >
              <Input
                id="routing-test-issue"
                autoComplete="off"
                placeholder="e.g. ENG-12"
                maxLength={100}
                value={identifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                  setInputError(undefined);
                }}
              />
            </Field>
            <Button type="submit" variant="secondary" disabled={test.isPending}>
              <IconPlayerPlay size={14} />
              {test.isPending ? "Testing…" : "Test"}
            </Button>
          </form>
        </Cluster>
        {tested && (
          <>
            <Result result={tested.result} defaults={defaults} />
            {tested.rules !== rules && (
              <Muted>The rules changed since this test: test again to see their effect.</Muted>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
