import { describe, expect, it } from "vitest";

import { CRITIQUE_SIZES, PLAN_RUBRICS, renderRubric } from "./critique.js";
import { type Fragment, SHARED_RULES, renderFragment } from "./rules.js";
import { EPIC_TEMPLATE, TASK_PARAGRAPHS, TASK_TEMPLATE } from "./templates.js";
import { TRIAGE_STEPS, renderTriageMethodology } from "./triage.js";

const context = { trackerName: "Acme Tracker", conventionsFile: "ACME.md" };

/** The `##`/`###` headings of a Markdown text outside fenced blocks, in order. */
function headings(markdown: string): string[] {
  let fenced = false;
  const found: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && /^#{2,3} /.test(line)) found.push(line);
  }
  return found;
}

const templates = { EPIC_TEMPLATE, TASK_TEMPLATE };
const fragments: Fragment[] = [...SHARED_RULES, ...TRIAGE_STEPS];

describe("templates", () => {
  it("lays out an epic as Problem, Scope (In / Out), Design, Technical notes, Requirements", () => {
    expect(headings(EPIC_TEMPLATE)).toEqual([
      "## Problem",
      "## Scope",
      "### In",
      "### Out",
      "## Design",
      "## Technical notes",
      "## Requirements",
    ]);
    expect(EPIC_TEMPLATE).toMatch(/^- FR-1: The system must /m);
  });

  it("lays out a task as three paragraphs: build, how, and don't stop until", () => {
    const paragraphs = TASK_TEMPLATE.split("\n\n");
    expect(paragraphs.map((paragraph) => paragraph.split(" [")[0])).toEqual([
      "I want you to",
      "Build it by",
      "Don't stop until",
    ]);
    expect(headings(TASK_TEMPLATE)).toEqual([]);
    expect(TASK_TEMPLATE).not.toMatch(/Covers:|As a \[|- \[ \]/);
  });

  it.each(Object.entries(TASK_PARAGRAPHS))(
    "explains the %s paragraph for a Story and for a Fix",
    (_name, paragraph) => {
      const text = TASK_TEMPLATE.split("\n\n").find((p) => p.startsWith(paragraph.opening));
      expect(text).toContain(`[Story: ${paragraph.story}. Fix: ${paragraph.fix}.]`);
    },
  );
});

describe("fragments", () => {
  it("have unique ids", () => {
    const ids = fragments.map((fragment) => fragment.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each([...fragments.map((f) => [f.id, f.body] as const), ...Object.entries(templates)])(
    "%s never asks for Success Metrics or Quality Gates, or names a tracker",
    (_name, text) => {
      expect(text).not.toMatch(/success metrics|quality gates/i);
      expect(text).not.toMatch(/\b(linear|github|gitlab|jira)\b/i);
    },
  );

  it("fills in the tracker and conventions file", () => {
    expect(renderFragment("Read {{conventionsFile}} for {{trackerName}} issues.", context)).toBe(
      "Read ACME.md for Acme Tracker issues.",
    );
  });

  it("rejects an unknown placeholder", () => {
    expect(() => renderFragment("Hello {{tracker.name}} and {{nope}}", context)).toThrow(
      "Unknown methodology placeholder {{nope}}",
    );
  });
});

describe("renderTriageMethodology", () => {
  const methodology = renderTriageMethodology(context);

  it.each(SHARED_RULES.map((rule) => [rule.id, rule] as const))(
    "includes the %s rule once",
    (_id, rule) => {
      const body = renderFragment(rule.body, context);
      expect(methodology.split(body)).toHaveLength(2);
      expect(methodology).toContain(`### ${rule.title}\n\n${body}`);
    },
  );

  it("includes every template", () => {
    for (const template of Object.values(templates)) expect(methodology).toContain(template);
  });

  it("numbers the triage steps in order, before the shared rules", () => {
    const stepHeadings = headings(methodology).filter((line) => /^### \d+\. /.test(line));
    expect(stepHeadings).toEqual(
      TRIAGE_STEPS.map((step, index) => `### ${index + 1}. ${step.title}`),
    );
    expect(methodology.indexOf("## How to triage")).toBeLessThan(
      methodology.indexOf("## Planning rules"),
    );
  });

  it("plans no validation task, leaving the requirements to the epic audit", () => {
    expect(methodology).toContain(
      "audits the epic against its requirements before its pull request opens",
    );
    expect(methodology).toContain("No validation or audit entry");
    expect(methodology).not.toMatch(/validation audit/i);
  });

  it("names the tracker it is rendered for and leaves no placeholder", () => {
    expect(methodology).toContain("Acme Tracker");
    expect(methodology).toContain("`ACME.md`");
    expect(methodology).not.toMatch(/\{\{/);
  });
});

describe("plan rubrics", () => {
  it.each(CRITIQUE_SIZES)("gives the %s rubric unique ids the critic can name", (size) => {
    const ids = PLAN_RUBRICS[size].map((item) => item.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
  });

  it.each(CRITIQUE_SIZES)(
    "renders the %s rubric as one line per item, safe in a prompt template",
    (size) => {
      const lines = renderRubric(size).split("\n");
      expect(lines).toHaveLength(PLAN_RUBRICS[size].length);
      expect(lines[0]).toBe(`- \`${PLAN_RUBRICS[size][0]!.id}\`: ${PLAN_RUBRICS[size][0]!.check}`);
      // The critic playbook embeds the rubric in its Mustache template.
      expect(renderRubric(size)).not.toContain("{{");
    },
  );

  it("judges a Fix on its cause and reproduction, a Story on its sentence, an Epic on coverage and order", () => {
    const ids = (size: (typeof CRITIQUE_SIZES)[number]) => PLAN_RUBRICS[size].map((i) => i.id);
    expect(ids("fix")).toEqual(
      expect.arrayContaining(["reproduction", "located-cause", "checkable-criteria"]),
    );
    expect(ids("story")).toEqual(expect.arrayContaining(["story-sentence", "checkable-criteria"]));
    expect(ids("story")).not.toContain("located-cause");
    expect(ids("epic")).toEqual(
      expect.arrayContaining(["epic-format", "requirements-covered", "story-order"]),
    );
    // The epic rubric names the template's sections as the formats define them.
    for (const section of ["## Problem", "## Scope", "### In", "### Out", "## Requirements"]) {
      expect(renderRubric("epic")).toContain(`\`${section}\``);
    }
  });
});
