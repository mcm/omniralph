import {
  createUISFX,
  type CueName,
  type PlayingSFX,
  type UISFXOptions,
  type UISFXPlayer,
} from "uisfx";
import { DEFAULT_SOUND, type SoundPreference } from "./preference";

/** The control panel's sound pack: dry, short, low cues that stay out of the way. */
export const SOUND_PACK = "minimal";

/** The cues the control panel plays (`docs`: the action-to-cue map in `SoundProvider`). */
export type SoundCue = Extract<
  CueName,
  "notification" | "mention" | "warning" | "complete" | "error" | "send" | "receive"
>;

/** The control panel's one sound player, made on the first gesture (see `createSoundService`). */
export interface SoundService {
  /**
   * Unlocks audio: call it synchronously from a genuine pointer or keyboard handler, before
   * any `await`. Makes the player on the first call (never during SSR or on page load).
   */
  unlock(): void;
  /** Whether a gesture has unlocked audio: until then, every cue is dropped, not queued. */
  isUnlocked(): boolean;
  /** Plays a cue now, or nothing (locked, muted, or the player declined): never queued. */
  play(cue: SoundCue): PlayingSFX | null;
  /** Applies the user's preference; muting stops what's playing first, so it's immediate. */
  configure(preference: SoundPreference): void;
  /** Stops everything playing (leaving the signed-in app). */
  stopAll(): void;
  /** Disposes of the player; the next gesture makes a new one. */
  destroy(): Promise<void>;
}

/** A sound service over `create` (uisfx's `createUISFX`; tests pass a fake). */
export function createSoundService(
  create: (options: UISFXOptions) => UISFXPlayer = createUISFX,
): SoundService {
  let player: UISFXPlayer | null = null;
  let unlocked = false;
  let preference: SoundPreference = DEFAULT_SOUND;

  return {
    unlock() {
      if (typeof window === "undefined" || unlocked) return;
      player ??= create({
        pack: SOUND_PACK,
        volume: preference.volume,
        enabled: preference.enabled,
      });
      const current = player;
      void current.unlock().then(
        (ok) => {
          // A player destroyed meanwhile stays locked.
          if (ok && player === current) unlocked = true;
        },
        () => {},
      );
    },
    isUnlocked: () => unlocked,
    play(cue) {
      if (!player || !unlocked || !preference.enabled) return null;
      return player.play(cue);
    },
    configure(next) {
      if (player && !next.enabled) player.stopAll();
      preference = next;
      if (!player) return;
      player.setEnabled(next.enabled);
      player.setVolume(next.volume);
      player.setPack(SOUND_PACK);
    },
    stopAll() {
      player?.stopAll();
    },
    async destroy() {
      const current = player;
      player = null;
      unlocked = false;
      if (current) {
        current.stopAll();
        await current.destroy();
      }
    },
  };
}

/** The app's sound service: one per page, shared across remounts and Strict Mode. */
export const sounds: SoundService = createSoundService();
