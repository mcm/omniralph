import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Inbox and Runs (TOOL-642) build each run component once and use it everywhere a run appears:
// the Inbox detail, the run detail, the phone step page and later screens. This reads every
// non-test source of `apps/web/src` and `packages/ui/src` for the components it declares, and
// checks that each run component is declared once, where the epic put it, and that the screens
// (`src/screens/`) declare no second status line, progress card, step panel, attempts list,
// Details, Session or Activity of their own.

const WEB = path.resolve(__dirname, "../..");
const REPO = path.resolve(WEB, "../..");
const ROOTS = ["apps/web/src", "packages/ui/src"];

/** Each run component and the one file (from the repository root) that declares it. */
const COMPONENTS: Record<string, string> = {
  StatusLine: "packages/ui/src/status/status-line.tsx",
  SplitView: "packages/ui/src/layout/split-view.tsx",
  FilterMenu: "packages/ui/src/actions/filter-menu.tsx",
  ActivityList: "packages/ui/src/lists/activity-list.tsx",
  RadioList: "packages/ui/src/controls/radio-list.tsx",
  ProgressCard: "packages/ui/src/surfaces/progress-card.tsx",
  DetailsSection: "packages/ui/src/surfaces/details-section.tsx",
  Transcript: "packages/ui/src/lists/transcript.tsx",
  DiffView: "packages/ui/src/lists/diff-view.tsx",
  DecisionButtons: "apps/web/src/components/runs/decision-buttons.tsx",
  QuestionForm: "apps/web/src/components/runs/question-form.tsx",
  RunProgress: "apps/web/src/components/runs/run-progress.tsx",
  RunActivity: "apps/web/src/components/runs/run-activity.tsx",
  AttemptOutcome: "apps/web/src/components/runs/attempt-outcome.tsx",
  RunFactBadges: "apps/web/src/components/runs/run-details.tsx",
  RunLanes: "apps/web/src/components/runs/run-details.tsx",
  TriageSummary: "apps/web/src/components/runs/triage-summary.tsx",
  RunSession: "apps/web/src/components/runs/run-session.tsx",
  StepPanel: "apps/web/src/components/runs/step-panel.tsx",
  AttemptList: "apps/web/src/components/runs/attempt-list.tsx",
};

/** Names a screen's own component may not have: they belong to the run components above. */
const RUN_COMPONENT_NAME =
  /StatusLine|Progress|StepPanel|Attempts?List|AttemptOutcome|Details|Session|Activity|Transcript|Diff|DecisionButtons|QuestionForm/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** The PascalCase functions, classes and variables `code` declares at its top level. */
function declaredComponents(file: string, code: string): string[] {
  const source = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) names.push(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
    }
  }
  return names.filter((name) => /^[A-Z][a-z]/.test(name));
}

const declarations = ROOTS.flatMap((root) =>
  walk(path.join(REPO, root))
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$|test-fixtures\.ts$/.test(file))
    .flatMap((file) => {
      const relative = path.relative(REPO, file).split(path.sep).join("/");
      return declaredComponents(file, readFileSync(file, "utf8")).map((name) => ({
        name,
        file: relative,
      }));
    }),
);

describe("the run components", () => {
  it.each(Object.entries(COMPONENTS))("%s is declared once, in %s", (name, file) => {
    expect(declarations.filter((d) => d.name === name).map((d) => d.file)).toEqual([file]);
  });

  it("have no second status line, progress card, step panel, attempts list, Details, Session or Activity in the screens", () => {
    const screens = declarations.filter((d) => d.file.startsWith("apps/web/src/screens/"));
    expect(screens.map((d) => d.name)).toContain("RunDetailView");
    expect(screens.filter((d) => RUN_COMPONENT_NAME.test(d.name))).toEqual([]);
  });
});
