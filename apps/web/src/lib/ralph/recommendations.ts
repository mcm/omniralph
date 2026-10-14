/**
 * Recommendations: advice a story's sessions give for another project or
 * repository (e.g. an upstream fix that would let a workaround go). They are
 * kept on the story and shown in the run, never filed as issues.
 */
import type { RalphStoryRecommendation } from "@omniralph/db";
import { MAX_RALPH_RECOMMENDATIONS, type RalphRecommendation } from "@omniralph/shared";

/**
 * The story's recommendations with a result's added: one per title (case-insensitive), the latest
 * wording kept and moved last, capped to the latest `MAX_RALPH_RECOMMENDATIONS`.
 */
export function addRecommendations(
  stored: readonly RalphStoryRecommendation[],
  added: readonly RalphRecommendation[],
  now: Date,
): RalphStoryRecommendation[] {
  const byTitle = new Map(stored.map((r) => [r.title.toLowerCase(), r]));
  for (const { title, description } of added) {
    byTitle.delete(title.toLowerCase());
    byTitle.set(title.toLowerCase(), { title, description, at: now.toISOString() });
  }
  return [...byTitle.values()].slice(-MAX_RALPH_RECOMMENDATIONS);
}
