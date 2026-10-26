// @vitest-environment jsdom
import "@/components/pickers/test-dom";
import type * as OmniralphUi from "@omniralph/ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTestQueryClient,
  jsonResponse,
  mockFetch,
  queryWrapper,
} from "@/components/query-test-utils";
import type { ScmConnectionListRow } from "@/lib/api/repositories";
import { ConnectGitLabForm } from "./connect-gitlab-form";

const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("@omniralph/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof OmniralphUi>()),
  toast: ui.toast,
}));

const ORG = "22222222-2222-4222-8222-222222222222";

const connection: ScmConnectionListRow = {
  id: "cccccccc-cccc-4ccc-8ccc-ccccccccccc1",
  provider: "gitlab",
  name: "bot @ gitlab.example.com",
  host: "gitlab.example.com",
  health: { state: "not_checked", problems: [] },
};

function renderForm(onConnected = vi.fn(), onCancel?: () => void) {
  render(
    <ConnectGitLabForm
      organizationId={ORG}
      defaultGitLabUrl="https://gitlab.com"
      onConnected={onConnected}
      onCancel={onCancel}
    />,
    { wrapper: queryWrapper(createTestQueryClient()) },
  );
  return onConnected;
}

afterEach(() => {
  vi.unstubAllGlobals();
  ui.toast.mockReset();
});

describe("ConnectGitLabForm", () => {
  it("prefills the GitLab URL, posts the form for its organization and hands back the connection", async () => {
    const seen = mockFetch({
      "POST /api/ui/gitlab-connections": () =>
        jsonResponse({ ok: true, connectionId: connection.id, connection }),
    });
    const onConnected = renderForm();
    const url = screen.getByLabelText("GitLab URL") as HTMLInputElement;
    expect(url.value).toBe("https://gitlab.com");
    await userEvent.clear(url);
    await userEvent.type(url, "https://gitlab.example.com");
    await userEvent.type(screen.getByLabelText("Access token"), "glpat-secret");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(onConnected).toHaveBeenCalledWith(connection));
    expect(seen.map((request) => [request.method, request.path, request.body])).toEqual([
      [
        "POST",
        "/api/ui/gitlab-connections",
        { baseUrl: "https://gitlab.example.com", token: "glpat-secret", organizationId: ORG },
      ],
    ]);
    expect(ui.toast).toHaveBeenCalledWith("GitLab connected");
  });

  it("shows the server's validation message and keeps the form", async () => {
    mockFetch({
      "POST /api/ui/gitlab-connections": () =>
        jsonResponse({ error: "The GitLab URL must use https." }, 400),
    });
    const onConnected = renderForm();
    const url = screen.getByLabelText("GitLab URL");
    await userEvent.clear(url);
    await userEvent.type(url, "http://gitlab.example.com");
    await userEvent.type(screen.getByLabelText("Access token"), "glpat-secret");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect((await screen.findByRole("alert")).textContent).toBe("The GitLab URL must use https.");
    expect(onConnected).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Access token") as HTMLInputElement).value).toBe("glpat-secret");
  });

  it("offers Cancel only with onCancel", async () => {
    const onCancel = vi.fn();
    renderForm(vi.fn(), onCancel);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
