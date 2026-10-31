import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  Transcript,
  transcriptOffset,
  transcriptPreview,
  type TranscriptEvent,
} from "./transcript.js";

const START = "2026-10-26T10:00:00.000Z";
const after = (seconds: number) => new Date(Date.parse(START) + seconds * 1000).toISOString();

const events: TranscriptEvent[] = [
  { id: "e1", type: "thought", body: "I'll read the export first.", parameter: null, at: after(4) },
  { id: "e2", type: "action", body: "Bash", parameter: "pnpm test --filter web", at: after(75) },
];

describe("transcriptOffset", () => {
  it("is m:ss under an hour", () => {
    expect(transcriptOffset(START, START)).toBe("0:00");
    expect(transcriptOffset(after(9), START)).toBe("0:09");
    expect(transcriptOffset(after(75), START)).toBe("1:15");
    expect(transcriptOffset(after(59 * 60 + 59), START)).toBe("59:59");
  });

  it("is h:mm:ss from an hour", () => {
    expect(transcriptOffset(after(3600), START)).toBe("1:00:00");
    expect(transcriptOffset(after(2 * 3600 + 5 * 60 + 7), new Date(START))).toBe("2:05:07");
  });

  it("is 0:00 before the start or for an invalid time", () => {
    expect(transcriptOffset(after(-30), START)).toBe("0:00");
    expect(transcriptOffset("not a date", START)).toBe("0:00");
  });
});

describe("Transcript", () => {
  it("renders one row per event, oldest first, with its offset", () => {
    render(<Transcript events={events} startedAt={START} />);
    const rows = within(screen.getByRole("list", { name: "Transcript" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const times = rows.map((row) => row.querySelector("time")!);
    expect(times.map((time) => time.textContent)).toEqual(["0:04", "1:15"]);
    expect(times[1]!.getAttribute("dateTime")).toBe(after(75));
    expect(times[0]!.className).toContain("or-mono");
  });

  it("shows a thought as 'thinking' with its text in prose", () => {
    render(<Transcript events={[events[0]!]} startedAt={START} />);
    const [row] = screen.getAllByRole("listitem");
    expect(row!.className).toContain("or-transcript__row--thought");
    expect(row!.querySelector(".or-transcript__name")!.textContent).toBe("thinking");
    const text = within(row!).getByText("I'll read the export first.");
    expect(text.tagName).toBe("P");
    expect(text.className).not.toContain("or-mono");
  });

  it("shows an action's name and its parameter in mono", () => {
    render(<Transcript events={[events[1]!]} startedAt={START} />);
    const [row] = screen.getAllByRole("listitem");
    expect(row!.className).toContain("or-transcript__row--action");
    expect(row!.querySelector(".or-transcript__name")!.textContent).toBe("Bash");
    const parameter = within(row!).getByText("pnpm test --filter web");
    expect(parameter.tagName).toBe("CODE");
    expect(parameter.className).toContain("or-mono");
  });

  it("leaves an action without a parameter at its name", () => {
    render(
      <Transcript
        events={[{ type: "action", body: "TodoWrite", parameter: null, at: after(1) }]}
        startedAt={START}
      />,
    );
    const [row] = screen.getAllByRole("listitem");
    expect(row!.querySelector("code")).toBeNull();
    expect(row!.textContent).toBe("0:01TodoWrite");
  });

  it("renders the error last, in coral, as an alert", () => {
    const { container } = render(
      <Transcript
        events={events}
        startedAt={START}
        error={"Tests failed\n2 failing"}
        more={<button type="button">Show all</button>}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Tests failed\n2 failing");
    expect(alert.className).toContain("or-transcript__error");
    const root = container.firstElementChild!;
    expect(root.lastElementChild).toBe(alert);
    expect(alert.previousElementSibling!.textContent).toBe("Show all");
  });

  it("renders no alert without an error, and no list without events", () => {
    render(<Transcript events={[]} startedAt={START} error={null} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("folds a long parameter to its first lines until View more, and back with View less", async () => {
    const heredoc = [
      "python3 - <<'EOF'",
      ...Array.from({ length: 20 }, (_, i) => `line ${i}`),
      "EOF",
    ];
    render(
      <Transcript
        events={[{ type: "action", body: "Bash", parameter: heredoc.join("\n"), at: after(1) }]}
        startedAt={START}
      />,
    );
    const code = screen.getByRole("listitem").querySelector("code")!;
    expect(code.textContent).toBe(heredoc.slice(0, 4).join("\n"));
    const toggle = screen.getByRole("button", { name: "View more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe(code.id);

    await userEvent.click(toggle);
    expect(code.textContent).toBe(heredoc.join("\n"));
    expect(toggle.textContent).toBe("View less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(toggle);
    expect(code.textContent).toBe(heredoc.slice(0, 4).join("\n"));
  });

  it("folds a long thought the same way, and each row on its own", async () => {
    const long = Array.from({ length: 8 }, (_, i) => `Step ${i}`).join("\n");
    render(
      <Transcript
        events={[
          { id: "t1", type: "thought", body: long, parameter: null, at: after(1) },
          { id: "t2", type: "thought", body: long, parameter: null, at: after(2) },
        ]}
        startedAt={START}
      />,
    );
    const [first, second] = screen.getAllByRole("listitem");
    await userEvent.click(within(first!).getByRole("button", { name: "View more" }));
    expect(first!.querySelector("p")!.textContent).toBe(long);
    expect(second!.querySelector("p")!.textContent).toBe("Step 0\nStep 1\nStep 2\nStep 3");
  });

  it("shows short texts whole, with no View more", () => {
    render(<Transcript events={events} startedAt={START} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("transcriptPreview", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join("\n");

  it("is null up to one line past the preview: folding a single line saves nothing", () => {
    expect(transcriptPreview("one line")).toBeNull();
    expect(transcriptPreview(lines(4))).toBeNull();
    expect(transcriptPreview(lines(5))).toBeNull();
  });

  it("is the first 4 lines past that", () => {
    expect(transcriptPreview(lines(6))).toBe("l0\nl1\nl2\nl3");
    expect(transcriptPreview(lines(40))).toBe("l0\nl1\nl2\nl3");
  });
});
