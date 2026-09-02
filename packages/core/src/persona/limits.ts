/**
 * What one persona call may cost, in one file so the numbers that decide the
 * price of describing a store are readable together.
 *
 * Unlike distillation this is a single call per store rather than one per
 * product, so the budget is generous — but it is still a budget. A store with
 * four hundred families and a ten-thousand-word "our story" page would
 * otherwise cost many times what an ordinary one does, for an answer that is no
 * better: the shape of a catalogue is visible in its largest few dozen
 * families, and a brand's voice is audible in the first page of its own prose.
 *
 * These deliberately do not live in `packages/rules`. That package holds the
 * thresholds that decide what we write about; nothing here decides anything a
 * merchant sees.
 */

/**
 * How many families reach the model, largest first.
 *
 * Forty is well past the four-to-six a grouped store settles at, so an ordinary
 * catalogue is described in full; the cap only bites on a store whose grouping
 * barely converged, where the tail is singletons and adds nothing.
 */
export const PERSONA_MAX_FAMILIES = 40

/** Top sellers, in rank order. The list itself is ten rows. */
export const PERSONA_MAX_TOP_SELLERS = 10

/**
 * How much of the homepage and the about page is read, each, in characters.
 * A brand's own account of itself is at the top of its about page; what follows
 * is usually a timeline and a photo caption.
 */
export const PERSONA_MAX_PAGE_CHARS = 4_000

/**
 * The output budget. Four sentences, a handful of categories and three short
 * strings is a couple of hundred tokens; this leaves room for a verbose answer
 * in a language that tokenises badly without paying for an essay.
 */
export const PERSONA_MAX_OUTPUT_TOKENS = 1_024
