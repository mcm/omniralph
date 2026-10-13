import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProfilesView, type ProfileModelChoices } from "./profiles-view";

vi.mock("./actions", () => ({ updateReviewProfile: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));

const CHOICES: ProfileModelChoices = {
  models: [
    { value: "claude-opus-5-5", displayName: "Opus 5.5", harnessIds: ["h1", "h2"] },
    { value: "claude-haiku-5-5", displayName: "Haiku 5.5", harnessIds: ["h1"] },
  ],
  harnessCount: 2,
};

const profile = (id: string, model: string) => ({
  id,
  name: id,
  description: null,
  model,
  maxTokensPerReview: 150_000,
  maxFiles: 50,
  allowRepoExploration: true,
  updatedAt: "2026-10-13T00:00:00.000Z",
  builtIn: false,
  defaults: null,
  repositories: [],
});

describe("ProfilesView", () => {
  it("picks each profile's model from the reported models, keeping an unreported one", () => {
    const html = renderToStaticMarkup(
      <ProfilesView
        profiles={[profile("standard", "claude-opus-5-5"), profile("legacy", "claude-old-1")]}
        choices={CHOICES}
      />,
    );
    expect(html).toMatch(/id="profile-standard-model"[^]*?Opus 5\.5/);
    expect(html).toMatch(
      /id="profile-legacy-model"[^]*?claude-old-1<\/span><span[^>]*>not available/,
    );
    // A picker, not a text box.
    expect(html).not.toContain('value="claude-opus-5-5"');
  });
});
