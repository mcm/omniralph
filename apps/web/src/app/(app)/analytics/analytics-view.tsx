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
  ChartContainer,
  Empty,
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
import {
  IconArrowDownLeft,
  IconArrowUpRight,
  IconChartBar,
  IconCoins,
  IconHistory,
  IconListCheck,
  IconRepeat,
  IconServer,
  IconThumbDown,
} from "@tabler/icons-react";
import type { AnalyticsRepositoryRef } from "@omniralph/db";
import { AppHeader } from "@/components/app-header";
import { useCurrentUser } from "@/components/current-user";
import { ReviewStatusBadge, SeverityBadge } from "@/components/review-badges";
import {
  ANALYTICS_RANGES,
  analyticsHref,
  dayLabel,
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
import { ProviderIcon } from "../repositories/repositories-view";

interface AnalyticsViewProps {
  analytics: AnalyticsData;
  ralph: RalphAnalyticsData;
  /** Every repository, for the filter. */
  repositories: AnalyticsRepositoryRef[];
  params: AnalyticsParams;
}

/** Series intents: the headline series in accent, the comparison in info. */
const SERIES = { primary: "accent", secondary: "info" } as const;

const mono = { fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" } as const;
const cellText = { fontSize: "var(--text-sm)", color: "var(--text-secondary)" } as const;
const grid = (columns: string) =>
  ({ display: "grid", gridTemplateColumns: columns, gap: "var(--space-4)", minWidth: 0 }) as const;

function StatCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: React.ElementType;
}) {
  return (
    <Card style={{ minWidth: 0 }}>
      <CardHeader style={{ paddingBottom: "var(--space-2)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <CardDescription>{label}</CardDescription>
          <div
            style={{
              width: 32,
              height: 32,
              borderRadius: "var(--radius-md)",
              background: "var(--bg-raised)",
              border: "1px solid var(--border-subtle)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--text-accent)",
            }}
          >
            <Icon size={16} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div
          style={{
            fontSize: "var(--text-2xl)",
            fontWeight: 300,
            color: "var(--text-primary)",
            lineHeight: 1.1,
            marginBottom: "var(--space-1)",
          }}
        >
          {value}
        </div>
        <Muted style={{ ...mono, color: "var(--text-tertiary)" }}>{detail}</Muted>
      </CardContent>
    </Card>
  );
}

/** A label, a bar proportional to the largest count, and the count. */
function CountRows({ rows }: { rows: { key: string; label: React.ReactNode; count: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {rows.map((row) => (
        <div key={row.key} style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
          <div style={{ width: "calc(var(--space-16) * 3)", flexShrink: 0 }}>{row.label}</div>
          <Progress value={(row.count / max) * 100} style={{ flex: 1 }} />
          <span
            style={{
              ...mono,
              color: "var(--text-primary)",
              width: "var(--space-16)",
              textAlign: "right",
            }}
          >
            {row.count.toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}

function RepositoryLink({ repository }: { repository: AnalyticsRepositoryRef }) {
  return (
    <Link
      href={`/repositories/${repository.id}/reviews`}
      style={{
        ...mono,
        color: "var(--text-primary)",
        textDecoration: "none",
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-1)",
      }}
    >
      <ProviderIcon provider={repository.provider} size={12} />
      {repository.fullPath}
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
      title="No ralph runs"
      description="No ralph runs started in this period."
    />
  );

  return (
    <section
      aria-label="Ralph"
      style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", minWidth: 0 }}
    >
      <div>
        <h2
          style={{
            margin: 0,
            fontSize: "var(--text-lg)",
            fontWeight: "var(--font-weight-semibold)",
          }}
        >
          Ralph
        </h2>
        <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
          Token usage of ralph jobs, the runs started in the period and their stories&apos;
          outcomes.
        </Muted>
      </div>

      <div style={grid("repeat(4, minmax(0, 1fr))")}>
        <StatCard
          label="Runs started"
          value={ralph.totals.runs.toLocaleString()}
          detail={period}
          icon={IconRepeat}
        />
        <StatCard
          label="Ralph tokens"
          value={formatTokens(tokens)}
          detail={`${formatTokens(ralph.totals.tokensIn)} in, ${formatTokens(ralph.totals.tokensOut)} out, ${ralph.totals.jobs.toLocaleString()} jobs`}
          icon={IconCoins}
        />
        <StatCard
          label="Stories completed"
          value={completed.toLocaleString()}
          detail={`Of ${stories.toLocaleString()} finished stories`}
          icon={IconListCheck}
        />
        <StatCard
          label="Average attempts"
          value={completed === 0 ? "—" : ralph.averageAttempts.toLocaleString()}
          detail="Per completed story"
          icon={IconHistory}
        />
      </div>

      <div style={grid("minmax(0, 2fr) minmax(0, 1fr)")}>
        <Card ribbon style={{ minWidth: 0 }}>
          <CardHeader>
            <CardTitle>Ralph tokens per day</CardTitle>
            <CardDescription>
              {period}, ralph jobs next to reviews (tokens in + out)
            </CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns && tokens === 0 ? (
              noRunsEmpty
            ) : (
              <ChartContainer>
                <AreaChart
                  height={240}
                  data={daily}
                  xKey="day"
                  showLegend
                  areas={[
                    { key: "ralphTokens", label: "Ralph", variant: SERIES.primary },
                    { key: "reviewTokens", label: "Reviews", variant: SERIES.secondary },
                  ]}
                />
              </ChartContainer>
            )}
          </CardContent>
        </Card>
        <Card style={{ minWidth: 0 }}>
          <CardHeader>
            <CardTitle>Runs per day</CardTitle>
            <CardDescription>{period}, runs started by their status</CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns ? (
              noRunsEmpty
            ) : (
              <ChartContainer>
                <BarChart
                  height={240}
                  data={daily}
                  xKey="day"
                  stacked
                  showLegend
                  bars={RALPH_RUN_OUTCOMES.map((outcome) => ({
                    key: outcome,
                    label: RALPH_RUN_OUTCOME_LABELS[outcome],
                    variant: RALPH_RUN_STATUS_VARIANTS[outcome],
                  }))}
                />
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card style={{ minWidth: 0 }}>
        <CardHeader>
          <CardTitle>Story outcomes per day</CardTitle>
          <CardDescription>{period}, stories of the runs started each day</CardDescription>
        </CardHeader>
        <CardContent>
          {noRuns ? (
            noRunsEmpty
          ) : (
            <ChartContainer>
              <BarChart
                height={240}
                data={daily}
                xKey="day"
                stacked
                showLegend
                bars={RALPH_STORY_OUTCOMES.map((outcome) => ({
                  key: outcome,
                  label: RALPH_STORY_OUTCOME_LABELS[outcome],
                  variant: RALPH_STORY_OUTCOME_VARIANTS[outcome],
                }))}
              />
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      <div style={grid("repeat(2, minmax(0, 1fr))")}>
        <Card style={{ minWidth: 0 }}>
          <CardHeader>
            <CardTitle>Story outcomes</CardTitle>
            <CardDescription>Stories of the runs started in the period</CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns ? (
              noRunsEmpty
            ) : (
              <CountRows
                rows={RALPH_STORY_OUTCOMES.map((outcome) => ({
                  key: outcome,
                  label: <span style={cellText}>{RALPH_STORY_OUTCOME_LABELS[outcome]}</span>,
                  count: outcomes[outcome],
                }))}
              />
            )}
          </CardContent>
        </Card>
        <Card style={{ minWidth: 0 }}>
          <CardHeader>
            <CardTitle>Runs by status</CardTitle>
            <CardDescription>{ralph.totals.runs.toLocaleString()} runs</CardDescription>
          </CardHeader>
          <CardContent>
            {noRuns ? (
              noRunsEmpty
            ) : (
              <CountRows
                rows={RALPH_RUN_OUTCOMES.map((outcome) => ({
                  key: outcome,
                  label: <span style={cellText}>{RALPH_RUN_OUTCOME_LABELS[outcome]}</span>,
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

  return (
    <>
      <AppHeader breadcrumbs={[{ label: "Analytics" }]} />
      <main
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "var(--space-8)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--space-4)",
            flexWrap: "wrap",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1
              style={{
                margin: 0,
                fontSize: "var(--text-2xl)",
                fontWeight: "var(--font-weight-semibold)",
              }}
            >
              Analytics
            </h1>
            <Muted style={{ display: "block", marginTop: "var(--space-1)" }}>
              Token usage, review quality and ralph runs for {scope}, by UTC day.
            </Muted>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
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
          </div>
        </div>

        <div style={grid("repeat(4, minmax(0, 1fr))")}>
          <StatCard
            label="Reviews"
            value={totals.reviews.toLocaleString()}
            detail={period}
            icon={IconHistory}
          />
          <StatCard
            label="Tokens in"
            value={formatTokens(totals.tokensIn)}
            detail={`${totals.tokensIn.toLocaleString()} tokens`}
            icon={IconArrowDownLeft}
          />
          <StatCard
            label="Tokens out"
            value={formatTokens(totals.tokensOut)}
            detail={`${totals.tokensOut.toLocaleString()} tokens`}
            icon={IconArrowUpRight}
          />
          <StatCard
            label="Average per review"
            value={formatTokens(overallAverageTokens(analytics.byProfile))}
            detail="Tokens in + out, finished reviews"
            icon={IconCoins}
          />
        </div>

        <div style={grid("minmax(0, 2fr) minmax(0, 1fr)")}>
          <Card ribbon style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Tokens per day</CardTitle>
              <CardDescription>{period}, input and output stacked</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer>
                <AreaChart
                  height={240}
                  data={daily}
                  xKey="day"
                  stacked
                  showLegend
                  areas={[
                    { key: "tokensIn", label: "Tokens in", variant: SERIES.primary },
                    { key: "tokensOut", label: "Tokens out", variant: SERIES.secondary },
                  ]}
                />
              </ChartContainer>
            </CardContent>
          </Card>
          <Card style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Reviews per day</CardTitle>
              <CardDescription>{period}</CardDescription>
            </CardHeader>
            <CardContent>
              <ChartContainer>
                <BarChart
                  height={240}
                  data={daily}
                  xKey="day"
                  bars={[{ key: "reviews", label: "Reviews", variant: SERIES.primary }]}
                />
              </ChartContainer>
            </CardContent>
          </Card>
        </div>

        <div style={grid("repeat(3, minmax(0, 1fr))")}>
          <Card style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Average tokens per review</CardTitle>
              <CardDescription>By profile, completed and budget-exhausted reviews</CardDescription>
            </CardHeader>
            <CardContent
              style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}
            >
              {profiles.length === 0 ? (
                <Empty size="sm" icon={<IconChartBar size={20} />} title="No reviews" />
              ) : (
                <>
                  <ChartContainer>
                    <BarChart
                      height={160}
                      data={profiles}
                      xKey="profile"
                      bars={[
                        {
                          key: "averageTokens",
                          label: "Tokens per review",
                          variant: SERIES.primary,
                        },
                      ]}
                    />
                  </ChartContainer>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Profile</TableHead>
                        <TableHead style={{ textAlign: "right" }}>Reviews</TableHead>
                        <TableHead style={{ textAlign: "right" }}>Average</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.byProfile.map((p) => (
                        <TableRow key={p.profileId ?? "deleted"}>
                          <TableCell style={cellText}>
                            {p.profileName ?? "Deleted profile"}
                          </TableCell>
                          <TableCell style={{ ...mono, textAlign: "right" }}>
                            {p.reviews.toLocaleString()}
                          </TableCell>
                          <TableCell
                            style={{ ...mono, textAlign: "right" }}
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
          <Card style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Reviews by status</CardTitle>
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
          <Card style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Findings by severity</CardTitle>
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

        <div style={grid("minmax(0, 3fr) minmax(0, 2fr)")}>
          <Card style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Dismissal rate per repository</CardTitle>
              <CardDescription>
                Dismissed findings out of all findings (superseded ones excluded). A high rate
                points to a noisy repository: check its learned rules and profile.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {analytics.dismissalsByRepository.length === 0 ? (
                <Empty
                  size="sm"
                  icon={<IconThumbDown size={20} />}
                  title="No findings"
                  description={noReviews ? "No reviews in this period." : undefined}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Repository</TableHead>
                      <TableHead style={{ textAlign: "right" }}>Findings</TableHead>
                      <TableHead style={{ textAlign: "right" }}>Dismissed</TableHead>
                      <TableHead style={{ textAlign: "right" }}>False positives</TableHead>
                      <TableHead>Rate</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analytics.dismissalsByRepository.map((d) => (
                      <TableRow key={d.repository.id}>
                        <TableCell>
                          <RepositoryLink repository={d.repository} />
                        </TableCell>
                        <TableCell style={{ ...mono, textAlign: "right" }}>
                          {d.findings.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ ...mono, textAlign: "right" }}>
                          {d.dismissed.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ ...mono, textAlign: "right" }}>
                          {d.falsePositives.toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: "var(--space-2)",
                              minWidth: "calc(var(--space-16) * 3)",
                            }}
                          >
                            <Progress
                              value={d.dismissalRate * 100}
                              variant={d.dismissalRate >= 0.5 ? "warning" : "accent"}
                              style={{ flex: 1 }}
                            />
                            <span style={{ ...mono, color: "var(--text-primary)" }}>
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
          <Card style={{ minWidth: 0 }}>
            <CardHeader>
              <CardTitle>Jobs per agent</CardTitle>
              <CardDescription>Jobs assigned to each agent, every job type</CardDescription>
            </CardHeader>
            <CardContent>
              {analytics.jobsByHarness.length === 0 ? (
                <Empty size="sm" icon={<IconServer size={20} />} title="No jobs ran" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Harness</TableHead>
                      <TableHead style={{ textAlign: "right" }}>Jobs</TableHead>
                      <TableHead style={{ textAlign: "right" }}>Completed</TableHead>
                      <TableHead style={{ textAlign: "right" }}>Failed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {analytics.jobsByHarness.map((a) => (
                      <TableRow key={a.agent.id}>
                        <TableCell>
                          {isAdmin ? (
                            <Link
                              href={`/harnesses/${a.agent.id}`}
                              style={{ ...cellText, textDecoration: "none" }}
                            >
                              {a.agent.name}
                            </Link>
                          ) : (
                            <span style={cellText}>{a.agent.name}</span>
                          )}
                        </TableCell>
                        <TableCell style={{ ...mono, textAlign: "right" }}>
                          {a.total.toLocaleString()}
                        </TableCell>
                        <TableCell style={{ ...mono, textAlign: "right" }}>
                          {a.completed.toLocaleString()}
                        </TableCell>
                        <TableCell
                          style={{
                            ...mono,
                            textAlign: "right",
                            color: a.failed > 0 ? "var(--danger-fg)" : undefined,
                          }}
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
        </div>

        <RalphSection ralph={ralph} analytics={analytics} period={period} />
      </main>
    </>
  );
}
