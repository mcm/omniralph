"use client";

import * as React from "react";
import type { InboxCountsResponse } from "@/lib/api/inbox";
import type { RunDetail } from "@/lib/api/runs";
import { inboxCountsCue, runOutcomeCue, type AttentionCue } from "@/lib/sound/attention";
import type { SoundPreference } from "@/lib/sound/preference";

/** What `SoundProvider` (./sound-provider) shares: the preference and the attention cues. */
export interface SoundState {
  preference: SoundPreference;
  /** Applies at once, saves, and reverts with an error toast if the save fails. */
  setPreference: (preference: SoundPreference) => void;
  /** Plays an attention cue, unless one played in the last few seconds. */
  attention: (cue: AttentionCue) => void;
}

export const SoundContext = React.createContext<SoundState | null>(null);

/** The user's sound preference, its setter, and the attention cue player. */
export function useSound(): SoundState {
  const state = React.useContext(SoundContext);
  if (!state) throw new Error("useSound must be used inside the signed-in app shell");
  return state;
}

/** Plays a cue when the live Inbox counts gain an item (`inboxCountsCue`); none on load. */
export function useInboxCountSounds(counts: InboxCountsResponse | undefined): void {
  const sound = React.useContext(SoundContext);
  const previous = React.useRef<InboxCountsResponse | undefined>(undefined);
  React.useEffect(() => {
    if (!counts) return;
    const cue = inboxCountsCue(previous.current, counts);
    previous.current = counts;
    if (cue) sound?.attention(cue);
  }, [counts, sound]);
}

/**
 * Plays a cue when the run on screen finishes or fails while it's watched
 * (`runOutcomeCue`): none on its first load, nor when another run is opened.
 */
export function useRunOutcomeSound(run: Pick<RunDetail, "id" | "status">): void {
  const sound = React.useContext(SoundContext);
  const previous = React.useRef<Pick<RunDetail, "id" | "status"> | null>(null);
  React.useEffect(() => {
    const before = previous.current?.id === run.id ? previous.current.status : undefined;
    previous.current = { id: run.id, status: run.status };
    const cue = runOutcomeCue(before, run.status);
    if (cue) sound?.attention(cue);
  }, [run.id, run.status, sound]);
}
