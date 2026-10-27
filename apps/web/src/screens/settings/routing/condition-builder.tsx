"use client";

import { Button, IconButton, Select, TextInput, TokenInput } from "@omniralph/ui";
import { IconFolderPlus, IconPlus, IconX } from "@tabler/icons-react";
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
import { MAX_ROUTING_DEPTH } from "@omniralph/shared";
import {
  coerceValue,
  defaultValue,
  findOption,
  normalizeQuery,
  valueKindOf,
  valueOptions,
  type RoutingFieldData,
  type RoutingLinear,
  type ValueOption,
} from "./rule-editor";

/**
 * A rule's condition: react-querybuilder with every control drawn by `@omniralph/ui`. An
 * AND/OR group of conditions (field, operator per field, value), nested groups up to
 * `MAX_ROUTING_DEPTH` and NOT on any group. Values are a `TextInput`, a `Select` of a
 * field's fixed or workspace values, or a `TokenInput` for sets (labels, Design rule 18)
 * that suggests the workspace's values.
 */

/** What the controls read beyond react-querybuilder's own props. */
interface BuilderContext {
  fields: ReadonlyMap<string, RoutingFieldData>;
  linear: RoutingLinear;
  /** Errors by condition or group path (`"1.0"`; `""` for the rule's own group). */
  errors: ReadonlyMap<string, string>;
}

/** A value that isn't in the connected workspace any more: what it says under the control. */
export function staleMessage(values: readonly string[]): string {
  const names = values.map((value) => `“${value}”`).join(", ");
  return `${names} ${values.length === 1 ? "is" : "are"} not available. It isn't in your Linear workspace any more (renamed or deleted). It's kept, and still saves.`;
}

function useBuilder(context: unknown): BuilderContext {
  return context as BuilderContext;
}

function pathKey(path: readonly number[]): string {
  return path.join(".");
}

function NodeError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="or-routing-builder__error">
      {message}
    </p>
  );
}

function StaleNote({ values }: { values: readonly string[] }) {
  if (values.length === 0) return null;
  return <p className="or-routing-builder__stale">{staleMessage(values)}</p>;
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
    <span className="or-routing-builder__field">
      <Select
        aria-label="Field"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => handleOnChange(event.target.value)}
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
      </Select>
    </span>
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
    <span className="or-routing-builder__operator">
      <Select
        aria-label="Operator"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => handleOnChange(event.target.value)}
      >
        {!operators.some((operator) => operator.name === value) && (
          <option value={value ?? ""}>Pick an operator</option>
        )}
        {operators.map((operator) => (
          <option key={operator.name} value={operator.name}>
            {operator.label}
          </option>
        ))}
      </Select>
    </span>
  );
}

function CombinatorSelector({ value, handleOnChange, disabled }: CombinatorSelectorProps) {
  return (
    <span className="or-routing-builder__combinator">
      <Select
        aria-label="Match"
        value={value ?? "and"}
        disabled={disabled}
        onChange={(event) => handleOnChange(event.target.value)}
      >
        <option value="and">All of (AND)</option>
        <option value="or">Any of (OR)</option>
      </Select>
    </span>
  );
}

function NotToggle({ checked, handleOnChange, disabled }: NotToggleProps) {
  const pressed = checked === true;
  return (
    <Button
      variant={pressed ? "solid" : "outline"}
      size="sm"
      aria-pressed={pressed}
      title="Matches when the group doesn't"
      disabled={disabled}
      onClick={() => handleOnChange(!pressed)}
    >
      NOT
    </Button>
  );
}

// ── Actions ───────────────────────────────────────────────────────────────────

function AddRuleAction({ handleOnClick, disabled }: ActionProps) {
  if (disabled) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={IconPlus}
      className="or-routing-builder__add-condition"
      onClick={(event) => handleOnClick(event)}
    >
      Condition
    </Button>
  );
}

function AddGroupAction({ handleOnClick, disabled, level }: ActionProps) {
  // The rule's own group is level 0, and groups nest at most MAX_ROUTING_DEPTH deep.
  if (disabled || level >= MAX_ROUTING_DEPTH - 1) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={IconFolderPlus}
      className="or-routing-builder__add-group"
      onClick={(event) => handleOnClick(event)}
    >
      Group
    </Button>
  );
}

function RemoveAction({ handleOnClick, disabled, ruleOrGroup }: ActionProps) {
  if (disabled) return null;
  return (
    <IconButton
      size="sm"
      icon={IconX}
      label={"rules" in ruleOrGroup ? "Remove group" : "Remove condition"}
      onClick={(event: React.MouseEvent) => handleOnClick(event)}
    />
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
    <span className="or-routing-builder__value">
      <TextInput
        aria-label={label}
        type={type}
        mono={mono}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </span>
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
  options: readonly ValueOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const match = value ? findOption(options, value) : undefined;
  const stale = value !== "" && !match;
  return (
    <span className="or-routing-builder__value">
      <Select
        aria-label="Value"
        value={match?.value ?? value}
        disabled={disabled}
        invalid={stale}
        onChange={(event) => onChange(event.target.value)}
      >
        {value === "" && <option value="">Pick a value</option>}
        {stale && <option value={value}>{value}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <StaleNote values={stale ? [value] : []} />
    </span>
  );
}

function ManyOfValue({
  values,
  options,
  onChange,
  disabled,
}: {
  values: string[];
  options: readonly ValueOption[] | null;
  onChange: (values: string[]) => void;
  disabled?: boolean;
}) {
  const listId = React.useId();
  // Names match ignoring case: a typed "backend" is the workspace's "Backend".
  const canonical = (value: string) =>
    options ? (findOption(options, value)?.value ?? value) : value;
  const stale = options ? values.filter((value) => !findOption(options, value)) : [];
  return (
    <span className="or-routing-builder__value">
      <TokenInput
        aria-label="Values"
        mono={false}
        values={values}
        list={options ? listId : undefined}
        disabled={disabled}
        placeholder="Type a value, then Enter"
        onChange={(next) => onChange([...new Set(next.map(canonical))])}
      />
      {options ? (
        <datalist id={listId}>
          {options.map((option) => (
            <option key={option.value} value={option.value} label={option.label} />
          ))}
        </datalist>
      ) : null}
      <StaleNote values={stale} />
    </span>
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
        <span className="or-routing-builder__range">
          <TextValue
            type={type}
            label="From"
            value={text(from)}
            onChange={(t) => handleOnChange([parse(t), to])}
            disabled={disabled}
          />
          <span className="or-routing-builder__and">and</span>
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
    case "options":
      return (
        <ManyOfValue
          values={current as string[]}
          options={options}
          onChange={handleOnChange}
          disabled={disabled}
        />
      );
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

export interface ConditionBuilderProps {
  query: RuleGroupType;
  onChange: (query: RuleGroupType) => void;
  fields: ReadonlyMap<string, RoutingFieldData>;
  linear: RoutingLinear;
  errors: ReadonlyMap<string, string>;
  disabled?: boolean;
}

/** One rule's condition builder. */
export function ConditionBuilder({
  query,
  onChange,
  fields,
  linear,
  errors,
  disabled = false,
}: ConditionBuilderProps) {
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
    <div className="or-routing-builder">
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
