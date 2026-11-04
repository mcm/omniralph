/**
 * A feature's planning documents: its PRFAQ and its Plan. Unlike epics and
 * tasks, they are flexible-format documents written for people. A Plan names
 * the epics it expects, which is where sharding the feature into epics starts.
 * The plugin's `prfaq` and `plan` modes render these fragments.
 *
 * Like the shared rules, a fragment may name the tracker as `{{trackerName}}`;
 * no fragment names a specific tracker.
 */
import type { Fragment } from "./rules.js";
import { EPIC_SECTIONS, heading } from "./templates.js";

/** The kinds of a feature's documents, as the Omniralph API names them. */
export const FEATURE_DOCUMENT_KINDS = ["prfaq", "plan"] as const;
export type FeatureDocumentKind = (typeof FEATURE_DOCUMENT_KINDS)[number];

/** The optional section of a PRFAQ or a Plan that holds its success metrics. */
export const SUCCESS_METRICS_SECTION = "Success metrics";

/** The section of a Plan that names the epics it expects. */
export const PLAN_EPICS_SECTION = "Epics";

/** The labels of the lines under each expected epic of a Plan. */
export const PLAN_EPIC_LINES = { covers: "Covers", after: "After" } as const;

function fence(text: string): string {
  return `\`\`\`markdown\n${text}\n\`\`\``;
}

function code(text: string): string {
  return `\`${text}\``;
}

/** What a PRFAQ looks like when the writer has no shape of their own in mind. */
export const PRFAQ_TEMPLATE = `# [Headline: the feature in one line, as its users would say it]

[Subheading: who it is for and what they get, in one sentence.]

${heading("Press release")}

[The problem: who has it today and why it matters.]

[The solution: what changes for them, in their words.]

[A quote from someone who would use it.]

[How to get started.]

${heading("FAQ")}

### Users

**[A question a user would ask.]**
[Its answer.]

### Internal

**[A question the team building or supporting it would ask: cost, risk, what it replaces.]**
[Its answer.]

${heading(SUCCESS_METRICS_SECTION)}

[Optional: how the people planning the feature will judge it once it ships.]`;

/** What a Plan looks like when the writer has no shape of their own in mind. */
export const PLAN_TEMPLATE = `${heading("Context")}

[Why this feature, why now, and what the PRFAQ promises.]

${heading("Goals")}

- [What the feature delivers when every epic is done]

${heading("Non-goals")}

- [What it deliberately leaves out]

${heading("Approach")}

[How it is built: the parts, the design and the technical decisions, as many sections as the work needs.]

${heading(SUCCESS_METRICS_SECTION)}

[Optional: how the people planning the feature will judge it once it ships.]

${heading(PLAN_EPICS_SECTION)}

### [Plain title of the first epic to ship]

[A sentence or two on what it delivers.]

- ${PLAN_EPIC_LINES.covers}: [the sections of this Plan it builds]

### [Plain title of the next epic]

[A sentence or two on what it delivers.]

- ${PLAN_EPIC_LINES.covers}: [the sections of this Plan it builds]
- ${PLAN_EPIC_LINES.after}: [the earlier epics it waits for]`;

/** Success metrics: optional, and for people only. */
export const SUCCESS_METRICS_RULE: Fragment = {
  id: "success-metrics",
  title: "Success metrics",
  body: `A PRFAQ or a Plan may have a ${code(heading(SUCCESS_METRICS_SECTION))} section; it is optional, and a document without one is complete.
- Success metrics are for people: how those planning the feature will judge it once it ships, such as adoption, time saved or fewer support requests.
- They never reach a run. Sharding the Plan into epics leaves them out, no epic requirement or task done criterion restates them, and no agent's checks measure them.
- Don't invent metrics the person didn't ask for. Offer the section once; if they don't want it, leave it out.`,
};

/** The PRFAQ: the feature told from its users' side, before it is built. */
export const PRFAQ_RULE: Fragment = {
  id: "prfaq",
  title: "PRFAQ",
  body: `A PRFAQ tells the feature from the side of the people who will use it, as if it had already shipped: a press release, then the questions people would ask about it, answered. It decides what the feature is and why it matters, not how it is built.
- **Flexible format.** The template below is a starting point, not a schema. Keep the person's own structure when they have one: rename, drop, reorder or add sections as the feature needs. Nothing checks its headings.
- **Press release.** A headline and a one-sentence subheading, then the problem, the solution in the users' words, a quote and how to get started. Short and concrete: a page, not a spec.
- **FAQ.** The questions users would ask, then the questions the team building or supporting it would ask (cost, risk, what it replaces, what it leaves out), each with a direct answer. An answer nobody has yet is a question to settle with the person, not a placeholder.
- **Success metrics** (optional): see the Success metrics rule.
- No implementation detail beyond what a user would notice, no epics and no tasks: those belong in the Plan.

${fence(PRFAQ_TEMPLATE)}`,
};

/** The Plan: how the feature is built, ending with the epics it expects. */
export const PLAN_RULE: Fragment = {
  id: "plan",
  title: "Plan",
  body: `A Plan says how the feature is built and names the epics it expects. Omniralph shards it into epic drafts, maps each draft to the Plan's sections it covers, and checks that every section saying what the feature delivers is covered and that no epic adds scope the Plan lacks. So:
- **Flexible format.** The template below is a starting point, not a schema: use the sections the work needs, in the person's own words. Give each part its own ${code("##")} heading, because coverage is checked section by section, and keep everything the feature delivers in the Plan, since an epic may build nothing the Plan doesn't say.
- **Scope.** State the whole scope, and what is deliberately left out. Never label work later or optional unless the person did; ask about anything genuinely optional.
- **Success metrics** (optional): see the Success metrics rule. No epic covers them.
- **The epics it expects.** End with a ${code(heading(PLAN_EPICS_SECTION))} section naming each epic the Plan expects, in the order they would ship, each as a ${code("###")} heading with its plain title, then a sentence or two on what it delivers and a short list:
  - ${code(`${PLAN_EPIC_LINES.covers}:`)} the Plan's sections it builds;
  - ${code(`${PLAN_EPIC_LINES.after}:`)} the earlier epics it waits for, only when it waits for any.
- Split the epics by what each delivers, never by development phase (no "backend", "frontend" or "tests" epic), and size each as an Epic: a set of tasks that ships in one pull request.
- An epic waits only for other epics, and the waits never form a cycle. When sharding files the epics, each ${code(`${PLAN_EPIC_LINES.after}:`)} becomes a blocks relation between epics in {{trackerName}}.
- Every section that says what the feature delivers is covered by at least one epic. The context, what is left out and the ${code(heading(SUCCESS_METRICS_SECTION))} need none.
- The named epics are where sharding starts, not the epics themselves: each is drafted in full in the epic format (${code(heading(EPIC_SECTIONS.problem))}, ${code(heading(EPIC_SECTIONS.scope))}, ${code(heading(EPIC_SECTIONS.requirements))}) and reviewed by a person before anything is filed. Don't write requirements or tasks in the Plan.

${fence(PLAN_TEMPLATE)}`,
};

/** Every planning-document fragment, in the order the methodology presents them. */
export const DOCUMENT_RULES: readonly Fragment[] = [PRFAQ_RULE, PLAN_RULE, SUCCESS_METRICS_RULE];
