// Test helpers for pages that register their repo for Ask (`useAskContextRepository`): the
// page renders beside New chat, whose repo picker should start on the page's repo.
import { screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { expect, vi } from "vitest";
import { jsonResponse, TEST_ORGANIZATION_ID } from "@/components/query-test-utils";
import type { AskRepositoryOption } from "@/lib/api/ask";
import { AskContextProvider } from "./ask-context";
import { AskNewChat } from "./ask-new-chat";

/**
 * Answers `GET /api/ui/ask/repositories` with `repositories` (Acme's), passing every other
 * request to the `fetch` stubbed before (e.g. `mockFetch`'s).
 */
export function serveAskRepositories(
  repositories: readonly Pick<AskRepositoryOption, "id" | "provider" | "fullPath">[],
): void {
  const base = globalThis.fetch;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/ui/ask/repositories") return base(input, init);
    return Promise.resolve(
      jsonResponse({
        repositories: repositories.map((repository) => ({
          ...repository,
          organization: { id: TEST_ORGANIZATION_ID, name: "Acme", role: "admin" },
        })),
      }),
    );
  });
}

/** The page, with New chat beside it, both under one Ask context (as in the app shell). */
export function WithAskNewChat({ children }: { children: React.ReactNode }) {
  return (
    <AskContextProvider>
      {children}
      <AskNewChat onBack={() => {}} onChatStarted={() => {}} />
    </AskContextProvider>
  );
}

/** Waits until New chat's repo picker starts on `label` (a repo's full path, or "All repos"). */
export async function expectAskRepo(label: string): Promise<void> {
  await waitFor(() => {
    const picker = screen.getByRole("combobox", { name: "Repo" }) as HTMLSelectElement;
    expect(picker.selectedOptions[0]?.textContent).toBe(label);
  });
}
