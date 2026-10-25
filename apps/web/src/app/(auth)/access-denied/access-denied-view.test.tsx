// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthShell } from "@/components/auth-shell";
import { AccessDeniedView } from "./access-denied-view";

vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));

afterEach(cleanup);

function renderView(reason: "not-allowed" | "forbidden") {
  return render(
    <AuthShell>
      <AccessDeniedView reason={reason} />
    </AuthShell>,
  );
}

describe("AccessDeniedView", () => {
  it("tells an account that may not sign in why, and offers another account", () => {
    renderView("not-allowed");
    expect(screen.getByRole("heading", { level: 1, name: "Access denied" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "Your account isn't allowed to use this control panel.",
    );
    expect(screen.getByRole("link", { name: "Try another account" }).getAttribute("href")).toBe(
      "/sign-in",
    );
  });

  it("tells a member a page is for admins, and leads back to the control panel", () => {
    renderView("forbidden");
    expect(screen.getByRole("heading", { level: 1, name: "Access denied" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("This page is only available to admins.");
    expect(
      screen.getByRole("link", { name: "Back to the control panel" }).getAttribute("href"),
    ).toBe("/");
  });
});
