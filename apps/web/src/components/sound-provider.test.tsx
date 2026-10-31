// @vitest-environment jsdom
import type * as OmniralphUi from "@omniralph/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/lib/action-result";
import type { InboxCountsResponse } from "@/lib/api/inbox";
import type { RunDetail } from "@/lib/api/runs";
import type { SoundPreference } from "@/lib/sound/preference";
import { fakeSoundService } from "@/lib/sound/test-utils";
import { useInboxCountSounds, useRunOutcomeSound, useSound } from "./sound";
import { SoundProvider } from "./sound-provider";

const actions = vi.hoisted(() => ({
  saveSoundPreference: vi.fn<(sound: SoundPreference) => Promise<ActionResult>>(),
  toast: vi.fn(),
}));
vi.mock("@/lib/theme-actions", () => ({ saveSoundPreference: actions.saveSoundPreference }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: actions.toast,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

const ON: SoundPreference = { enabled: true, volume: 0.7 };

function Counts({ counts }: { counts: InboxCountsResponse | undefined }) {
  useInboxCountSounds(counts);
  return null;
}

function Run({ run }: { run: Pick<RunDetail, "id" | "status"> }) {
  useRunOutcomeSound(run);
  return null;
}

/** A button that mutes, as the Sounds switch and the user menu do. */
function MuteButton() {
  const { setPreference } = useSound();
  return (
    <button type="button" onClick={() => setPreference({ enabled: false, volume: 0.7 })}>
      Mute
    </button>
  );
}

const counts = (needsYou: number, problems = 0, questions = 0): InboxCountsResponse => ({
  needsYou,
  problems,
  running: 0,
  questions,
});

describe("SoundProvider", () => {
  it("unlocks audio from a pointer press or a key press, synchronously in the handler", () => {
    const service = fakeSoundService({ unlocked: false });
    render(
      <SoundProvider initial={ON} service={service}>
        {null}
      </SoundProvider>,
    );
    expect(service.unlock).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(service.unlock).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "j" });
    expect(service.unlock).toHaveBeenCalledTimes(2);
  });

  it("applies the saved preference, and stops everything when the signed-in app goes", () => {
    const service = fakeSoundService();
    const { unmount } = render(
      <SoundProvider initial={{ enabled: false, volume: 0.35 }} service={service}>
        {null}
      </SoundProvider>,
    );
    expect(service.configure).toHaveBeenLastCalledWith({ enabled: false, volume: 0.35 });
    unmount();
    expect(service.stopAll).toHaveBeenCalled();
    // The listeners went with it.
    fireEvent.pointerDown(document.body);
    expect(service.unlock).not.toHaveBeenCalled();
  });

  it("mutes at once and saves it; a refused save turns sounds back on with a toast", async () => {
    const service = fakeSoundService();
    actions.saveSoundPreference.mockResolvedValue({ ok: false, error: "No" });
    render(
      <SoundProvider initial={ON} service={service}>
        <MuteButton />
      </SoundProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(service.configure).toHaveBeenLastCalledWith({ enabled: false, volume: 0.7 });
    expect(actions.saveSoundPreference).toHaveBeenCalledWith({ enabled: false, volume: 0.7 });
    await waitFor(() => expect(service.configure).toHaveBeenLastCalledWith(ON));
    expect(actions.toast).toHaveBeenCalledWith("Couldn't save your preference.", {
      variant: "danger",
    });
  });
});

describe("useInboxCountSounds", () => {
  it("plays nothing for the first counts, then a cue for each new item", () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const service = fakeSoundService();
    const tree = (value: InboxCountsResponse | undefined) => (
      <SoundProvider initial={ON} service={service}>
        <Counts counts={value} />
      </SoundProvider>
    );
    const { rerender } = render(tree(undefined));
    rerender(tree(counts(1)));
    expect(service.play).not.toHaveBeenCalled();
    rerender(tree(counts(2, 0, 1)));
    expect(service.play).toHaveBeenLastCalledWith("mention");
    vi.setSystemTime(5_000);
    rerender(tree(counts(2, 1, 1)));
    expect(service.play).toHaveBeenLastCalledWith("warning");
  });

  it("plays one cue for a burst of new items", () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const service = fakeSoundService();
    const tree = (value: InboxCountsResponse) => (
      <SoundProvider initial={ON} service={service}>
        <Counts counts={value} />
      </SoundProvider>
    );
    const { rerender } = render(tree(counts(0)));
    rerender(tree(counts(1)));
    vi.setSystemTime(1_000);
    rerender(tree(counts(2)));
    expect(service.play).toHaveBeenCalledTimes(1);
  });

  it("drops the cue, without spending the gap, while audio is locked or muted", () => {
    vi.useFakeTimers({ now: 0, toFake: ["Date"] });
    const service = fakeSoundService({ unlocked: false });
    const tree = (value: InboxCountsResponse) => (
      <SoundProvider initial={ON} service={service}>
        <Counts counts={value} />
      </SoundProvider>
    );
    const { rerender } = render(tree(counts(0)));
    rerender(tree(counts(1)));
    expect(service.play).not.toHaveBeenCalled();
    // A gesture unlocks audio: the next new item plays at once, not after a gap.
    fireEvent.pointerDown(document.body);
    rerender(tree(counts(2)));
    expect(service.play).toHaveBeenCalledWith("notification");
  });
});

describe("useRunOutcomeSound", () => {
  const tree = (
    service: ReturnType<typeof fakeSoundService>,
    run: Pick<RunDetail, "id" | "status">,
  ) => (
    <SoundProvider initial={ON} service={service}>
      <Run run={run} />
    </SoundProvider>
  );

  it("plays complete when the watched run finishes, error when it fails", () => {
    const finished = fakeSoundService();
    const a = render(tree(finished, { id: "r1", status: "running" }));
    a.rerender(tree(finished, { id: "r1", status: "completed" }));
    expect(finished.play).toHaveBeenCalledWith("complete");
    a.unmount();

    const failed = fakeSoundService();
    const b = render(tree(failed, { id: "r1", status: "running" }));
    b.rerender(tree(failed, { id: "r1", status: "failed" }));
    expect(failed.play).toHaveBeenCalledWith("error");
  });

  it("plays nothing for a run that loads finished, or for opening another run", () => {
    const service = fakeSoundService();
    const { rerender } = render(tree(service, { id: "r1", status: "completed" }));
    rerender(tree(service, { id: "r2", status: "running" }));
    rerender(tree(service, { id: "r3", status: "failed" }));
    expect(service.play).not.toHaveBeenCalled();
  });
});
