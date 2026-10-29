/**
 * `GET /api/ui/analytics/runs` fixtures for the Analytics view's tests, shaped like
 * production (usage.md, Oct 24): two organizations (NETbuilder, TheFrakinShip) over GitHub
 * and GitLab repos, about 30 stories a week, reviews all on Standard, a few triage runs and
 * asks, and rare failures (success near 98%). Every total is the sum of its buckets.
 */
import type { RunAnalyticsResponse } from "@/lib/api/analytics";
import { RUN_KINDS } from "@/lib/api/runs";

/** The test user's active organization (`TEST_ORGANIZATION_ID`). */
export const NETBUILDER = { id: "11111111-1111-4111-8111-111111111111", name: "NETbuilder" };
export const FRAKINSHIP = { id: "22222222-2222-4222-8222-222222222222", name: "TheFrakinShip" };

export const REPO_OMNIRALPH = {
  id: "a0000000-0000-4000-8000-000000000001",
  provider: "github" as const,
  fullPath: "mcm/omniralph",
};
export const REPO_PORTAL = {
  id: "a0000000-0000-4000-8000-000000000002",
  provider: "gitlab" as const,
  fullPath: "netbuilder/portal",
};
/** In scope, with no activity: the filter lists it, the By repo table doesn't. */
export const REPO_IDLE = {
  id: "a0000000-0000-4000-8000-000000000003",
  provider: "github" as const,
  fullPath: "netbuilder/archive",
};
export const REPO_SHIP = {
  id: "a0000000-0000-4000-8000-000000000004",
  provider: "github" as const,
  fullPath: "frakinship/ship",
};

type RunKind = (typeof RUN_KINDS)[number];
type Figures = RunAnalyticsResponse["totals"];
type Tokens = Figures["tokens"];

const DAY_MS = 86_400_000;
/** The window ends with Oct 24, 2026 (UTC). */
const TO = Date.UTC(2026, 9, 25);

function emptyTokens(): Tokens {
  return Object.fromEntries(
    RUN_KINDS.map((kind) => [kind, { tokensIn: 0, tokensOut: 0 }]),
  ) as Tokens;
}

function emptyFigures(): Figures {
  return {
    stories: 0,
    reviewRuns: 0,
    attempts: { finished: 0, completed: 0, failed: 0, expired: 0, successRate: null },
    tokens: emptyTokens(),
  };
}

/** `a + b`, the success rate derived again. */
function add(a: Figures, b: Figures): Figures {
  const completed = a.attempts.completed + b.attempts.completed;
  const failed = a.attempts.failed + b.attempts.failed;
  const expired = a.attempts.expired + b.attempts.expired;
  const rated = completed + failed + expired;
  return {
    stories: a.stories + b.stories,
    reviewRuns: a.reviewRuns + b.reviewRuns,
    attempts: {
      finished: a.attempts.finished + b.attempts.finished,
      completed,
      failed,
      expired,
      successRate: rated === 0 ? null : completed / rated,
    },
    tokens: Object.fromEntries(
      RUN_KINDS.map((kind) => [
        kind,
        {
          tokensIn: a.tokens[kind].tokensIn + b.tokens[kind].tokensIn,
          tokensOut: a.tokens[kind].tokensOut + b.tokens[kind].tokensOut,
        },
      ]),
    ) as Tokens,
  };
}

