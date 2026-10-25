// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as UI from "@omniralph/ui";
import type { ActionResult } from "@/lib/action-result";
import { ShowAdvancedProvider, useShowAdvanced } from "./show-advanced";

const save = vi.hoisted(() => ({ saveShowAdvancedPreference: vi.fn() }));
vi.mock("@/lib/theme-actions", () => save);
const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof UI>()),
  toast: ui.toast,
}));

beforeEach(() => {
  save.saveShowAdvancedPreference.mockReset();
  ui.toast.mockReset();
});
afterEach(cleanup);

function Toggle() {
  const [showAdvanced, setShowAdvanced] = useShowAdvanced();
  return (
    <button type="button" onClick={() => setShowAdvanced(!showAdvanced)}>
      {showAdvanced ? "Advanced shown" : "Advanced hidden"}
    </button>
  );
}

/** A save that settles when the test says so. */
function pendingSave() {
  let settle!: (result: ActionResult | Error) => void;
  save.saveShowAdvancedPreference.mockReturnValue(
    new Promise<ActionResult>((resolve, reject) => {
      settle = (result) => (result instanceof Error ? reject(result) : resolve(result));
    }),
  );
  return (result: ActionResult | Error) => act(async () => settle(result));
}

describe("useShowAdvanced", () => {
  it("starts from the saved preference", () => {
    render(
      <ShowAdvancedProvider initial={true}>
        <Toggle />
      </ShowAdvancedProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("Advanced shown");
  });

  it("updates at once and keeps the value once saved", async () => {
    const settle = pendingSave();
    render(
      <ShowAdvancedProvider initial={false}>
        <Toggle />
      </ShowAdvancedProvider>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("Advanced shown");
    expect(save.saveShowAdvancedPreference).toHaveBeenCalledWith(true);
    await settle({ ok: true });
    expect(screen.getByRole("button").textContent).toBe("Advanced shown");
    expect(ui.toast).not.toHaveBeenCalled();
  });

  it("reverts with an error toast when the save is refused", async () => {
    const settle = pendingSave();
    render(
      <ShowAdvancedProvider initial={false}>
        <Toggle />
      </ShowAdvancedProvider>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("Advanced shown");
    await settle({ ok: false, error: "You must be signed in." });
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Advanced hidden"));
    expect(ui.toast).toHaveBeenCalledWith("Couldn't save your preference.", {
      variant: "danger",
    });
  });

  it("reverts with an error toast when the save fails", async () => {
    const settle = pendingSave();
    render(
      <ShowAdvancedProvider initial={true}>
        <Toggle />
      </ShowAdvancedProvider>,
    );
    await userEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button").textContent).toBe("Advanced hidden");
    await settle(new Error("network down"));
    await waitFor(() => expect(screen.getByRole("button").textContent).toBe("Advanced shown"));
    expect(ui.toast).toHaveBeenCalledWith("Couldn't save your preference.", {
      variant: "danger",
    });
  });

  it("needs the app shell", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Toggle />)).toThrow(/inside the signed-in app shell/);
  });
});
