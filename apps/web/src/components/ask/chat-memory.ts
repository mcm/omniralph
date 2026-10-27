"use client";

import * as React from "react";
import type { AskTurnOverlay } from "./chat-cache";

/**
 * What a chat keeps in memory for the tab while its view comes and goes (the panel closes,
 * the phone goes back to the list): the composer's draft, and the turn in flight, which
 * runs to its end after the view unmounts.
 */

/** A turn in flight: what it shows so far, and what Om is doing ("Looking at runs"). */
export interface AskTurnState extends AskTurnOverlay {
  status: string | null;
}

const drafts = new Map<string, string>();
const turns = new Map<string, AskTurnState>();
const listeners = new Set<() => void>();

const notify = () => {
  for (const listener of listeners) listener();
};

/** The composer's draft of a chat ("" when none). */
export function askDraft(chatId: string): string {
  return drafts.get(chatId) ?? "";
}

export function setAskDraft(chatId: string, text: string): void {
  if (text) drafts.set(chatId, text);
  else drafts.delete(chatId);
}

/** The chat's turn in flight, or null. */
export function askTurn(chatId: string): AskTurnState | null {
  return turns.get(chatId) ?? null;
}

/** Starts, changes (`update` of the current one) or, with `null`, ends the chat's turn. */
export function setAskTurn(
  chatId: string,
  update: AskTurnState | null | ((turn: AskTurnState) => AskTurnState),
): void {
  if (update === null) turns.delete(chatId);
  else if (typeof update === "function") {
    const turn = turns.get(chatId);
    if (!turn) return;
    turns.set(chatId, update(turn));
  } else turns.set(chatId, update);
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The chat's turn in flight, re-rendering as it changes. */
export function useAskTurn(chatId: string): AskTurnState | null {
  return React.useSyncExternalStore(
    subscribe,
    () => askTurn(chatId),
    () => null,
  );
}

/** Forgets every draft and turn (tests). */
export function resetAskChatMemory(): void {
  drafts.clear();
  turns.clear();
  notify();
}
