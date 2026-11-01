"use client";

import {
  Button,
  Card,
  DataTable,
  Field,
  IssueBadge,
  RepoBadge,
  TextLink,
  TokenInput,
  type DataTableColumn,
} from "@omniralph/ui";
import type { TrackerProvider } from "@omniralph/tracker";
import * as React from "react";
import { useCurrentUser } from "@/components/current-user";
import { api, ApiError } from "@/lib/api/client";
import {
  routingPreviewSchema,
  routingTestResultSchema,
  type RoutingTestResult,
} from "@/lib/api/routing-rules";
import { runHref } from "@/lib/runs/hrefs";
import { toRuleInputs, validateDrafts, type DraftRule, type RoutingFieldData } from "./rule-editor";
import {
  decidedByLabel,
  identifierError,
  normalizeIdentifier,
  routedBySentence,
  ROUTING_TEST_MAX,
  ROUTING_TEST_STAGED_MAX,
  STAGED_LIMIT_MESSAGE,
  TOO_MANY_MESSAGE,
  type RoutingTestRow,
} from "./routing-test";

/** Shown before a test with unsaved rules when one of them isn't valid yet. */
export const INVALID_RULES_MESSAGE = "Fix the rules that need attention to test with them.";

/**
 * Where each identifier routes: the saved rules through one `POST /api/ui/routing/preview`,
 * or `staged` (the unsaved list) through one `POST /api/ui/routing-rules/test` each, where a
 * 404 is a work item the tracker doesn't know.
 */
async function routeIdentifiers(
  identifiers: readonly string[],
  staged: readonly DraftRule[] | null,
  organizationId: string,
): Promise<RoutingTestRow[]> {
  if (!staged) {
    const { results } = await api.post("/api/ui/routing/preview", routingPreviewSchema, {
      body: { identifiers },
      organizationId,
    });
    return results.map((result) => ({
      identifier: result.identifier,
      result: result.outcome === "not_found" ? null : result,
    }));
  }
  const rules = toRuleInputs(staged);
  return Promise.all(
    identifiers.map(async (identifier): Promise<RoutingTestRow> => {
      try {
        const result = await api.post("/api/ui/routing-rules/test", routingTestResultSchema, {
          body: { identifier, rules },
          organizationId,
        });
        return { identifier, result };
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return { identifier, result: null };
        throw error;
      }
    }),
  );
}

function Outcome({ result }: { result: RoutingTestResult | null }) {
  if (!result) return <span className="or-routing-test__missing">Not found</span>;
  if (result.outcome === "ask" || !result.repository) {
    return <span className="or-routing-test__outcome">Asks which repo</span>;
  }
  const badge = <RepoBadge host={result.repository.provider} name={result.repository.fullPath} />;
  if (result.outcome === "repository") return badge;
  return (
    <span className="or-routing-test__outcome">
      {badge}
      <span>Manual: Coding is off on this repo</span>
    </span>
  );
}

function AlreadyRouted({ run }: { run: RoutingTestResult["run"] }) {
  if (!run) return null;
  return (
    <TextLink href={runHref(run.id)}>
      {run.repository ? `Already routed to ${run.repository.fullPath}` : "Already has a run"}
    </TextLink>
  );
}

/** The results' columns, the work items carrying the tracker's mark. */
const columns = (tracker: TrackerProvider): readonly DataTableColumn<RoutingTestRow>[] => [
  {
    id: "work-item",
    header: "Work item",
    card: "title",
    cell: ({ identifier, result }) => (
      <span className="or-routing-test__item">
        <IssueBadge tracker={tracker} id={result?.issue.identifier ?? identifier} />
        {result ? <span className="or-routing-test__title">{result.issue.title}</span> : null}
      </span>
    ),
  },
  {
    id: "goes-to",
    header: "Goes to",
    card: "status",
    cell: ({ result }) => <Outcome result={result} />,
  },
  {
    id: "decided-by",
    header: "Decided by",
    cell: ({ result }) => (result ? decidedByLabel(result) : null),
  },
  {
    id: "why",
    header: "Why",
    cell: ({ result }) => (result ? routedBySentence(result.by) : null),
  },
  {
    id: "run",
    header: "Run",
    cell: ({ result }) => (result ? <AlreadyRouted run={result.run} /> : null),
  },
];

