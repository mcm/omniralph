"use client";

import * as React from "react";
import {
  QueryBuilder,
  Rule,
  RuleGroup,
  type ActionProps,
  type CombinatorSelectorProps,
  type ControlElementsProp,
  type Field,
  type FieldSelectorProps,
  type FullField,
  type NotToggleProps,
  type OperatorSelectorProps,
  type RuleGroupProps,
  type RuleGroupType,
  type RuleProps,
  type RuleType,
  type ValueEditorProps,
} from "react-querybuilder";
import { Button, Input, NativeSelect, Toggle } from "@iamthemcmaster/ui";
import { IconFolderPlus, IconPlus, IconX } from "@tabler/icons-react";
import { MAX_ROUTING_DEPTH } from "@omniralph/shared";
import { MultiSelect, NOT_AVAILABLE, StaleNote, TagInput } from "@/components/pickers";
import {
  coerceValue,
  defaultValue,
  findOption,
  normalizeQuery,
  valueKindOf,
  valueOptions,
  type RoutingFieldData,
  type RoutingLinear,
} from "./rule-editor";

/**
 * A rule's condition: react-querybuilder with every control drawn by `@iamthemcmaster/ui`
 * (and the panel's pickers), fields and operators from the tracker's catalog, value pickers
 * fed by the connected workspace's values.
 */

/** What the controls read beyond react-querybuilder's own props. */
interface BuilderContext {
  fields: ReadonlyMap<string, RoutingFieldData>;
  linear: RoutingLinear;
  /** Errors by condition or group path (`"1.0"`; `""` for the rule's own group). */
  errors: ReadonlyMap<string, string>;
}

const STALE_MESSAGE =
  "It isn't in your Linear workspace any more (renamed or deleted). It's kept, and still saves.";

function useBuilder(context: unknown): BuilderContext {
  return context as BuilderContext;
}

function pathKey(path: readonly number[]): string {
  return path.join(".");
}

function NodeError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="routing-node-error">
      {message}
    </p>
  );
}

// ── Selectors ─────────────────────────────────────────────────────────────────

/** Fields grouped by the issue they're read from: this one, its parent, its source. */
function fieldGroups(fields: ReadonlyMap<string, RoutingFieldData>) {
  const groups = new Map<string, RoutingFieldData[]>();
  for (const field of fields.values()) {
    const prefix = field.id.includes(".") ? field.id.split(".")[0]! : "";
    const group = groups.get(prefix) ?? [];
    group.push(field);
    groups.set(prefix, group);
  }
  const label: Record<string, string> = { "": "This issue", parent: "Parent", source: "Source" };
  return [...groups].map(([prefix, list]) => ({ label: label[prefix] ?? prefix, fields: list }));
}

function FieldSelector({ value, handleOnChange, disabled, context }: FieldSelectorProps) {
  const { fields } = useBuilder(context);
  const known = value !== undefined && fields.has(value);
  return (
    <NativeSelect
      aria-label="Field"
      className="routing-field"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => handleOnChange(e.target.value)}
    >
      {!known && (
        <option value={value ?? ""}>{value ? `${value} (unknown)` : "Pick a field"}</option>
      )}
      {fieldGroups(fields).map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.fields.map((field) => (
            <option key={field.id} value={field.id}>
              {field.label}
            </option>
          ))}
        </optgroup>
      ))}
    </NativeSelect>
  );
}

