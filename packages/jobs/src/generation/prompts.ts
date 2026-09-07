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