interface Tested {
  rows: RoutingTestRow[];
  /** Tested with the unsaved rules. */
  staged: boolean;
}

/**
 * "Test where a work item would go" (Design rule 14: only here, beside the routing rules): a
 * `TokenInput` of work item identifiers (`ENG-123`, up to 50) and Test. With no unsaved
 * change it previews the saved rules for every identifier in one request; with `staged` (the
 * card's unsaved list) it tests each identifier against it, at most 10 at once. Each result
 * shows the work item, where it goes, what decided it, why in a sentence and the run it
 * already has. Rate limits and a missing tracker connection answer with an alert.
 */
export function RoutingTestCard({
  staged,
  fields,
  tracker,
}: {
  /** The unsaved rules, or null when nothing is staged. */
  staged: readonly DraftRule[] | null;
  fields: readonly RoutingFieldData[];
  /** The organization's tracker, whose work items it tests. */
  tracker: TrackerProvider;
}) {
  const { organization } = useCurrentUser();
  const [identifiers, setIdentifiers] = React.useState<string[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [testing, setTesting] = React.useState(false);
  const [tested, setTested] = React.useState<Tested | null>(null);
  // Only the latest test's answer is shown.
  const latest = React.useRef(0);

  const change = (values: string[]) => {
    const next = [...new Set(values.map(normalizeIdentifier))];
    setError(next.length > ROUTING_TEST_MAX ? TOO_MANY_MESSAGE : null);
    setIdentifiers(next.slice(0, ROUTING_TEST_MAX));
  };

  const test = async (event: React.FormEvent) => {
    event.preventDefault();
    if (identifiers.length === 0) {
      setError("Enter at least one work item, like ENG-123.");
      return;
    }
    if (staged && identifiers.length > ROUTING_TEST_STAGED_MAX) {
      setError(STAGED_LIMIT_MESSAGE);
      return;
    }
    if (staged && validateDrafts(staged, fields)) {
      setError(INVALID_RULES_MESSAGE);
      return;
    }
    const request = ++latest.current;
    setError(null);
    setTesting(true);
    try {
      const rows = await routeIdentifiers(identifiers, staged, organization.id);
      if (request === latest.current) setTested({ rows, staged: staged !== null });
    } catch (failure) {
      if (request !== latest.current) return;
      setError(failure instanceof Error ? failure.message : "Couldn't test these work items.");
    } finally {
      if (request === latest.current) setTesting(false);
    }
  };

  return (
    <Card title="Test where a work item would go" titleId="routing-test">
      <form className="or-routing-test__form" onSubmit={(event) => void test(event)}>
        <Field
          label="Work items"
          htmlFor="routing-test-identifiers"
          className="or-routing-test__field"
        >
          <TokenInput
            id="routing-test-identifiers"
            values={identifiers}
            onChange={change}
            validate={identifierError}
            placeholder="ENG-123"
            autoComplete="off"
          />
        </Field>
        <Button type="submit" variant="solid" disabled={testing}>
          {testing ? "Testing…" : "Test"}
        </Button>
      </form>
      {staged ? (
        <p className="or-routing__note">
          Tests use your unsaved changes, up to {ROUTING_TEST_STAGED_MAX} work items at once.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="or-routing__error">
          {error}
        </p>
      ) : null}
      {tested ? (
        <>
          {tested.staged ? (
            <p className="or-routing__note">Tested with your unsaved changes.</p>
          ) : null}
          <DataTable
            caption="Where each work item would go"
            rows={tested.rows}
            getRowId={(row) => row.identifier}
            columns={columns(tracker)}
            className="or-routing-test__results"
          />
        </>
      ) : null}
    </Card>
  );
}
