// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { CurrentUserProvider, type SessionUser } from "@/components/current-user";
import { TEST_ORGANIZATION_ID, testUser } from "@/components/query-test-utils";
import { scopeParam, useScopeParam } from "./scope";

function scopeOf(user: SessionUser) {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <CurrentUserProvider user={user}>{children}</CurrentUserProvider>
  );
  return renderHook(useScopeParam, { wrapper }).result.current;
}

describe("useScopeParam", () => {
  it("sends the active organization's id with one organization selected", () => {
    expect(scopeOf(testUser)).toBe(TEST_ORGANIZATION_ID);
  });

  it('sends "all" under All organizations', () => {
    expect(scopeOf({ ...testUser, scope: "all" })).toBe("all");
  });

  it("scopeParam is the same rule", () => {
    expect(scopeParam(testUser)).toBe(TEST_ORGANIZATION_ID);
    expect(scopeParam({ ...testUser, scope: "all" })).toBe("all");
  });
});