function OperatorSelector({
  field,
  value,
  handleOnChange,
  disabled,
  context,
}: OperatorSelectorProps) {
  const operators = useBuilder(context).fields.get(field)?.operators ?? [];
  return (
    <NativeSelect
      aria-label="Operator"
      className="routing-operator"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => handleOnChange(e.target.value)}
    >
      {!operators.some((o) => o.name === value) && (
        <option value={value ?? ""}>Pick an operator</option>
      )}
      {operators.map((operator) => (
        <option key={operator.name} value={operator.name}>
          {operator.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function CombinatorSelector({ value, handleOnChange, disabled }: CombinatorSelectorProps) {
  return (
    <NativeSelect
      aria-label="Match"
      className="routing-combinator"
      value={value ?? "and"}
      disabled={disabled}
      onChange={(e) => handleOnChange(e.target.value)}
    >
      <option value="and">All of (AND)</option>
      <option value="or">Any of (OR)</option>
    </NativeSelect>
  );
}

function NotToggle({ checked, handleOnChange, disabled }: NotToggleProps) {
  return (
    <Toggle
      variant="outline"
      size="sm"
      aria-label="NOT"
      title="Matches when the group doesn't"
      pressed={checked === true}
      disabled={disabled}
      onPressedChange={handleOnChange}
    >
      NOT
    </Toggle>
  );
}

// ── Actions ───────────────────────────────────────────────────────────────────

function AddRuleAction({ handleOnClick, disabled }: ActionProps) {
  if (disabled) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="routing-add-condition"
      onClick={(e) => handleOnClick(e)}
    >
      <IconPlus size={14} />
      Condition
    </Button>
  );
}

function AddGroupAction({ handleOnClick, disabled, level }: ActionProps) {
  // The rule's own group is level 0, and groups nest at most MAX_ROUTING_DEPTH deep.
  if (disabled || level >= MAX_ROUTING_DEPTH - 1) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="routing-add-group"
      onClick={(e) => handleOnClick(e)}
    >
      <IconFolderPlus size={14} />
      Group
    </Button>
  );
}

function RemoveAction({ handleOnClick, disabled, ruleOrGroup }: ActionProps) {
  if (disabled) return null;
  const label = "rules" in ruleOrGroup ? "Remove group" : "Remove condition";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={(e) => handleOnClick(e)}
    >
      <IconX size={14} />
    </Button>
  );
}

// ── Values ────────────────────────────────────────────────────────────────────

function TextValue({
  value,
  onChange,
  disabled,
  mono,
  type = "text",
  label = "Value",
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  mono?: boolean;
  type?: "text" | "date" | "number";
  label?: string;
}) {
  return (
    <Input
      aria-label={label}
      type={type}
      className={mono ? "routing-value settings-mono" : "routing-value"}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

const numberText = (value: unknown) => (typeof value === "number" ? String(value) : "");
const parseNumber = (text: string) => (text.trim() === "" ? null : Number(text));

function OneOfValue({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const match = value ? findOption(options, value) : undefined;
  const stale = value !== "" && !match;
  return (
    <div className="routing-value">
      <NativeSelect
        aria-label="Value"
        value={match?.value ?? value}
        disabled={disabled}
        error={stale}
        onChange={(e) => onChange(e.target.value)}
      >
        {value === "" && <option value="">Pick a value</option>}
        {stale && <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </NativeSelect>
      {stale && (
        <StaleNote>
          “{value}” is {NOT_AVAILABLE}. {STALE_MESSAGE}
        </StaleNote>
      )}
    </div>
  );
}

function ValueEditor({
  field,
  operator,
  value,
  handleOnChange,
  disabled,
  context,
}: ValueEditorProps) {
  const { fields, linear } = useBuilder(context);
  const fieldData = fields.get(field);
  const kind = valueKindOf(fieldData, operator);
  const options = valueOptions(fieldData, linear);
  const current = coerceValue(kind, value);
  switch (kind) {
    case null:
    case "none":
      return null;
    case "text":
    case "regex":
      return (
        <TextValue
          value={current as string}
          onChange={handleOnChange}
          disabled={disabled}
          mono={kind === "regex"}
        />
      );
    case "date":
      return (
        <TextValue
          type="date"
          value={current as string}
          onChange={handleOnChange}
          disabled={disabled}
        />
      );
    case "number":
      return (
        <TextValue
          type="number"
          value={numberText(current)}
          onChange={(text) => handleOnChange(parseNumber(text))}
          disabled={disabled}
        />
      );
    case "number-range":
    case "date-range": {
      const [from, to] = current as [unknown, unknown];
      const type = kind === "date-range" ? "date" : "number";
      const text = (v: unknown) => (type === "date" ? String(v ?? "") : numberText(v));
      const parse = (t: string) => (type === "date" ? t : parseNumber(t));
      return (
        <span className="routing-range">
          <TextValue
            type={type}
            label="From"
            value={text(from)}
            onChange={(t) => handleOnChange([parse(t), to])}
            disabled={disabled}
          />
          <span className="routing-range-and">and</span>
          <TextValue
            type={type}
            label="To"
            value={text(to)}
            onChange={(t) => handleOnChange([from, parse(t)])}
            disabled={disabled}
          />
        </span>
      );
    }
    case "option":
      return options ? (
        <OneOfValue
          value={current as string}
          options={options}
          onChange={handleOnChange}
          disabled={disabled}
        />
      ) : (
        <TextValue value={current as string} onChange={handleOnChange} disabled={disabled} />
      );
    case "options": {
      const values = current as string[];
      return options ? (
        <MultiSelect
          aria-label="Values"
          className="routing-value"
          // Names match ignoring case: a saved "backend" is the workspace's "Backend".
          value={values.map((v) => findOption(options, v)?.value ?? v)}
          options={options}
          onChange={handleOnChange}
          disabled={disabled}
          placeholder="Pick values"
          staleMessage={STALE_MESSAGE}
        />
      ) : (
        <TagInput
          aria-label="Values"
          className="routing-value"
          value={values}
          options={[]}
          allowCustom
          onChange={handleOnChange}
          disabled={disabled}
          placeholder="Type a value, then Enter"
        />
      );
    }
  }
}

// ── Rules and groups ──────────────────────────────────────────────────────────

/** A condition, with its error under it. */
function RuleWithError(props: RuleProps) {
  const { errors } = useBuilder(props.context);
  return (
    <>
      <Rule {...props} />
      <NodeError message={errors.get(pathKey(props.path))} />
    </>
  );
}

/** A group (the rule's own, or nested), with its error under it. */
function GroupWithError(props: RuleGroupProps) {
  const { errors } = useBuilder(props.context);
  return (
    <>
      <RuleGroup {...props} />
      <NodeError message={errors.get(pathKey(props.path))} />
    </>
  );
}

const controlElements: ControlElementsProp<FullField, string> = {
  fieldSelector: FieldSelector,
  operatorSelector: OperatorSelector,
  combinatorSelector: CombinatorSelector,
  notToggle: NotToggle,
  valueEditor: ValueEditor,
  addRuleAction: AddRuleAction,
  addGroupAction: AddGroupAction,
  removeRuleAction: RemoveAction,
  removeGroupAction: RemoveAction,
  rule: RuleWithError,
  ruleGroup: GroupWithError,
};

export interface RoutingQueryBuilderProps {
  query: RuleGroupType;
  onChange: (query: RuleGroupType) => void;
  fields: ReadonlyMap<string, RoutingFieldData>;
  linear: RoutingLinear;
  errors: ReadonlyMap<string, string>;
  disabled?: boolean;
}

/** One rule's condition builder. */
export function RoutingQueryBuilder({
  query,
  onChange,
  fields,
  linear,
  errors,
  disabled = false,
}: RoutingQueryBuilderProps) {
  const builderFields = React.useMemo<Field[]>(
    () =>
      [...fields.values()].map((field) => ({
        name: field.id,
        label: field.label,
        operators: field.operators.map((o) => ({ name: o.name, label: o.label })),
      })),
    [fields],
  );
  const context = React.useMemo<BuilderContext>(
    () => ({ fields, linear, errors }),
    [fields, linear, errors],
  );
  const getDefaultOperator = React.useCallback(
    (field: string) => fields.get(field)?.operators[0]?.name ?? "=",
    [fields],
  );
  const getDefaultValue = React.useCallback(
    (rule: RuleType) => defaultValue(valueKindOf(fields.get(rule.field), rule.operator)),
    [fields],
  );
  return (
    <div className="routing-builder">
      <QueryBuilder
        fields={builderFields}
        query={query}
        onQueryChange={(next) => onChange(normalizeQuery(next, fields))}
        controlElements={controlElements}
        context={context}
        disabled={disabled}
        showNotToggle
        listsAsArrays
        enableMountQueryChange={false}
        getDefaultOperator={getDefaultOperator}
        getDefaultValue={getDefaultValue}
      />
    </div>
  );
}
