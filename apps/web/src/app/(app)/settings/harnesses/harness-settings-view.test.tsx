// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DefaultsSection } from "./harness-settings-view";

const actions = vi.hoisted(() => ({
  setOrganizationDefaults: vi.fn(async () => ({ ok: true }) as const),
  setGlobalHarnessVersion: vi.fn(async () => ({ ok: true }) as const),
}));
vi.mock("./actions", () => actions);
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const builtIn = { allowedTaskTypes: ["query", "review", "coding"], maxConcurrency: 5 };

function renderDefaults(desiredVersion: string | null = "1.4.0") {
  return render(
    <DefaultsSection
      desiredVersion={desiredVersion}
      updatedAt={null}
      latest={null}
      packageName="@omniralph/harness"
      defaults={builtIn}
      builtInDefaults={builtIn}
    />,
  );
}

async function saveAndConfirm() {
  await userEvent.click(screen.getByRole("button", { name: /Save defaults/ }));
  const dialog = await screen.findByRole("alertdialog");
  await userEvent.click(
    [...dialog.querySelectorAll("button")].find((b) => /^Save/.test(b.textContent ?? ""))!,
  );
}

describe("DefaultsSection", () => {
  it("holds task types, concurrency and the harness version in one section with one save", () => {
    const { container } = renderDefaults();
    expect(container.querySelectorAll("form")).toHaveLength(1);
    expect(container.querySelectorAll('button[type="submit"]')).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Task types",
      "Concurrency",
      "Harness version",
    ]);
  });

  it("saves only what changed: the version alone", async () => {
    renderDefaults();
    await userEvent.click(screen.getByRole("button", { name: /Track latest on npm/ }));
    expect(screen.getByLabelText("Desired version")).toHaveProperty("value", "latest");
    await saveAndConfirm();
    await waitFor(() => expect(actions.setGlobalHarnessVersion).toHaveBeenCalledWith("latest"));
    expect(actions.setOrganizationDefaults).not.toHaveBeenCalled();
  });

  it("saves the defaults, then the version, with one click", async () => {
    actions.setGlobalHarnessVersion.mockClear();
    renderDefaults();
    await userEvent.click(screen.getByLabelText("Coding"));
    await userEvent.clear(screen.getByLabelText("Desired version"));
    await userEvent.type(screen.getByLabelText("Desired version"), "1.5.0");
    expect(screen.getByText("2 unsaved changes")).toBeTruthy();
    await saveAndConfirm();
    await waitFor(() =>
      expect(actions.setOrganizationDefaults).toHaveBeenCalledWith({
        allowedTaskTypes: ["query", "review"],
        maxConcurrency: 5,
      }),
    );
    await waitFor(() => expect(actions.setGlobalHarnessVersion).toHaveBeenCalledWith("1.5.0"));
  });
});
