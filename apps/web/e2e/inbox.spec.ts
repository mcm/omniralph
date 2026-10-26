import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { open, triageRun } from "./runs";

const INBOX_FEED_API = /\/api\/ui\/inbox(\?|$)/;

// Wide enough for the list and the selected item side by side (`SplitView`, 880 px of content).
test.use({ viewport: { width: 1440, height: 900 } });

/** The Needs you list's row of the item titled `title`. */
const needsYouRow = (page: Page, title: string) =>
  page.getByRole("list", { name: "Needs you" }).getByRole("listitem").filter({ hasText: title });

test.describe("inbox", () => {
  test("an item decided Done leaves the list, and a new needs-you item appears without a reload", async ({
    db,
    page,
    signIn,
  }) => {
    // A triage that wrote a PRD without open questions: its PRD is ready for a person.
    const decided = await triageRun(db, "Ready PRD", "completed");
    await signIn("member");
    await open(page, "/?tab=needs-you", INBOX_FEED_API);
    // Marks this document: a reload would drop it.
    await page.evaluate(() => {
      (window as Window & { e2eNoReload?: boolean }).e2eNoReload = true;
    });

    const row = needsYouRow(page, decided.title);
    await expect(row).toContainText("PRD ready · Triage");
    await row.getByRole("link", { name: decided.title }).click();
    await expect(row).toHaveAttribute("aria-current", "true");
    const detail = page.getByRole("region", { name: "Item" });
    await expect(detail.getByRole("heading", { name: decided.title })).toBeVisible();

    await detail.getByRole("button", { name: "Done", exact: true }).click();
    await expect(row).toHaveCount(0);
    await expect(detail.getByRole("heading", { name: decided.title })).toHaveCount(0);

    // Another triage finishes with a PRD: its item shows up on the open Inbox.
    const added = await triageRun(db, "New PRD", "completed");
    await expect(needsYouRow(page, added.title)).toContainText("PRD ready · Triage");
    await expect(needsYouRow(page, decided.title)).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as Window & { e2eNoReload?: boolean }).e2eNoReload),
    ).toBe(true);

    // The decision was stored: the item stays gone after a reload.
    await page.reload();
    await expect(needsYouRow(page, added.title)).toBeVisible();
    await expect(needsYouRow(page, decided.title)).toHaveCount(0);
  });
});
