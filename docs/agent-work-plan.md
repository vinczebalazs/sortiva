# Sortiva — Agent Work Plan

How the spec set gets built by coding agents working in parallel without drifting from the specs or from each other. Three artefacts make it work: this plan, the constitution (`CLAUDE.md` — always in context), and the decision journal (`DECISIONS.md`). The specs themselves are the law and are never edited by an implementing agent.

---

## 1. Why this shape

Large specs fail in implementation for one reason: the implementer reads everything once, holds none of it under pressure, and starts making silent micro-decisions the moment attention saturates — usually on exactly the details the spec fought hardest for (the existing-target check, the two-phase publish, the no-denominator rule). Multiple agents make it worse: each one drifts differently, and they collide on the shared schema.

The plan controls **what is in an agent's context at any moment** and **what it is allowed to touch**:

- **One card per session.** A card is one subsystem slice, self-contained: scope, the exact spec sections to read first, checkable done-when criteria. A fresh session with only the constitution + the card + its citations must be able to do the work — if a card needs conversation history, it is a bad card.
- **Lanes with disjoint ownership.** Each parallel agent owns a set of directories and a slice of the spec. Cross-lane needs go through **contracts** (TypeScript interfaces + fixtures) frozen in milestone 0, and through **schema waves** (a single migration card per milestone) so no two agents ever edit the DB at once.
- **Enforcement before features.** Milestone 0 builds every lint, constraint, wrapper, and harness the specs define, so "did the agent remember invariant 9?" becomes a CI failure for the rest of the build.
- **Separate auditing sessions.** The session that wrote the code rationalises the spec as what it built. Invariant-heavy cards get a cold read by a different session before anything builds on them.

---

## 2. Roles

| Role | Who | Does |
|---|---|---|
| **Implementer** (N in parallel) | Claude Code sessions, one per lane, each in its own git worktree | Executes one card: reads constitution → card → cited sections; plans; implements; verifies done-when literally; journals decisions; opens one PR. |
| **Integrator** | One agent session per milestone boundary, or a founder | Merges lane PRs in dependency order, runs the milestone exit gate, runs the invariant sweep, triages `DECISIONS.md` (a/b/c), re-freezes contracts if a seam changed. |
| **Auditor** | A fresh session, never the implementer's | Task audits on flagged cards; invariant sweeps; drift checks; spec-contradiction hunts. Produces written findings only — never silent fixes. |
| **Spec keeper** | The two founders | The only ones who edit `/docs`. Resolve class-(c) decisions, approve promoted decisions, sign off Appendix B defaults (main spec), supply credentials (Shopify dev store, Stripe test mode, DataForSEO, GSC test property, Resend, PostHog). |

Concurrency ceiling: **four implementers at once**. Above that, schema-wave contention and contract churn cost more than the parallelism buys; this is a modular monolith on one Postgres by design (tech §2).

---

## 3. Lanes & ownership

| Lane | Owns (directories) | Spec slice | Consumes from | Provides to |
|---|---|---|---|---|
| **A — Platform & funnel** | `apps/web/app/api/{auth,preview,billing,domain,webhooks/stripe}`, `packages/providers/{stripe,turnstile}`, `packages/core/{account,domain,preview,billing}` | main §2–§5, §14.6 (billing parts), tech §3 | M0 | account/entitlement/domain state to every lane |
| **B — Store Intelligence** | `packages/providers/shopify`, `packages/core/{catalog,distill,families,persona,keywords}`, `packages/jobs/ingestion/*`, `apps/web/app/api/{shopify,profile}` | main §6.1–6.6, §6.8, §12.1 (enrichment), §14.1 (sync/webhooks) | M0, Lane A (domain claim) | facts, families, persona, keywords, competitors, catalog events |
| **C — Search Intelligence & Opportunity Engine** | `packages/providers/gsc`, `packages/core/{inventory,search,signals,opportunities}`, `packages/rules` (after M0), `packages/jobs/{gsc,inventory,scan}`, `apps/web/app/api/{gsc,opportunities}` | main §6.7, §6.9, §7, §12.2–12.6, §9.6.10 | M0, Lane B (families/persona), Lane D contract (`TopicScheduler`) | `existingTargetCheck`, opportunities, signal runs, `gsc_*` tables |
| **D — Content Engine & publishing** | `packages/core/{topics,calendar,gates,generation,publish,repair}`, `packages/jobs/{generation,replenish,publish,drift}`, `apps/web/app/api/{calendar,articles,publish}` | main §8, §9, §14.1 (drift policies), §14.3.7 | M0, Lane B, Lane C contract (`existingTargetCheck`, `OpportunitySource`) | articles, calendar, gate decisions, labels input |
| **E — OPTIMIZE & FIX** | `packages/core/{optimize,fix}`, `packages/jobs/optimize`, `apps/web/app/api/recommendations` | main §10, §11 | Lane C (opportunities, inventory), Lane D (judge) | recommendations, FIX tasks |
| **F — Frontend** | `apps/web/app/(app)/**`, `apps/web/app/(public)/**`, `packages/ui` | ui §1–§11 | API contracts (OpenAPI/zod from M0) via MSW mocks; real APIs as lanes land | every screen |
| **G — Ops, notifications, email** | `packages/core/{notifications,email,lifecycle}`, `packages/providers/{email,posthog}`, `packages/jobs/{notify,retention,sweeps}`, `apps/web/app/api/{notifications,webhooks/resend}`, `ops/posthog/*` | tech §1, §5; main §14.5, §14.6, §14.7 | M0; emission points from every lane via `NotificationEmitter` | bell/email, kill switches, dashboards-as-code |

**Files no lane owns, and what to do about them.** The lane table above divides
directories. It does not divide the handful of files *every* lane must append to,
and in wave 1 those were the entire collision surface — measured across the merge:
`packages/core/src/index.ts` and `eslint.config.mjs` touched by eight cards each,
`packages/db/src/index.ts` by seven, `apps/web/instrumentation.ts` and
`packages/db/src/testing.ts` by six, `scripts/prove-lint.mjs` by five.

Three different answers, by shape:

- **Append-only lists** — the barrel `index.ts` files and `DECISIONS.md` — are
  marked `merge=union` in `.gitattributes`. Two lanes adding different lines now
  merge with no conflict and both survive. The decision journal alone needed
  hand-resolving in three of four wave-1 merges, and a hand-resolved merge is a
  chance to silently drop somebody's work.
- **Registries** are discovered rather than listed. `pnpm lint:prove` reads one
  file per planted violation from `scripts/lint-proofs/`, so a lane adding a rule
  adds a file. It refuses to run on an empty directory, because an empty proof
  proves nothing. Prefer this shape for anything a lane extends.
- **Ordered code** — `eslint.config.mjs`, `apps/web/instrumentation.ts`,
  `packages/db/src/testing.ts` — is deliberately *not* union-merged, because
  merging both sides of a file whose lines depend on each other can be silently
  wrong rather than loudly broken. These stay integrator-resolved. If a lane needs
  to change one, say so in the session report so the integrator expects it.

**Repository ownership (added 2026-09-07, after a card was misplaced because the table did not say).** `packages/db/src/repositories/*` is not divided by lane above, every lane needs functions there, and until now it was resolved by custom. **A repository file belongs to the lane that owns the domain it serves** — `repositories/inventory.ts` is Lane C's by the same reading that makes `core/inventory` Lane C's, `repositories/publishing.ts` is Lane D's, and so on. This is the same drift that let `apps/web/app/api/settings` go unowned until ten endpoints diverged; the table now answers the question instead of leaving it to whoever is confident.

**Schema ownership:** nobody. Migrations land only in schema-wave cards (T0.3, T2.0, T4.0, T8.0), each authored by the lane that needs the wave most and reviewed by the integrator. A feature card needing an extra column writes a `DECISIONS.md` entry and either waits for the next wave or asks the integrator to hot-add a mini-wave — it never adds a migration itself.

---

## 4. Seams & contracts (frozen in M0, filled later)

Named seams are the difference between parallel lanes and a merge-day disaster. Each is a TypeScript interface in `packages/core/contracts/` with a test double and fixture data, written in T0.7 and **not changed without the integrator re-freezing it**.

| Contract | Producer (card) | Consumer (card) | Stub behaviour until filled |
|---|---|---|---|
| `existingTargetCheck(cluster, accountId) → {match, url?, action}` | C — T3.5 | D — T4.1 (Gate 1) | returns `no_match` and logs `stub_used` (a CI check fails if any stub is still wired at M3 exit) |
| `OpportunitySource.acceptedContentOpportunities(accountId)` | C — T3.6/T3.7 | D — T4.6 (replenishment), T4.2 (seed calendar) | fixture pool from `signals.fixtures` |
| `TopicScheduler.schedule(opportunity, date?)` | D — T4.2 | C — T3.7 (onboarding run seeds the calendar) | records intent, no calendar |
| `JudgeLite.grade(recommendation, pack)` | D — T4.4 | E — T6.2 | passes with fixed scores, logs `stub_used` |
| `NotificationEmitter.emit(type, refs, dedupeKey)` | G — T8.1 | every lane at its emission points | writes to a test table |
| `CatalogEvents` (product/collection change stream) | B — T2.2 | C — T3.2 (inventory), D — T5.3 (drift) | fixture events |
| `LlmClient`, `SeoDataProvider`, `EmailProvider`, `PosthogCapture` | M0 — T0.5 | everyone | in-memory doubles with cost accounting |
| API route contracts (zod schemas + OpenAPI) | M0 — T0.7 | F (MSW mocks), all API cards | MSW handlers returning fixtures |

Rule: a consumer card's done-when may pass against the stub, but the milestone exit gate that follows the producer card must re-run the consumer's tests against the real implementation.

---

## 5. Milestones, dependency order & parallel waves

**Revised 2026-09-01**, after wave 1 shipped, from the dependencies as they
actually are rather than as the original wave diagram assumed. The change is not
cosmetic: schema wave 2 is merged, which unblocks two lanes the diagram put a
whole wave later.

### What is done

M0 complete. M1 complete. `T2.0` merged, plus two mini-waves (`T1.2a`, `T2.0b`)
and five remediation cards (`R1`–`R5`) that came out of the audits and are not in
§6's numbering. Nineteen commits on `main`; twelve of the fifty-eight planned
cards.

### What can start immediately

Four lanes, which is the concurrency cap. None of these four waits on another:

| Lane | Card | Unblocked because |
|---|---|---|
| **B** | `T2.1` | `T1.4` (domain claim) is merged |
| **F** | `T9.1` | frontend build cards need only `T0.7` |
| **C** | `T3.1` | needs `T2.0` and `T0.7`; nothing from the rest of M2 |
| **G** | `T8.0` | a schema wave, dependent on nothing |

Start `T8.0` early on purpose. It is a schema wave, and schema waves are the only
cards allowed to add a column — so every later card that discovers it needs one
waits for the next wave or negotiates a mini-wave. Wave 1 needed three such
negotiations. Landing wave 4's schema before the cards that consume it removes
that scramble.

### The critical path, and it is only one lane

Lane B's remaining cards are genuinely serial — sync the catalogue, distil
products into facts, group facts into families, build the persona from the
families, derive keywords from the axes, confirm. Each consumes the previous
one's output.

That matters because **`T2.4` (families) and `T2.5` (persona) gate the entire
content engine and the catalog half of the Opportunity Engine**:

```
T2.1 → T2.2 → T2.3 → T2.4 → T2.5 ──┬──→ T2.6 → T2.7
                                    ├──→ M4 (7 cards) → M5 (3 cards) → M7
                                    └──→ T3.5 → T3.6 → T3.7 ──→ M6
```

Roughly fifteen cards of unavoidable sequence. Everything else fits alongside
without extending it, so adding sessions beyond four shortens nothing — the
schedule is set by Lane B, then Lane D.

### M3 splits, and the original diagram hid it

The old diagram put all of M3 in one wave behind M2. Four of its seven cards do
not need M2 at all:

- `T3.1` Search Console OAuth and sync — needs `T2.0` only.
- `T3.2` store content inventory — needs `store_pages` (in `T2.0`) and the
  `CatalogEvents` contract, which has a stand-in until `T2.2`.
- `T3.3` query clusters and the CTR curve — needs `T3.1`'s data.
- `T3.4` Search-Console signal detection — needs `T3.3`.

Only `T3.5` onward needs families and persona. Lane C can therefore run four
cards deep while Lane B is still on its second.

### Revised waves

```
Now:      T2.1 (B) ║ T9.1 (F) ║ T3.1 (C) ║ T8.0 (G)
Then:     T2.2 → T2.3 → T2.4 → T2.5 → T2.6 → T2.7   (B, serial — the critical path)
          T3.2 → T3.3 → T3.4                        (C, parallel to B)
          T9.2 → T9.3 → T9.4 …                      (F, parallel throughout)
          T8.1 → T8.2 → T8.3                        (G, parallel throughout)
After T2.5:   M4 (D) ║ T3.5 → T3.6 → T3.7 (C)
After T4.4:   M5 (D) ║ M6 (E)
After T5.1 + T3.7:   M7 (C+D)  — DEFERRED, not in v1 (founder, 2026-09-02)
Finally:  M10 exit gates, serial
```

### Hard dependencies

A card cannot start before these are merged. `M2` needs `T1.4` ✅. `M3` needs
`T2.0` ✅ and `T0.7` ✅; `T3.5` onward additionally needs `T2.4`–`T2.5`. `M4`
needs `T2.4`–`T2.5`. `M5` needs `T4.4`. `M6` needs `T3.6` and `T4.4`. `M7` is **deferred out of v1** and no longer
scheduled; nothing depends on it. Frontend integration cards need their backend cards; frontend
build cards need only `T0.7`.

### One card to pull forward

**The spend caps should not wait for `T8.4`.** They are currently the last card of
milestone 8, in the third wave. The meter is already populated — every paid vendor
call writes to `spend_events` — and the cap values are already in
`packages/rules`. What is missing is "sum the last day, compare, refuse to
dequeue", which is a small fraction of that card.

From the moment `T2.2` starts making real vendor calls, spending is unbounded with
no brake, and the first month of real merchants is when a runaway loop is most
likely. Splitting the caps out as a small early card in Lane G removes that,
independently of the incident records, four-eyes reset and dashboards that make up
the rest of `T8.4`.

### Cards created outside this numbering

Recorded in full in `docs/audits/remediation.md`: the spec-citation sweep, the
operations card (diagnosis script, one-command dead-letter replay, a health check
that can fail, crash reporting), and the durable account-scoping fix. None is
owned by a lane; each is small and can slot between cards.

Each milestone still ends with an **exit gate** card whose done-when proves the
milestone as a whole; a milestone cannot be declared complete by summing its
cards.

---

## 6. Build plan — task cards

Card format: **ID — title** · *Scope* (what exists after) · *Read first* (exact sections) · *Done when* (checkable) · *Invariants* (constitution numbers; only invariant-heavy cards, which get a fresh-session audit before dependents start). `main` = `sortiva-spec.md`, `ui` = `sortiva-ui-spec.md`, `tech` = `sortiva-tech-spec.md`.

### M0 — Foundation (enforcement before features) · serial

**T0.1 — Repo skeleton, package boundaries, lint, CI**
Scope: monorepo with the constitution's packages; boundary test proving `packages/core` cannot import Next/React/provider SDKs; lint rules banning raw `@anthropic-ai/sdk` imports outside `packages/llm`, numeric threshold comparisons outside `packages/rules`, and domain logic in route handlers (rule: handlers may import only from `core` + serialisers); CI running typecheck + tests + lint; Railway two-service config.
Read first: tech §2, §2.1, §5; CLAUDE.md code-structure rules; main §14.7 (wrapper rule).
Done when: `pnpm lint` fails on a deliberately planted raw SDK import and on a planted `if (position < 15)` outside rules; boundary test passes; CI green on an empty app; `railway.toml` deploys `app` + `postgres` to a throwaway environment.

**T0.2 — Rules & config module**
Scope: `packages/rules` with `signals.config.yaml` containing **every** number from main §7.3, §7.6 (confidence points, clamps), §8.2 (demand floors per locale), §9.6 (multipliers, exploration, refresh share, cooldown), §10.2 (caps), §14.5 (auto-trip thresholds), each with its § in a comment; JSON-schema validation at load; `rules_version = sha256(file)`; typed accessor; per-locale override layer; `rules_overrides` reader (empty in V1).
Read first: main §7.10, §7.3, §7.6, §8.2, §8.5, §9.6.2–9.6.6, §10.2, §14.5.
Done when: a test enumerates the spec's named thresholds and asserts each key exists; invalid YAML fails startup; `rules_version` changes when any value changes; snapshot of the loaded config committed.
Invariants: 9.

**T0.3 — Schema wave 1 + constraint tests**
Scope: migrations for `accounts, subscriptions, stripe_events, domains, preview_cache, shopify_conns, ingestion_jobs, job_steps, request_cache, ops_flags, account_settings, webhook_events, notifications, email_sends, email_suppressions, notification_prefs`; repository layer requiring `accountId`; tests proving each unique/partial index fires.
Read first: main §13 (those tables), §2, §14.3.1–14.3.2, §14.3.6, §14.3.8; tech §1.2–§1.4, §3.
Done when: constraint tests pass (duplicate domain, duplicate webhook id, duplicate stripe event, duplicate notification triple all conflict); a repository call without scope fails to compile.
Invariants: 1, 26.

**T0.4 — Worker runtime & step state machine**
Scope: Graphile Worker in-process; `ingestion_jobs`/`job_steps` state machine with guarded transitions, dependency-gated dispatch, derived idempotency keys with completed-key ledger, per-account advisory lock, checkpoint API, retry/backoff/jitter, DLQ with replay context, crontab registry.
Read first: main §14.3.1–14.3.5; tech §2, §2.1 (graceful SIGTERM).
Done when: tests: guard mismatch stops a second worker; re-running a completed key returns stored output without executing; two workers on one account serialise; a step crashed mid-checkpoint resumes at the cursor; retries follow 1m/5m/25m ±20%; DLQ entry carries step + key + error; SIGTERM drains.
Invariants: 15, 18.

