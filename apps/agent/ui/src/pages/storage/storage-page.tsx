/**
 * Storage (`/storage`), read-only: free space per filesystem, what the agent stores
 * (`GET /api/storage`, reused for 10 minutes; "Measure again" = `POST /api/storage/measure`,
 * whose result arrives as a `storage` event) and the cached repos with their last fetch,
 * last sync and pin (`GET /api/repos`, refreshed by `repos` events).
 */
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  MetaBadge,
  RepoBadge,
  StatusText,
  SummaryCells,
  type DataTableColumn,
} from "@omniralph/ui";
import { IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import type { StorageItem, StoredRepo } from "../../../../src/storage.js";
import type { ReposState, StorageState } from "../../../../src/ui/machine-routes.js";
import { localRequest } from "../../api.js";
import { formatBytes, relativeTime, useNow } from "../../format.js";
import { agentKeys } from "../../live/keys.js";
import { useLocalMutation } from "../../live/use-local-mutation.js";
import { AgentPage } from "../page.js";
import {
  ITEM_LABELS,
  NEVER_FETCHED,
  NO_REPOS,
  filesystemLabel,
  freeSpace,
  lastSyncText,
} from "./model.js";

function useStorage() {
  return useQuery({
    queryKey: agentKeys.storage,
    queryFn: ({ signal }) => localRequest<StorageState>("/api/storage", { signal }),
  });
}

function useRepos() {
  return useQuery({
    queryKey: agentKeys.repos,
    queryFn: ({ signal }) => localRequest<ReposState>("/api/repos", { signal }),
  });
}

function useMeasureAgain() {
  return useLocalMutation<{ measuring: boolean }, void>({
    // A body, so the request carries the JSON content type every change needs.
    mutationFn: () =>
      localRequest<{ measuring: boolean }>("/api/storage/measure", { method: "POST", body: {} }),
    invalidate: () => [agentKeys.storage],
    success: null,
    // "Measuring…" at once; the new sizes come with the `storage` event.
    optimistic: (_, cache) =>
      cache.set<StorageState>(cache.keys.storage, (storage) =>
        storage ? { ...storage, measuring: true } : storage,
      ),
  });
}

export function StoragePage() {
  const storage = useStorage();
  return (
    <AgentPage title="Storage">
      {storage.data ? (
        <FreeSpace storage={storage.data} />
      ) : storage.isError ? (
        <EmptyState title="Can't load storage" description={storage.error.message} />
      ) : null}
      {storage.data ? <UsageCard storage={storage.data} /> : null}
      <ReposCard />
    </AgentPage>
  );
}

function FreeSpace({ storage }: { storage: StorageState }) {
  if (storage.filesystems.length === 0) return null;
  return (
    <SummaryCells
      aria-label="Free space"
      cells={storage.filesystems.map((fs) => {
        const free = freeSpace(fs);
        return {
          id: fs.paths.join("\n"),
          label: filesystemLabel(fs, storage.roots),
          value: free.tone ? <StatusText tone={free.tone}>{free.text}</StatusText> : free.text,
          detail: free.detail,
        };
      })}
    />
  );
}

const USAGE_COLUMNS: DataTableColumn<StorageItem>[] = [
  { id: "item", header: "Item", cell: (row) => ITEM_LABELS[row.key], card: "title" },
  {
    id: "path",
    header: "Path",
    mono: true,
    cell: (row) => (
      <span className="agent-cell-paths">
        {row.paths.map((dir) => (
          <span key={dir}>{dir}</span>
        ))}
      </span>
    ),
  },
  {
    id: "size",
    header: "Size",
    align: "end",
    card: "status",
    cell: (row) => formatBytes(row.bytes),
  },
];

function UsageCard({ storage }: { storage: StorageState }) {
  const measure = useMeasureAgain();
  const now = useNow();
  const measuring = storage.measuring || measure.isPending;
  return (
    <Card
      title="Usage"
      actions={
        <Button size="sm" icon={IconRefresh} disabled={measuring} onClick={() => measure.mutate()}>
          {measuring ? "Measuring…" : "Measure again"}
        </Button>
      }
    >
      <p className="agent-card-description">
        Measured <time dateTime={storage.measuredAt}>{relativeTime(storage.measuredAt, now)}</time>
      </p>
      <DataTable
        caption="Usage"
        rows={storage.items}
        getRowId={(row) => row.key}
        columns={USAGE_COLUMNS}
      />
    </Card>
  );
}

function repoColumns(now: number): DataTableColumn<StoredRepo>[] {
  return [
    {
      id: "repo",
      header: "Repo",
      card: "title",
      cell: (row) => (
        <span className="agent-repo">
          <RepoBadge host={row.provider} name={row.fullPath} />
          {row.pinned ? <MetaBadge text="Pinned" /> : null}
        </span>
      ),
    },
    { id: "size", header: "Size", align: "end", cell: (row) => formatBytes(row.bytes) },
    {
      id: "fetched",
      header: "Last fetched",
      card: "time",
      cell: (row) =>
        row.lastFetchedAt === null ? (
          NEVER_FETCHED
        ) : (
          <time dateTime={row.lastFetchedAt}>{relativeTime(row.lastFetchedAt, now)}</time>
        ),
    },
    {
      id: "sync",
      header: "Last sync",
      cell: (row) => {
        const { text, tone } = lastSyncText(row, now);
        return tone ? <StatusText tone={tone}>{text}</StatusText> : text;
      },
    },
  ];
}

function ReposCard() {
  const repos = useRepos();
  const now = useNow();
  const rows = repos.data?.repos ?? [];
  return (
    <Card title="Repos">
      {repos.isError ? (
        <EmptyState title="Can't load the repos" description={repos.error.message} />
      ) : repos.data && rows.length === 0 ? (
        <EmptyState title={NO_REPOS} />
      ) : (
        <DataTable
          caption="Repos"
          rows={rows}
          getRowId={(row) => row.path}
          columns={repoColumns(now)}
          rowTone={(row) => (row.lastSync?.outcome === "failed" ? "bad" : undefined)}
        />
      )}
    </Card>
  );
}
