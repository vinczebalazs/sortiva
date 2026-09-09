/**
 * What the server is allowed to tell the analytics vendor.
 *
 * The browser side already works this way: a table naming every event and every
 * property it may carry, four kinds of value none of which can hold a sentence,
 * and anything undeclared dropped at the wrapper before it reaches the wire.
 * The server side had none of it — the capture took an open bag of properties
 * and ran a credential scrubber over it, which redacts an access token and
 * passes a product description, an article draft or a prompt straight through.
 * This file is the missing half, deliberately built to the same shape so the
 * two can be read side by side.
 *
 * Two rules, both applied on every capture:
 *
 * - **A property this event does not declare is dropped.** A call site cannot
 *   attach a field. Adding one means adding a row here, which is the point: the
 *   question "can this event carry a merchant's words?" is answered by one table
 *   rather than by reading thirty call sites.
 * - **Every declared property declares its kind**, and none of the kinds can
 *   hold prose: an identifier, an enumerated name, a count, a yes/no, or a map
 *   of short names to counts. An article title, an article body and a prompt all
 *   contain spaces and run past sixty-four characters, so none of them is
 *   expressible as any kind here.
 *
 * What this cannot see is written down in the tests beside it rather than
 * implied away: the message and stack of a captured exception are not
 * properties and are not checked here — they go through the credential scrubber
 * only.
 */

import { scrubString } from '../observability/scrub'

/** Values an analytics property may hold. Deliberately not `unknown`. */
export type ServerPropertyValue = string | number | boolean | Record<string, number>

/**
 * What a property is allowed to be.
 *
 * - `id` — an identifier we generated or a vendor gave us. No spaces, sixty-four
 *   characters at most.
 * - `enum` — one of a fixed set of names we chose, such as `OPTIMIZE` or
 *   `subscription_reconciliation_nightly`. Same shape rule as an identifier.
 * - `count` — a number: a quantity, a duration, a cost, a share.
 * - `flag` — a yes or a no.
 * - `count_map` — names paired with counts, for the one event that reports "how
 *   many families came from each grouping method" and cannot know the names in
 *   advance. Every key must satisfy the same shape rule as an identifier and
 *   every value must be a number, so it is no more permissive about text than
 *   `enum` is.
 *
 * There is deliberately no kind for text. Adding one is the change that would
 * let store data reach the vendor, so it is a change to argue about rather than
 * a property slipping in unnoticed.
 */
export type ServerPropertyKind = 'id' | 'enum' | 'count' | 'flag' | 'count_map'

export const SERVER_PROPERTY_KINDS = [
  'id',
  'enum',
  'count',
  'flag',
  'count_map',
] as const satisfies readonly ServerPropertyKind[]

/**
 * Identifiers and enumerated names share one shape rule: printable, no
 * whitespace, at most sixty-four characters. The length is what makes it a
 * guarantee rather than a hope — a headline or a paragraph fails it even after
 * someone has stripped the spaces out.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_.:@/-]{1,64}$/

/**
 * Event names are snake_case, with a leading `$` allowed for the two the vendor
 * names itself. Checked as well as declared, so an event name built by joining
 * a merchant's words onto a prefix is refused rather than sent.
 */
const EVENT_NAME_SHAPE = /^\$?[a-z][a-z0-9]*(_[a-z0-9]+)*$/

/**
 * Carried on every event by the attribution resolver, never by a call site.
 * Declared once here rather than repeated on all thirty rows.
 */
const BASE_PROPERTIES = {
  /** The account the work belongs to. */
  account_id: 'id',
  /** Preview traffic only: the host a stranger asked us about. Never a group. */
  target_domain: 'id',
} as const satisfies Record<string, ServerPropertyKind>

/**
 * The property table. One row per event; each property names what it may hold.
 *
 * Grouped the way the product is: who signed up, what they pay, what we
 * ingested, what the engine decided, what we published, and what it cost.
 */