**T0.5 — Provider wrappers**
Scope: instrumented `LlmClient` (schema validation, retry-once-with-error, request cache written before processing, `$ai_generation` capture with `call_type`, `prompt_version`, `cache_hit`, domain group); `SeoDataProvider` interface + DataForSEO impl + mock + request cache + endpoint→price map + `dataforseo_request` event; `EmailProvider` interface + Resend impl + mock; `PosthogCapture` server wrapper with domain group and preview `target_domain` property rule; secrets/envelope encryption helper + log scrubber.
Read first: main §14.2, §14.3.6, §14.7, §12.1, §3.2 (preview attribution); tech §1.4, §2, §4.
Done when: cache tests (crash-after-response replays without re-billing; retried LLM call replays identical completion); a cached call captures `usd_cost: 0` / `cache_hit: true`; scrubber test proves a token never reaches log output; mock providers account cost.
Invariants: 20, 25, 26.

**T0.6 — Test harnesses**
Scope: chaos harness (kills workers at random points in a scripted run, asserts convergence — cases land with features); eval-set runner (`*.eval` directories with gold files, MAE/F1 reporters); synthetic-store fixture generator (catalog with fluff/spec products, families, GSC page×query rows for each §7.8 scenario); Playwright scaffold against a seeded dev DB; PostHog provisioning script in check mode.
Read first: main §14.2, §14.3.9, §7.8; tech §5, §6.
Done when: `pnpm chaos` runs an empty scenario green; `pnpm eval` runs an empty set; fixtures for scenarios 1–8 generate deterministic data; provisioning check mode passes on an empty definitions dir.

**T0.7 — Contracts & API schemas (M0 exit gate)**
Scope: every seam in §4 above as an interface + test double + fixtures; zod schemas + OpenAPI for all `/api/*` routes named in ui §1–§10 and tech §3 (409 `code` enum included); MSW handlers for the frontend; `stub_used` telemetry and a CI check listing wired stubs.
Read first: main §7.7, §7.9, §8.7, §9.6.1; tech §3, §1.2; ui §5–§6 (to derive route shapes).
Done when: every contract has a double + fixture; `pnpm contracts:check` lists zero shape mismatches between zod and OpenAPI; MSW mock server boots the UI shell; wired-stub report lists all stubs (expected: all).

### M1 — Platform & funnel · Lane A

**T1.1 — Auth & account scoping**
Scope: Auth.js email + Google; account row on signup (`domain = null`); session→`accountId` middleware; repository scoping enforced in all routes.
Read first: main §4.1, §4.3; tech §3.
Done when: integration test: a route cannot read another account's rows; signup creates account; `signup_completed` captured.

**T1.2 — Stripe billing & entitlement**
Scope: plan screen API, Checkout session (monthly/annual price IDs from config), Customer Portal link, webhook receiver (signature, insert-or-ignore, async), single-writer status worker, nightly reconciliation, `isEntitled()` reading local row only, dunning state (pause generation, banner flag), cancellation semantics.
Read first: main §4.2, §14.6 (cancellation), §13 `subscriptions`/`stripe_events`; tech §3; ui §2.3, §9.4.
Done when: test-clock scenarios (activate, payment_failed → past_due → paid, cancel_at_period_end) drive `subscriptions.status` correctly; grep proves no `stripe.` call outside webhook worker + Checkout/Portal creators; snapshot asserts the literal cap string; read endpoints return 200 for `canceled` accounts.
Invariants: 16, 23, 24.

**T1.3 — Preview endpoint**
Scope: `POST /api/preview` with Turnstile verification, per-IP + global rate limits, 7-day cache, the **single SSRF-guarded fetcher** (shared by later cards), cheap extraction, Haiku summary via `LlmClient` (`call_type: preview`), graceful generic card, preview cost trip serving cache-only.
Read first: main §3, §14.5 (preview trip), §14.7 (preview attribution); tech §2 (fetcher).
Done when: tests: private-IP redirect blocked; size/timeout budgets enforced; cache hit skips fetch + LLM; rate limit returns 429; trip flag → generic card on miss, cache still served; events carry `target_domain` property and no domain group.
Invariants: 2, 17.

**T1.4 — Domain claim (M1 exit gate)**
Scope: normalisation (lowercase, strip scheme/www/path, PSL eTLD+1, multi-tenant suffix allowlist), transactional claim with conflict → 409 copy, enqueue ingestion job, dashboard state flip, `domain_claimed` event; 7-day release grace stub for deletion (filled in T8.3).
Read first: main §2, §5, §13 `domains`; ui §3.1.
Done when: normalisation table test (incl. `co.uk`, `myshopify.com`); two concurrent claims → exactly one succeeds; claim enqueues `ingestion_jobs` row with `detect` step pending; Playwright: signup → plan → claim → progress state.
Invariants: 1.

### M2 — Store Intelligence · Lane B

**T2.0 — Schema wave 2**
Scope: `products, product_facts, product_families, personas, top_products, keywords, competitors, store_pages, gsc_daily, gsc_query_daily, query_clusters, ctr_curve, serp_snapshots, opportunities, opportunity_tasks, optimize_recommendations, signal_runs, dismissed_opportunities, rules_overrides, landing_revenue_daily, gsc_conns` + constraint tests (competitor count ≤ 5, opportunity partial unique, store_pages unique url).
Read first: main §13 (those tables), §6.6 (cap), §7.9 (dedupe).
Done when: constraint tests fire; count constraint rejects a 6th competitor at DB level.
Invariants: 5, 10.

**T2.1 — Tech detection, parked state, Shopify read-only OAuth**
Scope: `detect` step (Shopify signals, myshopify handle), `custom_unsupported` parking with Appendix A copy, `oauth_wait` step with read scopes only, encrypted token + granted scopes persisted, `awaiting_shopify_auth` resume path, token-invalid → re-park, `app/uninstalled` handling, 24h reminder emission via `NotificationEmitter`.
Read first: main §6.1, §6.2, §14.4 (token row), §14.6 (uninstall); tech §4; ui §3.3–3.5; Appendix A.
Done when: OAuth request contains only `read_products, read_orders, read_content, read_locales` (test asserts no `write_`); token round-trips encrypted; 401 from Shopify moves state to `awaiting_shopify_auth`; dev-store OAuth smoke passes.
Invariants: 21, 26.

**T-START — A claimed domain actually starts moving** · *small; touches Lane A's claim code, so it is taken by whichever lane is free*
Scope: the domain claim pushes the first onboarding step onto the job queue in the same transaction that writes the run and its steps. Nothing else changes; the worker's recurring schedule stays off.
Read first: `DECISIONS.md` 2026-09-02 `T-START` (the decision and the alternative rejected, with reasons) and 2026-09-01 `T1.4` ("The claim enqueues durable step rows, not a Graphile job" — this card is the deliberate reversal of half of that, and the entry says why it was written that way); main §6.1, §14.3.1.
Done when: claiming a domain on a clean database leaves the first step queued **and** the run's rows written, in one transaction — proved by rolling the transaction back and showing neither survives; a claim that conflicts queues nothing; re-running the claim does not queue a second job for the same run; the existing claim tests still pass unchanged.
Invariants: 18.

**T-ANALYTICS — Screens report to the analytics vendor from the browser** · *Lane F, before any further screen card*
Scope: bind the reporting seam `T9.1` left — PostHog's browser library, public key in the page — so the seam's do-nothing default is replaced by a real transport. **Session replay is off on every view that renders a merchant's store data**, deliberately and provably. Event definitions stay the only way to send an event: a call site cannot attach a free-text field.
Read first: `DECISIONS.md` 2026-09-02 `T-ANALYTICS` (the decision, the alternative rejected, and the two obligations it creates); `docs/audits/false-confidence.md` (the finding that nothing structurally stops product content reaching an analytics event); main §14.7; tech §1.6.
Done when: an event sent from a screen reaches the vendor client with the account attribution the wrapper already applies; **replay is asserted off on every store-data view, by a test that fails when a new such view is added without it**; a test proves an event cannot carry a property its definition does not declare, planted-violation style; no product content, article text, prompt or token appears in any event payload (test over the definitions, not over one call site); the public funnel's server-side events are unchanged and not duplicated from the browser.
Invariants: 26.

**T-EMAIL — Email sign-in, which means moving sessions into the database** · *Lane A territory; taken by whichever lane is free*
Scope: magic-link email sign-in through the existing `EmailProvider` wrapper, using the `verification_tokens` table that already exists. **This requires a database session adapter, which the app deliberately does not have** — so it also converts sessions from self-contained tokens to database-backed ones, and revisits the session lifetime now that expiry is no longer the only way a session ends.
Read first: `DECISIONS.md` 2026-09-02 `T-EMAIL` (what this actually costs) and 2026-08-31 `T1.1` (both original blockers, and why sessions are tokens today); main §4.1; tech §3; `apps/web/app/api/auth/_lib/config.ts`, whose own comment names both blockers.
Done when: a magic link signs a new merchant in and provisions exactly one account; the same link cannot be used twice; an expired link is refused; **a session can be revoked before it expires, proved by revoking one and showing the next request is unauthenticated**; every existing Google sign-in test passes unchanged; the session lifetime is either changed with a journalled reason or explicitly kept with one.
Invariants: 1.

**T-BOOT — The app does not start: read thresholds on first use, and prove the server boots** · *runs alone; no lane owns it, and it edits files two lanes would otherwise collide on*
Scope: (1) `packages/rules` resolves and reads `signals.config.yaml` and its schema on the **first call that needs a threshold**, not at module load, caching thereafter — a genuinely missing or malformed file must then fail loudly and name the file, because the failure has moved later. (2) A lint rule that rejects computing a file path from `import.meta.url` at module top level anywhere in `packages/rules` and `packages/llm`, with a planted violation in `pnpm lint:prove` so the rule is proved to bite — `packages/llm`'s prompt loader has the same shape and `T1.3` already wrote it up. (3) A gate step that **starts the built application and asks it for a page**, wired into `package.json` and the CI workflow, because every existing gate command passed while the product served 500 on every route.
Read first: `DECISIONS.md` 2026-09-02 `T-BOOT` (the founder decision and the two alternatives rejected, with reasons) and 2026-09-01 `T1.3` (the same defect in the prompt loader); `docs/overnight-state.md` § "BLOCKER"; main §7.10; tech §2, §6.
Done when: `pnpm build` then a real start serves 200 on `/` and on `/api/health`, shown as command output; a deliberately corrupted `signals.config.yaml` produces one clear error naming the file, proved by breaking it; `pnpm lint:prove` rejects a planted module-load path resolution; the new gate step fails when the app cannot boot, proved by breaking the boot; the full existing gate stays green.
Invariants: 9.

**T-OPS — Diagnosis, replay, a health check that can fail, crash reporting** · *slots between `T2.1` and `T2.2`; no lane owns it*
Scope: four small things that share a theme — none exists today and no other card owns any of them. (1) A script taking an email or a domain and printing that store's state and every pipeline step, so answering "why is this store stuck" is not hand-written SQL. (2) A one-command replay for permanently-failed work: `replayDlqEntry` is written and tested and has **no caller**, while the spec promises this as a single action. (3) A health check that actually checks the database and the worker — `/api/health` currently returns OK unconditionally, so it cannot fail while the app is broken, which disables the platform's own restart-on-failure. (4) Wiring the crash reporter: `captureException` is implemented on the analytics wrapper and has **zero production callers**, so an unhandled error goes to stdout and nowhere else.
Read first: main §14.3.5 (the replay surface the spec asks for), §14.7 (observability); tech §2.1, §5. Accepted as `D8` in `docs/audits/remediation.md` — three of the four are founder-accepted proposals rather than spec requirements; the replay surface is the one the spec already requires.
Done when: the diagnosis script prints state and steps for a store identified by either email or domain, and says so plainly when there is no such store; a dead-letter entry can be replayed by one command and the replay is proved to re-run the work rather than duplicate it; the health check fails when the database is unreachable and when the worker is not running, proved by breaking each; an unhandled error in a route and in a job step both reach the crash reporter, proved by a test that asserts the call rather than the wiring.
Notes: this card is scheduled here because `T2.1` is what made background steps actually run — before it, every store looked identical and idle, so a working diagnosis script was indistinguishable from a broken one. `T2.2` is the card most likely to strand a merchant halfway through onboarding, and having diagnosis and replay in place *before* it ships is the difference between answering a support question in seconds and reconstructing state by hand.

**T2.2 — Catalog sync, orders aggregation, webhooks, reconciliation**
Scope: paginated catalog sync with page-cursor checkpointing under the 1 req/s limiter honouring `Retry-After`; 90-day order line-item aggregation (top products by revenue/qty) **stripping customer fields at read time**; landing-site daily aggregation (capture only); Shopify webhook receiver (HMAC, `X-Shopify-Webhook-Id` dedupe, 200 < 5 s, async, out-of-order guard); daily reconciliation sweep with checksum diff and `reconciliation_swept` metric; `CatalogEvents` contract filled.
Read first: main §6.2, §14.1 (change detection), §14.3.4, §14.3.8, §14.4, §17.3 (capture), §13 `top_products`/`landing_revenue_daily`.
Done when: customer-field stripping test passes; crash mid-sync resumes at cursor (chaos case); duplicate webhook is a no-op; sweep run twice converges; limiter never exceeds 1 req/s in a burst test.
Invariants: 4, 18.

**T2.3 — Product distillation + eval**
Scope: Haiku fact-sheet extraction (schema, extract-only rules), per-product caching on `updated_at`+checksum key, richness score roll-up, `raw_body_html` quarantine (compressed storage, no downstream read path), `distillation.eval` set (~50 items, F1 ≥ 0.85, zero inferred-fact violations).
Read first: main §6.3, §14.2, §14.3.2 (`distill` key); tech §2.1 (compression).
Done when: eval passes in CI; boundary test proves no module outside `catalog` imports `raw_body_html`; unchanged product re-run is a no-op by key.
Invariants: 3.

**T2.4 — Product family grouping**
Scope: taxonomy grouping with promo-collection blocklist, split-variant merge into logical products, deterministic fact-sheet clustering recording differentiation axes, embeddings fallback flagged low-confidence, sparse-product guardrail, provenance, recompute on affected products only, `family_grouping_completed` event, "report wrong grouping" endpoint.
Read first: main §6.4, §13 `product_families`/`products`.
Done when: fixture store of 40 shoes → 4–6 families with axes `{terrain, drop, width}`; sparse products stay singleton; split-variant fixture merges; provenance recorded for every family.

**T2.5 — Persona + locale/timezone**
Scope: Sonnet persona call (schema), inputs from facts/families/top sellers/homepage-about via the shared fetcher (never raw descriptions), locale/country detection chain, default IANA timezone per country table, `persona.smoke` set (10 stores, exact language/country).
Read first: main §6.5, §9.4 (timezone defaults), §14.2.
Done when: smoke set passes; a test proves the persona prompt input contains no `raw_body_html`; timezone table covers the multi-zone countries listed in §9.4.
Invariants: 3.

**T2.6 — Keywords & business competitors**
Scope: seed derivation (Sonnet) from families/axes; DataForSEO enrichment (locale params, 30-day cache); competitor auto-detection with marketplace blocklist; SERP-derived competitor suggestions (§7.2.1: top-10 for ≥ 3 confirmed keywords, blocklist-filtered, stored as suggestions, never auto-added); cap 5 in API + DB; manual add with normalisation/validation/"add anyway"; async high-priority enrichment lane for hand-added terms.
Read first: main §6.6, §7.2.1, §12.1, §13 `keywords`/`competitors`.
Done when: 6th competitor rejected at API and DB; own domain rejected; blocklist requires override flag; enrichment calls are cache-keyed and job-side (grep: no provider call in a route handler); `SeoDataProvider` mock records exactly one billable call per distinct request.
Invariants: 5, 20.

**T2.7 — Confirmation & profile settings (M2 exit gate)**
Scope: confirmation API (all sections editable), `needs_confirmation → ready_for_planning` guarded transition, post-confirmation edits trigger enrichment only (never re-ingestion), competitor swap invalidates only that competitor's cache, ingestion PostHog funnel events, SSE endpoint for `job_steps`.
Read first: main §6.8, §14.7 (funnel events); tech §1.6; ui §3.2, §3.7, §9.2.
Done when: full ingestion on the dev store completes through `awaiting_confirmation` and confirm flips state; editing a keyword after confirmation enqueues one enrichment job and zero ingestion steps; SSE streams step transitions; chaos harness now includes "kill during catalog_sync/distill/family_group" and converges.

### M3 — Search Intelligence & Opportunity Engine · Lane C

**T3.1 — GSC OAuth, property picker, sync, backfill**
Scope: Google OAuth `webmasters.readonly`; property list + host validation vs eTLD+1; `gsc_connected_at`; daily page×query sync into `gsc_query_daily` + page totals into `gsc_daily`; 16-month backfill as a job step; token-refresh failure → reporting stops, content pipeline continues; `gsc_connected` event; Limited Intelligence flag on `account_settings`.
Read first: main §12.2, §6.7, §7.11, §14.4 (GSC row); ui §3.6.
Done when: mismatched property rejected; backfill checkpoints per date range; refresh failure sets reconnect flag without touching job dispatch for generation; skip path sets `limited_intelligence = true`.

**T3.2 — Store content inventory**
Scope: `store_pages` sync from collections/products/pages/blogs/articles + our articles: page type, SEO fields, headings, outbound internal links, family mapping, checksum; runs inside the daily sweep and on `collections/update`/`articles/*` events via `CatalogEvents`.
Read first: main §12.3, §13 `store_pages`.
Done when: dev store inventory lists every collection/page/blog article with correct `page_type`; checksum changes on body edit; no crawler/fetcher call in this module (grep).

**T3.3 — Query clusters, CTR curve, page↔query mapping**
Scope: cluster construction (head query + related expansion, lineage stored), store-specific position→CTR curve fit (weekly, branded excluded where detectable, standard-curve fallback), page-cluster share tables used by detection.
Read first: main §7.3 (Low CTR, Cannibalization), §9.6.3, §13 `query_clusters`/`ctr_curve`.
Done when: curve fit on fixture GSC data reproduces expected CTRs within tolerance; fallback used when sample_n below config; clusters carry lineage.

