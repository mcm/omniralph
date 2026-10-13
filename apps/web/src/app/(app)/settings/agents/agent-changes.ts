/**
 * The agent form's draft (what its inputs hold) and its unsaved changes: the
 * "old → new" list an edit confirms. Pure, so the change list can be tested.
 */
import type {
  AgentDefinition,
  HarnessTool,
  LinearTool,
  NamedContent,
  SystemPromptMode,
  TaskType,
} from "@omniralph/tasks";
import {
  formatLongText,
  formatSettingValue,
  settingChanges,
  textSize,
  type SettingChange,
  type SettingSpec,
  type SettingValue,
} from "@/lib/settings/changes";
import { splitNames } from "./form-parts";

/** Everything the agent form edits, as typed. */
export interface AgentDraft {
  name: string;
  description: string;
  taskTypes: TaskType[];
  model: string;
  fallbackModel: string;
  systemPromptMode: SystemPromptMode;
  systemPrompt: string;
  builtinTools: string;
  harnessTools: HarnessTool[];
  linearTools: LinearTool[];
  mcpServers: string;
  skills: NamedContent[];
  referenceDocs: NamedContent[];
}

/** The draft of `agent`, or of a new agent when null. */
export function agentDraft(agent: Omit<AgentDefinition, "id"> | null): AgentDraft {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    taskTypes: agent?.taskTypes ?? [],
    model: agent?.model ?? "",
    fallbackModel: agent?.fallbackModel ?? "",
    systemPromptMode: agent?.systemPromptMode ?? "append",
    systemPrompt: agent?.systemPrompt ?? "",
    builtinTools: agent?.tools.builtin.join(", ") ?? "",
    harnessTools: agent?.tools.harness ?? [],
    linearTools: agent?.tools.linear ?? [],
    mcpServers: agent?.tools.mcpServers.join(", ") ?? "",
    skills: agent?.skills ?? [],
    referenceDocs: agent?.referenceDocs ?? [],
  };
}

/** How the system prompt mode reads in the form. */
export const SYSTEM_PROMPT_MODE_LABELS: Record<SystemPromptMode, string> = {
  append: "Append to the Claude Code system prompt",
  replace: "Replace the Claude Code system prompt",
};

/** Documents compare by name and content; the separator can't be typed into a name. */
const DOCUMENT_SEPARATOR = "\u0000";

const documentKey = (doc: NamedContent) => `${doc.name.trim()}${DOCUMENT_SEPARATOR}${doc.content}`;

/** Documents as the change list shows them: one per line, with its size. */
const formatDocuments = (value: SettingValue): string => {
  if (!Array.isArray(value) || value.length === 0) return formatSettingValue(value);
  return value
    .map((key: string) => {
      const [name, content = ""] = key.split(DOCUMENT_SEPARATOR);
      return `${name || "Unnamed"} (${textSize(content)})`;
    })
    .join("\n");
};

/** The values the agent form saves, compared to find its changes. */
export function agentValues(draft: AgentDraft): Record<string, SettingValue> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    taskTypes: draft.taskTypes,
    model: draft.model.trim(),
    fallbackModel: draft.fallbackModel.trim(),
    systemPromptMode: draft.systemPromptMode,
    systemPrompt: draft.systemPrompt,
    builtinTools: splitNames(draft.builtinTools),
    harnessTools: draft.harnessTools,
    linearTools: draft.linearTools,
    mcpServers: splitNames(draft.mcpServers),
    skills: draft.skills.map(documentKey),
    referenceDocs: draft.referenceDocs.map(documentKey),
  };
}

/** The agent form's settings in form order, with their labels and how they're shown. */
export const AGENT_SPECS: readonly SettingSpec[] = [
  { key: "name", label: "Name" },
  { key: "description", label: "Description", format: formatLongText },
  { key: "taskTypes", label: "Suited task types" },
  { key: "model", label: "Model" },
  { key: "fallbackModel", label: "Fallback model" },
  {
    key: "systemPromptMode",
    label: "System prompt mode",
    format: (value) => SYSTEM_PROMPT_MODE_LABELS[value as SystemPromptMode] ?? String(value),
  },
  { key: "systemPrompt", label: "System prompt", format: formatLongText },
  { key: "builtinTools", label: "Claude Code tools" },
  { key: "harnessTools", label: "Harness tools" },
  { key: "linearTools", label: "Linear tools" },
  { key: "mcpServers", label: "MCP servers" },
  { key: "skills", label: "Skills", format: formatDocuments },
  { key: "referenceDocs", label: "Reference docs", format: formatDocuments },
];

/** What saving `draft` over `saved` changes, in form order. */
export function agentChanges(saved: AgentDraft, draft: AgentDraft): SettingChange[] {
  return settingChanges(AGENT_SPECS, agentValues(saved), agentValues(draft));
}
