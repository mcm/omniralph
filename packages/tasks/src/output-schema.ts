/**
 * Static checks of a query task's output schema against the output a sink
 * accepts, both JSON schemas. The check is about shape: every output the
 * task's schema allows must have the types, required properties, enum values
 * and items the sink's schema asks for. Value constraints (lengths, patterns,
 * ranges, formats) aren't compared: the sink still validates each result.
 */
import { z } from "zod";

export type JsonSchema = Readonly<Record<string, unknown>> | boolean;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

/** The values a schema allows when it lists them (`const` or `enum`), else undefined. */
function allowedValues(schema: Readonly<Record<string, unknown>>): unknown[] | undefined {
  if ("const" in schema) return [schema.const];
  return Array.isArray(schema.enum) ? schema.enum : undefined;
}

/** The JSON types a schema allows, or undefined for any. */
function types(schema: Readonly<Record<string, unknown>>): string[] | undefined {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t) => typeof t === "string");
  const values = allowedValues(schema);
  return values && [...new Set(values.map(typeOf))];
}

function typeAccepted(type: string, accepted: readonly string[]): boolean {
  return accepted.includes(type) || (type === "integer" && accepted.includes("number"));
}

function union(schema: Readonly<Record<string, unknown>>): readonly JsonSchema[] | undefined {
  const branches = schema.anyOf ?? schema.oneOf;
  return Array.isArray(branches) ? (branches as JsonSchema[]) : undefined;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function at(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`;
}

function where(path: string): string {
  return path === "" ? "the output" : `\`${path}\``;
}

/**
 * Why an output matching `given` may not match `accepted` (the first reason
 * found), or null when every output `given` allows has the shape `accepted`
 * asks for. `path` names the place in the output, for the message.
 */
export function outputSchemaProblem(
  given: JsonSchema,
  accepted: JsonSchema,
  path = "",
): string | null {
  if (accepted === true || (isRecord(accepted) && Object.keys(accepted).length === 0)) return null;
  if (given === false) return null;
  if (accepted === false) return `${where(path)} isn't accepted at all.`;
  if (given === true) return `${where(path)} may be anything.`;

  // A union is fine when each of its branches is.
  const givenBranches = union(given);
  if (givenBranches) {
    for (const branch of givenBranches) {
      if (branch === false) continue;
      const problem = outputSchemaProblem(
        { ...without(given, "anyOf", "oneOf"), ...asRecord(branch) },
        accepted,
        path,
      );
      if (problem) return problem;
    }
    return null;
  }
  // Several types are fine when each of them is.
  const givenTypes = types(given);
  if (givenTypes && givenTypes.length > 1 && allowedValues(given) === undefined) {
    for (const type of givenTypes) {
      const problem = outputSchemaProblem({ ...given, type }, accepted, path);
      if (problem) return problem;
    }
    return null;
  }
  const acceptedBranches = union(accepted);
  if (acceptedBranches) {
    const rest = without(accepted, "anyOf", "oneOf");
    const problems = acceptedBranches
      .filter((branch) => branch !== false)
      .map((branch) => outputSchemaProblem(given, { ...rest, ...asRecord(branch) }, path));
    if (problems.some((problem) => problem === null)) return null;
    return problems[0] ?? `${where(path)} isn't accepted at all.`;
  }

  const acceptedTypes = types(accepted);
  if (acceptedTypes) {
    if (!givenTypes)
      return `${where(path)} may be any type; it must be ${acceptedTypes.join(" or ")}.`;
    const wrong = givenTypes.filter((type) => !typeAccepted(type, acceptedTypes));
    if (wrong.length > 0) {
      return `${where(path)} may be ${wrong.join(" or ")}; it must be ${acceptedTypes.join(" or ")}.`;
    }
  }
  const acceptedValues = allowedValues(accepted);
  if (acceptedValues) {
    const givenValues = allowedValues(given);
    if (!givenValues) return `${where(path)} must be one of ${JSON.stringify(acceptedValues)}.`;
    const extra = givenValues.filter((v) => !acceptedValues.some((a) => sameValue(a, v)));
    if (extra.length > 0) {
      return `${where(path)} may be ${JSON.stringify(extra)}; it must be one of ${JSON.stringify(acceptedValues)}.`;
    }
  }

  const type = givenTypes?.[0];
  if (type === "object") return objectProblem(given, accepted, path);
  if (type === "array" && "items" in accepted) {
    return outputSchemaProblem(asSchema(given.items), asSchema(accepted.items), at(path, "*"));
  }
  return null;
}

function objectProblem(
  given: Readonly<Record<string, unknown>>,
  accepted: Readonly<Record<string, unknown>>,
  path: string,
): string | null {
  const givenProperties = isRecord(given.properties) ? given.properties : {};
  const acceptedProperties = isRecord(accepted.properties) ? accepted.properties : {};
  const givenRequired = strings(given.required);
  const closed = given.additionalProperties === false;
  // What a property the given schema doesn't list may hold.
  const additional: JsonSchema = closed ? false : asSchema(given.additionalProperties);

  for (const name of strings(accepted.required)) {
    if (!givenRequired.includes(name)) return `${where(at(path, name))} must be required.`;
  }
  for (const [name, schema] of Object.entries(acceptedProperties)) {
    const property = Object.hasOwn(givenProperties, name)
      ? asSchema(givenProperties[name])
      : additional;
    const problem = outputSchemaProblem(property, asSchema(schema), at(path, name));
    if (problem) return problem;
  }
  const acceptedAdditional = accepted.additionalProperties;
  if (acceptedAdditional === undefined || acceptedAdditional === true) return null;
  for (const [name, schema] of Object.entries(givenProperties)) {
    if (Object.hasOwn(acceptedProperties, name)) continue;
    const problem = outputSchemaProblem(
      asSchema(schema),
      asSchema(acceptedAdditional),
      at(path, name),
    );
    if (problem) return problem;
  }
  if (!closed) {
    const problem = outputSchemaProblem(additional, asSchema(acceptedAdditional), at(path, "*"));
    if (problem) return `${problem} (set additionalProperties to false)`;
  }
  return null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/** A schema value as a schema: absent (or malformed) allows anything. */
function asSchema(value: unknown): JsonSchema {
  return typeof value === "boolean" || isRecord(value) ? value : true;
}

/** A union branch as an object to merge into its parent (`false` ones are filtered out first). */
function asRecord(schema: JsonSchema): Readonly<Record<string, unknown>> {
  return typeof schema === "boolean" ? {} : schema;
}

function without(
  schema: Readonly<Record<string, unknown>>,
  ...keys: string[]
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));
}

/**
 * Why `schema` can't be a query task's output schema, or null when it can: a
 * structured output is a JSON object, and the agent checks each result
 * against the schema (`z.fromJSONSchema`), so it must convert.
 */
export function invalidOutputSchema(schema: Readonly<Record<string, unknown>>): string | null {
  if (schema.type !== "object") return 'The output must be an object: set "type": "object".';
  try {
    z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    return `This isn't a JSON schema the agent can check output against: ${error instanceof Error ? error.message : String(error)}.`;
  }
  return null;
}