**T3.4 — Signal detection: GSC-based P0**
Scope: Striking Distance, Low CTR at Strong Rank, Content Decay, Cannibalization (with validation: same intent + alternation-or-loss) as pure functions over `gsc_query_daily`/`store_pages`/`ctr_curve`, all thresholds from `packages/rules`, evidence blobs with source/window per fact.
Read first: main §7.3 (those rows), §7.10, §7.6 (evidence shape), §7.8 examples 1, 2, 5, 6.
Done when: fixtures for examples 1/2/5/6 produce exactly the expected signals and evidence numbers; lint proves no threshold literal; changing a YAML band changes detections.
Invariants: 7, 9.

**T3.5 — Signal detection: catalog/market P0 + existing-target check**
Scope: Uncovered Commercial Query, Competitor Coverage Gap, Product Family Coverage Gap, Catalog Richness Gap (HOLD with product/field list), Missing/Duplicate Metadata (SQL over `store_pages`, no external calls); **`existingTargetCheck` implemented** (GSC ≤ 30 → content mapping → DataForSEO ranked-keywords proxy in limited mode) and wired to the T0.7 contract; Limited Intelligence branching.
Read first: main §7.3 (those rows), §7.7, §7.11, §8.2 (substance inventory), §11 (metadata row), §7.8 examples 3, 4 (trigger side), 7.
Done when: examples 3 and 7 pass; a fixture with two collections sharing a `seo_title` and one with none yields exactly two metadata OPTIMIZE opportunities; existing-target table test (positions × inventory × limited mode → no_match / optimize / refresh / proceed-with-link); contract stub report no longer lists `existingTargetCheck`.
Invariants: 6, 7.

**T3.6 — Opportunity object, scoring, action selection, lifecycle**
Scope: opportunity creation/update with partial-unique dedupe; both score families (§9.6.4 formula for CREATE incl. `business_weight`; expected-gain for existing pages), percentile `impact_score` + tercile bands, additive confidence, action selection as a separate function over full evidence, deterministic task generation, status machine with guarded transitions, expiry with reason, dismissed list, `reason_template_key` + why-line renderer in `packages/ui`, opportunity PostHog events.
Read first: main §7.4–7.9, §9.6.4–9.6.5 (formulas), §13 `opportunities`/`opportunity_tasks`/`dismissed_opportunities`, §14.7 (opportunity events).
Done when: all 8 worked examples yield the specified action; competitor-gap fixture yields CREATE without a URL and OPTIMIZE with a URL at #18; re-running detection updates the open row (row count unchanged); expiry keeps the row; every why-line is produced by the template renderer (test: renderer has no LLM import).
Invariants: 6, 7, 8, 10.

**T3.7 — Signal runs & Limited Intelligence (M3 exit gate)**
Scope: onboarding run (after `ready_for_planning`; seeds the calendar via `TopicScheduler`; `opportunities_ready` emission), weekly scan (Mondays, persona clock; expiry; label recompute hook for T7.1), event-driven runs from drift, `signal_runs` accounting, SSE for the "finding opportunities" state, `/api/opportunities` routes with 409 codes.
Read first: main §7.5, §6.9, §7.11, §14.3 (idempotency), §14.7; ui §3.8, §5.4; tech §1.6, §3.
Done when: full run on the synthetic store produces the expected opportunity set in both full and limited modes; running the weekly scan twice converges; chaos case "kill during scan" converges; Lane D's Gate 1 tests pass against the real `existingTargetCheck`.

### M4 — Content Engine · Lane D

**T4.0 — Schema wave 3**
Scope: `topics, articles, gate_decisions, article_product_refs, article_labels, pattern_stats, refresh_log, not_interested, publish_intents` + constraint tests (publish_intents unique external id; topics ↔ opportunities FK).
**Plus two additions from `docs/content-pointers.md`:** `article_claims` — one row per assertion an article makes, carrying its text, its kind (a fact about this store · a fact about the world · something that follows arithmetically from other claims · a judgement about fit), the evidence behind it (which product, which page, which quoted passage), how confident we are, how fast it goes stale, and which sections used it; and — this one required by the founder decision of 2026-09-01 (`DECISIONS.md`) — the storage for **product references**: an article body holds a placeholder where a price, stock state, sale status or product URL would go, so `article_product_refs` must also carry which fields each reference renders and the values it last resolved to, alongside the body.
Read first: main §13 (those tables), §14.3.7; `docs/content-pointers.md` §1 and §9.
Done when: constraint tests fire; a claim row cannot exist without at least one evidence entry; a reference row names at least one field to render.

**T4.1 — Topic model & Gate 1**
Scope: topic entity with intent class, family mapping, `opportunity_id`, `keyword_cluster` lineage; Gate 1 checks (demand floor per locale, winnability with GSC calibration or constant, substance inventory over merged facts, **existing-target check via contract**, intent/commercial relevance), reason codes + user-facing reason cards — **each carrying a retry condition** (retry by itself when the catalogue updates, or when the search results are re-checked, or never) and a redirect where one exists, so a held-back topic resolves itself when the merchant acts instead of becoming a dead end; manual-add path with proceed/warn/convert/reject outcomes, `gate_decisions` logging with `prompt_version`/`rules_version`.
Read first: main §8.1, §8.2, §8.6 (reason card), §8.7 (manual add), §7.7, §13 `topics`/`gate_decisions`.
Done when: table tests per check; a manual topic whose cluster matches an inventory page returns `converted` with the OPTIMIZE opportunity id; every rejection writes a `gate_decisions` row with `reason_user_facing`.
Invariants: 6, 9.

**T4.2 — Calendar & topic state machine**
Scope: topic states with guarded transitions; operations veto (gap kept, `not_interested`), move/swap, pin, add; lock semantics (veto after dequeue cancels publication, cost absorbed); `TopicScheduler` contract filled; `/api/calendar` with 409 codes; calendar PostHog events.
Read first: main §8.7, §14.3.1; tech §3; ui §6.1 (interaction rules only).
Done when: veto of a `generating` topic parks the draft and never publishes; drag onto a pinned day is rejected; deleted topic fingerprint is never re-proposed by a fixture replenishment; concurrent veto + dequeue race yields exactly one winner (guard test).
Invariants: 14, 15.

**T4.3 — Evidence pack, Gate 2, article construction**
Scope: evidence-pack assembly (fact sheets, SERP snapshot + top-3 content via shared fetcher, competitor angles, family axes, images from catalog, existing-target link tasks); Gate 2 distinct-claim check; templates by intent class with axis-derived skeletons; SERP-matched length; internal-link requirements; metadata + stable slug; Sonnet draft via `LlmClient` (`call_type: draft`).
**Plus, from `docs/content-pointers.md`:** a **claim plan written before the draft** — every assertion the article will make, enumerated and bound to its evidence, with weakly-supported ones dropped and recorded as gaps rather than softened into vagueness; the writer is given the approved claims, **not the raw evidence pack**, so there is no route to asserting something no claim covers. The draft cites each assertion inline with a marker that is stripped before publish. Section shapes gain a **named failure condition each** (a comparison that refuses to recommend has failed; a sizing article whose answer is not in the first paragraph has failed) and three further shapes — sizing, troubleshooting, category explainer. **The answer goes in the first paragraph, before any heading**, in every shape. An FAQ appears only where the research turned up questions the body does not already answer, never as a default block. Volatile values are written as references, never as figures (founder decision, `DECISIONS.md`), and **prose may not build an argument on a price** — "the cheapest in the range" is banned, because a figure rendering correctly does not make a sentence reasoning about it true.
Read first: main §8.3, §9.2, §7.7 step 4 (link tasks), §6.4 (axes), §12.1 (SERP cache); `docs/content-pointers.md` §1–§6, §9.
Done when: a pack with 90% boilerplate is rejected at Gate 2; buying-guide draft for the shoe fixture has sections named by the family's axes; every product claim in a fixture draft maps to a pack fact (grounding harness); images are catalog URLs only (no generated/proxied image, grep + test); no draft contains a currency figure as literal text (test); the claim plan exists and is persisted before the draft call is made (call-order assertion); the writer's prompt contains the claim list and not the raw pack (test).

**T4.4 — Gate 3: lints, blind judge, repair loop, override**
Scope: deterministic lints (length floor, near-duplicate vs own articles and SERP, broken/missing links, stuffing); blind judge (separate call, draft + pack + top-3 only, per-criterion 1–5 with justifications, min-not-average floors); exactly one repair loop; `gate_decisions` audit rows; `published_via_override` path with logging and exclusion flag; `JudgeLite` contract filled; `judge.eval` (MAE ≤ 0.5, zero false-pass).
**Plus, from `docs/content-pointers.md` §7–§8 — all free, and all run before any judge call, because a draft with a broken table should never cost one:** every sentence carrying checkable content (a number, a unit, a percentage, a duration, a superlative, an absolute, an attributed statement, a comparison) **must carry a citation, and an uncited one fails** — the check scans for such content independently rather than trusting the markers, so a forgotten citation fails rather than passes; each cited claim must match its evidence, with claims that follow arithmetically **re-derived in code**; the strength of a sentence must match the strength of its evidence, so words like *always*, *never*, *guarantees*, *the only* are permitted only on a strongly-supported claim and never on a recommendation; **the document must not contradict itself** — extract every number, threshold, recommendation and absolute, group them by what they are about, require agreement, and send only genuine candidate conflicts to a model to decide whether two statements are scoped differently or actually disagree; and structural validity (ragged table rows, duplicate headings, skipped heading levels, broken links, unresolvable or duplicated references, invalid structured data, unclosed markup, internal metadata leaked into the body). Judged criteria gain **ecommerce usefulness** — is the decision identifiable, are the trade-offs stated, is the next step obvious, has it become a sales pitch. **Information gain failing ends the run with no repair attempt** (founder decision, `DECISIONS.md`); every other criterion keeps its single attempt.
Read first: main §8.4, §8.5, §8.6, §14.2, §14.4 (never downgrade), §9.6.7; `docs/content-pointers.md` §2, §3, §7, §8.
Done when: eval passes in CI; test proves the judge call's messages contain no writer conversation; a 5/5/5/1/5 draft fails; second regrade failure → `rejected` with no third loop (call-count assertion); override sets the flag and the row is absent from the calibration query; **a draft failing only information gain is rejected with zero repair calls (call-count assertion)**; a sentence with a number and no citation fails; a draft saying "above 300 kg" in one section and "above 200 kg" in another fails; a draft failing structural validity consumes no judge call (call-count assertion).
Invariants: 11, 12.

**T4.5 — Daily generation cycle & draft review**
Scope: per-account daily scheduler anchored to persona timezone, one dequeue max, today-only rule, checks in order: kill switches → entitlement → vacation → Shopify token → topic for today; pipeline orchestration through gates; `in_review` state with approve/discard (no editor); `articles` state machine.
Read first: main §9.1, §9.3, §8.7 (gap rule), §14.5 (dequeue checks), §4.2 (entitlement), §14.6 (vacation).
Done when: a day with no scheduled topic produces no dequeue (assert future topics untouched); `past_due`/vacation/kill-switch each block dequeue; two scheduler passes on one day dequeue once; review-on account lands drafts in `in_review`; grep proves no edit endpoint for article bodies.
Invariants: 14, 16, 17.

**T4.6 — Replenishment & candidate scoring (M4 exit gate)**
Scope: monthly replenishment when horizon < 60 days; candidates from `OpportunitySource` (real, post-M3) scored with pattern multipliers (stub patterns until T7.1), source bonus, refresh ≤ 40%, exploration ≥ max(2, 15%), pinned/moved topics untouched, why-lines from scoring record, `replenishment_completed` event.
Read first: main §9.6.1, §9.6.4, §9.6.5 (cap), §9.6.6, §9.6.8, §9.6.9, §7.5 (cadence).
Done when: a fixture batch respects refresh/exploration shares; pinned topics unchanged across two runs; every filled slot carries a why-line and `opportunity_id`; full M4 flow (opportunity → topic → gates → article in `in_review`) runs on the synthetic store; chaos case "kill mid-generation" converges.

### M5 — Publishing & repair · Lane D

**T5.1 — Export mode & publish-hour scheduling**
Scope: 09:00 persona-timezone publish hour (configurable, IANA), generation cycle timed to finish before it; export bundle (Markdown + HTML + metadata + image URLs — never bytes) **with every product reference resolved against the live store at the moment the bundle is built**, so a downloaded article never carries a stale price; "mark as published" URL confirm validated against the claimed domain; GSC attribution link.
Read first: main §9.4, §9.5 (export), §12.2 (attribution); tech §2.1 (no image bytes); ui §6.2.
Done when: bundle contains only `cdn.shopify.com` image URLs; URL on another domain rejected; publish-hour test across three timezones; export article appears at the hour, not at gate pass; a bundle built after a fixture price change carries the new price and no unresolved placeholder.

**T5.2 — Auto-publish: second grant, blog target, two-phase publish**
Scope: `write_content` OAuth only from Settings/first-publish; blog picker + one-click create; `publish_intents` protocol (intent in the same transaction as article state, execute with `external_id` metafield/tag, confirm, 5-min recovery sweeper querying the remote marker, abandon after 3 → DLQ); update protocol per revision, conditional on stored id, never create; live vs Shopify-draft setting.
**Plus (founder decision, `DECISIONS.md`):** every product reference in the body is **resolved immediately before publish and again on every republish** — from the live store, never from the research snapshot the article was written against — and the resolved values are stored alongside the body. A product that has gone missing fails the publish and raises a repair rather than publishing a hole; a changed URL or title renders the new one.
Read first: main §9.5, §14.3.7, §13 `publish_intents`/`shopify_conns`; ui §9.1; `docs/content-pointers.md` §9.
Done when: dev-store smoke publishes once; **chaos case kill-between-execute-and-confirm yields exactly one remote article**; update on a remotely-deleted article surfaces a card and creates nothing; auto-publish cannot be enabled with `target_blog_id = null` (API test); read-only grant contains no write scope (re-assert); a fixture price changed between generation and publish appears at its new value in the published body; a deleted referenced product fails the publish and opens a repair instead.
Invariants: 19, 21.

