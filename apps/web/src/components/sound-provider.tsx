"use client";

import { toast } from "@omniralph/ui";
import * as React from "react";
import { createAttentionGate, type AttentionCue } from "@/lib/sound/attention";
import { sounds, type SoundService } from "@/lib/sound/player";
import type { SoundPreference } from "@/lib/sound/preference";
import { saveSoundPreference } from "@/lib/theme-actions";
import { SoundContext } from "./sound";

/**
 * The signed-in user's sound preference and the page's sound player (`sounds`). Sounds
 * reinforce what the screen already shows; they're never the only signal.
 *
 * - Audio unlocks on the first pointer press or key press anywhere (browsers allow no
 *   sound before one); until then, every cue is dropped rather than queued.
 * - Muting stops what's playing first, so it's immediate.
 * - Attention cues (`useInboxCountSounds`, `useRunOutcomeSound`) share one gate: a burst of
 *   changes plays once.
 * - Leaving the signed-in app stops everything; the player itself lives as long as the page.
 *
 * What plays: something new in the Inbox (`notification`, Om's question `mention`, a new
 * problem `warning`), the run on screen finishing (`complete`) or failing (`error`), and
 * Ask's message sent (`send`) and reply received (`receive`, `runAskTurn`).
 */
export function SoundProvider({
  initial,
  service = sounds,
  children,
}: {
  initial: SoundPreference;
  /** The sound service (tests pass a fake). */
  service?: SoundService;
  children: React.ReactNode;
}) {
  const [preference, setValue] = React.useState(initial);
  // A fresh server render (another device changed it) brings the saved value.
  const [rendered, setRendered] = React.useState(initial);
  if (rendered.enabled !== initial.enabled || rendered.volume !== initial.volume) {
    setRendered(initial);
    setValue(initial);
  }
  const current = React.useRef(preference);
  React.useEffect(() => {
    current.current = preference;
    service.configure(preference);
  }, [preference, service]);

  // Unlock on a genuine gesture, synchronously inside its handler.
  React.useEffect(() => {
    const unlock = () => service.unlock();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    return () => {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      service.stopAll();
    };
  }, [service]);

  const setPreference = React.useCallback((next: SoundPreference) => {
    const previous = current.current;
    current.current = next;
    setValue(next);
    const revert = () => {
      // Only undo this change if no later one replaced it.
      if (current.current === next) {
        current.current = previous;
        setValue(previous);
      }
      toast("Couldn't save your preference.", { variant: "danger" });
    };
    void saveSoundPreference(next).then((result) => {
      if (!result.ok) revert();
    }, revert);
  }, []);

  const [gate] = React.useState(() => createAttentionGate());
  const attention = React.useCallback(
    (cue: AttentionCue) => {
      // A locked or muted player plays nothing: don't spend the gate on it.
      if (!service.isUnlocked() || !current.current.enabled) return;
      if (gate()) service.play(cue);
    },
    [gate, service],
  );

  const state = React.useMemo(
    () => ({ preference, setPreference, attention }),
    [preference, setPreference, attention],
  );
  return <SoundContext.Provider value={state}>{children}</SoundContext.Provider>;
}
