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
  OPTIONAL_EPIC_SECTIONS,
  REQUIREMENT_PREFIX,
  SCOPE_PARTS,
  TASK_PARAGRAPHS,
  TASK_TEMPLATE,
  VALIDATION_AUDIT_TITLE,
  heading,
} from "./methodology/templates.js";
export type { TaskParagraph } from "./methodology/templates.js";
export {
  CHECKABLE_CRITERIA_RULE,
  DEPENDENCY_RULE,
  EPIC_FORMAT_RULE,
  REQUIREMENT_WORDING_RULE,
  SHARED_RULES,
  SIZING_RULE,
  SPLITTING_RULE,
  TASK_CONSTRAINTS_RULE,
  TASK_FORMAT_RULE,
  EPIC_AUDIT_RULE,
  WORK_ITEMS_RULE,
  renderFragment,
  renderSection,
} from "./methodology/rules.js";
export type { Fragment, MethodologyContext } from "./methodology/rules.js";
export {
  TRIAGE_BUG_STEP,
  TRIAGE_DESCRIPTION_STEP,
  TRIAGE_FEATURE_STEP,
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
  DOCUMENT_RULES,
  FEATURE_DOCUMENT_KINDS,
  PLAN_EPICS_SECTION,
  PLAN_EPIC_LINES,
  PLAN_RULE,
  PLAN_TEMPLATE,
  PRFAQ_RULE,
  PRFAQ_TEMPLATE,
  SUCCESS_METRICS_RULE,
  SUCCESS_METRICS_SECTION,
} from "./methodology/documents.js";
export type { FeatureDocumentKind } from "./methodology/documents.js";

export { CRITIQUE_SIZES, PLAN_RUBRICS, renderRubric } from "./methodology/critique.js";
export type { CritiqueSize, RubricItem } from "./methodology/critique.js";

export {
  CRITERIA_AS_EVIDENCE_NOTE,
  EPIC_CONTEXT_HEADING,
  EPIC_CONTEXT_NOTE,
  FIX_TASK_NOTE,
  FIX_TASK_PROMPT_NOTE,
  TASK_APPROACH_NOTE,
  TASK_DONE_NOTE,
  TASK_PROMPT_HEADINGS,
} from "./methodology/task-prompt.js";

export {
  TASK_PARAGRAPH_NAMES,
  findSection,
  isPlanningFormat,
  parseCriteria,
  parseDoneCriteria,
  parseRequirements,
  parseWorkItem,
  requirementId,
  sectionKey,
  splitSections,
  splitSentences,
  workItemFormat,
} from "./work-item/parse.js";
export type {
  ParseWorkItemOptions,
  ParsedWorkItem,
  Requirement,
  TaskParagraphName,
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
  renderMode,
  renderPluginFiles,
  renderSkill,
} from "./plugin/render.js";
export type { PluginFile } from "./plugin/render.js";
export { PLUGIN_MODES } from "./plugin/modes.js";
export type { PluginMode } from "./plugin/modes.js";

export { checkShard, dependencyCycle, planSections } from "./methodology/shard.js";
export type { PlanSection, ShardEpic, ShardExemption } from "./methodology/shard.js";
