import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { DIFF_TOO_LARGE, DiffView, diffLineKind, type DiffFile } from "./diff-view.js";

const URL = "https://github.com/acme/widgets/commit/6dcb09b";

const modified: DiffFile = {
  path: "src/app.ts",
  additions: 2,
  deletions: 1,
  patch:
    "@@ -10,3 +10,4 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n+const c = 4;\n const d = 5;",
};
const renamed: DiffFile = {
  path: "docs/importing.md",
  previousPath: "docs/import.md",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-# Import\n+# Importing",
};

function fileSections() {
  return within(screen.getByRole("list", { name: "Diff" })).getAllByRole("listitem");
}

describe("diffLineKind", () => {
  it("reads hunk headers, added, removed, notes and context lines", () => {
    expect(diffLineKind("@@ -1 +1 @@")).toBe("hunk");
    expect(diffLineKind("+added")).toBe("add");
    expect(diffLineKind("-removed")).toBe("del");
    expect(diffLineKind("\\ No newline at end of file")).toBe("meta");
    expect(diffLineKind(" context")).toBe("ctx");
  });
});

describe("DiffView", () => {
  it("renders one section per file with its path, counts and unified lines", () => {
    const { container } = render(<DiffView files={[modified, renamed]} url={URL} />);
    const [first, second] = fileSections();
    const toggle = within(first!).getByRole("button");
    expect(toggle.textContent).toContain("src/app.ts");
    expect(toggle.textContent).toContain("+2 −1");
    expect(within(second!).getByRole("button").textContent).toContain(
      "docs/import.md → docs/importing.md",
    );

    const lines = Array.from(first!.querySelectorAll(".or-diff__line"));
    expect(lines.map((l) => l.textContent)).toEqual([
      "@@ -10,3 +10,4 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
      "+const c = 4;",
      " const d = 5;",
    ]);
    expect(lines.map((l) => l.className.replace("or-diff__line or-diff__line--", ""))).toEqual([
      "hunk",
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
    expect(container.textContent).not.toContain(DIFF_TOO_LARGE);
  });

  it("collapses and expands a file with its toggle", async () => {
    const user = userEvent.setup();
    render(<DiffView files={[modified]} />);
    const toggle = screen.getByRole("button", { name: /src\/app\.ts/ });
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(body.hidden).toBe(true);
    await user.click(toggle);
    expect(body.hidden).toBe(false);
  });

  it("says a truncated file is too large, with a link to the commit", () => {
    render(
      <DiffView
        files={[
          { ...modified, truncated: true },
          {
            path: "pnpm-lock.yaml",
            additions: 4210,
            deletions: 3988,
            patch: null,
            truncated: true,
          },
        ]}
        url={URL}
        urlLabel="Open on GitHub"
      />,
    );
    const [cut, omitted] = fileSections();
    for (const section of [cut!, omitted!]) {
      expect(section.textContent).toContain(DIFF_TOO_LARGE);
      expect(
        within(section).getByRole("link", { name: "Open on GitHub" }).getAttribute("href"),
      ).toBe(URL);
    }
    // The lines that are there still show.
    expect(cut!.querySelectorAll(".or-diff__line")).toHaveLength(6);
    expect(omitted!.querySelectorAll(".or-diff__line")).toHaveLength(0);
  });

  it("says a truncated diff is too large, once, after the files", () => {
    const { container } = render(<DiffView files={[modified]} truncated url={URL} />);
    expect(screen.getAllByText(DIFF_TOO_LARGE, { exact: false })).toHaveLength(1);
    const notice = container.querySelector(".or-diff > .or-diff__notice")!;
    expect(notice.textContent).toContain(DIFF_TOO_LARGE);
    const link = within(notice as HTMLElement).getByRole("link", { name: "Open the commit" });
    expect(link.getAttribute("href")).toBe(URL);
  });

  it("notes a file without line changes and a diff without files", () => {
    const { rerender } = render(
      <DiffView files={[{ path: "logo.png", additions: 0, deletions: 0, patch: null }]} />,
    );
    expect(fileSections()[0]!.textContent).toContain("No line changes to show.");
    rerender(<DiffView files={[]} />);
    expect(screen.getByText("No files changed.")).toBeTruthy();
  });
});
