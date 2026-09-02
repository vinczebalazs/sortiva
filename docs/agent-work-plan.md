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

**R-DEV — `next dev` cannot start, so nobody can run the app locally** · integrator to assign
Scope: `pnpm dev` fails outright. The server's start-up hook imports `@sortiva/jobs`, whose runtime imports `graphile-worker`, which imports `cosmiconfig`, which requires `fs/promises` — and Next cannot resolve that for the dev bundle. The error is `Module not found: Can't resolve 'fs/promises'` while compiling `/instrumentation`. **The production build is unaffected and `pnpm smoke:boot` is green**, which is exactly why no gate catches it: `smoke:boot` starts the *built* app. Found by `T9.5` while trying to run browser flows, and reproduced by the integrator directly.
Read first: `DECISIONS.md` `2026-09-02 — T-BOOT` (all four entries) and the "FIXED — the application would not start" section of `docs/overnight-state.md`; tech §2.
Done when: `pnpm dev` starts and serves `/` and `/api/health`; a gate step proves it, so this cannot regress unnoticed the way it has; and the two Playwright projects still pointing at `pnpm dev` can run locally again.
**Why this is not a lane's to take.** It is the same family as the defect `T-BOOT` repaired — a module resolved one way at build time and another at run time — and the founder ruled on that one deliberately, choosing "load on first use, plus a lint rule" and **explicitly rejecting** "mark the package external to the server bundle". The obvious fix here (declaring the job library external, or keeping it out of the dev bundle) is that rejected option wearing different clothes, so it should be settled by the same person rather than picked at night by an integrator.
Note: **this is pre-existing, not a regression from the 2026-09-02 run.** The start-up hook has imported the jobs package since well before it. Its cost is that every developer runs against `next start` or not at all, and that two browser-flow suites are dead locally.

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
Done when: card shows all required fields (test asserts action badge, impact, confidence, evidence line, why-line, signal tag, primary action per type); filters + group-by; drawer with evidence table, tasks, OPTIMIZE current-vs-suggested view with copy buttons and download, FIX view, HOLD checklist, history; dismiss with undo; 409 toast; Limited Intelligence header; empty state copy "next scan runs Monday".

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
