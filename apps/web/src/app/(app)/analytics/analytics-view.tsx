"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AreaChart,
  BarChart,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Empty,
  Metric,
  Muted,
  NativeSelect,
  Progress,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
} from "@iamthemcmaster/ui";
import { IconChartBar, IconRepeat, IconServer, IconThumbDown } from "@tabler/icons-react";
import type { AnalyticsRepositoryRef } from "@omniralph/db";
import { AppHeader } from "@/components/app-header";
import { EmptyValue } from "@/components/empty-value";
import { useCurrentUser } from "@/components/current-user";
import { PhoneMeta, WIDE_COLUMN } from "@/components/list-table";
import { PageHeader } from "@/components/page-header";
import { MonoValue } from "@/components/mono-value";
import { ReviewStatusBadge, SeverityBadge } from "@/components/review-badges";
import { RalphRunStatusBadge } from "@/components/ralph-badges";
import {
  ANALYTICS_RANGES,
  analyticsHref,
  countTick,
  tokenTick,
  dayLabel,
  falsePositivesNoun,
  formatRate,
  overallAverageTokens,
  RALPH_RUN_OUTCOME_LABELS,
  RALPH_RUN_OUTCOMES,
  RALPH_STORY_OUTCOME_LABELS,
  RALPH_STORY_OUTCOMES,
  ralphDailyRows,
  type AnalyticsData,
  type AnalyticsParams,
  type RalphAnalyticsData,
} from "@/lib/analytics/display";
import { FINDING_SEVERITIES, formatTokens, REVIEW_STATUSES } from "@/lib/reviews/display";
import { RALPH_RUN_STATUS_VARIANTS, RALPH_STORY_OUTCOME_VARIANTS } from "@/lib/state-variants";
import { ProviderIcon } from "@/components/provider-icon";

interface AnalyticsViewProps {
  analytics: AnalyticsData;
  ralph: RalphAnalyticsData;
  /** Every repository, for the filter. */
  repositories: AnalyticsRepositoryRef[];
  params: AnalyticsParams;
}

/**
 * Series: the headline in accent; the comparison in neutral through
 * `--analytics-comparison`, which globals.css draws dashed with a fainter fill (plot and
 * legend), so the two never differ by hue alone.
 */
const PRIMARY_SERIES = { variant: "accent" } as const;
const COMPARISON_SERIES = { color: "var(--analytics-comparison)" } as const;

/** KPI tiles: the library `Metric`, mono value, reflowing by min width. */
function Metrics({ children }: { children: React.ReactNode }) {
  return <div className="analytics-metrics">{children}</div>;
}

