// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthShell } from "@/components/auth-shell";
import { SignInView } from "./sign-in-view";

vi.mock("next/link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLinkStatus: () => ({ pending: false }),
}));
const actions = vi.hoisted(() => ({ signInWithProvider: vi.fn(async () => {}) }));
vi.mock("@/lib/auth/actions", () => actions);

afterEach(() => {
  cleanup();
  actions.signInWithProvider.mockClear();
});

const GITHUB = { id: "github" as const, name: "GitHub" };

function renderSignIn(props: Partial<React.ComponentProps<typeof SignInView>> = {}) {
  return render(
    <AuthShell>
      <SignInView
        providers={[GITHUB]}
        callbackUrl="/runs"
        error={null}
        devSignIn={false}
        {...props}
      />
    </AuthShell>,
  );
}

describe("SignInView", () => {
  it("is headed Sign in under the home-linked brand lockup", () => {
    renderSignIn();
    expect(screen.getByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Omniralph home" }).getAttribute("href")).toBe("/");
    expect(screen.queryByRole("alert")).toBeNull();
    const legal = screen.getByRole("navigation", { name: "Legal" });
    expect(within(legal).getByRole("link", { name: "Terms of service" })).toBeTruthy();
  });

  it("signs in with a provider from its button", async () => {
    const user = userEvent.setup();
    renderSignIn();
    await user.click(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(actions.signInWithProvider).toHaveBeenCalledWith("github", "/runs");
    expect(
      (screen.getByRole("button", { name: "Redirecting to GitHub…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("shows a sign-in error in an alert", () => {
    renderSignIn({ error: "OAuthAccountNotLinked" });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Couldn't sign you in");
    expect(alert.textContent).toContain("This email is already linked to another provider.");
  });

  it("explains a server with no sign-in providers in an alert", () => {
    renderSignIn({ providers: [] });
    expect(screen.getByRole("alert").textContent).toContain("No sign-in providers configured");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("offers the dev sign-in by email as a GET form to the dev route", () => {
    renderSignIn({ devSignIn: true });
    const email = screen.getByRole("textbox", { name: "Dev sign-in" }) as HTMLInputElement;
    expect(email.name).toBe("email");
    expect(email.required).toBe(true);
    const submit = screen.getByRole("button", { name: "Sign in by email" }) as HTMLButtonElement;
    expect(submit.type).toBe("submit");
    const form = submit.form!;
    expect(form.getAttribute("action")).toBe("/sign-in/dev");
    expect(form.method).toBe("get");
    expect((form.elements.namedItem("callbackUrl") as HTMLInputElement).value).toBe("/runs");
  });
});
