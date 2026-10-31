/** Whether the control panel plays sounds, and how loud (0 to 1). Each user's own. */
export interface SoundPreference {
  enabled: boolean;
  volume: number;
}

/** A new user's: on, at the player's usual volume. */
export const DEFAULT_SOUND: SoundPreference = { enabled: true, volume: 0.7 };

/** The volume steps the setting offers (a segmented control, not a free slider). */
export const SOUND_VOLUMES = [
  { value: "low", label: "Low", volume: 0.35 },
  { value: "medium", label: "Medium", volume: 0.7 },
  { value: "high", label: "High", volume: 1 },
] as const;

export type SoundVolumeStep = (typeof SOUND_VOLUMES)[number]["value"];

/** The step a saved volume falls in: the nearest one. */
export function volumeStep(volume: number): SoundVolumeStep {
  let best: (typeof SOUND_VOLUMES)[number] = SOUND_VOLUMES[0];
  for (const step of SOUND_VOLUMES) {
    if (Math.abs(step.volume - volume) < Math.abs(best.volume - volume)) best = step;
  }
  return best.value;
}

/** A user row's sound columns as a preference; anything missing or out of range is the default. */
export function parseSoundPreference(enabled: unknown, volume: unknown): SoundPreference {
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULT_SOUND.enabled,
    volume:
      typeof volume === "number" && Number.isFinite(volume) && volume >= 0 && volume <= 1
        ? volume
        : DEFAULT_SOUND.volume,
  };
}
