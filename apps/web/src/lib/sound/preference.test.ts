import { describe, expect, it } from "vitest";
import { DEFAULT_SOUND, parseSoundPreference, volumeStep } from "./preference";

describe("parseSoundPreference", () => {
  it("reads a user's columns, and falls back to on at medium for anything unusable", () => {
    expect(parseSoundPreference(false, 0.35)).toEqual({ enabled: false, volume: 0.35 });
    expect(parseSoundPreference(undefined, undefined)).toEqual(DEFAULT_SOUND);
    expect(parseSoundPreference(true, 4)).toEqual({ enabled: true, volume: DEFAULT_SOUND.volume });
    expect(parseSoundPreference(true, Number.NaN).volume).toBe(DEFAULT_SOUND.volume);
  });
});

describe("volumeStep", () => {
  it("shows a saved volume as its nearest step", () => {
    expect(volumeStep(0.35)).toBe("low");
    expect(volumeStep(0.6)).toBe("medium");
    expect(volumeStep(0.95)).toBe("high");
  });
});
