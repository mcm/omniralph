/**
 * The plan critic (`builtin:critique-plan`, role `verifier`): what it is
 * given (a triage draft and its size) and what it answers (a verdict, a note
 * per rubric item and the questions the repo can't answer). The rubrics
 * themselves are in `@omniralph/planning` (`PLAN_RUBRICS`); the critic's
 * output schema is fixed, and `PlanCritiqueOutput` reads it.
 */
import { CRITIQUE_SIZES, type CritiqueSize } from "@omniralph/planning";
import { z } from "zod";

/** The sizes of draft the critic has a rubric for (`CRITIQUE_SIZES` of `@omniralph/planning`). */
export const PLAN_CRITIQUE_SIZES = CRITIQUE_SIZES;
export type PlanCritiqueSize = CritiqueSize;

export const PLAN_CRITIQUE_VERDICTS = ["pass", "fail"] as const;
export type PlanCritiqueVerdict = (typeof PLAN_CRITIQUE_VERDICTS)[number];

/** Most notes a critique may give (the longest rubric has far fewer items). */
export const MAX_PLAN_CRITIQUE_NOTES = 40;
/** Longest rubric item id a note may name. */
export const MAX_PLAN_CRITIQUE_ITEM_LENGTH = 100;
/** Longest note on one rubric item. */
export const MAX_PLAN_CRITIQUE_NOTE_LENGTH = 2_000;
/** Most open questions a critique may ask. */
export const MAX_PLAN_CRITIQUE_QUESTIONS = 20;
/** Longest open question. */
export const MAX_PLAN_CRITIQUE_QUESTION_LENGTH = 1_000;

/** Most stories of an epic draft the critic is given. */
export const MAX_PLAN_CRITIQUE_STORIES = 50;
/** Longest draft description (or story body) the critic is given. */
export const MAX_PLAN_CRITIQUE_TEXT_LENGTH = 50_000;

/** The critic's judgement of a draft on one rubric item. */
export const PlanCritiqueNote = z.object({
  /** The rubric item's `id`, as given. */
  item: z.string().trim().min(1).max(MAX_PLAN_CRITIQUE_ITEM_LENGTH),
  /** Whether the draft meets the item. */
  ok: z.boolean(),
  /** Why, and for an unmet item what the draft must change. */
  note: z.string().trim().min(1).max(MAX_PLAN_CRITIQUE_NOTE_LENGTH),
});
export type PlanCritiqueNote = z.infer<typeof PlanCritiqueNote>;

/**
 * The structured output of a plan critique (`builtin:critique-plan`'s fixed
 * output schema). A `pass` must have every note `ok` and no open questions:
 * a draft with an unmet item or an unanswered question isn't ready to build.
 */
export const PlanCritiqueOutput = z
  .object({
    verdict: z.enum(PLAN_CRITIQUE_VERDICTS),
    notes: z.array(PlanCritiqueNote).min(1).max(MAX_PLAN_CRITIQUE_NOTES),
    openQuestions: z
      .array(z.string().trim().min(1).max(MAX_PLAN_CRITIQUE_QUESTION_LENGTH))
      .max(MAX_PLAN_CRITIQUE_QUESTIONS),
  })
  .superRefine((output, ctx) => {
    if (output.verdict !== "pass") return;
    output.notes.forEach((note, index) => {
      if (!note.ok) {
        ctx.addIssue({
          code: "custom",
          path: ["notes", index, "ok"],
          message: `A passing critique can't have an unmet item (${note.item}).`,
        });
      }
    });
    if (output.openQuestions.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["openQuestions"],
        message: "A passing critique can't leave open questions.",
      });
    }
  });
export type PlanCritiqueOutput = z.infer<typeof PlanCritiqueOutput>;

const DraftText = z.string().max(MAX_PLAN_CRITIQUE_TEXT_LENGTH);

/** A story of an epic draft, as the critic sees it. */
export const PlanCritiqueStory = z.object({
  /** The story's 0-based position in the draft, which `dependsOn` refers to. */
  index: z.int().min(0),
  title: z.string().min(1),
  body: DraftText,
  kind: z.enum(["story", "fix"]),
  /** 0-based indexes of the stories it is blocked by. */
  dependsOn: z.array(z.int().min(0)),
  manual: z.boolean(),
});
export type PlanCritiqueStory = z.infer<typeof PlanCritiqueStory>;

/**
 * The `critique` of a plan critique's trigger context: the draft and its
 * size, with one flag per size so the prompt shows the matching rubric.
 */
export const PlanCritiqueContext = z.object({
  size: z.enum(PLAN_CRITIQUE_SIZES),
  fix: z.boolean(),
  story: z.boolean(),
  epic: z.boolean(),
  draft: z.object({
    title: z.string().min(1),
    description: DraftText,
    /** An epic's stories, as JSON-ready objects; null for a Fix or a Story. */
    stories: z.array(PlanCritiqueStory).max(MAX_PLAN_CRITIQUE_STORIES).nullable(),
  }),
});
export type PlanCritiqueContext = z.infer<typeof PlanCritiqueContext>;

/** A story of an epic draft to critique, in order. */
export interface PlanCritiqueRequestStory {
  title: string;
  body: string;
  kind: PlanCritiqueStory["kind"];
  /** 0-based indexes of the stories it is blocked by. */
  dependsOn: readonly number[];
  manual: boolean;
}

/** A draft to critique. */
export interface PlanCritiqueRequest {
  size: PlanCritiqueSize;
  title: string;
  description: string;
  /** An epic's stories in order (ignored for a Fix or a Story). */
  stories?: readonly PlanCritiqueRequestStory[];
}

/**
 * The `critique` trigger context of a draft's critique, for the run that
 * invokes the critic to add to its own (with `invoker` and `repository`).
 * Only an epic carries stories; text past the limits is cut.
 */
export function planCritiqueContext(request: PlanCritiqueRequest): PlanCritiqueContext {
  const cut = (text: string) => text.slice(0, MAX_PLAN_CRITIQUE_TEXT_LENGTH);
  return PlanCritiqueContext.parse({
    size: request.size,
    fix: request.size === "fix",
    story: request.size === "story",
    epic: request.size === "epic",
    draft: {
      title: request.title.replace(/\s+/g, " ").trim(),
      description: cut(request.description),
      stories:
        request.size === "epic"
          ? (request.stories ?? []).slice(0, MAX_PLAN_CRITIQUE_STORIES).map((story, index) => ({
              index,
              title: story.title.replace(/\s+/g, " ").trim(),
              body: cut(story.body),
              kind: story.kind,
              dependsOn: [...story.dependsOn],
              manual: story.manual,
            }))
          : null,
    },
  });
}
