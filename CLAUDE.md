# CLAUDE.md — Sortiva constitution

Specs are law and live in `/docs`: `sortiva-spec.md` (**main**), `sortiva-ui-spec.md` (**ui**), `sortiva-tech-spec.md` (**tech**). The build plan is `docs/agent-work-plan.md` (§6 is the card list). Decision journal: `DECISIONS.md`.

## Prime directive (process)

1. **Never work from memory of the specs.** Before writing code, open and read the exact sections your card cites, verbatim.
2. **One task card per session.** Finish or explicitly park it before touching another.
3. **Every choice the specs don't dictate → `DECISIONS.md`, immediately**, with date, card ID, rationale, nearest spec §. If it changes user-visible behaviour or an interface another lane consumes: stop and ask.
4. **If your code touches behaviour outside your card's citations, find the owning section in the pointer map and read it first.**
5. **You own only your lane's directories** (build plan §3). Touching another lane's directory, or a migration outside a schema-wave card, is a review failure.

## Invariants (silent violation corrupts the product)

**Data & identity**
1. One domain per account, one account per domain, claimed at eTLD+1 (PSL-normalised). Unique index on `domains.domain_normalized`; claim is an insert-with-conflict, never check-then-insert. (main §2, §5)
2. Preview output is disposable: nothing from `preview_cache` is ever read by ingestion, persona, topics, or evidence. Test asserts no import path from `preview` into `core`. (main §2, §3)
3. `raw_body_html` is quarantined: never an input to persona, topic selection, evidence packs, or recommendations. Only distilled fact sheets flow downstream. (main §6.3)
4. Order ingestion strips all customer fields at read time; only line-item / landing-page aggregates are persisted. A test asserts no customer field reaches storage. GDPR customer webhooks answer "no data held". (main §6.2, §14.6, §17.3)
5. Business competitors ≤ 5 per account, enforced in API **and** DB; SERP ranking domains live only inside `serp_snapshots` and never enter `competitors`; they may be *suggested* to the merchant, never auto-added. (main §6.6, §7.2.1)

**Opportunity Engine**
6. **No CREATE without the existing-target check.** Gate 1's cannibalization check and §7.7 are the *same function*; a match converts to OPTIMIZE/REFRESH, never a competing URL. (main §7.7, §8.2)
7. Signal and action are never mapped 1:1 in code; action selection is a separate function taking full evidence. Every opportunity row has evidence (with source + window per fact), impact, confidence, `reason_template_key`, `recommended_action`, preconditions, `rules_version`. (main §7.1, §7.6)
8. Every user-facing "why" (opportunity reasons, calendar why-lines) renders from template strings over the scoring/evidence record — never from an LLM. (main §7.1, §9.6.8)
9. No threshold literal outside `packages/rules`. All numbers from main §7.3/§7.6/§8.2/§9.6 live in `signals.config.yaml`, schema-validated, and `rules_version` (its hash) is stamped on every opportunity and gate decision. Lint bans numeric comparisons against volume/position/impression/CTR fields elsewhere. (main §7.10)
10. Open opportunities dedupe on `(account_id, signal_type, entity_ref)` (partial unique index); re-detection updates, never duplicates; expiry never deletes. (main §7.9)

**Quality**
11. Gate on the minimum, never the average: information gain and grounding ≥ 4, others ≥ 3; **one** repair loop max; the judge is a separate call blind to the writer's context and is **never** run on a smaller model. (main §8.4, §14.4)
12. Override-published articles carry `published_via_override`, are excluded from calibration data, pattern learning, and headline performance claims, and are shown segmented. (main §8.6, §9.6.7)
13. No verdict before 28 days post-publish/apply; labels are relative to the store's own median, never absolute. (main §9.6.2, §9.6.10)

**Scheduling & calendar**
14. At most one topic dequeues per account per day, and only the topic scheduled for *today*: the scheduler never pulls a future topic forward, gaps stay gaps, missed days are never back-filled as bursts. (main §8.7, §9.1)
15. Veto is available any time up to dequeue. All state transitions are guarded updates (`UPDATE … WHERE state = expected`); a zero-row guard means stop; the API returns 409 with a machine-readable code. (main §8.7, §14.3.1, tech §3)

