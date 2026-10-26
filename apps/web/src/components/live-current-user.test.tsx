// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { organizationKeys, queryKeys } from "@/lib/api/keys";
import type { OrganizationSettings } from "@/lib/api/organization";
import { organizationSettings } from "@/screens/settings/test-fixtures";
import { CurrentUserProvider, useCurrentUser, type SessionUser } from "./current-user";
import { LiveCurrentUser, withOrganizationName } from "./live-current-user";
import { createTestQueryClient, TEST_ORGANIZATION_ID, testUser } from "./query-test-utils";

afterEach(cleanup);

const BETA_ID = "22222222-2222-4222-8222-222222222222";
const key = organizationKeys(queryKeys(TEST_ORGANIZATION_ID)).settings;

function Names() {
  const { organization, organizations } = useCurrentUser();
  return (
    <p data-testid="names">
      {[organization.name, ...organizations.map((option) => option.name)].join(" | ")}
    </p>
  );
}

function setup(user: SessionUser = testUser) {
  const client = createTestQueryClient();
  const tree = (session: SessionUser) => (
    <CurrentUserProvider user={session}>
      <QueryClientProvider client={client}>
        <LiveCurrentUser>
          <Names />
        </LiveCurrentUser>
      </QueryClientProvider>
    </CurrentUserProvider>
  );
  const utils = render(tree(user));
  const cache = (name: string) =>
    act(() =>
      client.setQueryData<OrganizationSettings>(
        key,
        organizationSettings({
          organization: { id: TEST_ORGANIZATION_ID, name, allowDomainJoin: false },
        }),
      ),
    );
  return { client, cache, rerender: (session: SessionUser) => utils.rerender(tree(session)) };
}

const names = () => screen.getByTestId("names").textContent;

describe("withOrganizationName", () => {
  it("renames the active organization only", () => {
    const user: SessionUser = {
      ...testUser,
      organizations: [
        { ...testUser.organization, role: "admin" },
        { id: BETA_ID, name: "Beta", role: "member" },
      ],
    };
    expect(withOrganizationName(user, "Acme Labs")).toMatchObject({
      organization: { id: TEST_ORGANIZATION_ID, name: "Acme Labs" },
      organizations: [
        { id: TEST_ORGANIZATION_ID, name: "Acme Labs" },
        { id: BETA_ID, name: "Beta" },
      ],
    });
    expect(withOrganizationName(user, "Acme")).toBe(user);
  });
});

describe("LiveCurrentUser", () => {
  it("names the organization as the server rendered it until its settings are cached", () => {
    const { cache } = setup();
    expect(names()).toBe("Acme | Acme");
    cache("Acme Labs");
    expect(names()).toBe("Acme Labs | Acme Labs");
  });

  it("keeps the latest cached name after its query leaves the cache", () => {
    const { client, cache } = setup();
    cache("Acme Labs");
    act(() => client.removeQueries({ queryKey: key }));
    expect(names()).toBe("Acme Labs | Acme Labs");
  });

  it("follows the server's name once it renders the shell again", () => {
    const { cache, rerender } = setup();
    cache("Acme Labs");
    const renamed = withOrganizationName(testUser, "Acme Industries");
    rerender(renamed);
    expect(names()).toBe("Acme Industries | Acme Industries");
    cache("Acme Works");
    expect(names()).toBe("Acme Works | Acme Works");
  });
});
