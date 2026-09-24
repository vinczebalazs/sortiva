/**
 * Which version of the writing prompt the generation cycle asks with.
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
export const DRAFT_PROMPT_MAJOR_VERSION = 2

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
