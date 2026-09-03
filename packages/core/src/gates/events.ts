/**
 * Main section 14.7's Quality event: "gate_decision (gate, outcome,
 * reason_code, vertical, prompt_version, model_id, per-criterion scores as
 * properties)". T4.1 built Gate 1 and wired it into the manual-add path
 * (packages/jobs/src/generation/admit-manual-topic.ts) but stopped at a
 * structured log line, never a PostHog capture - completed here as part of
 * this card's "calendar PostHog events" scope, since topic admission is a
 * calendar concern. See DECISIONS 2026-09-03 T4.2.
 */
export const GATE_DECISION_EVENT = 'gate_decision'

export interface GateDecisionEventProperties {
  readonly gate: 1 | 2 | 3
  readonly outcome: string
  /** Null for Gate 1, which makes no model call - matches gate_decisions.prompt_version/model_id. */
  readonly promptVersion: string | null
  readonly modelId: string | null
}