/** A label, a bar proportional to the largest count, and the count. */
function CountRows({ rows }: { rows: { key: string; label: React.ReactNode; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="analytics-count-rows">
      {rows.map((row) => (
        <li key={row.key} className="analytics-count-row">
          <span className="analytics-count-label">{row.label}</span>
          <Progress value={(row.count / max) * 100} />
          <span className="analytics-num text-numeric">{row.count.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

function RepositoryLink({ repository }: { repository: AnalyticsRepositoryRef }) {
  return (
    <Link href={`/repositories/${repository.id}/reviews`} className="analytics-repo-link">
      <ProviderIcon provider={repository.provider} size={12} />
      <MonoValue value={repository.fullPath} />
    </Link>
  );
}

/** Ralph's token usage, runs and story outcomes over the period. */
function RalphSection({
  ralph,
  analytics,
  period,
}: {
  ralph: RalphAnalyticsData;
  analytics: AnalyticsData;
  period: string;
}) {
  const daily = ralphDailyRows(ralph, analytics);
  const tokens = ralph.totals.tokensIn + ralph.totals.tokensOut;
  const outcomes = ralph.storyOutcomes;
  const completed = outcomes.firstAttempt + outcomes.afterRetries;
  const stories = completed + outcomes.exhausted + outcomes.blocked;
  const noRuns = ralph.totals.runs === 0;
  const noRunsEmpty = (
    <Empty
      size="sm"
      icon={<IconRepeat size={20} />}
      title="No coding tasks"
      titleAs="h4"
      description="No coding tasks started in this period."
    />
  );

  return (
    <section aria-labelledby="analytics-ralph" className="analytics-section">
      <div>
        <h2 id="analytics-ralph" className="analytics-section-title">
          Coding
        </h2>
        <Muted>
          Token usage of coding jobs, the tasks started in the period and their stories&apos;
          outcomes.
        </Muted>
      </div>

      <Metrics>
        <Metric label="Runs started" value={ralph.totals.runs.toLocaleString()} />
        <Metric
          label="Coding tokens"
          value={formatTokens(tokens)}
          title={`${tokens.toLocaleString()} tokens`}
        />
        <Metric
          label="Stories completed"
          value={completed.toLocaleString()}
          unit={`of ${stories.toLocaleString()}`}
        />
        <Metric
          label="Attempts per story"
          value={completed === 0 ? <EmptyValue /> : ralph.averageAttempts.toLocaleString()}
          title="Average attempts per completed story"
        />
      </Metrics>

      <div className="analytics-split">
        <Card ribbon>
          <CardHeader>
            <CardTitle as="h3">Coding tokens per day</CardTitle>
            <CardDescription>
              {period}: {formatTokens(ralph.totals.tokensIn)} in,{" "}
              {formatTokens(ralph.totals.tokensOut)} out over {ralph.totals.jobs.toLocaleString()}{" "}
              jobs. Coding jobs next to reviews (in + out).
            </CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns && tokens === 0 ? (
              noRunsEmpty
            ) : (
              <AreaChart
                aria-label="Coding tokens per day"
                height={240}
                data={daily}
                xKey="day"
                showLegend
                tickFormatter={formatTokens}
                areas={[
                  { key: "ralphTokens", label: "Coding", ...PRIMARY_SERIES },
                  { key: "reviewTokens", label: "Reviews", ...COMPARISON_SERIES },
                ]}
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h3">Runs per day</CardTitle>
            <CardDescription>{period}, runs started by their status</CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns ? (
              noRunsEmpty
            ) : (
              <BarChart
                aria-label="Runs per day"
                height={240}
                data={daily}
                xKey="day"
                stacked
                showLegend
                tickFormatter={countTick}
                bars={RALPH_RUN_OUTCOMES.map((outcome) => ({
                  key: outcome,
                  label: RALPH_RUN_OUTCOME_LABELS[outcome],
                  variant: RALPH_RUN_STATUS_VARIANTS[outcome],
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle as="h3">Story outcomes per day</CardTitle>
          <CardDescription>{period}, stories of the runs started each day</CardDescription>
        </CardHeader>
        <CardContent>
          {noRuns ? (
            noRunsEmpty
          ) : (
            <BarChart
              aria-label="Story outcomes per day"
              height={240}
              data={daily}
              xKey="day"
              stacked
              showLegend
              tickFormatter={countTick}
              bars={RALPH_STORY_OUTCOMES.map((outcome) => ({
                key: outcome,
                label: RALPH_STORY_OUTCOME_LABELS[outcome],
                variant: RALPH_STORY_OUTCOME_VARIANTS[outcome],
              }))}
            />
          )}
        </CardContent>
      </Card>

      <div className="analytics-cards">
        <Card>
          <CardHeader>
            <CardTitle as="h3">Story outcomes</CardTitle>
            <CardDescription>Stories of the runs started in the period</CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns ? (
              noRunsEmpty
            ) : (
              <CountRows
                rows={RALPH_STORY_OUTCOMES.map((outcome) => ({
                  key: outcome,
                  label: RALPH_STORY_OUTCOME_LABELS[outcome],
                  count: outcomes[outcome],
                }))}
              />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle as="h3">Runs by status</CardTitle>
            <CardDescription>{ralph.totals.runs.toLocaleString()} runs</CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns ? (
              noRunsEmpty
            ) : (
              <CountRows
                rows={RALPH_RUN_OUTCOMES.map((outcome) => ({
                  key: outcome,
                  label: <RalphRunStatusBadge status={outcome} />,
                  count: ralph.runsByOutcome[outcome],
                }))}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

export function AnalyticsView({ analytics, ralph, repositories, params }: AnalyticsViewProps) {
  const isAdmin = useCurrentUser().role === "admin";
  const router = useRouter();
  const pathname = usePathname();
  const setFilter = (change: Partial<AnalyticsParams>) =>
    router.push(analyticsHref(pathname, { ...params, ...change }));

  const { totals } = analytics;
  const repository = repositories.find((r) => r.id === params.repositoryId) ?? null;
  const scope = repository ? repository.fullPath : "all repositories";
  const period = `Last ${params.days} days`;
  const daily = analytics.daily.map((d) => ({
    day: dayLabel(d.date),
    tokensIn: d.tokensIn,
    tokensOut: d.tokensOut,
    reviews: d.reviews,
  }));
  const profiles = analytics.byProfile.map((p) => ({
    profile: p.profileName ?? "Deleted profile",
    averageTokens: p.averageTokens,
  }));
  const totalFindings = Object.values(analytics.findingsBySeverity).reduce((a, b) => a + b, 0);
  const noReviews = totals.reviews === 0;
  const averageTokens = overallAverageTokens(analytics.byProfile);

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Analytics" }]} />
      <main className="detail-main analytics-main">
        <PageHeader
          title="Analytics"
          description={`Token usage, review quality and coding tasks for ${scope}, last ${params.days} days by UTC day.`}
          actions={
            <>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                aria-label="Time range"
                value={String(params.days)}
                onValueChange={(value) => {
                  if (value) setFilter({ days: Number(value) as AnalyticsParams["days"] });
                }}
              >
                {ANALYTICS_RANGES.map((days) => (
                  <ToggleGroupItem key={days} value={String(days)} aria-label={`Last ${days} days`}>
                    {days}d
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <NativeSelect
                aria-label="Filter by repository"
                value={params.repositoryId ?? ""}
                onChange={(e) => setFilter({ repositoryId: e.target.value || null })}
              >
                <option value="">All repositories</option>
                {repositories.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullPath}
                  </option>
                ))}
              </NativeSelect>
            </>
          }
        />

        <Metrics>
          <Metric label="Reviews" value={totals.reviews.toLocaleString()} />
          <Metric
            label="Tokens in"
            value={formatTokens(totals.tokensIn)}
            title={`${totals.tokensIn.toLocaleString()} tokens`}
          />
          <Metric
            label="Tokens out"
            value={formatTokens(totals.tokensOut)}
            title={`${totals.tokensOut.toLocaleString()} tokens`}
          />
          <Metric
            label="Tokens per review"
            value={formatTokens(averageTokens)}
            title={`${averageTokens.toLocaleString()} tokens in + out on average, finished reviews`}
          />
        </Metrics>

        <div className="analytics-split">
          <Card ribbon>
            <CardHeader>
              <CardTitle as="h2">Tokens per day</CardTitle>
              <CardDescription>
                {period}, input and output each on its own scale (output is far smaller)
              </CardDescription>
            </CardHeader>
            <CardContent className="analytics-card-stack">
              <AreaChart
                aria-label="Input tokens per day"
                height={176}
                data={daily}
                xKey="day"
                showLegend
                tickFormatter={tokenTick}
                areas={[{ key: "tokensIn", label: "Tokens in", ...PRIMARY_SERIES }]}
              />
              <AreaChart
                aria-label="Output tokens per day"
                height={128}
                data={daily}
                xKey="day"
                showLegend
                tickFormatter={tokenTick}
                areas={[{ key: "tokensOut", label: "Tokens out", ...COMPARISON_SERIES }]}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">Reviews per day</CardTitle>
              <CardDescription>{period}</CardDescription>
            </CardHeader>
            <CardContent>
              <BarChart
                aria-label="Reviews per day"
                height={240}
                data={daily}
                xKey="day"
                tickFormatter={countTick}
                bars={[{ key: "reviews", label: "Reviews", ...PRIMARY_SERIES }]}
              />
            </CardContent>
          </Card>
        </div>

        <div className="analytics-cards">
          <Card>
            <CardHeader>
              <CardTitle as="h2">Average tokens per review</CardTitle>
              <CardDescription>By profile, completed and budget-exhausted reviews</CardDescription>
            </CardHeader>
            <CardContent className="analytics-card-stack">
              {profiles.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<IconChartBar size={20} />}
                  title="No reviews"
                  titleAs="h3"
                />
              ) : (
                <>
                  <BarChart
                    aria-label="Average tokens per review by profile"
                    height={160}
                    data={profiles}
                    xKey="profile"
                    tickFormatter={formatTokens}
                    bars={[
                      {
                        key: "averageTokens",
                        label: "Tokens per review",
                        ...PRIMARY_SERIES,
                      },
                    ]}
                  />
                  <Table className="list-table">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Profile</TableHead>
                        <TableHead className="analytics-num">Reviews</TableHead>
                        <TableHead className="analytics-num">Average</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.byProfile.map((p) => (
                        <TableRow key={p.profileId ?? "deleted"}>
                          <TableCell className="analytics-cell-text">
                            {p.profileName ?? "Deleted profile"}
                          </TableCell>
                          <TableCell className="analytics-num text-numeric">
                            {p.reviews.toLocaleString()}
                          </TableCell>
                          <TableCell
                            className="analytics-num text-numeric"
                            title={`${p.averageTokens.toLocaleString()} tokens`}
                          >
                            {formatTokens(p.averageTokens)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">Reviews by status</CardTitle>
              <CardDescription>{totals.reviews.toLocaleString()} reviews</CardDescription>
            </CardHeader>
            <CardContent>
              <CountRows
                rows={REVIEW_STATUSES.map((status) => ({
                  key: status,
                  label: <ReviewStatusBadge status={status} />,
                  count: analytics.reviewsByStatus[status],
                }))}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle as="h2">Findings by severity</CardTitle>
              <CardDescription>{totalFindings.toLocaleString()} findings</CardDescription>
            </CardHeader>
            <CardContent>
              <CountRows
                rows={FINDING_SEVERITIES.map((severity) => ({
                  key: severity,
                  label: <SeverityBadge severity={severity} />,
                  count: analytics.findingsBySeverity[severity],
                }))}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Dismissal rate per repository</CardTitle>
            <CardDescription>
              Dismissed findings out of all findings (superseded ones excluded). A high rate points
              to a noisy repository: check its learned rules and profile.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.dismissalsByRepository.length === 0 ? (
              <Empty
                size="sm"
                icon={<IconThumbDown size={20} />}
                title="No findings"
                titleAs="h3"
                description={noReviews ? "No reviews in this period." : undefined}
              />
            ) : (
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead className="analytics-repo-col">Repository</TableHead>
                    <TableHead className={`analytics-num ${WIDE_COLUMN}`}>Findings</TableHead>
                    <TableHead className={`analytics-num ${WIDE_COLUMN}`}>Dismissed</TableHead>
                    <TableHead className={`analytics-num ${WIDE_COLUMN}`}>
                      False positives
                    </TableHead>
                    <TableHead className="analytics-rate-col">Rate</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.dismissalsByRepository.map((d) => (
                    <TableRow key={d.repository.id}>
                      <TableCell className="analytics-repo-col">
                        <RepositoryLink repository={d.repository} />
                        <PhoneMeta>
                          <span className="analytics-phone-detail">
                            <span className="text-numeric">{d.dismissed.toLocaleString()}</span> of{" "}
                            <span className="text-numeric">{d.findings.toLocaleString()}</span>{" "}
                            dismissed,{" "}
                            <span className="text-numeric">
                              {d.falsePositives.toLocaleString()}
                            </span>{" "}
                            {falsePositivesNoun(d.falsePositives)}
                          </span>
                        </PhoneMeta>
                      </TableCell>
                      <TableCell className={`analytics-num text-numeric ${WIDE_COLUMN}`}>
                        {d.findings.toLocaleString()}
                      </TableCell>
                      <TableCell className={`analytics-num text-numeric ${WIDE_COLUMN}`}>
                        {d.dismissed.toLocaleString()}
                      </TableCell>
                      <TableCell className={`analytics-num text-numeric ${WIDE_COLUMN}`}>
                        {d.falsePositives.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <div className="analytics-rate">
                          <Progress
                            value={d.dismissalRate * 100}
                            variant={d.dismissalRate >= 0.5 ? "warning" : "accent"}
                          />
                          <span className="analytics-num text-numeric">
                            {formatRate(d.dismissalRate)}
                          </span>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle as="h2">Jobs per agent</CardTitle>
            <CardDescription>Jobs assigned to each agent, every job type</CardDescription>
          </CardHeader>
          <CardContent>
            {analytics.jobsByHarness.length === 0 ? (
              <Empty size="sm" icon={<IconServer size={20} />} title="No jobs ran" titleAs="h3" />
            ) : (
              <Table className="list-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Harness</TableHead>
                    <TableHead className="analytics-num">Jobs</TableHead>
                    <TableHead className={`analytics-num ${WIDE_COLUMN}`}>Completed</TableHead>
                    <TableHead className="analytics-num">Failed</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.jobsByHarness.map((a) => (
                    <TableRow key={a.agent.id}>
                      <TableCell className="analytics-cell-text">
                        {isAdmin ? (
                          <Link href={`/harnesses/${a.agent.id}`} className="analytics-link">
                            {a.agent.name}
                          </Link>
                        ) : (
                          a.agent.name
                        )}
                        <PhoneMeta>
                          <span className="analytics-phone-detail text-numeric">
                            {a.completed.toLocaleString()} completed
                          </span>
                        </PhoneMeta>
                      </TableCell>
                      <TableCell className="analytics-num text-numeric">
                        {a.total.toLocaleString()}
                      </TableCell>
                      <TableCell className={`analytics-num text-numeric ${WIDE_COLUMN}`}>
                        {a.completed.toLocaleString()}
                      </TableCell>
                      <TableCell
                        className="analytics-num text-numeric"
                        data-failed={a.failed > 0 || undefined}
                      >
                        {a.failed.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <RalphSection ralph={ralph} analytics={analytics} period={period} />
      </main>
    </>
  );
}