**Money**
16. Entitlement = local `subscriptions.status` written only by the Stripe webhook worker, nightly-reconciled. No Stripe API call in any request path or at scheduler dequeue. Billing state gates generation/publishing only — **read access is never revoked**. We render no card form, ever. Snapshot test asserts the literal string "up to 1 article per day, quality permitting". (main §4.2, tech §3)
17. Spend caps are enforced from `ops_flags` / DB counters in our code, checked at dequeue; PostHog is telemetry and alerting only, never the control plane. (main §14.5, §14.7)

**Effectively-once**
18. The queue is at-least-once; every worker is effectively-once: idempotency keys are derived from inputs (never random), completed keys return stored output, all account work serialises under `pg_advisory_xact_lock(account_id)`, any step > 60 s checkpoints. (main §14.3.1–14.3.4)
19. External writes go through `publish_intents` (two-phase: intent → execute with `external_id` marker → confirm; recovery sweeper checks the remote for our marker before re-executing). An update is conditional on the stored remote id and **never falls back to create**. (main §14.3.7)
20. Billable reads (DataForSEO) and LLM calls are cached at request level, keyed on canonical params / `(prompt_version, model_id, sha256(prompt))`, **written before processing**. (main §14.3.6)

**Trust & consent**
21. Read and write are separate consents: initial Shopify OAuth requests read scopes only; `write_content` is a second grant made only from Settings or first publish attempt, and auto-publish cannot enable without a resolved target blog. OPTIMIZE/FIX never write to Shopify in V1; nothing ever touches theme code or redirects; export accounts never receive silent edits. (main §6.2, §9.5, §10.1, §11, §14.1)
22. Degrade to pause, never to lower quality: no model substitution, no gate decision on stale SERP data, no forced publish. User-facing copy for this: "Delayed — we paused this action rather than continue with lower-quality or stale data." (main §14.4, Appendix A)
23. No denominators or targets in any user-facing count ("x of y", "x/30") — the cap is a ceiling, not a promise. (main §8.6, ui §4)
24. Canonical strings in main Appendix A are used verbatim (teaser, cap line, GSC connect, Limited Intelligence badge, read-only trust copy, outage copy). Snapshot tests hold them.

**Plumbing**
25. Every LLM call goes through the single instrumented wrapper in `packages/llm`; importing `@anthropic-ai/sdk` anywhere else is a lint error. Model IDs and prompt versions are explicit config; every artefact is stamped with both. Same wrapper rule for DataForSEO (`SeoDataProvider`) and email (`EmailProvider`). (main §14.2, §14.7, tech §1.4, §2)
26. Events: notifications are append-only records with unique `(account_id, type, dedupe_key)`; attention items are live queries, never stored. Email sends are unique on the same triple. PostHog events carry ids and aggregates only — never product content, article text, prompts, or tokens; tokens are envelope-encrypted and scrubbed from logs. (tech §1, §4; main §14.7)

## Pointer map (area → owning sections)

