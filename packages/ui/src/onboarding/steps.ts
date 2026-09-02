import type { StringKey } from '../strings'

/**
 * The setup progress bar, and the arithmetic that turns what the server reports
 * into what the merchant sees.
 *
 * The server tracks nine steps because that is how the work is actually
 * divided — reading a catalogue, distilling each product into facts, and
 * grouping those products into families are three separate jobs that fail,
 * retry and resume independently. A merchant has no use for that distinction:
 * all three are "reading your store", and a bar that ticked past nine
 * indistinguishable technical names would tell them less, not more.
 *
 * So seven rows are shown, three of the nine collapse into one of them, and
 * everything about how a group of steps becomes one row is decided here rather
 * than inside a component.
 */

/** The steps the server reports, as the ingestion status response spells them. */
export type JobStepName =
  | 'detect'
  | 'oauth_wait'
  | 'catalog_sync'
  | 'distill'
  | 'family_group'
  | 'persona'
  | 'keywords_competitors'
  | 'gsc_connect'
  | 'awaiting_confirmation'

export type JobStepState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'skipped'

export interface JobStep {
  readonly step: JobStepName
  readonly state: JobStepState
  readonly startedAt: string | null
  readonly updatedAt: string
  readonly attempts: number
}

export interface IngestionStatus {
  readonly jobId: string
  readonly status: 'running' | 'succeeded' | 'failed' | 'abandoned'
  readonly steps: readonly JobStep[]
  readonly startedAt: string
}

export type OnboardingStepId =
  | 'detect'
  | 'connect_store'
  | 'read_store'
  | 'business_profile'
  | 'keywords_competitors'
  | 'search_console'
  | 'review'

export interface OnboardingStepDefinition {
  readonly id: OnboardingStepId
  readonly labelKey: StringKey
  /** The server-side steps this row stands for. */
  readonly jobSteps: readonly JobStepName[]
  /**
   * Search Console is the one step a merchant may decline. It is marked so the
   * row can say so before they reach it, rather than only afterwards.
   */
  readonly skippable: boolean
}

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  { id: 'detect', labelKey: 'onboarding.step.detect', jobSteps: ['detect'], skippable: false },
  { id: 'connect_store', labelKey: 'onboarding.step.connectStore', jobSteps: ['oauth_wait'], skippable: false },
  {
    id: 'read_store',
    labelKey: 'onboarding.step.readStore',
    // Fetching the catalogue, reducing each product to a fact sheet and
    // grouping those products into families are one thing to the merchant and
    // three resumable jobs to us.
    jobSteps: ['catalog_sync', 'distill', 'family_group'],
    skippable: false,
  },
  { id: 'business_profile', labelKey: 'onboarding.step.businessProfile', jobSteps: ['persona'], skippable: false },
  {
    id: 'keywords_competitors',
    labelKey: 'onboarding.step.keywordsCompetitors',
    jobSteps: ['keywords_competitors'],
    skippable: false,
  },
  { id: 'search_console', labelKey: 'onboarding.step.searchConsole', jobSteps: ['gsc_connect'], skippable: true },
  { id: 'review', labelKey: 'onboarding.step.review', jobSteps: ['awaiting_confirmation'], skippable: false },
]

/** What one row shows. `skipped` is Search Console's alone. */
export type OnboardingStepState = 'pending' | 'active' | 'done' | 'skipped' | 'failed'

export interface ResolvedOnboardingStep extends OnboardingStepDefinition {
  readonly state: OnboardingStepState
  /**
   * How long the row has been working, in milliseconds. Present only on an
   * active row that has actually started, so a row waiting to begin shows no
   * clock.
   */
  readonly elapsedMs: number | null
  /**
   * True once the row has been working long enough that silence would read as
   * a hang. A big catalogue genuinely takes minutes, so the wait is explained
   * rather than hidden.
   */
  readonly stillWorking: boolean
  /** Set on a failed row: whether anything will retry it, or a human has to. */
  readonly retrying: boolean
  readonly attempts: number
}

/**
 * How long an active row works before it starts saying so. A merchant watching
 * an unchanged spinner assumes it is broken well before a large catalogue has
 * finished being read.
 */
export const STILL_WORKING_AFTER_MS = 60_000

/**
 * A step nobody reported yet. The server sends only the steps a run has
 * reached, so anything further down the list has not started.
 */
const NOT_STARTED: JobStepState = 'pending'

function stateOf(steps: readonly JobStep[], name: JobStepName): JobStepState {
  return steps.find((step) => step.step === name)?.state ?? NOT_STARTED
}

/**
 * One row's state from the states of the steps behind it.
 *
 * The order of these tests is the point. A failure outranks everything, so a
 * row whose second job died does not read as still working. Anything running
 * outranks a partial success, so a row two thirds finished reads as active
 * rather than done. And a row is only finished when nothing in it is left.
 */
function groupState(states: readonly JobStepState[]): OnboardingStepState {
  if (states.some((state) => state === 'failed_terminal' || state === 'failed_retryable')) {
    return 'failed'
  }
  if (states.some((state) => state === 'running')) return 'active'
  if (states.every((state) => state === 'skipped')) return 'skipped'
  if (states.every((state) => state === 'succeeded' || state === 'skipped')) return 'done'
  // Something in the group has finished but the group has not: the work is
  // between two of its jobs, which is still work in flight.
  if (states.some((state) => state === 'succeeded')) return 'active'
  return 'pending'
}

export interface StepperOptions {
  /** Milliseconds since the epoch, for the elapsed readout. */
  readonly now?: number
}

/** The seven rows, in order, with everything a component needs to draw them. */
export function resolveStepper(
  status: IngestionStatus | null,
  options: StepperOptions = {},
): readonly ResolvedOnboardingStep[] {
  const steps = status?.steps ?? []
  const now = options.now ?? Date.now()

  return ONBOARDING_STEPS.map((definition) => {
    const members = definition.jobSteps.map((name) => stateOf(steps, name))
    const state = groupState(members)
    const rows = steps.filter((step) => definition.jobSteps.includes(step.step))

    const startedAt = rows
      .map((row) => (row.startedAt === null ? null : Date.parse(row.startedAt)))
      .filter((value): value is number => value !== null && Number.isFinite(value))
      .sort((a, b) => a - b)[0]

    const elapsedMs = state === 'active' && startedAt !== undefined ? Math.max(0, now - startedAt) : null

    return {
      ...definition,
      state,
      elapsedMs,
      stillWorking: elapsedMs !== null && elapsedMs >= STILL_WORKING_AFTER_MS,
      // A step that has exhausted its retries is a dead end the merchant needs
      // a person for; one still retrying is genuinely nothing for them to do.
      retrying: rows.some((row) => row.state === 'failed_retryable'),
      attempts: rows.reduce((most, row) => Math.max(most, row.attempts), 0),
    }
  })
}

/** `2m 40s` — the readout beside a row that has been working a while. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

/** Whether the whole run has finished with nothing left to wait for. */
export function stepperComplete(steps: readonly ResolvedOnboardingStep[]): boolean {
  return steps.every((step) => step.state === 'done' || step.state === 'skipped')
}
