export const packageName = "@omniralph/planning";

export { DEFAULT_FIX_LABELS, dependencyViolations, workItemKind, workItemRole } from "./model.js";
export type {
  DependencyViolation,
  ItemRef,
  PlannedItem,
  RoleItem,
  ViolationReason,
  WorkItemKind,
  WorkItemRole,
  WorkItemRoleName,
} from "./model.js";

export {
  ACCEPTANCE_CRITERIA_SECTION,
  COVERS_LABEL,
  EPIC_SECTIONS,
  EPIC_TEMPLATE,
  FIX_SECTIONS,
  FIX_TEMPLATE,
  OPTIONAL_EPIC_SECTIONS,
  REQUIREMENT_PREFIX,
  SCOPE_PARTS,
  STORY_TEMPLATE,
  VALIDATION_AUDIT_TITLE,
  heading,
} from "./methodology/templates.js";
export {
  CHECKABLE_CRITERIA_RULE,
  DEPENDENCY_RULE,
  EPIC_FORMAT_RULE,
  FIX_FORMAT_RULE,
  REQUIREMENT_WORDING_RULE,
  SHARED_RULES,
  SIZING_RULE,
  SPLITTING_RULE,
  STORY_FORMAT_RULE,
  EPIC_AUDIT_RULE,
  WORK_ITEMS_RULE,
  renderFragment,
  renderSection,
} from "./methodology/rules.js";
export type { Fragment, MethodologyContext } from "./methodology/rules.js";
export {
  TRIAGE_DESCRIPTION_STEP,
  TRIAGE_OPEN_QUESTIONS_STEP,
  TRIAGE_OUTCOME_STEP,
  TRIAGE_REFORMAT_STEP,
  TRIAGE_SIZE_STEP,
  TRIAGE_STEPS,
  TRIAGE_STORIES_STEP,
  TRIAGE_SUMMARY_STEP,
  TRIAGE_UNDERSTAND_STEP,
  renderTriageMethodology,
} from "./methodology/triage.js";

export {
  COVERED_REQUIREMENTS_HEADING,
  COVERED_REQUIREMENTS_NOTE,
  CRITERIA_AS_EVIDENCE_NOTE,
  EPIC_CONTEXT_HEADING,
  EPIC_CONTEXT_NOTE,
  FIX_TASK_NOTE,
  UNKNOWN_REQUIREMENT_TEXT,
  splitFixDescription,
} from "./methodology/task-prompt.js";
export type { FixDescription } from "./methodology/task-prompt.js";

export {
  findSection,
  isPlanningFormat,
  parseCriteria,
  parseRequirements,
  parseWorkItem,
  requirementId,
  sectionKey,
  splitSections,
  workItemFormat,
} from "./work-item/parse.js";
export type {
  ParsedWorkItem,
  Requirement,
  WorkItemFormat,
  WorkItemSection,
} from "./work-item/parse.js";
export { OPEN_QUESTIONS_SECTION, isOutcomeCriterion, lintWorkItem } from "./work-item/lint.js";
export type { LintCode, LintOptions, LintProblem } from "./work-item/lint.js";

export {
  GENERATED_NOTICE,
  PLUGIN_CONTEXT,
  PLUGIN_DIR,
  PLUGIN_NAME,
  renderCommon,
  renderPluginFiles,
  renderSkill,
} from "./plugin/render.js";
export type { PluginFile } from "./plugin/render.js";
export { PLUGIN_MODES } from "./plugin/modes.js";
export type { PluginMode } from "./plugin/modes.js";
