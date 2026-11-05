import { describe, expect, it } from "vitest";
import { applyFormat, type TextSelection } from "./markdown-format";

/** `text` with the selection marked by `[` and `]`. */
function sel(marked: string): TextSelection {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  return { text: marked.replace("[", "").replace("]", ""), start, end };
}
const show = ({ text, start, end }: TextSelection) =>
  `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;

describe("applyFormat", () => {
  it("wraps the selection in bold and unwraps it again", () => {
    const bold = applyFormat("bold", sel("a [word] here"));
    expect(show(bold)).toBe("a **[word]** here");
    expect(show(applyFormat("bold", bold))).toBe("a [word] here");
  });

  it("inserts a selected placeholder when nothing is selected", () => {
    expect(show(applyFormat("italic", sel("a []")))).toBe("a _[italic text]_");
  });

  it("makes every selected line a list item, numbering them, and toggles back", () => {
    const listed = applyFormat("numberedList", sel("in[tro\nsec]ond\nthird"));
    expect(listed.text).toBe("1. intro\n2. second\nthird");
    expect(applyFormat("numberedList", listed).text).toBe("intro\nsecond\nthird");
    expect(applyFormat("bulletList", sel("one\n[]two")).text).toBe("one\n- two");
  });

  it("turns the line into a section heading", () => {
    expect(applyFormat("heading", sel("Intro\nGo[al]s")).text).toBe("Intro\n## Goals");
  });

  it("links the selection and selects the URL to type over", () => {
    expect(show(applyFormat("link", sel("see [the docs]")))).toBe("see [the docs]([https://])");
  });
});
