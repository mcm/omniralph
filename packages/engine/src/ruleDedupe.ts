import { distance } from "fastest-levenshtein";
import { RULE_DUPLICATE_SIMILARITY } from "@omniralph/shared";

/** Lower-cased, punctuation stripped, whitespace collapsed: what rule dedupe compares. */
export function normalizeRuleText(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein similarity (0–1) of the two rules' normalized texts. */
export function ruleSimilarity(a: string, b: string): number {
  const x = normalizeRuleText(a);
  const y = normalizeRuleText(b);
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 1;
  return 1 - distance(x, y) / longest;
}

/**
 * The first existing rule `text` nearly duplicates (normalized similarity
 * ≥ `threshold`), or undefined when it's new.
 */
export function findDuplicateRule<T extends { text: string }>(
  text: string,
  existing: readonly T[],
  threshold = RULE_DUPLICATE_SIMILARITY,
): T | undefined {
  return existing.find((rule) => ruleSimilarity(text, rule.text) >= threshold);
}
