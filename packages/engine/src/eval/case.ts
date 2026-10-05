import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { FindingCategory, FindingSeverity, FINDING_SEVERITIES } from "@omniralph/shared";
import { z } from "zod";

/** A finding the review must report (head-side lines). */
export const ExpectedFinding = z.object({
  path: z.string().min(1),
  startLine: z.int().min(1),
  endLine: z.int().min(1),
  category: FindingCategory,
  /** The finding's severity must be at least this. */
  minSeverity: FindingSeverity,
});
export type ExpectedFinding = z.infer<typeof ExpectedFinding>;

/** Code the review must not flag; without lines the whole file is off limits. */
export const MustNotFlag = z.object({
  path: z.string().min(1),
  startLine: z.int().min(1).optional(),
  endLine: z.int().min(1).optional(),
  note: z.string().min(1),
});
export type MustNotFlag = z.infer<typeof MustNotFlag>;

/** `evals/cases/<id>/case.json`. */
export const CaseDefinition = z.strictObject({
  description: z.string().min(1),
  language: z.string().min(1),
  tags: z.array(z.string().min(1)),
  /** The PR/MR text shown to the reviewer; it must not give the answer away. */
  pr: z.strictObject({
    title: z.string().min(1),
    description: z.string().optional(),
  }),
  /** Empty for clean cases. */
  expected: z.array(ExpectedFinding),
  mustNotFlag: z.array(MustNotFlag).optional(),
});
export type CaseDefinition = z.infer<typeof CaseDefinition>;

export interface EvalCase extends CaseDefinition {
  /** The case's directory name. */
  id: string;
  /** Absolute path of the case directory (holds `base/` and `change.patch`). */
  dir: string;
}

export const isCleanCase = (evalCase: Pick<EvalCase, "expected">): boolean =>
  evalCase.expected.length === 0;

/** critical = 4 … info = 0. */
export function severityRank(severity: FindingSeverity): number {
  return FINDING_SEVERITIES.length - 1 - FINDING_SEVERITIES.indexOf(severity);
}

export class EvalCaseError extends Error {
  override name = "EvalCaseError";
}

/** Reads and validates one case directory. */
export async function loadCase(dir: string, id: string): Promise<EvalCase> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(dir, "case.json"), "utf8"));
  } catch (error) {
    throw new EvalCaseError(`${id}: cannot read case.json: ${(error as Error).message}`);
  }
  const parsed = CaseDefinition.safeParse(raw);
  if (!parsed.success) {
    throw new EvalCaseError(`${id}: invalid case.json: ${z.prettifyError(parsed.error)}`);
  }
  for (const item of [...parsed.data.expected, ...(parsed.data.mustNotFlag ?? [])]) {
    if (
      item.startLine !== undefined &&
      item.endLine !== undefined &&
      item.endLine < item.startLine
    ) {
      throw new EvalCaseError(`${id}: ${item.path}: endLine is before startLine`);
    }
  }
  for (const required of ["base", "change.patch"]) {
    const exists = await stat(join(dir, required)).then(
      () => true,
      () => false,
    );
    if (!exists) throw new EvalCaseError(`${id}: missing ${required}`);
  }
  return { ...parsed.data, id, dir };
}

/** Every case under `casesDir`, sorted by ID; `only` keeps the given IDs (all must exist). */
export async function loadCases(casesDir: string, only?: readonly string[]): Promise<EvalCase[]> {
  const entries = await readdir(casesDir, { withFileTypes: true });
  const ids = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (only && only.length > 0) {
    const missing = only.filter((id) => !ids.includes(id));
    if (missing.length > 0) throw new EvalCaseError(`Unknown case: ${missing.join(", ")}`);
  }
  const selected = only && only.length > 0 ? ids.filter((id) => only.includes(id)) : ids;
  return Promise.all(selected.map((id) => loadCase(join(casesDir, id), id)));
}