const SERVER_EVENT_DEFINITIONS = {
  // ---- Account lifecycle ----
  /** An account row was created for a new sign-in. */
  signup_completed: { provider: 'enum' },
  /** A domain was claimed, which is the moment the domain group starts existing. */
  domain_claimed: {},
  /** The merchant accepted the persona we inferred for their store. */
  profile_confirmed: {},
  /** Search Console was connected. Which *kind* of property, never the address. */
  gsc_connected: { property_kind: 'enum' },
  /** The account was deleted at the merchant's request. */
  account_deleted: { had_subscription: 'flag' },

  // ---- Money ----
  checkout_started: { interval: 'enum', price_id: 'id' },
  subscription_activated: { previous_status: 'enum', price_id: 'id' },
  payment_failed: { previous_status: 'enum' },
  subscription_canceled: { previous_status: 'enum', status: 'enum' },
  /** A job or a reconciliation gave up and parked the work for a human. */
  dlq_entry_created: {
    step: 'enum',
    error_class: 'enum',
    stripe_customer_id: 'id',
    stripe_event_type: 'enum',
    stripe_event_id: 'id',
    subscription_id: 'id',
  },

  // ---- The free preview ----
  preview_requested: {},
  /** Never the summary itself: whether it was generic, and how long it took. */
  preview_served: { cache_hit: 'flag', generic: 'flag', reason: 'enum', duration_ms: 'count' },

  // ---- Catalog and ingestion ----
  /** A Shopify webhook was drained. `lag_ms` is how far behind the drain is running. */
  webhook_processed: { topic: 'enum', outcome: 'enum', lag_ms: 'count' },
  /** The nightly reconciliation compared our catalog against the shop's. */
  reconciliation_swept: { diff_count: 'count', products_seen: 'count' },
  family_grouping_completed: {
    products_grouped: 'count',
    families: 'count',
    families_without_axes: 'count',
    logical_products_merged: 'count',
    /** How many families each grouping method produced. Names and counts only. */
    grouping_sources: 'count_map',
    low_confidence_families: 'count',
  },
  /** A merchant told us we grouped their products wrongly. What they typed goes to support, never here. */
  family_grouping_reported: { family_id: 'id', member_count: 'count', grouping_source: 'enum' },

  // ---- The opportunity engine ----
  signal_run_completed: {
    kind: 'enum',
    rules_version: 'id',
    signals_evaluated: 'count',
    opportunities_created: 'count',
    opportunities_updated: 'count',
    opportunities_expired: 'count',
    duration_ms: 'count',
  },
  opportunity_detected: {
    signal_type: 'enum',
    recommended_action: 'enum',
    impact: 'enum',
    confidence: 'enum',
    limited_intelligence: 'flag',
  },
  opportunity_status_changed: { from: 'enum', to: 'enum', actor: 'enum' },
  /**
   * What became of a piece of work the merchant told us they carried out,
   * read four weeks later. Only the kind of work and the verdict: the address
   * measured and the store's own click counts stay here.
   */
  opportunity_outcome_measured: { action_type: 'enum', label: 'enum' },

  // ---- Quality gates ----
  /**
   * Which gate, what it decided, and the judge's per-criterion marks — each of
   * which is a number out of five. The judge's written justifications are the
   * merchant-facing prose and are deliberately not here.
   */
  gate_decision: {
    gate: 'count',
    outcome: 'enum',
    prompt_version: 'enum',
    model_id: 'enum',
    informationGain: 'count',
    factualGrounding: 'count',
    searchIntentMatch: 'count',
    actionability: 'count',
    languageQuality: 'count',
    ecommerceUsefulness: 'count',
  },

  // ---- Generation and publishing ----
  generation_cycle_completed: { status: 'enum', outcome: 'enum' },
  replenishment_completed: {
    candidates_scored: 'count',
    slots_filled: 'count',
    refresh_share: 'count',
    exploration_share: 'count',
  },
  /**
   * The weekly verdict on one published article — which of the four it got and
   * how many days old it was. No id, no title, no click count: the saved
   * insight this feeds watches how a store's mix of verdicts moves, which needs
   * neither.
   */
  article_labeled: { label: 'enum', age_days: 'count' },
  article_delivered: { article_id: 'id', delivery: 'enum' },
  article_published: { article_id: 'id', delivery: 'enum', published_as: 'enum' },

  // ---- Drift ----
  /**
   * Counts only, and their names are camelCase because the result object is
   * spread straight in. Renaming them would break the dashboards already built
   * on them, so they are declared as they are rather than quietly changed.
   */
  drift_pass_completed: {
    articlesChecked: 'count',
    driftFound: 'count',
    repairedAutomatically: 'count',
    cardsRaised: 'count',
    rewritesQueued: 'count',
  },

  // ---- Operations ----
  kill_switch_tripped: { flag: 'enum', tripped_by: 'enum', reason_code: 'enum' },
  /** A stand-in implementation actually served a call, rather than merely being wired. */
  stub_used: { contract: 'enum', method: 'enum', type: 'enum' },
  /** What one finished article cost us, all in. */
  article_cost_finalized: {
    article_id: 'id',
    usd_total: 'count',
    usd_llm: 'count',
    usd_seo: 'count',
    llm_call_count: 'count',
    repaired: 'flag',
    published_via_override: 'flag',
  },

  // ---- The vendor's own event names ----
  /** Every model call. Token counts, cost and latency; never a prompt or a completion. */
  $ai_generation: {
    $ai_provider: 'enum',
    $ai_model: 'enum',
    $ai_input_tokens: 'count',
    $ai_output_tokens: 'count',
    $ai_latency: 'count',
    $ai_total_cost_usd: 'count',
    $ai_trace_id: 'id',
    call_type: 'enum',
    prompt_version: 'enum',
    cache_hit: 'flag',
    outcome: 'enum',
    cost_estimated: 'flag',
  },
  /** Every paid search-data read. */
  dataforseo_request: {
    endpoint: 'enum',
    billable: 'flag',
    cache_hit: 'flag',
    usd_cost: 'count',
    outcome: 'enum',
    price_unknown: 'flag',
  },
  /**
   * A crash. Where it happened and what kind it was — the error's own message
   * and stack are not properties and are not checked by this table; they carry
   * whatever the throwing code put in them, past the credential scrubber only.
   */
  $exception: {
    source: 'enum',
    method: 'enum',
    path: 'id',
    route_path: 'id',
    route_type: 'enum',
    router_kind: 'enum',
    step: 'enum',
    error_class: 'enum',
    attempts: 'count',
    job_id: 'id',
    step_id: 'id',
    idempotency_key: 'id',
  },
} as const satisfies Record<string, Record<string, ServerPropertyKind>>

