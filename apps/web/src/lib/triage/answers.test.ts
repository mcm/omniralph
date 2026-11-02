import { describe, expect, it, vi } from "vitest";
import { composeTriageAnswers } from "./answers";

vi.mock("server-only", () => ({}));

describe("composeTriageAnswers", () => {
  it("names the sender, then gives the answered questions in index order with their answers indented", () => {
    const text = composeTriageAnswers(
      [
        { index: 3, question: "Who can export?", answer: "Owners only." },
        { index: 0, question: " Which currency? ", answer: "EUR.\n\nUSD for US customers." },
      ],
      "Ada Lovelace",
    );
    expect(text).toBe(
      [
        "Answers to the open questions, from Omniralph by Ada Lovelace:",
        "1. Which currency?\n   EUR.\n\n   USD for US customers.",
        "4. Who can export?\n   Owners only.",
      ].join("\n\n"),
    );
    // Questions 2 and 3 weren't answered: they aren't mentioned.
    expect(text).not.toMatch(/^[23]\./m);
  });
});