/** One organization-repo's figures on a day: `seed` varies them, `quiet` is no attempts. */
function day(seed: number, scale: number, quiet: boolean): Figures {
  const stories = quiet ? 0 : (seed % 3) + 3;
  const completed = quiet ? 0 : 10 + (seed % 5);
  const failed = quiet ? 0 : seed % 11 === 0 ? 1 : 0;
  const tokens = emptyTokens();
  const set = (kind: RunKind, tokensIn: number, tokensOut: number) => {
    tokens[kind] = { tokensIn: tokensIn * scale, tokensOut: tokensOut * scale };
  };
  set("epic", 1_800_000 + seed * 10_000, 42_000 + seed * 100);
  set("request", 120_000, 3_000);
  set("review", 300_000 + seed * 1_000, 9_000);
  set("triage", seed % 2 === 0 ? 40_000 : 0, seed % 2 === 0 ? 1_000 : 0);
  // Asks are rare enough to stay out of the window: "By kind" leaves Ask out.
  set("ask", 0, 0);
  const rated = completed + failed;
  return {
    stories,
    reviewRuns: quiet ? 0 : (seed % 4) + 8,
    attempts: {
      finished: rated,
      completed,
      failed,
      expired: 0,
      successRate: rated === 0 ? null : completed / rated,
    },
    tokens,
  };
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function bucketStarts(days: 7 | 30 | 90, bucket: "day" | "week"): string[] {
  const from = TO - days * DAY_MS;
  let start = from;
  if (bucket === "week") start -= ((new Date(from).getUTCDay() + 6) % 7) * DAY_MS;
  const step = bucket === "week" ? 7 * DAY_MS : DAY_MS;
  const starts: string[] = [];
  for (let t = start; t < TO; t += step) starts.push(iso(t));
  return starts;
}

/** Each bucket's first and following days inside the window. */
function daysOf(start: string, bucket: "day" | "week", from: number): number[] {
  const first = Date.parse(`${start}T00:00:00Z`);
  const length = bucket === "week" ? 7 : 1;
  return Array.from({ length }, (_, i) => first + i * DAY_MS).filter((t) => t >= from && t < TO);
}

interface ActiveRepository {
  repository: RunAnalyticsResponse["byRepository"][number]["repository"];
  organization: typeof NETBUILDER;
  scale: number;
}

const ACTIVE: ActiveRepository[] = [
  { repository: REPO_OMNIRALPH, organization: NETBUILDER, scale: 3 },
  { repository: REPO_PORTAL, organization: NETBUILDER, scale: 1 },
  { repository: REPO_SHIP, organization: FRAKINSHIP, scale: 2 },
];

export interface FixtureOptions {
  days?: 7 | 30 | 90;
  /** `all` (both organizations), else NETbuilder only. */
  scope?: "all" | "single";
  repositoryId?: string | null;
  /** Price the tokens (Epic 12): `costUsd` everywhere, and unpriced attempts on some. */
  cost?: boolean;
  /** Nothing ran in the window. */
  empty?: boolean;
}

/** USD at a flat made-up rate, so each sum's cost is its tokens'. */
const usd = (tokens: { tokensIn: number; tokensOut: number }) =>
  Math.round((tokens.tokensIn * 3 + tokens.tokensOut * 15) / 10_000) / 100;

function priced<T extends Figures>(figures: T, unpricedAttempts?: number): T {
  const tokens = Object.fromEntries(
    RUN_KINDS.map((kind) => [
      kind,
      { ...figures.tokens[kind], costUsd: usd(figures.tokens[kind]) },
    ]),
  ) as Tokens;
  const costUsd = RUN_KINDS.reduce((sum, kind) => sum + tokens[kind].costUsd!, 0);
  return {
    ...figures,
    tokens,
    costUsd: Math.round(costUsd * 100) / 100,
    ...(unpricedAttempts ? { unpricedAttempts } : {}),
  };
}

/** A whole response for the filters, in the shape the route answers. */
export function analyticsFixture({
  days = 30,
  scope = "single",
  repositoryId = null,
  cost = false,
  empty = false,
}: FixtureOptions = {}): RunAnalyticsResponse {
  const bucket = days === 90 ? "week" : "day";
  const from = TO - days * DAY_MS;
  const organizations = scope === "all" ? [FRAKINSHIP, NETBUILDER] : [NETBUILDER];
  const inScope = (organizationId: string) => organizations.some((o) => o.id === organizationId);
  const active = ACTIVE.filter(
    (a) =>
      !empty &&
      inScope(a.organization.id) &&
      (repositoryId === null || a.repository.id === repositoryId),
  );

  // The third day of the window had no finished attempt anywhere.
  const quietDay = from + 2 * DAY_MS;
  const figuresOn = (a: ActiveRepository, t: number) =>
    day(Math.round((t - from) / DAY_MS) + a.scale, a.scale, t === quietDay);

  const buckets = bucketStarts(days, bucket).map((start) => {
    let figures = emptyFigures();
    for (const a of active) {
      for (const t of daysOf(start, bucket, from)) figures = add(figures, figuresOn(a, t));
    }
    return { start, ...(cost ? priced(figures, start.endsWith("-12") ? 1 : undefined) : figures) };
  });
  const repositoryTotal = (a: ActiveRepository) => {
    let figures = emptyFigures();
    for (let t = from; t < TO; t += DAY_MS) figures = add(figures, figuresOn(a, t));
    return figures;
  };
  const byRepository = active
    .map((a) => {
      const figures = repositoryTotal(a);
      return {
        repository: a.repository,
        organization: a.organization,
        ...(cost ? priced(figures, a.repository === REPO_PORTAL ? 3 : undefined) : figures),
      };
    })
    .sort((a, b) => a.repository.fullPath.localeCompare(b.repository.fullPath));
  const byOrganization = organizations.map((organization) => {
    let figures = emptyFigures();
    for (const a of active.filter((a) => a.organization.id === organization.id)) {
      figures = add(figures, repositoryTotal(a));
    }
    return { organization, ...(cost ? priced(figures) : figures) };
  });
  let totals = emptyFigures();
  for (const a of active) totals = add(totals, repositoryTotal(a));

  const repositories = [
    { ...REPO_IDLE, organization: NETBUILDER },
    { ...REPO_OMNIRALPH, organization: NETBUILDER },
    { ...REPO_PORTAL, organization: NETBUILDER },
    { ...REPO_SHIP, organization: FRAKINSHIP },
  ]
    .filter((r) => inScope(r.organization.id))
    .sort((a, b) => a.fullPath.localeCompare(b.fullPath));

  return {
    from: new Date(from).toISOString(),
    to: new Date(TO).toISOString(),
    bucket,
    buckets,
    totals: cost ? priced(totals, 4) : totals,
    byRepository,
    byOrganization,
    repositories,
    params: { days, bucket, repositoryId },
  };
}

/** Tokens in and out of every kind. */
export function totalTokens(figures: Pick<Figures, "tokens">): { in: number; out: number } {
  return RUN_KINDS.reduce(
    (sum, kind) => ({
      in: sum.in + figures.tokens[kind].tokensIn,
      out: sum.out + figures.tokens[kind].tokensOut,
    }),
    { in: 0, out: 0 },
  );
}