**T5.3 — Drift & repair (M5 exit gate)**
Scope: `article_product_refs` written at generation; drift policies table (deleted → repair ≤ 24 h; OOS ≥ 14 d; axis change; collection deleted) driven by `CatalogEvents`; **the price-drift trigger is retired** — per the founder decision of 2026-09-01 (`DECISIONS.md`) a price is never stored as text, so a price change re-renders the affected references and consumes no calendar day, and main §14.1's "price differs ≥ 20 % → refresh queue" row no longer applies; repair queue by delivery mode (`auto_repair` mechanical fixes only; prose changes through Gate 3; export accounts get action cards); repairs logged before/after; each drift row also creates/updates a `product_change_impact` / `broken_product_reference` opportunity.
Read first: main §14.1, §7.3 (those rows), §7.5 (event-driven), §9.6.7 (pending repairs excluded).
Done when: deleting a fixture product flags every referencing article within the sweep; a fixture price change queues **no** refresh and consumes no calendar slot (assert the day's topic is untouched); export account receives a card and no edit; auto-publish account's mechanical repair goes through `publish_intents` update; the drift opportunity appears with evidence; chaos test now covers ingest → generate → publish → repair end to end.

### M6 — OPTIMIZE & FIX · Lane E

**T6.1 — Intent-gap analysis**
Scope: subtopic coverage call (Sonnet, schema) over page body + top-5 SERP content via shared fetcher, cached by `(page_checksum, serp_snapshot_id)`, budget-guarded; wired both as the *Existing Page Intent Gap* signal (weekly scan, shortlisted pages only) and as step 2 of the recommendation pipeline.
Read first: main §10.3 (steps 1–2), §7.3 (Intent Gap row), §14.2, §14.5 (per-type cap).
Done when: example 4 fixture yields the gap set with per-subtopic evidence; unchanged page + same snapshot → cache hit, zero cost; cap exceeded → call type paused, generation unaffected.

**T6.2 — OPTIMIZE recommendations**
Scope: on-demand generation (cap 2/day config), evidence pack, Sonnet recommendation JSON per page type, lints (grounding via `facts_used`, no duplicate paragraph, link targets exist, lengths, stuffing) with one regeneration then `failed_validation`, `JudgeLite` grounding + intent floors, storage/supersession, download (MD/HTML), mark-applied → `completed` + outcome scheduling, heuristic applied-detection prompt on next inventory sync; `/api/recommendations`.
Read first: main §10.1–10.4, §7.9 (policy), §13 `optimize_recommendations`; ui §5.3 (view shape only).
Done when: every `facts_used` resolves in fixture output; a planted duplicate paragraph fails lint; grep proves no Shopify write call in `packages/core/optimize`; third request in a day returns the cap error; mark-applied schedules an outcome row at +28 d.
Invariants: 8, 21.

**T6.3 — FIX recommendations & blocking preconditions (M6 exit gate)**
Scope: cannibalization consolidation recommendation (primary URL choice with reason, internal-link realignment list, canonical suggestion — text only), FIX task rendering, blocking-precondition propagation (open blocking FIX → CREATE/OPTIMIZE on same entity `blocked`), our-article OPTIMIZE/REFRESH routed to the refresh pool (T7.2 seam).
Read first: main §11, §7.9 (technical blockers), §10.5, §7.8 example 5.
Done when: example 5 produces a FIX with the three task kinds; a blocking FIX on a collection blocks an OPTIMIZE on it; grep proves no redirect/canonical write path exists.

### M7 — Learning & outcomes · Lanes C + D · **DEFERRED — not in the first deployment**

> **Founder decision, 2026-09-02: the learning loop does not ship in v1.** Both cards
> below stay in the plan and stay unbuilt. Nothing else depends on them — `M10`'s exit
> gates do not read outcomes — so deferring costs no other card. What the product gives
> up until they are built: it never learns from what it published. Every article is
> written from evidence, none from what worked last time; no verdict is ever attached to
> a published piece, and no pattern is ever extracted from the store's own results. The
> plan's dependency line `After T5.1 + T3.7: M7 (C+D)` is suspended, not deleted.

**T7.1 — Labels, patterns, per-opportunity outcomes**
Scope: weekly label recompute (28-day maturity, relative thresholds, winner/neutral/underperformer/unrated), `pattern_stats` over intent_class / family / keyword_cluster / **action_type** with n ≥ 3 activation, multipliers clamped [0.5, 2.0] over 90 days, exclusions (override, young, pending repair, unconfirmed export), OPTIMIZE/REFRESH/FIX outcomes written to `opportunities.outcome_json`, `article_labeled` and `opportunity_outcome_measured` events; replaces T4.6's stub patterns.
Read first: main §9.6.2, §9.6.3, §9.6.7, §9.6.10, §13 `article_labels`/`pattern_stats`.
Done when: an article at day 27 is `unrated`, at day 28 labelled; multiplier of a 3-winner pattern = 1.25 and stacking stays within clamps; an override article is absent from every pattern query; OPTIMIZE outcome `improved` fires on the fixture delta.
Invariants: 12, 13.

**T7.2 — Refresh candidates & cooldown (M7 exit gate)**
Scope: refresh eligibility (position 5–15 config, impressions ≥ median, 60-day cooldown via `refresh_log`, no pending repair, not override), expected-gain scoring, ≤ 40 % share enforced in replenishment, "Request refresh" endpoint honouring cooldown, our-article OPTIMIZE routed here.
Read first: main §9.6.5, §10.5, §7.3 (Striking Distance row), ui §6.3 (button state).
Done when: an article refreshed 30 days ago is ineligible; expected-gain ordering matches the §9.6.5 example (pos 6 / 10k beats pos 12 / 800); replenishment fixture with many eligible refreshes caps at 40 %.

### Remediation cards — created 2026-09-02 by the integrator from scheduled audits

Build plan §7 says audit findings become cards or `DECISIONS.md` entries. These two come
from the **scheduled `T2.2` audit** and are recorded here so they cannot be lost in a
report. Neither has been acted on: the overnight rules forbid the integrator from fixing
an audit finding. **`R-PRIVACY` should be done before any Shopify Partner credential
exists.**

**R-PRIVACY — the webhook receiver must stop storing shoppers' personal data** · Lane B
Scope: the Shopify webhook receiver stores the entire message body verbatim for every topic it accepts, and the two customer-privacy topics (`customers/redact`, `customers/data_request`) carry a shopper's `email` and `phone` inside a `customer` object. The drain then logs the literal answer "no customer data held" about a row that holds exactly that, and nothing deletes it. Reduce the stored body for the three privacy topics to the non-personal envelope (`shop_id`, `shop_domain`, the id lists), or store no body for them at all.
Read first: main §14.6, §6.2, §17.3; the `T2.2` audit's critical finding as recorded in `docs/overnight-state.md`.
Done when: a realistic `customers/redact` body is planted **through the receiver** and a test asserts the stored row contains none of the shopper's values — the same non-vacuity shape `packages/core/src/catalog/orders.test.ts` already uses, which plants a full order and proves the fixture really contained what was stripped. The existing invariant-4 test cannot catch this because it scans **column names** and this data sits inside a JSONB blob; extend it or add beside it.
Invariants: 4.
Note: the answer we give Shopify is the correct one. It is the data we keep that is wrong.

**R-STREAM — the change stream has a producer and no consumer, and the check that would have said so was switched off** · integrator to assign
Scope: `T2.2` filled the `CatalogEvents` seam on the producer side and it works. Nothing in production registers or enqueues the consumer — `registerCatalogEventTasks` has zero production callers and `DatabaseCatalogEvents` is referenced only from its own test — so Lane C's event-driven inventory freshness is dark and the inventory is only as current as the nightly walk. Meanwhile `scripts/stub-report.mjs`, whose job is to fail a milestone when the product is running on a stand-in, had the corresponding line removed on the grounds that the seam was filled. The seam is now neither stub nor wired, and reported as done.
Read first: build plan §4 (the `CatalogEvents` contract); main §12.3, §14.1; the `T2.2` audit as recorded in `docs/overnight-state.md`.
Done when: either the consumer is registered in the composition root and the sweep enqueues a drain per store, **or** the stub-report line is restored until someone does — and in both cases a test proves the report tells the truth about whether the seam is wired.
Note: the ownership is genuinely open — the producer is Lane B's, the consumer is Lane C's, and the report is nobody's. That is why this is the integrator's to assign rather than a lane's to take.

### Founder authorisations of 2026-09-04 — the remediation cards

Sixteen decisions came back on the build docket. These are the ones that are work. Each cites
its `DECISIONS.md` entry of the same date; **read that entry before the card**, because it
carries the reasoning the founder gave and the cost they accepted.

**R-GRAPH — the opportunity state graph matches what the product actually does** · Lane C
Scope: three status moves the improve-this-page feature performs (`new`/`accepted` → `executing`, `executing` → `accepted`) are absent from the project's written state graph, and nothing objects because the database helper never consults it. The auditor judged the code right and the graph wrong. Correct the graph. **Do not change the transitions the code performs.**
Read first: `DECISIONS.md` 2026-09-04 "The OPTIMIZE state graph is corrected, not the code"; main §7.9; the `T6.2` audit in `docs/overnight-state.md`.
Done when: the graph admits every transition the OPTIMIZE path performs; a test drives an opportunity through the full improve-this-page lifecycle against the graph and it is accepted at each step; and a transition the graph does *not* admit is still refused, proved by attempting one.
Note: **this is the only thing stopping `T6.3`.** Keep it that size.

**R-OPTIMIZE-STUCK — the improve-this-page button stops breaking accounts** · Lane E
Scope: two findings that produce the same permanent stuck state, fixed together because fixing either alone leaves the other reachable. (a) Pressing the button marks the opportunity busy *before* queueing, so two presses consume the store's daily allowance for ever and the guard then refuses to retry them — recoverable only by editing the database. (b) There is no way out of the busy state when the work is refused or crashes: the job returns the row on exactly two paths (success, and failing its own checks), while a paused call type, a page missing from the inventory and any unexpected error leave it where it is. No sweeper, timeout or reaper exists anywhere — grep before assuming one does.
Read first: `DECISIONS.md` 2026-09-04 "The OPTIMIZE stuck states are fixed"; main §7.9, §10.1–10.4; the `T6.2` audit in `docs/overnight-state.md`.
Done when: a press that never gets picked up does not consume the allowance; two presses in a row leave the opportunity retryable; a refusal, a skip and a thrown error each return the row to a state the merchant can act from; and a row somehow left busy is recovered rather than stranded, proved by planting one. **The allowance must count work that actually happened, not rows that were marked.**
Note: the job's registration in the composition root is still deliberately held. **Say in your report whether this card makes it safe to register, and write the line into the report — do not apply it.**

**R-NOQUERY — we stop buying search results for a web address** · Lane E, placed by the integrator (spans two lanes)
Scope: three of the four signals that produce an improve-this-page suggestion record a search term; `missing_or_weak_metadata` records none, and the pipeline falls back to **the page's own web address as the search**. It then pays the search vendor for results for that address, tells the model "the search: <that address>", and measures keyword stuffing against the words in a URL. **The fix is to refuse, not to substitute:** resolve a real search term from the store's existing query clusters for that page, or do not offer the recommendation and say why.
Read first: `DECISIONS.md` 2026-09-04 "A signal with no search term stops buying search results for a web address"; main §7.3, §10.3, §14.5.
Done when: a signal carrying no search term never reaches the search vendor — asserted by *measuring* that the provider recorded zero calls, not by asserting a mock; a page with a resolvable query cluster produces the recommendation normally; a page without one produces no recommendation, spends nothing, and leaves a reason a person can read.

**R-SPEND — the spend brake stops switching OPTIMIZE off for ordinary use** · Lane G
Scope: the nightly sweep counts **model calls** rather than generations, trips at `used >= cap` rather than above it, and the flag is sticky until an operator clears it — so a merchant who uses both of their two daily recommendations, or one that needed its single automatic retry, has the feature off permanently. The same defect applies to the intent-gap call type. Also: when it fires the merchant is shown the outage copy, which tells them we protected their quality when they hit our arithmetic; and the operator-facing incident text states a count that is wrong.
Read first: `DECISIONS.md` 2026-09-04 "The spend brake stops switching OPTIMIZE off for ordinary use"; main §14.5, §14.4, Appendix A; invariant 22.
Done when: a store using its full daily allowance is not tripped; a generation that needed its one retry is not tripped; the trip clears on its own cadence rather than needing an operator; the intent-gap type behaves the same; and a merchant who *is* legitimately paused sees copy that is true of what happened. **The outage sentence is canonical — if it no longer fits this case, say so and stop rather than rewording it.**

**R-PUBLISH — four defects in the publishing path, and the visible tag goes** · Lane D
Scope: all four live in the same code and would collide as separate cards. (a) The did-my-post-land check reads one page of up to 250 recent articles with no paging and no server-side filter, so an established blog can answer "no" when the answer is yes and get a **second copy posted** — the exact duplicate the two-phase protocol exists to prevent. (b) A transient Shopify failure at the moment of posting strands that article for ever: no error handling, the retry collides with its own claim and reports "already claimed" every day after. And a rejected token is never reported to the merchant, though the machinery exists and drives the reconnect banner and the 24-hour email. (c) The address recorded for a published article uses the blog's numeric id where Shopify uses its name-slug, so Search Console attribution can never match it and a working article appears to earn nothing for ever — **the correct value is already stored and unused.** (d) **Every published article carries a `sortiva-<id>` tag in the merchant's own Shopify admin, which can surface in storefront tag lists their shoppers see. The founder's answer is no visible tag anywhere.** The real marker is a metafield and stays; the tag was a duplicate, written every time because the recovery sweep reads it out of a plain list response. Removing it means the sweep must find the article by metafield — the extra request per article that the tag existed to avoid, and the cost the founder accepted.
Read first: `DECISIONS.md` 2026-09-04 "The publishing path's four defects are fixed together"; main §9.5, §14.3.7, §12.2; invariants 19 and 22; the `T5.2` audit in `docs/overnight-state.md`.
Done when: a blog holding more than one page of articles still finds our post rather than posting a second — **with a fake that can actually paginate, because the present one cannot fail the way a real shop fails, and that is why no test caught this**; a transient failure at the moment of posting leaves the article retryable rather than stranded; a rejected token raises the same reconnect the rest of the product already raises; the recorded address is the one Search Console will see; and no article we post carries any tag, asserted on what is sent to the shop.
Note: `T5.3`'s repair path republishes through this same code, so it is now exercised without the merchant clicking anything.

**R-OPTIMIZE-WIRE — the improve-this-page button reaches a worker that answers** · Lane E, with one authorised cross-lane edit
Scope: `R-OPTIMIZE-STUCK` made registering the OPTIMIZE job safe — the stuck states that made wiring it dangerous are gone. It is still not one line, because the job needs the process's Anthropic client and the generation lane memoises its own privately in `apps/web/app/api/articles/_lib/config.ts` without exporting it. Two cards in a row correctly refused to build a second one.
**The integrator's decision, taken 2026-09-04:** export the existing memoised factory under a process-wide name and use it from the recommendations config. **Not** moving construction into the composition root — the root imports the deps *from* these config files, so building the client there would invert that direction and force a client argument through every deps factory, for no behavioural gain. What matters is that the process has exactly one client, and exporting achieves that.
So: (a) export the memoised client factory from the articles config — **an authorised cross-lane edit, and the only change permitted in that file**; (b) build `optimizeTaskDeps()` in `apps/web/app/api/recommendations/_lib/config.ts`; (c) write the composition-root registration into the report — **integrator-resolved, do not apply it.**
Read first: `DECISIONS.md` 2026-09-04 `R-OPTIMIZE-STUCK` entries and the `R-INTENTGAP-JOB` entry that first raised this; the header comment of `apps/web/instrumentation-node.ts`, which states the one-client rule this follows.
Done when: the process constructs exactly one Anthropic client, proved by a test rather than by inspection; the job's dependencies are built without opening a database connection at registration time; and pressing the button end to end reaches the worker in a test that would fail if the registration were absent.
Note: `R-INTENTGAP-JOB`'s own registration waits on the same client and can be wired in the same card. Say in your report whether you did, and why or why not.

### Founder decisions of 2026-09-04 evening — the second wave of cards

Thirteen decisions in one pass. Each card cites its `DECISIONS.md` entry of the same date;
**read that entry before the card** — it carries the founder's reasoning and the cost they
accepted, which the card text does not repeat.

**T-WAVE5 — schema mini-wave: a fifth article state and a sessions table** · integrator to assign
Scope: one migration, two additions, nothing that reads or writes either. (a) A fifth value on the article state, meaning **cleared to deliver** — for an article a merchant publishes over a quality rejection. Today it returns to `draft`, which already means "written, not yet graded", so one value covers three situations and the only thing separating them is a flag whose meaning is "excluded from learning". (b) A `sessions` table, so a signed-in session can be revoked before it expires — there is none anywhere today, and a session must exist somewhere before anything can delete it.
Read first: `DECISIONS.md` 2026-09-04 "An overridden article gets its own state" and "Sessions become revocable".
Done when: the migration applies forward from an empty database; an article can still exist in every state it could before; a session row can be written and deleted; and nothing in the product yet reads or writes either — the cards below do that.

**R-REVOKE — signing out signs you out, and a deleted account locks out at once** · Lane G, after `T-WAVE5`
Scope: sessions become revocable. Signing out revokes rather than only clearing the cookie in that browser; deleting an account or losing a credential locks out immediately. **Revisit the 24-hour session lifetime in the same card** — it is short only because revocation was impossible, so the reason for the number goes with this change.
Read first: `DECISIONS.md` 2026-09-04 "Sessions become revocable"; main §4.1; tech §3.
Done when: a copied session cookie stops working the moment its session is revoked; signing out in one browser ends the session everywhere; deleting an account revokes every session it had; and the cost the founder accepted — a database read on every signed-in request — is the only read added.

**R-OVERRIDE-STATE — an overridden article stops pretending to be a draft** · Lane D, after `T-WAVE5`
Scope: an article published over a quality rejection moves to the new fifth state instead of `draft`, and **does not pass through draft review** on accounts that have review turned on. Every read that asks "which articles go out today" is updated to name the new state rather than joining the decision table to work it out.
Read first: `DECISIONS.md` 2026-09-04 "An overridden article gets its own state"; main §8.6, §9.3.
Done when: an overridden article is delivered without a gate decision saying `passed`; it never appears in a review queue; and an un-graded draft still cannot be delivered by mistake — proved by planting one.

**R-PUBLISH-2 — a repair sends only our words, and the address is the one shoppers visit** · Lane D
Scope: two founder decisions in one path. (a) An update sends the title, body and summary and **omits the article's address, its tags and its published state**, so a merchant's rename, their own tags and their choice to unpublish survive a repair untouched. The account's live-or-draft setting applies at creation and not on later updates. (b) The address recorded for a published article uses **the merchant's own claimed domain**, not the `myshopify.com` host, so Search Console attribution can finally match. We already hold the claimed domain per account; the publishing client is one per process, so it needs somewhere to look one up rather than holding one.
Read first: `DECISIONS.md` 2026-09-04 "A repair sends only the words we wrote" and "A store's own claimed domain is the address we record"; main §9.5, §12.2, §14.3.7.
Done when: a repair on a post the merchant renamed, tagged and unpublished leaves all three as they left them — asserted on what is sent to the shop, not on our intent; a newly published article records the claimed domain; and an article published before this change is not silently re-addressed.

**R-STRANDED — a run killed before midnight is finished or given up on, loudly** · Lane D
Scope: a sweeper finds generation runs stranded past their own day, finishes the one furthest along, and dead-letters the rest so a person is told. **This is what turns the deliberately-red chaos scenario green** — do not change the scenario to make it pass; make the product converge.
Read first: `DECISIONS.md` 2026-09-04 "A stranded generation run is swept"; main §8.7, §9.1, §14.3; the `T4.5` audit in `docs/overnight-state.md`.
Done when: `generation_cycle_killed_across_midnight` passes for the right reason; a stranded run that cannot be finished leaves a dead letter rather than silence; and a calendar day is never given an article it was not scheduled for.

**R-RUNWAY — ten hours of runway, not six** · Lane D
Scope: writing starts ten hours before the store's publish hour rather than six. One number, in `packages/rules`, with a plain-language note saying what it decides and what moving it costs.
Read first: `DECISIONS.md` 2026-09-04 "The generation runway widens".
Done when: a store publishing at 09:00 starts writing at 23:00 its own previous evening; the publish-hour tests still pass across three timezones; and the day a run belongs to is unchanged by the widening.

**R-GRAPH-ENFORCE — the state graph starts refusing, and a merchant may dismiss running work** · Lane C
Scope: (a) Every status write on an opportunity consults the graph first, and a move the graph does not list **fails loudly**. (b) The graph gains the edge that lets a merchant press "not interested" on a suggestion the product is already working on, and the work is abandoned.
Read first: `DECISIONS.md` 2026-09-04 "The opportunity state graph starts refusing moves" and "A merchant may dismiss work already running"; main §7.9, §14.3.1; the `R-GRAPH` section of `docs/overnight-state.md`.
Done when: every path in the product that writes an opportunity status is exercised and passes — **this is the card's real work, and a path missed here breaks a working feature in production**; an unlisted move raises rather than writes; dismissing running work succeeds and stops the work; and the graph and the repository's own guards do not disagree anywhere, proved rather than asserted.
Note: `R-GRAPH` found two disagreements by hand in one day, one of them the most common completion in the whole improve-this-page feature. **Assume there are more and go looking before switching enforcement on.**

**R-RECO-QUALITY — three changes to what a recommendation may rest on and say** · Lane E
Scope: (a) The writing prompt asks for at least one fact from the merchant's own catalogue per suggested section where one exists. **No lint, no hard failure, and no counting** — the founder declined a report-only measurement explicitly. (b) The `rationale_key` field is explained in the prompt, which never mentions it today though the schema requires it; it stays free prose and is **labelled on screen as model-written**; its name should stop implying it is a catalogue key. (c) The weekly comparison pass shortlists fewer pages than the store's daily allowance, so the merchant-pressed path always has room.
Read first: `DECISIONS.md` 2026-09-04 "Grounding in the merchant's own facts", "The recommendation's rationale", "The scheduled comparison shortlist shrinks"; main §10.3, §10.4, §14.5.
Done when: the prompt carries both instructions; the model-written line is labelled wherever a merchant sees it, including the download; and a store using the scheduled pass in full can still press the button its allowance permits.

**R-GATE-LANG — every language gets the same citation bar** · Lane D
Scope: **remove** the English superlative, absolute, attribution and comparison word lists rather than extend them per language, and move the instruction into the writing prompt: cite every superlative, absolute, attributed statement and comparison, in whatever language the store publishes in. **Shape-based detection stays exactly as it is** — numbers, measurements, percentages and durations are found by pattern and remain deterministic in every language.
Read first: `DECISIONS.md` 2026-09-04 "The citation word lists go"; main §8.3, §8.4.
Done when: an English draft and a Danish draft are held to the same bar; the shape-based checks still fail an uncited number in both; and nothing anywhere still branches on whether a lexicon exists for a language.
Note: the founder was told the cost before choosing and accepted it — for these four claim kinds nothing deterministic stands behind the model any more. **Do not quietly reintroduce a list.**

**R-HOLD — a deleted account's domain is released on the deadline, job or no job** · **Lane A** (integrator placed it in Lane G by mistake; the claim path is Lane A's and the card's own done-when names it) · **LANDED**
Scope: the seven-day hold on a deleted account's domain is delivered by something that does not depend on a cleanup job having run. Today the hold is the job deleting the row, so if the job never runs the domain is blocked for ever.
Read first: `DECISIONS.md` 2026-09-04 "The seven-day domain hold stays" and the original question in `docs/overnight-state.md`; main §2, §5, §14.6; invariant 1.
Done when: a domain deleted eight days ago can be claimed even if the cleanup job has never run; one deleted six days ago cannot; and the claim path is still insert-with-conflict rather than check-then-insert.

**R-JUDGE-COPY — the judge cannot be downgraded, and its words reach a merchant in English** · Lane D
Scope: (a) The judge tier stops honouring the `ANTHROPIC_MODEL_*` environment override, which ships in `.env.example` and would let an operator point the judge at the cheap model with neither the code nor CI noticing — while the spend was misreported, since the expensive price list is kept. The override stays for every other tier. (b) The judge's own justification may be shown to a merchant verbatim, and is **always in English** whatever language the store publishes in.
Read first: `DECISIONS.md` 2026-09-04 "The quality judge's model cannot be changed by configuration" and "The judge's own sentences may reach a merchant"; main §8.4, §8.6, §14.4; invariant 11.
Done when: setting the judge's model by environment variable is refused or ignored, proved by trying it; every other tier still honours it; and a Danish store's rejection card carries an English justification rather than a mixed-language sentence.

**R-QUOTA — our own failure never costs a merchant a day, and we can see when it does** · Lane D
Scope: a draft that fails our own quality gate does not consume the store's daily allowance, and **the rate at which that happens is measured and visible to an operator**. The founder named the measurement as the load-bearing half: a quota that silently absorbs our failures looks identical to a quota the merchant used.
Read first: `DECISIONS.md` 2026-09-04 "A quality failure of ours never costs the merchant a day"; main §4.2, §8.4, §9.6.
Done when: a gate rejection leaves the day's allowance intact; the count of days lost to our own failures is queryable per account and in aggregate; and **nothing of that count is shown to a merchant** — no denominators, per invariant 23.

**R-SCANCOPY — the empty state stops promising Monday** · Lane F
Scope: the canonical sentence telling a merchant with no open opportunities when the next scan runs becomes **relative** — "next scan in x days" — rather than naming Monday. Quoted copy, changed on the founder's word. The snapshot test that holds it moves with it.
Read first: `DECISIONS.md` 2026-09-04 "The empty-state scan line becomes relative"; main Appendix A; ui §5.
Done when: the empty state and the screen's own header can never contradict each other, whichever day a store's scan falls on; and the snapshot test holds the new string as firmly as it held the old one.

**T7.2 — the refresh pool** · Lane D · **UN-DEFERRED 2026-09-04 by the founder**
Scope: as written in M7, and **only this card** — the rest of M7 (labels, patterns, per-opportunity outcomes) stays deferred. A suggestion landing on one of our own published articles is refused today with nowhere to go, so the merchant sees a card they can do nothing with. This is where that work goes.
Read first: `DECISIONS.md` 2026-09-04 "The refresh pool comes forward"; main §9.6.5; the `T6.3` section of `docs/overnight-state.md`, which built the refusal and named the request shape the pool consumes.
Done when: a refusal from `T6.3` reaches the pool and becomes work the merchant can see; the pool respects the same placement rules as any other route onto the calendar — no second, quieter path; and a refresh never displaces new coverage beyond the cap the spec sets.

**R-TESTDB — the gate stops crying wolf under concurrent lane load** · integrator to assign
Scope: `pnpm test` fails *files* — never assertions — when several build sessions share the test database. Two shapes, both documented and both re-confirmed on 2026-09-04: files failing on 10-second hook timeouts, and every test passing with a non-zero exit on one Postgres `57P01` teardown error. **It is getting worse**: 13 files on one run and 21 on the immediate re-run, with three lanes active, while all 3,440 tests passed both times. The cause lives in `packages/db/src/testing.ts`, which force-drops each suite's own database and kills a connection a suite forgot to close.
Read first: "The concurrent-load test flake, triangulated across four independent sessions" in `docs/overnight-state.md`.
Done when: a full `pnpm test` under three concurrent lane sessions passes without file-level failures, ten runs in a row; and a suite that genuinely leaks a connection still fails loudly rather than being swallowed by whatever fixes the teardown.
**LANDED 2026-09-07, with a named residue the card deliberately did not fix.** File-level failures, connection refusals and silently skipped suites are gone. What remains: a handful of tests that measure elapsed wall-clock time and exceed their budget when thirty workers share twelve cores. Four were named — `generation/replenish`, `providers/shopify/limiter`, `runtime/runtime`, `generation/veto-topic` — and a fifth sighting has since been reported: **`packages/jobs/src/runtime/runtime.test.ts:571`, "frees the store even when the unlock itself fails"**, failing once under full concurrent load and then passing 60/60 five runs in isolation. Fixing these means changing an assertion or raising a timeout, which is why they were left. **Treat a failure in one of these five under load as unproven rather than as a flake, and capture the name before re-running.**
Note: this is the gate telling the truth badly rather than lying — no assertion has ever failed under it. But a gate that goes red for its own reasons trains people to re-run rather than read, and this project has already had one genuine regression hide underneath exactly that. **A lane found it that way once, which is why re-running is not the same as ignoring.**

**R-REFUSAL — a refusal the merchant can read** · integrator (the contract) + Lane F (the words)
Scope: the product refuses to improve a page when it cannot tell which search that page competes for, and today the button simply spins and comes back. Add one machine-readable refusal code to the frozen contract and one sentence to the copy catalogue; mark the suggestion on the Opportunities screen as needing Search Console connected rather than leaving it silently un-actionable. **The suggestion is still shortlisted** — the merchant keeps the signal that the page's Google listing text is missing or duplicated, which is true whether or not we know its search.
Read first: `DECISIONS.md` 2026-09-07 "A suggestion that cannot name its search"; the `R-NOQUERY` section of `docs/overnight-state.md`; main §7.11, §10.1.
Done when: a store with no Search Console connection sees why the button cannot act, in its own words rather than a generic error; the refusal still spends nothing and still writes no recommendation row, so no day's allowance is consumed; and the nearest existing code is **not** reused — it would say "already moved on — refreshed", which is untrue.
Note: the contract is the integrator's by rule; the sentence is Lane F's. Sequence accordingly.

**R-DISMISS-CALENDAR — saying "not interested" calls off the article too** · Lane C, with Lane D's calendar
Scope: dismissing a suggestion cancels the calendar topic it produced, if one is booked or being written. Today the suggestion disappears and the article still appears, because the daily cycle works off the topic row and never looks at the suggestion's status.
Read first: `DECISIONS.md` 2026-09-07 "Saying not interested also calls off an article"; main §7.9, §8.7; the `R-GRAPH-ENFORCE` section of `docs/overnight-state.md`, which found this and correctly stopped.
Done when: dismissing a suggestion whose topic is `planned` removes that topic and leaves the day a gap rather than back-filling it; dismissing one whose article is mid-generation stops the run without leaving a half-written draft or a stranded state; and the guarded-update rules hold throughout, so a dismissal racing a publish loses cleanly rather than half-applying.
Note: **this reaches into the calendar's state machine from the opportunities side.** Both lanes' territory — read the calendar's transitions before writing, and if the right shape is a call the calendar owns, say so rather than reaching in.

**R-STOREFRONT — record the address shoppers actually land on** · Lane D
Scope: a store's claimed domain is stored bare (`acme.com`) but its storefront may be `www.acme.com` or `shop.acme.com`. Read the shop's primary domain from Shopify — the scope is already held — and record published articles under it.
Read first: `DECISIONS.md` 2026-09-07 "The published address should use the shop's primary storefront domain" and 2026-09-04 "A store's own claimed domain is the address we record"; main §12.2.
Done when: an article published by a store whose storefront is `www.` is recorded at the `www.` address; a store whose storefront is the bare domain is unaffected; a store we cannot ask falls back to the claimed domain rather than failing to publish; and articles published before this keep their address, as `R-PUBLISH-2` established.

**R-SIGNOUT — there is no sign-out button anywhere in the product** · Lane F
Scope: `R-REVOKE` built revocation and proved it works; **nothing in the interface calls it.** The endpoint exists (the sign-in library's own), every screen was checked and the string catalogue was searched — there is no control that signs a merchant out, and there never has been. Add it where the design puts it, with the copy in the catalogue.
Read first: `DECISIONS.md` 2026-09-07 `R-REVOKE` entries; ui §9 (Settings), §1 (shell).
Done when: a merchant can sign out from the product; doing so ends their sessions in every browser, not just the one they pressed it in; and the copy lives in the string catalogue rather than inline.

**R-SESSION-PRUNE — lapsed sessions are cleared away** · Lane G
Scope: with sessions living thirty days rather than one, dead rows sit thirty times longer. **No schedule change is needed** — the nightly retention sweep already prunes expired sign-in links, and this slots in beside it; the index it needs was added by the last schema wave for exactly this purpose.
Read first: `DECISIONS.md` 2026-09-07 `R-REVOKE` entries; main §14.6 (retention).
Done when: a session past its expiry is removed by the nightly sweep; a live one is untouched; and no crontab entry or task registration is added.

**R-DRAFT-PROMPT — the writing prompt names the fields its schema demands** · Lane D
Scope: the article-writing prompt never mentions `metaDescription`, `sections`, `productId` or `refType`, all of which its answer schema requires. The model fills four fields nobody told it what to put in. **Add the same test `R-RECO-QUALITY` added** — holding the prompt the product actually loads against every field its schema demands — and then make it pass by explaining the fields.
Read first: `DECISIONS.md` 2026-09-07 "The writing prompt must name the fields its own answer schema demands"; the `R-RECO-QUALITY` and `R-GATE-LANG` entries; main §9.2.
Done when: the prompt names every field its schema requires; the test that would have caught this exists and passes; and the prompt is a **new version file**, since a version stamped on a stored article has to keep meaning what it said.
Note: **this changes the articles the product writes** — that is why the lane that found it removed its own test rather than fix it. It is also **ungraded**: `pnpm eval` is the machinery for grading a prompt change and cannot run without an Anthropic key.

**R-SIGNIN-CSRF — the Google sign-in button does not work** · Lane F
Scope: the button on `/signin` posts a bare form with no anti-forgery token, which the sign-in library rejects. Recorded in `DECISIONS.md` by an earlier card and never fixed. The fix is the one `R-SIGNOUT` just used — fetch the token first — and **it would fix email sign-in on the same screen at the same time.**
Read first: the `R-SIGNOUT` entries in `DECISIONS.md` dated 2026-09-07, which contain the working pattern.
**Priority: this outranks everything else queued.** On a deployed server a merchant reaches the sign-in screen and stops, so every other thing the product does is unreachable behind it.
Verified 2026-09-07: `packages/ui/src/public/SignIn.tsx:49` posts `method="post" action="/api/auth/signin/google"` carrying only a `callbackUrl` hidden input and no `csrfToken`. The library refuses that.
**Correction to an earlier version of this card, which was wrong:** there is **no email sign-in form on that screen, or anywhere else in the interface.** The email provider is configured server-side (`apps/web/app/api/auth/_lib/config.ts`) and nothing renders a form for it, so email sign-in is unreachable for a different reason than this bug. **Do not build that form** — it is a feature nobody has asked for, and adding it here would hide the gap rather than report it. Say in your report that it is still missing.
Done when: signing in with Google works end to end against the real library configuration; and a refused attempt is judged by **where the library says to go**, never by its status code.
**Your own test must not be foolable the way the product was.** The library answers a refused sign-in with **200 and an error page**, so a check written against the status passes on a completely broken sign-in. Assert on the destination, and prove the test bites by pointing it at a request you know is refused.

**R-CREATE-COMPLETE — a suggestion whose article was published stays open for ever** · Lane C
Scope: when a CREATE suggestion's article is published, nothing moves the suggestion to `completed`. It sits on the merchant's Opportunities screen indefinitely, indistinguishable from work still to do. Found by `R-DISMISS-CALENDAR`, which had to work around it: on state alone, a day that published a fortnight ago looks the same as one being written right now.
Read first: the `R-DISMISS-CALENDAR` and `R-STRANDED` entries in `DECISIONS.md` dated 2026-09-07; main §7.9.
Done when: publishing an article completes the suggestion behind it; the Opportunities screen stops showing finished work as outstanding; and the completion goes through the enforced state graph rather than around it.
Note: the sibling defect — **a calendar day never leaves `generating` when its article publishes**, so the Content calendar reads "Generating" for every past published day — is the same shape and was reported by `R-STRANDED`. Decide whether they are one card or two before starting; the founder has been asked about the calendar half, which needs a state that does not exist.

**R-PAGE-GONE-WRITE — something notices a merchant deleted a page** · **Lane C's ground, being built from the `lane-b` worktree by `sortiva-a8` under an explicit integrator authorisation of 2026-09-07** (the card was written "Lane B" from the phrase "the store walk" without opening §3; the walk is `core/inventory` and `jobs/inventory`, both Lane C's). Authorised because Lane C is mid-card and its uncommitted files were checked and contain **no** inventory file, so the collision the rule prevents is not live. Scope is `core/inventory/{sync,ports}.ts`, `jobs/inventory/tasks.ts`, `db/repositories/inventory.ts` and nothing else of Lane C's
Scope: `store_pages.status` was added by `T4.0a` as **migration only** — the schema's own comment says "nothing sets this to 'gone' yet and nothing reads it", and that is still true. Verified 2026-09-07: no writer anywhere. The store-page walk must mark a page `gone` when the merchant's store stops serving it.
Read first: `DECISIONS.md` 2026-09-03 "A deleted store page gets a status field" (the founder chose this shape); build plan §6 `T4.0a`, whose note names this follow-up and says explicitly it is **not** a founder question; main §12.3, §14.1.
Done when: a page the store no longer serves is marked `gone` by the ordinary walk; a page that is merely unreachable once is **not** — the founder's decision rejected inferring deletion from a single pass, because an interrupted walk would mark live pages gone; and the marking is idempotent, since the walk runs nightly.
Note: this and `R-PAGE-GONE-READ` were expected to become cards when `T4.0a` landed and never did. **Neither needs a founder decision** — the shape was chosen on 2026-09-03.
**THE TRAP, and it would sink the card silently.** The obvious implementation — compare `store_pages.last_synced_at` against the walk's start and mark what was not seen — is wrong, because **that column means *last changed*, not *last seen***. `packages/core/src/inventory/sync.ts` (`writeChanged`) deliberately skips upserting any page whose checksum is unchanged, and its own comment gives the reason: restamping would look like an edit to everything watching the checksum and re-run the paid analyses that hang off one. So the obvious build would mark **every unchanged page in every store as deleted**, and would look entirely plausible doing it.
**The mechanism instead: stamp "seen" on every page the walk finds, changed or not, leaving the checksum and the change path untouched.** Rejected alternatives, with their reasons: a separate `last_seen_at` column (correct separation, but a feature card may not add a migration, so the card would stall until the next wave and the gap stays open), and recording each walk's full address list (needs a new table, and the list must survive a walk resumed across many job runs).
**And the "did the walk finish?" signal already exists**: `runInventorySync` returns `status: 'done'` versus `more`, distinguishing a completed resumable walk from a targeted re-sync and from a disconnected store (`packages/jobs/src/inventory/tasks.ts`). It lives only in memory and nothing records it. That is the part to build.

**R-PAGE-GONE-READ — the existing-target check stops treating deleted pages as live** · Lane C
Scope: the check that stops the product proposing a new page for something an existing page already covers — **invariant 6, "no CREATE without the existing-target check"** — does not read `store_pages.status` at all (`packages/jobs/src/scan/existing-target.ts`, verified 2026-09-07: zero references). So it cannot tell a deleted page from a live one.
**The consequence runs both ways, which is why it matters:** a deleted page still blocks a legitimate CREATE, *and* a suggestion to improve a page can land on one the merchant deleted. Which of those happens depends only on which side of the deletion the check falls.
Read first: `DECISIONS.md` 2026-09-03 "A deleted store page gets a status field"; main §7.7, §12.3; invariant 6.
Done when: a `gone` page no longer blocks a CREATE for the subject it used to cover; a `live` page still does; and an improve-this-page suggestion is never produced for a `gone` page.
Note: `R-PAGE-GONE-WRITE` has **landed**, so real rows exist to read.
**One thing its author asked to be passed on, because this lane will not have the context: `gone` means "not a candidate", and nothing more.** The row still exists and still holds its checksum and body, because **the walk may bring it back to `live` at any time without rewriting it** — a restored page keeps the checksum it always had, so nothing would otherwise mark it live again. **A reader that deletes or archives on seeing `gone` breaks resurrection.**
**And a second constraint from the same author: our own published articles are never marked `gone` at all**, because for an export-delivery store they live on a site the walk cannot see, so absence is evidence of nothing. **The reader will therefore never meet an `article_ours` row in that state and must not grow a branch for one.**
Both constraints are written here so this card does not depend on anyone's memory — §8's rule is that a card which cannot be done without chat history is a card that needs fixing.

**R-PAGE-GONE-OPTIMIZE — improve-this-page still works on pages the merchant deleted** · Lane E
Scope: the improve-a-page machinery reads every store page a merchant has ever had, including ones the walk has marked deleted. `packages/jobs/src/optimize/{scan,generate,pack}.ts` each call `listStorePages` unfiltered (verified 2026-09-07: `scan.ts:73`, `generate.ts:319`, `pack.ts:142`). So a merchant can press "improve this page" on a page deleted since the last scan, and the recommendation machinery will spend a paid model call writing advice about a page that is gone.
Read first: `DECISIONS.md` 2026-09-03 "A deleted store page gets a status field"; the `R-PAGE-GONE-WRITE` and `R-PAGE-GONE-READ` cards above; main §10, §12.3.
Done when: a recommendation is never produced for a `gone` page, on either the scheduled path or the merchant-pressed one; a merchant who presses the button on a page deleted since the page loaded is told so rather than billed for advice about nothing; and a page the walk later restores to `live` becomes eligible again with no further action.
Note: found by the `R-PAGE-GONE-READ` session, which correctly stopped at its lane boundary rather than reaching into Lane E's directories. **Do not fix this by changing what `listStorePages` returns by default** — one caller (account deletion) legitimately wants every row, and a silent change to a shared repository function is how another lane's behaviour breaks without anyone editing it. The same reasoning that `R-PAGE-GONE-READ` applies inside Lane C applies here: filter at the call site.
**Carries the same two constraints as `R-PAGE-GONE-READ`, repeated here so this card stands alone**: `gone` means "not a candidate" and nothing more — the row keeps its checksum and body because the walk may restore it to `live` without rewriting it, so a reader that deletes or archives on seeing `gone` breaks resurrection. And our own published articles are never marked `gone`, so no branch should be grown for one.

**R-REJECTION-REASON — every quality rejection shows "the reasoning isn't available yet"** · Lane C (the params) + Lane F (the key)
Scope: a merchant whose article was held back by the quality bar is shown **"The reasoning for this one isn't available yet."** — for every gate-3 rejection, today, in every language. Two independent breaks on the same path, both verified 2026-09-07: (a) `apps/web/app/api/calendar/_lib/handlers.ts:107` builds the reason with `params: {}`, so `{failed_criteria}` and `{first_justification}` have nothing to fill them, though the stored gate decision holds the real values; (b) `catalogKeyFor` in `packages/ui/src/opportunities/why.ts` returns `template.gate3.below_quality_bar` while the catalogue holds `gate3.below_quality_bar`, so nothing matches and it falls through to the placeholder.
Read first: `DECISIONS.md` 2026-09-04 "The judge's own sentences may reach a merchant" and 2026-09-07 `R-JUDGE-COPY`; main §8.4, §8.6; ui §6.
Done when: a held article shows which criteria it failed and the grader's own sentence; a Danish store's card carries an **English** justification, which is what `R-JUDGE-COPY` made true at the source; and the renderer's "no sentence for this key" path is exercised by a test so a future key mismatch fails loudly instead of showing the placeholder.
Note: **this is why `R-JUDGE-COPY` could not meet its third done-when.** It made the justification English where it is produced; nothing carries it to the screen. The other surface that would show it — the article page's quality panel — has no server behind it at all: there is no `GET /api/articles/{id}` route and the panel renders from fixtures.

### Screens with no server behind them — found 2026-09-07 by the integrator while building `R-CONTRACT`

**What was found.** Lane F built every screen against a fake server (build plan §6 `M9`: "starts Wave 1
on MSW mocks; integration cards follow backends"). For six screens the integration card never followed.
The screens call `/api/…` addresses that **have no route file anywhere in the repository**, and nothing
reports it, for three compounding reasons: the fake server is generated from the frozen route table, so
it answers every declared address whether or not anything was built; `pnpm contracts:check` compares
the table only to a generated document and never to the routes on disk; and `getJson`
(`apps/web/app/(app)/_lib/api.ts:38`) deliberately returns `null` on any failure rather than throwing —
so a 404 from a route that does not exist is indistinguishable from an account with no data. **On a
deployed server these screens render their empty state and nothing anywhere goes red.** This is the
eighth "reporter that fails towards fine" and the widest of them.

**Method, so it can be repeated:** every `route.ts` under `apps/web/app/api` was enumerated with its
exported HTTP methods and compared against the route table and against every `/api/…` string in
`apps/web/app/(app)` and `packages/ui/src`. The one file that exports its handlers by destructuring
(`api/auth/[...nextauth]/route.ts`) was checked by hand; the table omits `/api/auth/*` deliberately.

The four cards below build the missing servers. **Each is scoped to one lane's own directories** and
carries the shape it must satisfy, which already exists as a zod schema in
`packages/core/src/api/schemas.ts` — the contract described these endpoints correctly all along, so
none of these cards is designing an interface, only implementing one.

### The ninth reporter: the Opportunities screen cannot explain almost any of its own cards

Found 2026-09-07 by `R-REPAIR-COPY`'s lane, which enumerated every explanation an opportunity row can
carry rather than grepping for the two keys its card named, and by the read-only audit run alongside it.
**The two findings are the same defect at two levels: the words a merchant reads are declared in one
place and produced in another, and nobody ever compared the two sets.**

How it hid, and it is the same shape as the other eight: the mock data, the browser tests and the screen
contract all use keys the catalogue **does** hold and the engine **never produces**. Screens were built
against the catalogue; the engine was built separately. Every screenshot and every fixture-driven test
showed a working explanation over an engine with no words behind it.

**R-SIGNAL-COPY — nearly every card on the Opportunities screen says "the reasoning isn't available yet"** · Lane F
Scope: twelve reason keys the weekly scan produces have **no sentence in the copy catalogue**, so in the live product nearly every card on the product's central screen explains itself with the placeholder. They are: `striking_distance.refresh_ours`, `striking_distance.optimize`, `low_ctr_at_strong_rank.optimize`, `content_decay.refresh`, `cannibalization.fix`, `uncovered_commercial_query.create`, `uncovered_commercial_query.create_with_link`, `competitor_coverage_gap.create`, `product_family_coverage_gap.create`, `missing_or_weak_metadata.optimize`, `existing_page_intent_gap.optimize`, `indexing_issue.fix`. They are already listed in `REASON_KEYS_AWAITING_COPY` with a test that fails if one is left there after being written.
**Two more things in the same family, because they are the same screen and the same file:** (a) two signal *names* are missing from the catalogue — `missing_or_weak_metadata` and `wrong_canonical_or_duplicate` — so the merchant is shown a machine-generated "Missing Or Weak Metadata"; the humanised fallback at `list.ts:228` is exactly why nobody noticed. (b) Two orphan keys, `template.striking_distance.page_one_intent_mismatch` and `template.uncovered_commercial_query.no_suitable_url`, hold sentences nothing produces and are what the fixtures use — decide whether they become the real keys' copy or go.
Read first: `DECISIONS.md` 2026-09-07 `R-REPAIR-COPY` entries; main §7.1, §7.6, Appendix A; ui §5; invariant 8 (every user-facing "why" renders from a template over the record, never from a model) and 24 (canonical strings verbatim).
Done when: every reason key the scan can produce has a sentence; `REASON_KEYS_AWAITING_COPY` is empty; both signal names exist; the orphan keys are resolved one way or the other and the fixtures use keys the engine actually produces; and a merchant on a store with real opportunities reads a real explanation on every card.
Note: **the guard already exists** — `reasonKeysWithoutCopy` / `hasCopy` / `placeholdersIn` in `packages/ui/src/strings/reason-copy.ts`. Extend it; do not build a second one. `R-REJECTION-REASON` was told the same.
Note: **where a sentence would state a number, check the plural.** `template.catalog_richness_gap.insufficient_substance` already ships "1 products" when one product is sparse, because the catalogue has no singular/plural machinery. Say what you did rather than adding to that.

**R-TASK-COPY — the improve-this-page tasks are English prose written in the wrong layer** · Lane C (the producer) + Lane F (the words)
Scope: `packages/core/src/opportunities/tasks.ts` builds every task's wording as literal English with numbers interpolated — lines 38, 50, 54, 58, 67, 69, 79, 89, 90, 116, 146 — and it reaches the merchant raw as `task.label` (`OpportunityDrawer.tsx:365`). Two rules bear on it: the constitution says copy lives in `packages/ui/strings` only, externalised from day one; invariant 8 says every user-facing explanation renders from a template over the record. This is neither, and it is assembled in the one layer that cannot know what language the store publishes in.
**The intended home already exists and has no consumers:** `optimize.task.title_rewrite`, `.meta_rewrite`, `.add_section`, `.add_faq`, `.internal_links` are in the catalogue and referenced by nothing. Six further task kinds have no key at all: `product_data`, `consolidate`, `primary_url`, `canonical_recommendation`, `schedule_topic`, `repair_reference`.
Read first: `DECISIONS.md` 2026-09-04 "The citation word lists go" (`R-GATE-LANG`, which removed English word lists so every language gets the same bar — a Danish store still gets English task instructions, so this is the same gap unclosed); main §10.4; ui §5.3; invariant 8.
Done when: a task carries a template key and its parameters rather than a finished sentence; every task kind has a key; the five existing keys are used or deliberately replaced; and `packages/core` composes no merchant-facing English anywhere in that file.
Note: **this changes an interface two lanes share** — the task shape crosses from `core` into the drawer. Agree the shape before either side writes, and say in the report what the other lane must do.

**R-DEAD-STORAGE — two tables and two columns nothing has ever written** · **needs a founder decision before any lane takes it**
Scope: found by the read-only audit of 2026-09-07 by resolving producers rather than declarations. **`rules_overrides` and `incident_findings` have zero non-test references outside the schema file** — not written, not read; both carry not-null columns with no default, so nothing has ever inserted a row. `incident_findings` was added by schema wave 3 to collect what an operator learned after investigating a kill-switch trip, and its schema comment explains the intent in full. Separately, `products.metafields` and `article_claims.staleness` are written by nothing and read by nothing; `staleness` has an unused enum of its own, and the walk does read Shopify metafields (`inventory/source.ts:320`) but routes them elsewhere.
**The decision:** each of these is either work someone intended and never did, or a schema that outlived its plan. Building them is real work; dropping them needs a migration and schema waves are closed. **Which of the four are still wanted?**
Read first: main §14.5 (kill switches and incidents), §7.10 (the rules layer), §6.3; the schema comments on both tables, which state the original intent better than this card can.
Done when: the founder has said which are wanted; the wanted ones have a writer and a reader; and the rest are recorded as deliberately empty rather than left looking like an oversight.
Note: the audit's own stated limit, worth carrying — its column scan counts "appears as an object key in non-test source" as written, so it **under-reports**: a column written only through raw SQL would look written. Fourteen candidates from 429 columns; the `article_labels` and `pattern_stats` ones were discarded as belonging to deferred `T7.1`.

**R-REWRITE-PLACE — a rewrite would publish a second article competing with the first** · **BLOCKED on a founder decision**
Scope: when the product rewrites one of its own articles, the generation pipeline mints a new article at a new address and publishes it as a new post. Nothing downstream reads that a topic is a rewrite rather than new coverage. So a rewrite puts a **second page on the merchant's blog competing with the original for the same search** — cannibalization, which is the thing the existing-target check (invariant 6) exists to prevent, arriving by the one route that check does not guard.
**Status: pre-existing, and newly reachable.** It was already reachable through content-decay and repair-driven rewrites, neither of which anyone built deliberately. `T7.2` (landed 2026-09-07) makes it the ordinary path rather than a corner, which is why its own lane named this as the blocker before any rewrite reaches a real store, and stopped rather than choosing.
**The decision the founder owns:** does a rewrite replace the article in place — same address, same post, updated words — or go out as a new post? In-place keeps the article's accumulated search history and cannot cannibalize; it also means overwriting words a merchant may have edited themselves. A new post is simpler and is what the pipeline already does. **The machinery for updating in place already exists in the publishing path** (`R-PUBLISH-2` built a conditional update that never falls back to create), so neither answer is a large build; the choice is a product one.
Read first: `DECISIONS.md` 2026-09-07 `T7.2` entries; main §9.6.5, §14.3.7; invariants 6 and 19.
**An answer has been REPORTED and is not yet confirmed to the integrator directly.** Relayed 2026-09-07 by the `sortiva-a8` session: **a rewrite replaces the article in place — same address, same post, updated words** — and the founder is said to have accepted the cost that a rewrite overwrites words the merchant may have edited themselves, and to have declined "new post, then retire the original" because retiring one would mean unpublishing or redirecting a merchant's post, which this version does not do.
**This is recorded as a report, not as the decision.** A decision is real when it is in `DECISIONS.md`, and there is one path by which that happens; two paths is how a project ends up with two answers. **Whoever takes this card must check `DECISIONS.md` holds the entry before building**, and if it does not, stop and ask rather than building on a relay.
If confirmed, carry this into the build: `R-PUBLISH-2` decided that a repair sends only title, body and summary and leaves the merchant's address, tags and unpublish choice alone. **The same restraint applies to a rewrite and is not automatic** — an in-place update that rewrote more than those three fields would take back edits the merchant made, which is the cost the founder accepted, not an invitation to widen it.
Done when: the decision is journalled, and a rewrite reaching a real store does what it says.
**Until then, no rewrite should reach a live merchant.**

**R-ARTICLE-OURS — the product never recognises a page as one of its own** · Lane C
Scope: `store_pages.page_type = 'article_ours'` and `store_pages.article_id` are **read in several places and written in none** outside tests (reported by `T7.2`'s lane, 2026-09-07). The store-page walk records a merchant's pages but never marks the ones we published, and never links them back to the article row they came from.
**What is dormant because of it, both of them landed and green:** `T6.3`'s refusal — "we published this article, so we rewrite it rather than hand you edits for it" — can never fire for a real merchant, because no page is ever recognised as ours. And `T7.2`'s routing of that refusal into the rewrite pool is correct, tested, and unreachable for the same reason. **This is the single thing standing between the founder's own done-when for `T7.2` and being true for a live store.**
Read first: `DECISIONS.md` 2026-09-07 `T7.2` entries; the `T6.3` section of `docs/overnight-state.md`; main §12.3, §9.5, §14.1.
Done when: a page the product published is marked as ours by the ordinary walk and carries the id of the article it came from; a merchant's own page is never marked ours; the marking survives the walk running again; and `T6.3`'s refusal and `T7.2`'s pool routing are both exercised end to end against a page the walk itself marked, rather than one a test planted.
Note: an export-delivery store publishes on a site the walk cannot see, so those articles will never be found this way. **Say what happens for those rather than leaving it implied** — `R-PAGE-GONE-WRITE` already established that our own articles are never marked `gone` for exactly that reason.
Also in scope, because it is the same file and one assertion: **a test that an `article_ours` row is never marked `gone`.** That constraint is currently defended only by nobody having written the branch, which is invisible to the next reader. Requested by the `R-PAGE-GONE-READ` session, which correctly said it belongs in the writer's suite rather than the reader's.

**R-TASK-DONE — the Products screen can never show a finished task** · Lane C
Scope: `merchantTask.completedAt` is declared in the contract and has **no source in the product at all** (found by `R-API-PRODUCTS`, 2026-09-07). A merchant who fixes the thin product pages blocking an opportunity leaves behind an expiry whose recorded reason is "the evidence no longer holds" — the identical reason produced when a keyword simply loses its search volume. Reading that as "you completed this" would congratulate merchants for work they never did, so the endpoint returns null and the screen's completed-tasks section (ui §7: "Completed tasks collapse with the date and, once the opportunity proceeds, a link to what it became") can never fill.
Read first: `DECISIONS.md` 2026-09-07 `R-API-PRODUCTS` entries; main §7.9 (expiry), §6.3; ui §7.
Done when: an opportunity that expired because the merchant improved their catalogue is distinguishable from one that expired for any other reason, and carries the moment it happened; the Products screen shows those and only those as completed; and an opportunity that expired for a different reason never appears as merchant work done.
Note: this is the scan's territory, not the screen's. **Do not infer completion in the endpoint** — the reason the field is null today is that inferring it is wrong, and that reasoning is journalled.

**R-REPAIR-COPY — the repair path's explanations render blank** · Lane F
Scope: the reason keys `broken_product_reference.fix` and `product_change_impact.*` have no `template.` entries in `packages/ui/strings/en.json`, so a merchant whose article was flagged for a broken product link or a product change sees an empty explanation where the reason should be (found by `T7.2`'s lane, 2026-09-07, which had two keys of its own with the same defect; those two were applied at merge).
Read first: main §14.1 (drift and repair), §7.1; invariant 8 (every user-facing "why" renders from a template, never from a model); ui §6.
Done when: every reason key the repair path can produce has a sentence; and a key with no sentence fails a test loudly rather than rendering nothing — the renderer's "no sentence for this key" path is currently silent, which is how these went unnoticed.
Note: `R-REJECTION-REASON` asks for that same loud-failure test from the other side. **Whichever card lands first should build it**, and the other should say so rather than building a second one.

**R-API-ARTICLES — the articles library and the article page have no server** · Lane D
Scope: build `GET /api/articles` (the library list), `GET /api/articles/{articleId}` (read-only detail with its quality report), and `POST /api/articles/{articleId}/publish-anyway` (publish a draft the quality gate rejected). All three are declared in the frozen route table with response schemas and none exists on disk (verified 2026-09-07).
**The third one matters most and is the reason this card is Lane D's first:** `packages/ui/src/content/ArticleDetail.tsx:275` posts to `publish-anyway` when a merchant overrules a quality rejection, and there is nothing at that address. `R-OVERRIDE-STATE` landed the state the override writes and `R-JUDGE-COPY` landed the words it shows — **the button between them reaches nothing.**
Read first: `DECISIONS.md` 2026-09-04 "An overridden article gets its own state, and is never reviewed again"; main §8.6, §9.3; ui §6.
Done when: the articles library lists a store's articles; the article page renders from the server rather than from fixtures; the override button publishes and stamps `published_via_override`; and an article that is not in the rejected state refuses the override rather than publishing it.
Note: `POST /api/articles/{articleId}/refresh` is the fourth missing article route and belongs to `T7.2`, which is building it now. Do not build it here.
Invariants: 12 (override articles excluded from learning and shown segmented), 23.

**R-API-PRODUCTS — the Products screen has no server** · Lane B
Scope: build `GET /api/products` (richness, merchant tasks from open HOLDs, the product table) and `GET /api/products/families` (the read-only family list with its differentiation axes). Both declared with schemas, neither on disk (verified 2026-09-07). `apps/web/app/api/products/families/report` — the "this grouping is wrong" endpoint — is built, so the directory exists and only the two reads are missing.
Read first: main §6.3 (richness), §6.4 (families and grouping guardrails); ui §7.
Done when: the Products screen renders a real store's products and families rather than an empty state; the family list is read-only, with no editing affordance; and richness is the figure the distillation actually produced.
Note: `apps/web/app/api/products` was a directory no lane owned. It is Lane B's by the ownership rule added to §3 on 2026-09-07 — a file belongs to the lane that owns the domain it serves, and the catalogue is Lane B's.
Invariants: 3 (raw HTML never flows downstream), 23.

**R-NEXTSCAN — the product never says when the next scan is, because nothing works it out** · Lane C
Scope: `GET /api/opportunities` returns `nextScanAt: null` unconditionally (`apps/web/app/api/opportunities/_lib/handlers.ts:191`), and its comment gives the honest reason — nothing anywhere in the product computes when an account's next scan falls, so null beats a guessed cadence. The weekly scan does have a schedule; what is missing is anything that turns it into a date for a particular account and hands it to the screen.
**Why it is worth a card now:** two screens are built to say it and neither can. The Opportunities header renders "Last scan {date} · next scan {next}", and `R-SCANCOPY` (landed 2026-09-07) built the empty-state sentence that counts days to that same date. Both fall back to saying nothing. **So a merchant who has nothing to act on is told nothing about when that changes** — which is better than the false "Monday" it replaced, and still less than the screen was designed to say.
Read first: `DECISIONS.md` 2026-09-04 "The empty-state scan line becomes relative" and the `R-SCANCOPY` entries of 2026-09-07; main §7.11 (scan cadence); ui §5.1.
Done when: an account whose weekly scan is due gets a real next-scan time from the API; a paused or unentitled account is not promised one; the header and the empty state agree because they read the same value; and nothing invents a date from a cadence when the account's own schedule does not say.
Note: `R-SCANCOPY` deliberately built the merchant-facing half first and left this dormant rather than guessing a weekly cadence in the browser. **Do not resolve this by computing "last scan + 7 days" in the frontend** — that is the guess the founder's decision was made to remove.

**R-API-PERFORMANCE — the Performance screens and the opportunity drawer have no server** · Lane C
Scope: build `GET /api/performance/overview` (the headline chart, its markers, the results table), `GET /api/performance/search-console` (query and page tables with signal badges), and `GET /api/opportunities/{opportunityId}` (the detail drawer: evidence, tasks, recommendation, history, outcome). All three declared with schemas, none on disk (verified 2026-09-07).
Read first: main §9.6.2 and §9.6.10 (verdict timing and store-relative labels), §12.2 (Search Console), §7.6 and §7.12; ui §5, §8.
Done when: the Performance screen draws a real store's search data with its connect, publish and applied markers and the lag note; the Search Console tables carry signal badges that link into Opportunities; the opportunity drawer renders its evidence from the stored record; and a store with no Search Console connection gets the Limited Intelligence treatment rather than an error.
Invariants: 8 (every user-facing "why" renders from a template, never from a model), 13, 23.

**R-API-SETTINGS — the Settings screens call three addresses that do not exist** · Lane F
Scope: two halves. **(a)** Build `GET /api/settings` and `PATCH /api/settings` at `apps/web/app/api/settings`, the directory the founder assigned to this lane on 2026-09-04. These are genuinely settings-shaped — they span several lanes' settings — which is why they are not being moved elsewhere. **(b)** Repoint the blog picker: `packages/ui/src/settings/PublishingSettings.tsx:63-66` defaults to `/api/settings`, `/api/settings/blogs` and `/api/settings/blog`; the last two **are built**, at `/api/publish/blogs` and `/api/publish/target`, and the auto-publish toggle's own endpoint is `/api/publish/mode`. The frozen contract moves to those built addresses in `R-CONTRACT`; this card moves the screen with it.
Read first: `DECISIONS.md` 2026-09-04 "The frozen contract moves to the addresses that were built, and Lane F gets the settings ground"; main §9.4, §9.5; ui §9.
Done when: both Settings screens load from a real server; the blog picker lists a store's blogs and sets a target through the built publishing endpoints; auto-publish cannot enable without a resolved target blog; and every control ui §9 lists still exists with none that it does not.
Note: **sequence after `R-CONTRACT`**, which moves the table entries this card's screen follows. The write-grant flow (`/api/publish/grant/start`) is already built and is not this card's to change.
Invariants: 21 (read and write are separate consents; auto-publish cannot enable without a resolved target blog), 16 (we render no card form, ever).

**R-CONTRACT — the frozen contract describes the endpoints that exist** · integrator
Scope: ten endpoints were built at addresses the frozen route table does not declare, while the table declares several with no implementation, and `contracts:check` passes throughout because it compares the table to a generated document and **never to the routes on disk**. The founder delegated the call: amend the contract to the built addresses rather than move ten endpoints; assign `apps/web/app/api/settings` to Lane F for anything genuinely settings-shaped; the missing routes-on-disk check lands with `T10.2`.
Read first: `DECISIONS.md` 2026-09-04 "The frozen contract moves to the addresses that were built".
Done when: the table names every route that exists and no route that does not; the frontend's generated fake server answers on every address the Settings screen calls; and the "grant posting permission" button points at the **write** grant rather than the read-only install flow.
Exact line, verified 2026-09-07: `packages/ui/src/settings/PublishingSettings.tsx:64` defaults `writeGrantEndpoint` to `/api/shopify/oauth/start` — the **read-only install flow** — and `apps/web/app/(app)/settings/publishing/page.tsx` renders the component without overriding it. **`T5.2` did build the real routes** (`/api/publish/grant/start` and `/api/publish/grant/callback`) and they work, so this is one prop away from correct, not a missing feature. A stale note at `packages/ui/src/fixtures/screen-contract.ts:216` still says no such route exists anywhere; correct it while you are here.

**R-STREAM-WIRE — a merchant's edit actually reaches the product** · Lane B, placed by the integrator 2026-09-04
Scope: `R-STREAM` took its own second branch — it restored the stand-in report line and built the test that stops the report lying again, and left the consumer unwired on the founder's instruction that wiring it and switching the recurring schedule on should be judged together. Both are now decided (`DECISIONS.md`, 2026-09-04). This card takes the first branch. **Three things, in three different grounds:** (a) the Shopify webhook handler queues a pass over the change stream immediately after it records what changed, so a collection rewritten at nine in the morning is re-read minutes later instead of at the next nightly walk — Lane B's file, and this card's real work; (b) the reader is registered in the composition root and handed the real change stream and the signal-scan dependencies, so a catalogue change also triggers a full market scan for that store — **integrator-resolved, so the lane writes the line into its report and does not apply it**; (c) the `CatalogEvents` seam leaves the stand-in report and gains its entry in `seams-wired.test.ts`, which is what `R-STREAM` built that file to require.
Read first: build plan §4 (the `CatalogEvents` contract); main §7.5 (event-driven cadence), §12.3, §14.1; the `R-STREAM` LANDED section of `docs/overnight-state.md`; `DECISIONS.md` 2026-09-04 (both change-stream entries).
Done when: a webhook delivered through the receiver leaves a queued pass behind it, asserted on the queue rather than on a mock; a pass over a planted change re-reads exactly the pages that changed and no others; a store with nothing changed queues no follow-on pass; two passes at the same point in the stream produce one scan, not two; and `pnpm stubs:report` no longer lists `CatalogEvents` **because** `seams-wired.test.ts` now proves it is constructed outside a test.
Note: `packages/jobs/src/inventory/drain.ts` is Lane C's and needs no change — its dependencies already accept the scan. Its file comments claim the producing half "does not exist yet", which has been false since `T2.2`; leave them, and flag them.


**R-DEV — `next dev` cannot start, so nobody can run the app locally** · integrator to assign
Scope: `pnpm dev` fails outright. The server's start-up hook imports `@sortiva/jobs`, whose runtime imports `graphile-worker`, which imports `cosmiconfig`, which requires `fs/promises` — and Next cannot resolve that for the dev bundle. The error is `Module not found: Can't resolve 'fs/promises'` while compiling `/instrumentation`. **The production build is unaffected and `pnpm smoke:boot` is green**, which is exactly why no gate catches it: `smoke:boot` starts the *built* app. Found by `T9.5` while trying to run browser flows, and reproduced by the integrator directly.
Read first: `DECISIONS.md` `2026-09-02 — T-BOOT` (all four entries) and the "FIXED — the application would not start" section of `docs/overnight-state.md`; tech §2.
Done when: `pnpm dev` starts and serves `/` and `/api/health`; a gate step proves it, so this cannot regress unnoticed the way it has; and the two Playwright projects still pointing at `pnpm dev` can run locally again.
**Why this is not a lane's to take.** It is the same family as the defect `T-BOOT` repaired — a module resolved one way at build time and another at run time — and the founder ruled on that one deliberately, choosing "load on first use, plus a lint rule" and **explicitly rejecting** "mark the package external to the server bundle". The obvious fix here (declaring the job library external, or keeping it out of the dev bundle) is that rejected option wearing different clothes, so it should be settled by the same person rather than picked at night by an integrator.
Note: **this is pre-existing, not a regression from the 2026-09-02 run.** The start-up hook has imported the jobs package since well before it. Its cost is that every developer runs against `next start` or not at all, and that two browser-flow suites are dead locally.

### Mini-wave, authorised 2026-09-03 by the founder

Schema wave 3 (`T4.0`) closed deliberately without this, because the founder had not
picked its shape. The shape is now picked, so it needs a wave of its own — a feature card
may not add a migration (§3, "Schema ownership").

**T4.0a — Schema mini-wave: a store page can be recorded as gone** · integrator to assign
Scope: one migration adding a status field to `store_pages` naming which condition the row is in — live or gone, with room for a further condition such as "moved" or "unreachable" to be added later without a second migration. Existing rows default to live. **Migration only**: nothing in this card writes the new value or reads it, and the inventory walk is untouched.
Read first: main §12.3; `DECISIONS.md` `2026-09-03 — FOUNDER — A deleted store page gets a status field`; `DECISIONS.md` `2026-09-02 — T3.2` (the original deferral) and the `T4.0` preparation list in `docs/overnight-state.md` (item 7).
Done when: the migration applies forward, every existing `store_pages` row reads as live, and a constraint test proves the field cannot hold a value outside the named set.
Note: the founder chose the status field over a single deleted-at date, and rejected inferring deletion from "not seen by the last completed walk" — that option needs something to record that a walk *completed*, and an interrupted walk would otherwise mark live pages as gone. **Two follow-ups this card does not do**, and neither is a founder question: the producer that sets the value when a page disappears, and teaching `T3.5`'s existing-target check to skip a page that is gone — which is the reason the field exists, since today the product can recommend improving a page a merchant has deleted.

**T4.0b — Schema mini-wave: a finished draft has somewhere to be stored** · integrator
Scope: one migration adding `articles.body_json` (the draft in the shape the writer produced it — intro, sections, FAQ) and `articles.meta_description`. **Migration only**: nothing writes or reads either column; `T4.4` onward do that.
Read first: `DECISIONS.md` `2026-09-03 — FOUNDER — A stored draft keeps its parts separate`; main §9.2 (on-page metadata generated with the draft); `packages/core/src/generation/draft.ts` (the `Draft` shape being stored).
Done when: the migration applies forward from empty, an article row can exist with no draft, a stored draft reads back as an object rather than a string to parse, one part can be queried without reading the whole body, and a non-object body is refused.
Note: **LANDED 2026-09-03.** `jsonb`, not gzipped `bytea` — see the journal entry for why, and for what it would cost to change.


### Intent-gap wiring, authorised 2026-09-03 by the founder

`T6.1` built the paid page comparison and deliberately wired it to nothing, because the
place its own card names — the weekly signal scan — is another lane's file. The founder
chose the shape: **the comparison runs as its own scheduled pass, and the scan reads what
that pass already produced rather than buying anything itself.** Reasoning and the two
rejected alternatives are in `DECISIONS.md`, `2026-09-03 — FOUNDER — The intent-gap
comparison runs as its own job`.

Two cards because the two halves are in two lanes. **The job must land before the read**,
or the read has nothing to find.

**R-INTENTGAP-JOB — the page comparison actually runs** · Lane E, after `T6.2`
Scope: `scanIntentGaps` in `packages/jobs/src/optimize/scan.ts` exists, is tested, and is called by nothing outside its own test — verified by grep, not taken from a report. Register it as a scheduled task of its own, in the same shape as the other jobs in `packages/jobs`: a derived idempotency key, the per-account advisory lock, and the existing daily allowance and pause flag it already honours. It walks the shortlist, buys what the allowance permits, and stops. It writes no new table — `analyseIntentGap` already stores the model's raw answer in `request_cache`.
Read first: `DECISIONS.md`, the five entries dated `2026-09-03 — T6.1` (especially the cache-key entry, which explains why the results page's fetch time is part of the key) and the founder entry above; main §10.3, §14.3.1–14.3.4 (effectively-once), §14.5 (per-type cap); `packages/jobs/src/generation/tasks.ts` for the registration shape this should match.
Done when: the task is registered in the composition root and a test proves the registered handler is the real function, not a stand-in; a run with the allowance exhausted buys nothing and does not fail; a re-run over the same shortlist with nothing changed makes no second model call; a killed run resumes without paying twice.
Note: **do not add it to the crontab as a running entry without saying so in the report.** The recurring schedule is switched off by founder decision (open question 4) until the last handlerless entries land, and this card must not be the thing that quietly turns paid work on.

**R-INTENTGAP-SCAN — the weekly scan reads the comparison it did not pay for** · Lane C, after the job lands
Scope: `runSignalScanLocked` in `packages/jobs/src/scan/run.ts` hard-codes its detector list and every detector in it is a pure function over data already assembled. Add `existing_page_intent_gap` to `GSC_SIGNAL_TYPES` and derive it inside the same limited-intelligence guard as the other Search Console detectors — **from the cached analysis only.** For each shortlisted page, recompute the cache key and read it; if there is a fresh answer, turn it into a signal with `buildIntentGapSignal`; if there is not, skip that page. **The scan must never fetch a page and never make a model call.** That is the whole point of the split: a slow fetch or a model outage must not delay or fail any other signal.
Read first: the founder entry above and the `T6.1` cache-key entry in `DECISIONS.md`; `packages/core/src/optimize/intent-gap.ts` (`shortlistIntentGapPages`, `buildIntentGapSignal`); main §7.3 (the Intent Gap row), §7.11 (Limited Intelligence).
Done when: a shortlisted page with a fresh cached analysis produces the signal, and `buildOpportunityDraft` turns it into an `OPTIMIZE` on the existing URL; a shortlisted page with no cached analysis is skipped and the scan still completes with every other signal; a test proves the scan makes no page fetch and no model call on either path; a limited-intelligence account evaluates none of it.
Note: if recomputing the cache key inside the scan turns out not to be possible — the results page's fetch time is part of the key and the scan may not have it to hand — **stop and report rather than reaching for a new table.** A table is a schema wave, and the alternative shapes are the integrator's to weigh.


### Founder-authorised fix card, created 2026-09-03 by the integrator

Two small changes the founder authorised directly, grouped because both are in Lane D's
territory, both are a clause plus a test, and both must be merged and gated **before
`T5.1` starts** — `T5.1` builds publishing on the first of them and would otherwise edit
the same file as the second.

**R-DELIVER — an overridden article can actually be delivered, and a waiting draft is announced** · Lane D
Scope: two independent fixes.
(a) **`articlesReadyForDelivery`** (`packages/db/src/repositories/articles.ts`) is the single read that answers "which finished articles go out today". It returns an article only if its subject has a quality-gate decision recorded as `passed`. When a merchant overrules a rejection, `markArticleOverridden` sets the permanent flag, moves the article back to `draft`, and **writes nothing to the decision trail** — so the article's only decision stays the rejection and this read can never return it. Widen it: deliver an article whose subject passed the gate **or** which carries `published_via_override`, **or** whose subject has a gate-3 decision with outcome `overridden`. The third arm is written by nothing today and is there so that when `T5.1`/`T5.2` build the override route and record that decision, the read already accepts it. No migration — `gate_decisions.outcome` is free text, and `OVERRIDE_GATE_OUTCOME = 'overridden'` already exists as a constant in `packages/core/src/gates/gate3/override.ts` and is written by no path.
(b) **`draft_ready_for_review` is never sent.** On an account with draft review switched on, a passing article is moved to `in_review` at `packages/jobs/src/generation/daily-cycle.ts` and nothing tells the merchant. The notification type, its wording, its email template and the emitter are all already built and tested; only the call is missing. Emit it at that transition, deduped on the article id so a retried cycle sends once.
Read first: `DECISIONS.md` `2026-09-03 — FOUNDER — An overridden article is delivered on its flag now` and `2026-09-03 — FOUNDER — The draft-ready notification is built now`; main §8.6 (override), §9.3 (draft review), §13 `gate_decisions`; tech §1 (notifications are append-only and unique on `(account_id, type, dedupe_key)`); the `T4.4` and `T4.5` audit findings as recorded in `docs/overnight-state.md`.
Done when: an article rejected by the gate and then overridden **appears** in `articlesReadyForDelivery`, and an ungraded `draft` on the same account still does not; an article whose subject carries a manually planted `overridden` gate-3 decision also appears; an article moved to `in_review` produces exactly one `draft_ready_for_review` notification, and running the cycle again produces no second one; an account with draft review switched off produces none.
Invariants: 12 (the override flag's exclusions are unchanged — this card widens delivery, never learning), 18 (the emission must survive a retry without duplicating).
Note: **do not change what `published_via_override` excludes.** It still keeps the article out of calibration data, pattern learning and every headline performance claim. This card changes only whether the article can be *delivered*.
Note: the second half of open question 13 stays open — whether an overridden article should still pass through draft review on accounts that have review switched on. Today it rejoins the ordinary path. Leave that as it is.


### Stub-filling card, created 2026-09-03 by the integrator

Three stand-ins were written before the `articles` table existed. It has existed since
`T4.0` landed on 2026-09-03, so all three are now buildable and none needs a migration.
They are grouped into one card because they are the same change made in three places, in
one lane's directories, and splitting them would mean three merges of the same shape.

**R-ARTICLES — the three article-shaped stubs, now that articles exist** · Lane G
Scope: three registered stand-ins in `packages/core/notifications` and `packages/jobs/notify` return nothing, each with a `registerStub` entry saying so. Fill them from the real tables.
(a) **`AttentionSources.articles`** (`packages/core/src/notifications/ports.ts`) — the dashboard's "needs you" list. `draftsAwaitingReview` reads articles in state `in_review`; `unconfirmedExportUrls` reads articles with `delivery = 'export'` that are published, have a null `published_url`, and passed the reminder window. **`pendingRepairs` cannot be filled and must stay a registered stub** — there is no repairs table anywhere in the schema (grep it; the word appears only as `accounts.auto_repair` and two enum values), and it arrives with `T5.3`. Re-register that one condition alone with an accurate `filledBy` and a `mustBeGoneBy` of `M5`, rather than deleting the entry or leaving it claiming schema wave 3 will fill it.
(b) **`EmailFacts.articles`** (`packages/jobs/src/notify/assembler.ts`) — the monthly summary. Count what actually went live in the month and what the quality gate held back, from `articles` and `gate_decisions`, instead of reporting an empty month. A productive month currently reads as a quiet one, which is worse than sending nothing.
(c) **`ExportUrlReminder.articles`** (`packages/jobs/src/notify/export-url-reminder.ts`) — the sweep already takes an `UnconfirmedExportSource` and already emits one deduped notification per article; only the source is missing. Supply it and pass it in the composition root, where the task is already registered.
Read first: each stub's own `registerStub` block, which states what it is standing in for; `packages/db/src/schema/content-engine.ts` (the `articles` and `gate_decisions` tables) and `packages/db/src/schema/enums.ts` (`article_state`, `delivery_mode`); tech §1 (notifications are append-only, unique on `(account_id, type, dedupe_key)`; attention items are live queries, never stored); main §9.3 (draft review), §9.5 (export and the published-URL confirm), ui §10.
Done when: `pnpm stubs:report` no longer lists `EmailFacts.articles` or `ExportUrlReminder.articles`, and lists `AttentionSources.articles` for `pendingRepairs` only, with `mustBeGoneBy: M5`; a planted `in_review` article appears in the attention list and one in every other state does not; a planted exported article with no `published_url`, older than the window, produces exactly one `export_url_reminder` notification and a second sweep produces none; a month with a published article and a gate-rejected topic renders a summary naming both, and the same month with neither renders the quiet-month wording; every new read is account-scoped and a test proves another account's article is invisible.
Note: **the `draft_ready_for_review` notification is deliberately not in this card.** The type, the copy and the email template all exist and only the sending is missing — but the place to send it from is the moment an article becomes `in_review`, which is `packages/jobs/src/generation/daily-cycle.ts`, **Lane D's directory**, and whether draft review ships with a way to be told at all is founder question 13. This card makes the *dashboard* able to show a waiting draft, which needs no decision and no other lane's files. **The founder has since authorised the notification itself and it is carded as `R-DELIVER` in Lane D**, which owns that file and is about to edit it anyway.
Note: `unconfirmedExportUrls` and the reminder sweep will correctly find nothing until `T5.1` starts marking exported articles published — an empty result from a correct query, not a stub. Build and test them against planted rows regardless; that is the seam `T5.1` lands into.


### M8 — Notifications, email, lifecycle, ops · Lane G

**T8.0 — Schema wave 4**
Scope: any columns deferred via DECISIONS entries from waves 1–3 (integrator-collected), retention bookkeeping.
Read first: `DECISIONS.md` (class-b entries tagged `schema`); tech §1.3, §1.7.
Done when: every schema-tagged DECISIONS entry is resolved or explicitly deferred.

**T8.1 — Notifications & attention items**
Scope: append-only `notifications` writer (same transaction as the state change), closed type enum incl. the opportunity types, reference-only payloads with render-time lookup, `seen_at`/`read_at`, unique triple dedupe, attention list as live queries (in_review drafts, open repairs, unconfirmed URLs > 7 d, HOLD tasks, stale recommendations), 30 s polling API; `NotificationEmitter` contract filled.
Read first: tech §1.1–1.3, §1.6; ui §4 (attention list), §10; main §6.9 (activation).
Done when: retried publish job rings once (constraint conflict test); approving a draft removes the attention item with no write; a deleted referenced entity renders the generic line; matrix table-test passes for in-app column.
Invariants: 26.

**T8.2 — Email pipeline**
Scope: Resend via `EmailProvider`, React Email templates versioned, `email_sends` unique triple + Resend idempotency header, send worker with retries → DLQ, suppression from bounce/complaint webhooks, List-Unsubscribe flipping prefs, scheduled: monthly summary (1st, 08:00 persona time; results + actions across types + held back + next opportunities; **no denominators**), 24 h OAuth reminder, 7 d export-URL reminder, opportunities-ready email.
Read first: tech §1.3–1.5; main §8.6, §6.9; ui §10 (email column, defaults).
Done when: matrix table-test passes for email column and default on/off; monthly summary snapshot contains no `/`, "of", or target phrasing patterns (denominator lint); hourly sweep run twice sends once; suppressed address skipped except deletion confirmation.
Invariants: 23, 24, 26.

**T8.3 — Lifecycle, deletion, GDPR, retention**
Scope: vacation mode gate; cancellation facts surfaced; account deletion (immediate Stripe cancel, Shopify + Google token revocation, PII + aggregates purge ≤ 30 d, 7-day domain release grace, preview-cache purge, notifications/email cascade); Shopify GDPR webhooks (`shop/redact` purge, customer topics → logged "no data held"); retention sweeps (webhook payloads 30 d, notifications 90 d, `gsc_*` roll-ups at 16 mo, request_cache TTL, email_sends 12 mo).
Read first: main §14.6, §4.2 (cancel), §6.2 (customer stripping), tech §1.5, §1.7, §2.1 (Postgres stays small).
Done when: deletion test: domain still claimed at day 6, free at day 8; Stripe cancel called once; tokens revoked; `customers/data_request` returns 200 + "no data held" and a test proves no customer table exists; each retention sweep is idempotent.
Invariants: 1, 4, 16.

**T8.4 — Kill switches, auto-trips, dashboards-as-code (M8 exit gate)**
Scope: `ops_flags` manual flags with four-eyes reset on global, checked at every dequeue ≤ 60 s; auto-trips (account LLM 10× median / hard cap, global DataForSEO cap, preview cap → cache-only, judge fail-rate > 60 % / 50, publish error > 20 % / 1 h, per-type caps for intent-gap/optimize) from DB counters, incident records, never auto-reset; PostHog definitions (funnel, cost-per-domain, preview economics, calibration, opportunity mix) + alerts provisioned idempotently by script; `article_cost_finalized`.
Read first: main §14.5, §14.7, §14.4 (degradation table); tech §5.
Done when: flipping `global.pause_all` stops dequeue within one tick; judge-fail fixture trips the global pause and pages; a trip fires with PostHog mocked offline (control-plane test); provisioning script run twice creates no duplicates; check mode fails on a hand-edited dashboard.
Invariants: 17.

### M9 — Frontend · Lane F (starts Wave 1 on MSW mocks; integration cards follow backends)

**T9.1 — App shell, nav, locked states, banners, i18n, PostHog client**
Read first: ui §1, §11; main Appendix A; tech §1.6.
Done when: six nav items; locked treatment before `ready_for_planning`; banner stack max 2 visible; all strings externalised (lint: no string literal JSX text); Limited Intelligence badge component; Storybook/preview for the banner stack.

**T9.2 — Landing, preview, signup, plan**
Read first: ui §2; main §3, §4.2; Appendix A.
Done when: Playwright: URL → card → teaser (snapshot: "See your organic growth opportunities →") → signup → plan (snapshot: cap string) → Checkout redirect; 429 and fallback states rendered; no card form anywhere (grep).

**T9.3 — Onboarding**
Read first: ui §3 (all); main §6.1–6.9.
Done when: stepper mirrors `job_steps` over SSE with the seven labelled steps incl. skipped GSC; Shopify blocking card snapshot contains the read-only trust copy; parked states; confirmation page with all seven sections incl. competitor cap tooltip, SERP-derived competitor suggestions with Add (disabled at 5), and family accordion; "finding opportunities" card → navigates to Opportunities with the headline string (snapshot).

**T9.4 — Opportunities screen**
Read first: ui §5 (all); main §7.6, §7.9, §7.12, §10.4; Appendix A.
Done when: card shows all required fields (test asserts action badge, impact, confidence, evidence line, why-line, signal tag, primary action per type); filters + group-by; drawer with evidence table, tasks, OPTIMIZE current-vs-suggested view with copy buttons and download, FIX view, HOLD checklist, history; dismiss with undo; 409 toast; Limited Intelligence header; empty state copy. **The empty-state sentence this done-when originally quoted — "next scan runs Monday" — was replaced by the founder's decision of 2026-09-04 and by `R-SCANCOPY`, which landed 2026-09-07. It now counts days to the date the screen's own header names, and says nothing about timing when no date is known.**

**T9.5 — Content: calendar, articles, article detail**
Read first: ui §6 (all); main §8.6, §8.7, §9.3.
Done when: Playwright: veto + undo, drag/swap, pinned rejection shake, add → `checking` → `planned`/`warning`/`converted`/rejected; past-day outcomes incl. rejection card; no-topic days render nothing; article detail has no edit affordance (assert absence of any editor/textarea); override confirm dialog restates failing criteria; export rows show downloads + URL confirm.

**T9.6 — Dashboard, Products, Performance**
Read first: ui §4, §7, §8; main §7.12, §9.6.2, §12.2.
Done when: dashboard order is growth headline → next up → month strip → performance → attention → connections; month strip has no "x of y" (denominator lint on rendered output); Products shows merchant task cards with Shopify deep links and the read-only family list; Performance chart with connect/publish/applied markers and the lag note; Search Console tab rows carry signal badges linking to opportunities; override articles in a collapsed section.

**T9.7 — Settings & notifications bell**
Read first: ui §9, §10; tech §1.6; main §9.5 (blog picker), §14.6.
Done when: every control in ui §9 exists and none that isn't (inventory test against the settings map); auto-publish toggle runs write-grant → blog picker inline; cancellation facts on the billing card; delete-account modal type-to-confirm; bell polls at 30 s with seen/read tiers.

**T9.8 — End-to-end flows (M9 exit gate)**
Read first: tech §6 (UI row); ui §3, §5, §6.
Done when: Playwright against staging: onboarding through activation; opportunity → schedule → calendar; OPTIMIZE generate → download → mark applied; draft review approve; override; export URL confirm — all green.

### M10 — Exit gates · serial

**T10.1 — Full chaos test nightly green** — main §14.3.9; tech §5. Done when: ingest → scan → generate → publish → repair with random kills converges; exactly one remote article per external id; billable-call count equals distinct canonical requests; wired-stub report is empty.
**T10.2 — Invariant sweep** — auditor session; every constitution invariant mapped to a named mechanism, each run; findings report. Done when: zero "invariant without teeth".

> **Named work this card must carry (founder, 2026-09-04).** Four reporters are known to
> fail towards "fine" — they report success when the thing they check is broken. Each is
> already diagnosed; this card is where they get teeth.
>
> 1. **A scheduled job name with no matching handler disables the whole schedule instead of
>    failing.** The worker enables recurring jobs only when every scheduled entry has code
>    registered under exactly that name; one mismatch turns all seventeen off and says so in
>    a single log line. It should stop the worker loudly. This is the defect that kept the
>    product's clock off while everything looked green.
> 2. **`contracts:check` never compares the frozen contract to the route files on disk** —
>    only to the generated document — so ten endpoints built at addresses the contract does
>    not know about passed it every time.
> 3. **The stub report only sees class-shaped stand-ins**, so a stub of any other shape is
>    outside it entirely.
> 4. **The chaos suite discards `result.kills`**, so a scenario whose kill never fires is
>    indistinguishable from one that passes.
> 5. **`pnpm stubs:report` mixes one stale entry with two real ones and nothing tells them apart.**
>    `LlmJudgeLite` is constructed in production and its line was never removed; the judge-rejection
>    and publish-failure auto-trips genuinely cannot fire, because the composition root passes
>    neither counter. A reader who dismisses the stale one dismisses all three.
> 6. **A refused sign-in answers 200 with an error page**, so any check written against the status
>    code passes on a completely broken sign-in. That is how the broken Google button shipped and
>    stayed broken after being recorded.
> 7. **A check whose *claimed scope* exceeds its real one — a different kind from the six above, and
>    grepping for weak assertions will not find it.** `apps/web/app/api/auth/_lib/config.ts:67` says
>    `authWiring.test.ts` asserts the email provider is present "so email sign-in cannot quietly fall
>    off the sign-in screen". The test exists and passes; it checks the built configuration and can
>    say nothing about what the screen renders — and email sign-in has done exactly the thing the
>    comment says it cannot. **Only reading the sentence beside a test finds this class.** Sweep the
>    comments around load-bearing tests, not just the assertions inside them.
>
> Two patterns worth copying, both already in the tree: `R-INTENTGAP-SCAN`'s guard file
> asserts up front that it found files to check before forbidding anything, and its
> end-to-end test *measures* that the search provider recorded zero calls rather than
> asserting it.
**T10.3 — DECISIONS drift check + spec-contradiction hunt** — auditor session; classify every entry, propose spec edits for class b, escalate class c; hunt stale cross-refs between the three specs. Done when: no class-c entries stand; spec-keeper approved edits applied to `/docs`.
**T10.4 — Dev-store smoke suite & app-listing checklist** — tech §6; main §14.6 (GDPR webhooks), §6.2. Done when: OAuth (read, then write), sync, two-phase publish, webhook HMAC, `shop/redact`, `customers/*` all pass against the dev store; Shopify app-listing requirements checklist complete.

---

## 7. Audit schedule

- **Task audit** (fresh session, before dependents start) after: T0.3, T0.4, T0.5, T1.2, T2.2, T3.5, T3.6, T4.2, T4.4, T4.5, T5.2, T6.2, T8.2, T8.3.
- **Invariant sweep** at the end of every milestone (the integrator runs it; findings become cards or DECISIONS entries).
- **Drift check** at the end of every wave; class-c entries block the next wave.
- **Spec-contradiction hunt** before Wave 2 and before M10.

Audit output is always a written report with `[severity] §ref — finding / spec requires / code does / proposed fix`; never a silent fix.

---

## 8. Session mechanics (Claude Code)

- One git worktree per lane: `git worktree add ../sortiva-lane-c lane-c`. Each session starts in its lane's worktree with `CLAUDE.md` auto-loaded.
- **Kick-off prompt (paste verbatim, replace the ID):**
  > Implement card **T3.4** from `docs/agent-work-plan.md` §6. Follow `CLAUDE.md`. First: read the card, then read every section it cites verbatim from `/docs`, then grep `DECISIONS.md` for this area. Write a short plan (files, order, which done-when each step satisfies, invariants touched) before any code. Journal undictated choices in `DECISIONS.md` as you go. Finish by running every done-when check and reporting the evidence. Do not start another card.
- The session ends with: what was built, done-when evidence (test output, not assertion), DECISIONS entries made, next card in order, and whether an audit is required.
- **Audit prompt:** "Audit card **T5.2** per the audit procedure: read its cited sections cold first, write expectations, then read only the diff `git diff main...lane-d` against them. Report findings; change nothing."
- Never paste chat history into a session. If a card can't be done without it, the card is wrong — fix the card (integrator) rather than the session.
- Credentials arrive as environment variables in the worktree; agents never see live keys (Stripe test mode, Shopify dev store, DataForSEO mock outside prod — tech §5).

---

## 9. Standing rules (every card, every session)

1. Read the card's cited sections before writing code. Do not cite them in the commit message or in code comments — the commit title says what changed, in words.
2. Undictated choices go to `DECISIONS.md` immediately. Large ones (user-visible behaviour, an interface another lane consumes) stop the session and ask.
3. New thresholds go to `packages/rules`, never inline. New copy goes to `packages/ui/strings`, never inline.
4. Stay inside your lane's directories; migrations only in schema-wave cards; contracts change only through the integrator.
5. Never mark a card done with failing checks; park it explicitly with what remains.
6. Flagged cards get a fresh-session audit before anything builds on them.
7. Specs are edited only by the spec keepers; if the spec is wrong, say so in the session report and in `DECISIONS.md` — never implement around it.

---

## 10. Kickoff checklist (before the first agent session)

- [ ] Founders sign off main-spec Appendix B defaults (or the plan's cards that assume them: T3.1/T3.5 for GSC soft-required, T6.2 for recommendation-only OPTIMIZE, T2.2 for revenue capture-only, T6.3 for FIX scope, T3.6 for High/Medium/Low impact, T9.1 for six-item nav).
- [ ] Repo created with `/docs/{sortiva-spec,sortiva-ui-spec,sortiva-tech-spec}.md`, `CLAUDE.md`, `DECISIONS.md`, `docs/agent-work-plan.md`.
- [ ] Shopify Partner dev store, Stripe test mode (+ test clocks), DataForSEO sandbox or mock config, a GSC test property, Resend domain, PostHog project, Railway project — credentials in the secret store.
- [ ] Decide who plays integrator per milestone (a founder for M0–M2 is recommended; an agent session can take over once the pattern is established).
- [ ] Run M0 serially with one agent (T0.1–T0.4), then two in parallel (T0.5 ∥ T0.6), then T0.7. Only after the M0 exit gate does any lane start.
