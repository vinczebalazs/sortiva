/**
 * Which version of the writing prompt the generation cycle asks with.
 *
 * v3 closes the gap the article grader kept finding: a sentence saying what a
 * product *is* — "built on a wider last", "double-walled" — needed no citation
 * under v2, because it carries no figure, superlative, absolute, attribution
 * or comparison, and those were the five kinds the rule listed. It is now the
 * sixth, along with the reminder that a product called Wide is named that and
 * not shaped that. The same version draws the other half of the line, in the
 * same words the grader uses: explaining how a kind of thing works is not a
 * claim about a product and needs no claim behind it. Founder decision,
 * 2026-09-24.
 *
 * Named in one place rather than written into each `loadPrompt` call, so that
 * a test can hold the very prompt the product uses against the answer schema
 * it will be validated by — and so a version bump cannot leave the chaos suite
 * or a pipeline test exercising the prompt nobody ships any more.
 *
 * Prompt files are never edited in place: a change is a new `draft.v<N>.md`
 * and this number moving, which is what keeps the `prompt_version` stamped on
 * an article written last month meaning what it said at the time.
 */
export const DRAFT_PROMPT_MAJOR_VERSION = 3

/**
 * Which version of the grading prompt the generation cycle asks with, named
 * here for the same reason and used by the same callers.
 *
 * v2 differed from v1 in one respect: it requires the grader's written
 * objections to be in English whatever language the article is in. Those
 * sentences are shown to the merchant inside our own English screens, so one
 * arriving in the store's language would produce a card that changes language
 * halfway through. Founder decision, 2026-09-04.
 *
 * v3 says where the grounding line sits. Grounding asks whether what an
 * article says about a *product* traces to the facts the store holds about it;
 * a general statement about a category — that glass breaks and steel dents —
 * is not a claim about a product and is not marked down. Until this was
 * written down the grader was rejecting every article it saw, good ones
 * included, for explaining how things work. It is not a lower bar: inventing a
 * specification is scored exactly as it was. Founder decision, 2026-09-24.
 */
export const JUDGE_PROMPT_MAJOR_VERSION = 3
