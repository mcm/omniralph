import { z } from "zod";

/**
 * Definition IDs: built-in definitions (in code) are `builtin:<name>`, with a
 * name of lowercase letters, digits and `-`; user-defined ones are UUIDs.
 */
const BUILTIN_ID = /^builtin:[a-z0-9-]+$/;

export function isBuiltinId(id: string): boolean {
  return BUILTIN_ID.test(id);
}

export const BuiltinId = z.string().regex(BUILTIN_ID, "Expected builtin:<name>");

export const DefinitionId = z.union([BuiltinId, z.uuid()]);
export type DefinitionId = z.infer<typeof DefinitionId>;
