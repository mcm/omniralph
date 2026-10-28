"use client";

import {
  BrandMark,
  MetaBadge,
  OrgBadge,
  RepoBadge,
  SearchPalette,
  type SearchPaletteItem,
} from "@omniralph/ui";
import { IconSettings } from "@tabler/icons-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { useCurrentUser } from "@/components/current-user";
import { api, ApiError } from "@/lib/api/client";
import { mutationResultSchema } from "@/lib/api/schemas";
import {
  SEARCH_MIN_QUERY_LENGTH,
  searchResponseSchema,
  type SearchResponse,
  type SearchResult,
} from "@/lib/api/search";
import { splitRepositoryPath } from "@/lib/repositories/path";
import { BacklogRowBadges } from "@/screens/backlog/backlog-row-badges";
import { RunRowBadges } from "@/screens/runs/run-badges";
import { runRowLabel } from "@/screens/runs/labels";
import { useScopeParam } from "@/screens/scope";

/** How long typing pauses before a search is sent. */
export const SEARCH_DEBOUNCE_MS = 150;

/** Shown when the search request failed. */
export const SEARCH_FAILED_MESSAGE = "Search didn't answer. Try again.";

/** Shown for a short query while the user has opened nothing from search yet. */
export const NO_RECENT_MESSAGE =
  "Type a name or ID to find runs, work items, repos, agents and settings.";

/** Shown when nothing matches `query`. */
export function noMatchesMessage(query: string): string {
  return `No matches for “${query}”`;
}

interface SearchContextValue {
  /** Opens the search palette. */
  openSearch: () => void;
}

const SearchContext = React.createContext<SearchContextValue | null>(null);

/** The search palette's opener (inside `SearchProvider`). */
export function useSearch(): SearchContextValue {
  const value = React.useContext(SearchContext);
  if (!value) throw new Error("useSearch must be used inside SearchProvider");
  return value;
}

/** ⌘K (macOS) or Ctrl+K (elsewhere), with no other modifier. */
export function isSearchShortcut(event: KeyboardEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "k"
  );
}

/**
 * Search and jump for the signed-in app: the search palette, opened by `useSearch` (the
 * frame's search buttons) or ⌘K / Ctrl+K anywhere (no visible hint, Design rule 7).
 */
export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const openSearch = React.useCallback(() => setOpen(true), []);

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || !isSearchShortcut(event)) return;
      event.preventDefault();
      setOpen(true);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const value = React.useMemo(() => ({ openSearch }), [openSearch]);
  return (
    <SearchContext.Provider value={value}>
      {children}
      {open ? <AppSearchPalette onClose={() => setOpen(false)} /> : null}
    </SearchContext.Provider>
  );
}

interface SearchState {
  /** The query the response answers. */
  query: string;
  response: SearchResponse | null;
  error: string | null;
}

/**
 * The search's answer for `query` (trimmed): sent `SEARCH_DEBOUNCE_MS` after typing pauses
 * (a short query, the recent items, at once), the previous request aborted. Until the new
 * answer arrives the previous one stays (`pending`).
 */
export function useSearchResults(query: string) {
  const { organization } = useCurrentUser();
  const scope = useScopeParam();
  const trimmed = query.trim();
  const [state, setState] = React.useState<SearchState | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    const short = trimmed.length < SEARCH_MIN_QUERY_LENGTH;
    const timer = setTimeout(
      () => {
        api
          .get("/api/ui/search", searchResponseSchema, {
            params: { q: short ? "" : trimmed, organization: scope },
            organizationId: organization.id,
            signal: controller.signal,
          })
          .then(
            (response) => setState({ query: trimmed, response, error: null }),
            (error: unknown) => {
              if (controller.signal.aborted) return;
              setState({
                query: trimmed,
                response: null,
                error: error instanceof ApiError ? error.message : SEARCH_FAILED_MESSAGE,
              });
            },
          );
      },
      short ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, scope, organization.id]);

  return { state, pending: state?.query !== trimmed };
}

/** A result as the palette draws it. */
type PaletteItem = SearchPaletteItem & { result: SearchResult };

/** A result's row: the same dot or mark, title and reference badges as its list's rows. */
export function paletteItem(result: SearchResult, showOrganization: boolean): PaletteItem {
  const id = `${result.kind}:${result.id}`;
  const org = (name: string) => (showOrganization ? <OrgBadge name={name} /> : null);
  switch (result.kind) {
    case "run": {
      const { label, tone } = runRowLabel(result.run);
      return {
        id,
        result,
        title: result.run.title,
        kindLabel: label,
        tone,
        meta: <RunRowBadges run={result.run} showOrganization={showOrganization} />,
      };
    }
    case "workItem":
      return {
        id,
        result,
        title: result.workItem.title,
        mark: <BrandMark brand={result.workItem.tracker} />,
        meta: <BacklogRowBadges row={result.workItem} showOrganization={showOrganization} />,
      };
    case "repository": {
      const { repository } = result;
      return {
        id,
        result,
        title: splitRepositoryPath(repository.fullPath).name,
        mark: <BrandMark brand={repository.provider} />,
        meta: (
          <>
            {org(repository.organization.name)}
            <RepoBadge host={repository.provider} name={repository.fullPath} />
          </>
        ),
      };
    }
    case "agent": {
      const { agent } = result;
      return {
        id,
        result,
        title: agent.name,
        kindLabel: `Agent · ${agent.status.label}`,
        tone: agent.status.tone,
        // The name is the title: only the organization, under All organizations.
        meta: showOrganization ? <OrgBadge name={agent.organization.name} /> : undefined,
      };
    }
    case "settings":
      return {
        id,
        result,
        title: result.settings.title,
        mark: <IconSettings size={16} stroke={1.75} role="img" aria-label="Settings page" />,
        meta: <MetaBadge text={`Settings · ${result.settings.section}`} />,
      };
  }
}

/** The palette, open: the input, the recent items or the matches, and choosing one. */
function AppSearchPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const user = useCurrentUser();
  const showOrganization = user.scope === "all";
  const [query, setQuery] = React.useState("");
  const { state, pending } = useSearchResults(query);
  const trimmed = query.trim();

  const groups = React.useMemo(
    () =>
      (state?.response?.groups ?? []).map((group) => ({
        id: group.id,
        label: group.label,
        items: group.results.map((result) => paletteItem(result, showOrganization)),
      })),
    [state, showOrganization],
  );

  let message: string | undefined;
  if (state?.error) message = state.error;
  else if (!pending && groups.every((group) => group.items.length === 0)) {
    if (state?.response?.mode === "results") message = noMatchesMessage(trimmed);
    else if (state?.response?.mode === "recent") message = NO_RECENT_MESSAGE;
  }

  function choose(item: PaletteItem) {
    const { result } = item;
    // Remembered for the recent items; opening doesn't wait for it, nor fail with it.
    void api
      .post("/api/ui/search/recent", mutationResultSchema, {
        body: { kind: result.kind, id: result.id },
        organizationId: user.organization.id,
      })
      .catch(() => {});
    onClose();
    router.push(result.href);
  }

  return (
    <SearchPalette
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      onSelect={choose}
      message={message}
      busy={pending}
    />
  );
}
