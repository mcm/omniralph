// @vitest-environment jsdom
import type { UISFXPlayer } from "uisfx";
import { describe, expect, it, vi } from "vitest";
import { createSoundService, SOUND_PACK } from "./player";

/** A uisfx player that records calls; `unlock` resolves when the test says. */
function fakePlayer() {
  let resolveUnlock: (ok: boolean) => void = () => {};
  const calls: string[] = [];
  const player = {
    unlock: vi.fn(() => new Promise<boolean>((resolve) => (resolveUnlock = resolve))),
    play: vi.fn(() => ({ stop: () => {}, ended: Promise.resolve() })),
    preload: vi.fn(async () => {}),
    setPack: vi.fn(),
    getPack: () => SOUND_PACK,
    setVolume: vi.fn((volume: number) => calls.push(`volume ${volume}`)),
    getVolume: () => 0.7,
    setEnabled: vi.fn((enabled: boolean) => calls.push(`enabled ${enabled}`)),
    isEnabled: () => true,
    stopAll: vi.fn(() => calls.push("stopAll")),
    destroy: vi.fn(async () => {}),
  } satisfies UISFXPlayer;
  return { player, calls, unlocked: (ok = true) => resolveUnlock(ok) };
}

function setup() {
  const fakes: ReturnType<typeof fakePlayer>[] = [];
  const create = vi.fn(() => {
    const fake = fakePlayer();
    fakes.push(fake);
    return fake.player;
  });
  return { service: createSoundService(create), create, fakes };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createSoundService", () => {
  it("makes no player until a gesture unlocks audio, then one with the minimal pack", () => {
    const { service, create } = setup();
    expect(service.play("notification")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    service.unlock();
    expect(create).toHaveBeenCalledWith({ pack: "minimal", volume: 0.7, enabled: true });
  });

  it("drops cues until the unlock resolves, rather than queueing them", async () => {
    const { service, fakes } = setup();
    service.unlock();
    expect(service.play("notification")).toBeNull();
    fakes[0]!.unlocked();
    await flush();
    expect(service.isUnlocked()).toBe(true);
    expect(service.play("notification")).not.toBeNull();
    // The cue from before the unlock never plays late.
    expect(fakes[0]!.player.play).toHaveBeenCalledTimes(1);
  });

  it("stays locked when the browser refuses the unlock", async () => {
    const { service, fakes } = setup();
    service.unlock();
    fakes[0]!.unlocked(false);
    await flush();
    expect(service.isUnlocked()).toBe(false);
    expect(service.play("mention")).toBeNull();
  });

  it("keeps one player however many gestures (and remounts) unlock it", async () => {
    const { service, create, fakes } = setup();
    service.unlock();
    service.unlock();
    fakes[0]!.unlocked();
    await flush();
    service.unlock();
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("stops what's playing before muting, and plays nothing while muted", async () => {
    const { service, fakes } = setup();
    service.unlock();
    fakes[0]!.unlocked();
    await flush();
    service.configure({ enabled: false, volume: 0.7 });
    expect(fakes[0]!.calls.slice(0, 2)).toEqual(["stopAll", "enabled false"]);
    expect(service.play("notification")).toBeNull();
    service.configure({ enabled: true, volume: 0.35 });
    expect(fakes[0]!.calls.slice(-2)).toEqual(["enabled true", "volume 0.35"]);
    expect(service.play("notification")).not.toBeNull();
  });

  it("makes its player with the saved preference when it's set before the first gesture", () => {
    const { service, create } = setup();
    service.configure({ enabled: false, volume: 0.35 });
    service.unlock();
    expect(create).toHaveBeenCalledWith({ pack: "minimal", volume: 0.35, enabled: false });
  });

  it("disposes of its player, and the next gesture makes a new one", async () => {
    const { service, create, fakes } = setup();
    service.unlock();
    fakes[0]!.unlocked();
    await flush();
    await service.destroy();
    expect(fakes[0]!.player.stopAll).toHaveBeenCalled();
    expect(fakes[0]!.player.destroy).toHaveBeenCalled();
    expect(service.isUnlocked()).toBe(false);
    service.unlock();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("leaves a player destroyed during its unlock locked", async () => {
    const { service, fakes } = setup();
    service.unlock();
    await service.destroy();
    fakes[0]!.unlocked();
    await flush();
    expect(service.isUnlocked()).toBe(false);
  });
});
