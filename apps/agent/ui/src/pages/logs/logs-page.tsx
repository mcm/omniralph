/**
 * Logs (`/logs`): the agent's log, oldest at the top. The toolbar filters by level and text
 * (`GET /api/logs?level=&q=`, 200 lines a page, newest first), "Load older" pages back
 * through the file, and the `logs` events append new lines live. Pause holds new lines until
 * Resume. A reader at the bottom follows new lines; one who scrolled up stays where they are.
 * The page keeps at most `MAX_LOG_LINES` lines: the oldest pages go first.
 */
import { Button, IconButton, SegmentedControl, TextInput } from "@omniralph/ui";
import {
  IconChevronRight,
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
} from "@tabler/icons-react";
import {
  keepPreviousData,
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent,
} from "react";
import type { LogEntry } from "../../../../src/logs/entries.js";
import type { LogPageState } from "../../../../src/ui/log-routes.js";
import { localRequest } from "../../api.js";
import { agentKeys } from "../../live/keys.js";
import { clockTimeSeconds } from "../overview/model.js";
import { AgentPage } from "../page.js";
import {
  AT_LINE_LIMIT,
  LEVEL_OPTIONS,
  LOG_PAGE_SIZE,
  MAX_LOG_LINES,
  NOTHING_LOGGED,
  NOTHING_MATCHES,
  entriesAfter,
  fieldText,
  fitToCap,
  isProblemLevel,
  lineMatches,
  linesAfterPage,
  type LogFilterValue,
  type LogLine,
  type LogPageLevel,
} from "./model.js";

/** How long typing in Filter waits before asking the agent. */
export const FILTER_DELAY_MS = 200;
/** How close to the bottom (px) still counts as following. */
const BOTTOM_SLACK = 24;

type LogPages = InfiniteData<LogPageState, string | undefined>;

function logsUrl(filter: LogFilterValue, before: string | undefined): string {
  const params = new URLSearchParams({ level: filter.level });
  if (filter.q) params.set("q", filter.q);
  if (before) params.set("before", before);
  return `/api/logs?${params}`;
}

