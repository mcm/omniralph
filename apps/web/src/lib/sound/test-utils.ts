import { vi } from "vitest";
import type { SoundService } from "./player";

/** A `SoundService` that records what it's asked, unlocked unless told otherwise. */
export function fakeSoundService({ unlocked = true }: { unlocked?: boolean } = {}) {
  let isUnlocked = unlocked;
  const service = {
    unlock: vi.fn(() => {
      isUnlocked = true;
    }),
    isUnlocked: () => isUnlocked,
    play: vi.fn<SoundService["play"]>(() => null),
    configure: vi.fn<SoundService["configure"]>(),
    stopAll: vi.fn(),
    destroy: vi.fn(async () => {}),
  } satisfies SoundService;
  return service;
}
