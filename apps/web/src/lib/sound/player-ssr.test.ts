// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createSoundService } from "./player";

describe("the sound service on the server", () => {
  it("makes no player and plays nothing without a window", () => {
    const create = vi.fn();
    const service = createSoundService(create);
    service.unlock();
    service.configure({ enabled: true, volume: 1 });
    expect(create).not.toHaveBeenCalled();
    expect(service.play("notification")).toBeNull();
  });
});