| Area | Read |
|---|---|
| Domain normalisation, claim, states | main §2, §5, §13 `domains` |
| Preview funnel, Turnstile, cache, SSRF fetcher | main §3, §14.5; tech §2 (single fetcher) |
| Auth, sessions, repository scoping | main §4.1; tech §3 |
| Stripe, entitlement, dunning, cancellation | main §4.2, §14.6; tech §3; ui §2.3, §9.4 |
| Shopify OAuth, scopes, token revocation, GDPR webhooks | main §6.2, §9.5, §14.6; tech §4 |
| Catalog sync, checkpointing, rate limits, webhooks, sweep | main §6.2, §14.1, §14.3.4, §14.3.8, §14.4 |
| Distillation, fact sheets, richness | main §6.3, §14.2 (eval) |
| Families, axes, grouping guardrails | main §6.4 |
| Persona, locale, timezone defaults | main §6.5, §9.4 |
| Keywords, business competitors, DataForSEO | main §6.6, §7.2.1, §12.1 |
| GSC OAuth, property, sync, backfill, Limited Intelligence | main §6.7, §7.11, §12.2 |
| Content inventory (store pages) | main §12.3 |
| Signals, thresholds, config layer | main §7.3, §7.10; `packages/rules` |
| Opportunity object, scoring, action selection, lifecycle | main §7.4–7.9 |
| Existing-target check | main §7.7 (+ §8.2) |
| Gates 1–3, judge, calibration, override | main §8.2–8.6, §14.2 |
| Calendar, topics, veto/move/pin/add, replenishment | main §8.7, §9.6.1, §9.6.4–9.6.6 |
| Generation cycle, templates, images, metadata, draft review | main §9.1–9.3 |
| Publish hour, export, auto-publish, two-phase publish | main §9.4, §9.5, §14.3.7 |
| Learning loop, labels, patterns, outcomes | main §9.6 |
| OPTIMIZE recommendations, intent gap | main §10 |
| FIX / technical layer | main §11 |
| Drift & repair | main §14.1 |
| Idempotency, retries, DLQ, chaos test | main §14.3 |
| Degradation, kill switches, auto-trips | main §14.4, §14.5 |
| Observability, events, dashboards-as-code | main §14.7; tech §5 |
| Notifications, email, retention | tech §1; ui §10 |
| Architecture, Railway, cost disciplines, CI | tech §2, §5, §6 |
| Every screen and its states | ui §1–§11 |
| Canonical copy | main Appendix A |
| Open founder decisions (assumed defaults) | main Appendix B |

## Code-structure rules

- Monorepo: `apps/web` (Next.js App Router: UI + `/api/*` routes + worker bootstrap) · `packages/core` (domain logic; **cannot import Next, React, or any provider SDK** — a test proves it) · `packages/db` (schema, migrations, repositories) · `packages/rules` (`signals.config.yaml`, typed loader, `rules_version`) · `packages/llm` (instrumented client, prompts as `prompts/<name>.v<N>.md`, schemas, eval sets) · `packages/providers` (`shopify`, `gsc`, `seo` (DataForSEO), `email` (Resend), `stripe`, `posthog` — each behind an interface with a test double) · `packages/jobs` (Graphile tasks: one file per step/job) · `packages/ui` (shared components incl. why-line renderer, opportunity card) · `docs/`.
- Route handlers contain no domain logic: parse → call `core` → serialise. Every repository method requires an `accountId` scope parameter; there is no unscoped table access outside migrations and admin scripts.
- Migrations are forward-only, live in `packages/db/migrations`, and are added **only by schema-wave cards** (build plan). Feature cards that need a column file a DECISIONS entry and wait for the next wave, or negotiate with the integrator.
- Thresholds: `packages/rules` only, each with a plain-language note saying what the number decides and what changing it would do — never a bare spec § reference. Copy: `packages/ui/strings/*.json` only (externalised from day one), canonical strings keyed by their Appendix A row.
- Every job step: derived idempotency key, guarded transition, checkpoint if > 60 s, typed failure class. Every external write: through `publish_intents`.
- **No spec citations in code.** The build is the source of truth. A comment earns its place by saying what the code can't show — intent, a constraint from outside the file, a tradeoff, a warning about a non-obvious consequence — in plain language. `§14.3.6` is not an explanation; "so a crash after the vendor answered doesn't make us pay twice" is. Where the build departs from a spec, that goes in `DECISIONS.md` and into the session report, never into a comment.
- Tests live beside code; spec-defined suites (`distillation.eval`, `judge.eval`, `persona.smoke`, `signals.fixtures`, `chaos`) have fixed names so CI and audits can find them.
- Commit message: `T<M>.<n>: <title>` — the title says what changed, in words. No spec § list. One PR per card, from the lane's worktree branch.
