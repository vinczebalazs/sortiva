# Wave 1 audit remediation — accepted decisions

Source: the three cold-read audits of cards T0.3, T0.4 and T0.5 (`docs/audits/T0.3.md`,
`T0.4.md`, `T0.5.md`). Founder accepted every recommendation on 2026-08-31.

This document is the integrator's record of what was decided and which card owns each
fix. Sessions implementing these read this file plus the relevant audit report — not a
chat summary.

---

## D1 — A durable record of money spent (audit T0.5, blocker)

**Accepted: Option A.** An append-only spend ledger lands in schema wave 2 (card `T2.0`),
because that is the last database wave before wave 3 and the caps cannot be built without
it.

Starting shape, from the auditor's proposal — the implementing card may refine it with a
`DECISIONS.md` entry:

```
spend_events
  account_id        nullable — null for public-preview spend, which has no account
  preview_target    nullable — the domain a logged-out preview was for
  vendor            which paid vendor
  call_type         the AI call type, or the vendor endpoint
  usd_cost          numeric
  cache_hit         boolean — a replayed answer is recorded at zero, not omitted
  occurred_at       timestamptz
```

Append-only. No update path. The daily spend caps in `packages/rules/signals.config.yaml`
(`hard_cap_usd_per_day`, `dataforseo_spend.global_cap_usd_per_day`,
`preview_spend.global_cap_usd_per_day`) are computed from this table by our own code —
never from PostHog. That is invariant 17 and main §14.7's explicit boundary.

**Owner:** `T2.0` for the table. A follow-up card (`R2`) writes to it from the wrappers.

## D2 — Cost is recorded on failure paths, not only on success (audit T0.5, 5 findings)

**Accepted: fix now**, as card `R2`, while no part of the product calls these wrappers yet.

Recording a cost is an obligation of making the call, not a side effect of the call
succeeding. Every path that reaches a paid vendor emits a record: success, vendor error,
rate limit, timeout, dropped connection, a stream cut off partway, and a storage failure
after a successful call.

**Owner:** `R2`. Sequenced after `T2.0` so it can write to the ledger in the same pass
rather than touching every failure path twice.

## D3 — A step interrupted by process death must be recoverable (audit T0.4, blocker)

**Accepted: fix before Lane B builds the catalogue sync (`T2.2`)**, which is the first
long-running step in the product.

Needs a time limit on the `running` state plus something that reclaims expired steps, the
shutdown signal wired to a producer so a long step can save its position during a deploy's
grace period, and a chaos scenario that kills the process rather than throwing an
exception — the existing test proves the wrong case.

**Owner:** `R1`.

## D4 — The per-store lock cannot be leaked (audit T0.4, major)

**Accepted: fix now.** Two local changes plus a bounded wait timeout, and a guard so a
nested acquisition throws a clear error instead of deadlocking forever.

Also flagged to the spec keepers: `CLAUDE.md` invariant 18 names
`pg_advisory_xact_lock(account_id)`, which the code deliberately does not use, for a
reason recorded in `DECISIONS.md` and accepted by this audit. The invariant's wording
should be reconciled with the mechanism actually in use — that is a constitution edit, not
a code change.

**Owner:** `R1` for the code; the spec keepers for invariant 18's wording.

## D5 — Account scoping needs teeth outside the repository layer (audit T0.3, major)

**Accepted: stopgap now, durable version as an early card.**

- **Stopgap (`R1`):** a lint rule forbidding imports of the raw schema barrel and the raw
  database handle outside `packages/db`, with the existing worker code either routed
  through new scoped helpers or covered by an explicit, bounded exemption recorded in
  `DECISIONS.md`.
- **Durable (a later card, not yet written):** stop `@sortiva/db` publishing raw tables at
  all, and supply the join-scoped helpers the job tables need, so job code has a sanctioned
  route rather than going around the layer.

---

## Cards created by this remediation

| Card | Scope | Owns | Depends on |
|---|---|---|---|
| `T2.0` *(amended)* | Schema wave 2, plus the `spend_events` ledger from D1 | `packages/db` | nothing |
| `R1` | Worker-runtime fixes: D3, D4, D5 stopgap, plus the minor findings in `docs/audits/T0.4.md` | `packages/jobs/src/runtime`, `tools/eslint-plugin-sortiva` | nothing |
| `R2` | Cost-accounting fixes: D2, plus writing to the D1 ledger and the minor findings in `docs/audits/T0.5.md` | `packages/llm`, `packages/providers` | `T2.0` merged |

`R1` and `R2` are foundation remediation, not lane work. They touch no lane's directories
and add no migration.

## Still open

- **The idempotency ledger's home** (audit `T0.4`, major). The record of "I already did
  this work" lives on the job rows, so a future retention sweep or a "restart onboarding"
  feature could erase it and let real work run twice. `R1` takes the cheap guard — a test
  forbidding any deletion path from reaching those rows, and a comment on the retention
  sweep naming them never-prunable. The durable fix is a separate table with no link to
  jobs, which is a database-wave change and would have to ride in `T2.0` alongside the
  spend ledger. **Not yet decided.**
- **Item D1 on `docs/founder-decisions.md`** — the `job_dlq` table added outside a schema
  wave. Integrator folds it into wave 1 or accepts it as a mini-wave. No code change
  either way.