export type ServerEventDefinitions = typeof SERVER_EVENT_DEFINITIONS

export type ServerEventName = keyof ServerEventDefinitions

export const SERVER_EVENT_NAMES = Object.keys(SERVER_EVENT_DEFINITIONS) as readonly ServerEventName[]

/** Whether this event has a row in the table. */
export function isDeclaredServerEvent(event: string): event is ServerEventName {
  return Object.prototype.hasOwnProperty.call(SERVER_EVENT_DEFINITIONS, event)
}

/** The declared properties of one event, including the two every event carries. */
export function serverPropertiesOf(event: string): Readonly<Record<string, ServerPropertyKind>> {
  return isDeclaredServerEvent(event)
    ? { ...BASE_PROPERTIES, ...SERVER_EVENT_DEFINITIONS[event] }
    : BASE_PROPERTIES
}

/** Every event paired with its own declared properties — for checks over the whole table. */
export function allServerEventDefinitions(): readonly (readonly [
  ServerEventName,
  Readonly<Record<string, ServerPropertyKind>>,
])[] {
  return SERVER_EVENT_NAMES.map((event) => [event, SERVER_EVENT_DEFINITIONS[event]] as const)
}

/** The two properties the attribution resolver adds to every event. */
export function baseServerProperties(): Readonly<Record<string, ServerPropertyKind>> {
  return BASE_PROPERTIES
}

function isToken(value: unknown): boolean {
  // A vendor access token is exactly the shape of an identifier — no spaces,
  // short enough — so shape alone would let one through under a key like
  // `article_id`. The same secret matcher the logs use rejects it here.
  // Rejected rather than redacted: an id that is really a token is a bug, and
  // `[redacted]` in its place is a worse event than no property at all.
  return typeof value === 'string' && TOKEN_SHAPE.test(value) && scrubString(value) === value
}

/** Whether a value is something this kind can hold. */
export function acceptsServerValue(
  kind: ServerPropertyKind,
  value: unknown,
): value is ServerPropertyValue {
  switch (kind) {
    case 'id':
    case 'enum':
      return isToken(value)
    case 'count':
      return typeof value === 'number' && Number.isFinite(value)
    case 'flag':
      return typeof value === 'boolean'
    case 'count_map':
      return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.entries(value).every(
          ([key, count]) => isToken(key) && typeof count === 'number' && Number.isFinite(count),
        )
      )
  }
}

export interface RejectedServerProperty {
  readonly key: string
  /** `undeclared` — this event has no such property. `wrong_shape` — it has one, but not holding this. */
  readonly reason: 'undeclared' | 'wrong_shape'
}

export interface CheckedServerEvent {
  /** False when the event name itself is not one we declared or not shaped like a name. */
  readonly sendable: boolean
  readonly properties: Record<string, ServerPropertyValue | null>
  readonly rejected: readonly RejectedServerProperty[]
}

/**
 * Everything the server reports passes through here before it goes anywhere.
 *
 * A rejected property is dropped, never sent and never thrown over: telemetry
 * must not be able to fail a job. What it must not do is guess — an
 * unrecognised field is dropped whole rather than truncated or coerced, because
 * the first sixty-four characters of an article body are still an article body.
 *
 * An event whose *name* is not declared keeps its attribution and loses every
 * property it was given. Losing the row entirely would hide that the work
 * happened at all; losing the properties is what the rule is actually about.
 * An event whose name is not even shaped like a name is not sent.
 *
 * `null` is accepted under any declared property. "We had none" is an answer
 * with no content in it, and several events legitimately report one — the gate
 * that makes no model call has no model id.
 */
export function checkServerEvent(
  event: string,
  properties: Readonly<Record<string, unknown>>,
): CheckedServerEvent {
  if (!EVENT_NAME_SHAPE.test(event) || event.length > 64) {
    return { sendable: false, properties: {}, rejected: [] }
  }

  const declared = serverPropertiesOf(event)
  const accepted: Record<string, ServerPropertyValue | null> = {}
  const rejected: RejectedServerProperty[] = []

  for (const [key, value] of Object.entries(properties)) {
    const kind = declared[key]
    if (kind === undefined) {
      rejected.push({ key, reason: 'undeclared' })
      continue
    }
    if (value === null) {
      accepted[key] = null
      continue
    }
    if (!acceptsServerValue(kind, value)) {
      rejected.push({ key, reason: 'wrong_shape' })
      continue
    }
    accepted[key] = value
  }

  return { sendable: true, properties: accepted, rejected }
}