function useLogPages(filter: LogFilterValue) {
  return useInfiniteQuery({
    queryKey: agentKeys.logs.pages(filter),
    queryFn: ({ pageParam, signal }) =>
      localRequest<LogPageState>(logsUrl(filter, pageParam), { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.before ?? undefined,
    // The lines on screen stay while another filter loads.
    placeholderData: keepPreviousData,
  });
}

/**
 * The loaded pages' lines, oldest first, keyed by their content: a refetch or an older page
 * re-keys nothing, so an expanded line stays expanded.
 */
function keyedLines(pages: readonly LogPageState[]): LogLine[] {
  const lines: LogLine[] = [];
  const seen = new Map<string, number>();
  for (let p = pages.length - 1; p >= 0; p--) {
    const entries = pages[p]!.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const base = `${entry.time}:${entry.level}:${entry.msg}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      lines.push({ ...entry, key: `${base}:${n}` });
    }
  }
  return lines;
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * The live lines since the page opened (or the filter changed), and those Pause holds. It
 * listens to the cache itself rather than rendering the live tail: the tail is capped, and
 * several `logs` events can land between two renders.
 */
function useLiveLines(filter: LogFilterValue, paused: boolean) {
  const client = useQueryClient();
  const [lines, setLines] = useState<{ shown: LogLine[]; held: LogLine[] }>({
    shown: [],
    held: [],
  });
  const current = useRef({ filter, paused });
  current.current = { filter, paused };

  useEffect(() => {
    const key = agentKeys.logs.tail;
    // Lines from before the page opened are in the file, so the page's request has them.
    let last = client.getQueryData<LogEntry[]>(key)?.at(-1) ?? null;
    let nextKey = 0;
    return client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || !isTail(event.query.queryKey)) return;
      const tail = (event.query.state.data as LogEntry[] | undefined) ?? [];
      const fresh = entriesAfter(tail, last);
      last = tail.at(-1) ?? last;
      const { filter: applied, paused: holding } = current.current;
      const added = fresh
        .filter((entry) => lineMatches(entry, applied))
        .map((entry) => ({ ...entry, key: `live-${nextKey++}` }));
      if (added.length === 0) return;
      setLines((lines) =>
        holding
          ? { ...lines, held: [...lines.held, ...added] }
          : { ...lines, shown: [...lines.shown, ...added] },
      );
    });
  }, [client]);

  // Another filter: its page is read now, and holds what was live.
  const filterKey = `${filter.level}\u0000${filter.q}`;
  const appliedFilter = useRef(filterKey);
  useEffect(() => {
    if (appliedFilter.current === filterKey) return;
    appliedFilter.current = filterKey;
    setLines({ shown: [], held: [] });
  }, [filterKey]);

  const resume = () => setLines((lines) => ({ shown: [...lines.shown, ...lines.held], held: [] }));
  return { ...lines, setLines, resume };
}

function isTail(queryKey: readonly unknown[]): boolean {
  const tail = agentKeys.logs.tail;
  return queryKey.length === tail.length && tail.every((part, i) => queryKey[i] === part);
}

export function LogsPage() {
  const [level, setLevel] = useState<LogPageLevel>("all");
  const [text, setText] = useState("");
  const q = useSettled(text.trim(), FILTER_DELAY_MS);
  const filter = useMemo<LogFilterValue>(() => ({ level, q }), [level, q]);
  const [paused, setPaused] = useState(false);
  const client = useQueryClient();
  const query = useLogPages(filter);
  const live = useLiveLines(filter, paused);
  const pages = query.isPlaceholderData ? undefined : query.data?.pages;
  const newestPage = pages?.[0]?.entries;

  // Live lines the newest page already holds (it was read after they arrived) go.
  const shown = useMemo(() => linesAfterPage(live.shown, newestPage), [live.shown, newestPage]);
  const held = useMemo(() => linesAfterPage(live.held, newestPage), [live.held, newestPage]);

  // At most MAX_LOG_LINES lines: the oldest pages go first, then the oldest live lines.
  useEffect(() => {
    if (!pages) return;
    const { dropPages, keepLive } = fitToCap(
      pages.map((page) => page.entries.length),
      shown.length + held.length,
    );
    if (dropPages > 0) {
      client.setQueryData<LogPages>(agentKeys.logs.pages(filter), (data) =>
        data
          ? {
              pages: data.pages.slice(0, -dropPages),
              pageParams: data.pageParams.slice(0, -dropPages),
            }
          : data,
      );
    }
    const liveCount = shown.length + held.length;
    if (
      keepLive < liveCount ||
      shown.length < live.shown.length ||
      held.length < live.held.length
    ) {
      const drop = liveCount - keepLive;
      live.setLines({
        shown: shown.slice(Math.min(drop, shown.length)),
        held: held.slice(Math.max(0, drop - shown.length)),
      });
    }
  }, [pages, shown, held, live, client, filter]);

  const loaded = useMemo(() => (pages ? keyedLines(pages) : []), [pages]);
  const lines = useMemo(() => [...loaded, ...shown], [loaded, shown]);
  const total = lines.length + held.length;
  const canLoadOlder = Boolean(query.hasNextPage) && !query.isPlaceholderData;
  const atLimit = canLoadOlder && total + LOG_PAGE_SIZE > MAX_LOG_LINES;

  return (
    <AgentPage title="Logs">
      <div className="agent-logs__toolbar" role="group" aria-label="Log controls">
        <SegmentedControl
          aria-label="Levels"
          size="sm"
          options={LEVEL_OPTIONS}
          value={level}
          onValueChange={setLevel}
        />
        <TextInput
          className="agent-logs__filter"
          type="search"
          aria-label="Filter"
          placeholder="Filter"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="agent-logs__buttons">
          <IconButton
            variant="outline"
            label={paused ? "Resume" : "Pause"}
            icon={paused ? IconPlayerPlay : IconPlayerPause}
            onClick={() => {
              if (paused) live.resume();
              setPaused(!paused);
            }}
          />
          <IconButton
            variant="outline"
            label="Download log"
            icon={IconDownload}
            href="/api/logs/download"
            download="agent.log"
          />
        </div>
      </div>
      {query.isError ? (
        <p className="agent-alert" role="alert">
          {query.error.message}
        </p>
      ) : null}
      <LogLines
        lines={lines}
        paused={paused}
        header={
          atLimit ? (
            <p className="agent-logs__note">{AT_LINE_LIMIT}</p>
          ) : canLoadOlder ? (
            <Button
              size="sm"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? "Loading…" : "Load older"}
            </Button>
          ) : null
        }
        empty={
          pages ? (filter.q || filter.level !== "all" ? NOTHING_MATCHES : NOTHING_LOGGED) : null
        }
      />
      {held.length > 0 ? (
        <p className="agent-logs__note" role="status">
          {held.length === 1 ? "1 new line" : `${held.length.toLocaleString("en-US")} new lines`}{" "}
          while paused
        </p>
      ) : null}
    </AgentPage>
  );
}

interface Anchor {
  key: string;
  /** The anchor line's top minus the scroll position. */
  offset: number;
}

function LogLines({
  lines,
  paused,
  header,
  empty,
}: {
  lines: LogLine[];
  paused: boolean;
  header: ReactNode;
  empty: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
    anchor.current = null;
    for (const child of el.querySelectorAll<HTMLElement>("[data-line]")) {
      if (child.offsetTop + child.offsetHeight > el.scrollTop) {
        anchor.current = { key: child.dataset.line!, offset: child.offsetTop - el.scrollTop };
        break;
      }
    }
  };

  // Follow new lines at the bottom; otherwise keep the line the reader looks at in place
  // (older lines loaded above it, the oldest dropped by the cap).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (following.current && !paused) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    const at = anchor.current;
    if (!at) return;
    const line = el.querySelector<HTMLElement>(`[data-line="${CSS.escape(at.key)}"]`);
    if (line) el.scrollTop = line.offsetTop - at.offset;
  }, [lines, paused]);

  const toggle = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <div ref={ref} className="agent-logs__lines or-mono" onScroll={onScroll}>
      {header}
      {lines.length === 0 && empty ? <p className="agent-logs__note">{empty}</p> : null}
      <ol className="agent-logs__list" aria-label="Log">
        {lines.map((line) => (
          <LogLineItem
            key={line.key}
            line={line}
            expanded={expanded.has(line.key)}
            onToggle={() => toggle(line.key)}
          />
        ))}
      </ol>
    </div>
  );
}

function LogLineItem({
  line,
  expanded,
  onToggle,
}: {
  line: LogLine;
  expanded: boolean;
  onToggle: () => void;
}) {
  const fields = Object.entries(line.fields);
  const tone = isProblemLevel(line.level) ? " agent-logs__line--fail" : "";
  const date = new Date(line.time);
  const content = (
    <>
      <time
        className="agent-logs__time"
        dateTime={date.toISOString()}
        title={date.toLocaleString("en-US")}
      >
        {clockTimeSeconds(line.time)}
      </time>
      <span className="agent-logs__level">{line.level}</span>
      <span className="agent-logs__msg">{line.msg}</span>
    </>
  );
  const fieldsId = `log-fields-${line.key}`;
  return (
    <li className={`agent-logs__line${tone}`} data-line={line.key}>
      {fields.length > 0 ? (
        <>
          <button
            type="button"
            className="agent-logs__row agent-logs__row--toggle"
            aria-expanded={expanded}
            aria-controls={expanded ? fieldsId : undefined}
            onClick={onToggle}
          >
            <IconChevronRight className="agent-logs__chevron" size={14} aria-hidden="true" />
            {content}
          </button>
          {expanded ? (
            <dl className="agent-logs__fields" id={fieldsId}>
              {fields.map(([name, value]) => (
                <div key={name} className="agent-logs__field">
                  <dt>{name}</dt>
                  <dd>{fieldText(value)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </>
      ) : (
        <div className="agent-logs__row">
          <span className="agent-logs__chevron" aria-hidden="true" />
          {content}
        </div>
      )}
    </li>
  );
}
