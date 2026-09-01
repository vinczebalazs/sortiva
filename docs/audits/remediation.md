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

---

# Later additions (2026-08-31, same session)

## D6 — The pipeline logs per store (from the debuggability investigation)

**Accepted: folded into `R1` while it was still running.**

The product has a structured JSON logger with secret scrubbing, real and tested, at
`packages/core/src/observability/logger.ts` — with **zero callers**. No log line anywhere
carries a store's identity, a job identity or a step name, so a merchant reporting
"nothing has happened" can be *located* (which step is stuck) but not *explained*.

`runStep` in `packages/jobs/src/runtime/runStep.ts` is the one place that knows the
account, job, step and attempt simultaneously, and `R1` was already open in that file.
One change there gives every step handler any lane ever writes a per-store log line for
free; the same change after forty handlers exist touches forty files.

## D7 — Schema mini-wave 2b (card `T2.0b`)

`T2.0` committed minutes before two approved additions could reach it, so they ride in a
small explicitly-sanctioned follow-up wave on branch `schema-2b`:

1. **A table for email sign-in tokens.** Card `T1.1` shipped Google-only sign-in and
   reported this as a blocker: a magic link needs somewhere to keep its single-use token,
   and no wave had created one. main §4.1 asks for email sign-in.
2. **The idempotency ledger moved to its own table**, with no foreign key to the job
   tables — the durable half of the `T0.4` finding, replacing `R1`'s cheap guard.
   **The worker runtime does not yet read it**; a follow-up card must move it over, after
   `R1` lands.
3. **`account_settings.limited_intelligence`** — a boolean `T3.1` sets when a merchant
   skips Google Search Console. Flagged by `T2.0`, which correctly declined to add it.
   *Integrator's judgement, not a founder instruction* — one reversible column, against a
   mini-wave mid-milestone-3.

## D8 — An operations card, scheduled after wave 1

**Accepted.** Four small things that share a theme, none of which exists and none of which
any card in the build plan owns:

- a script taking an email or domain and printing the store's state and every pipeline step;
- a one-command replay for permanently-failed work — the function exists and has no caller,
  while main §14.3.5 promises "one action";
- a health check that actually checks the database and the worker, rather than the current
  one that returns OK unconditionally and so cannot fail while the app is broken;
- wiring the crash-reporting method that is already written and never called.

Three of the four are proposals rather than spec requirements; the replay surface is the
one the spec already asks for. To be carded at the wave-1 boundary.

## Infrastructure

The Railway project `sortiva` (created 2026-08-17) was running a **different application** —
its last successful deployments, 2026-08-21, are from commits absent from this repository,
whose first commit is 2026-08-27. Four services against the two tech §2.1 specifies, including
a Redis the current architecture explicitly does not use. Founder ordered it deleted in full;
deletion requested 2026-08-31 and accepted by Railway, which schedules rather than performs it
inline. **Confirm it is gone before the rebuild is first deployed.**

## D7 item 3 — declined by the implementing session, with better evidence

`T2.0b` did not build `account_settings.limited_intelligence`, and recommends it stays
unbuilt. The reasoning survives scrutiny and overturns the integrator's judgement call:

"Limited Intelligence" — the reduced mode a store runs in without Google Search Console —
is *defined by the spec as the absence of the connection* (main §7.11's title; §6.7's
"until connected"). The table recording that connection, `gsc_conns`, already exists as of
schema wave 2, one row per account. So the answer is a one-row existence check, not a fact
anyone needs to write down. Storing it too creates two records of one fact that drift in
two directions, both merchant-visible: a badge nagging someone who has already connected,
or reduced-mode signals evaluating against data that is not there. The merchant's explicit
"I skipped this" is separately recorded — main §14.3.1 ends that onboarding step in a
`skipped` state.

Decisive: **card `T1.1` has already shipped `GET /api/account` with `limitedIntelligence`
computed as "no Search Console connected"**, and journalled that reading. The live API
already treats it as derived.

**Open for the integrator (one line, no code):** `docs/agent-work-plan.md` puts the flag in
`T3.1`'s scope and says the skip path "sets `limited_intelligence = true`". That line
contradicts the spec and the shipped API. Recommend amending it so `T3.1` computes the
value rather than storing it. Not done — changing a card's declared scope is the
integrator's call, not the orchestrator's.

## Open after R3

- **The idempotency ledger has no account column.** `T2.0b` built exactly the three columns
  its card specified. If card `R3` finds it needs one — for operability ("which store did
  this belong to") or for pruning — that is another wave exception and the integrator
  decides. `R3` is instructed to report rather than add it.

## D9 — Schema mini-wave 2c (card `T2.0c`), founder-requested

Card `T1.2` (Stripe billing) reported two schema-shaped gaps it worked around rather than
filed as blockers. Founder asked for both fixed, 2026-08-31. Branch `schema-2c`, built off
schema wave 2b merged with `T1.2`'s billing code — because a schema change nobody adopts
leaves the dangerous behaviour in place.

1. **`subscriptions.synced_at` is doing two jobs.** Stripe delivers billing webhooks
   at-least-once and out of order, so `T1.2` discards any message older than the state we
   hold. Needing Stripe's own timestamp and having no column for it, it repurposed
   `synced_at` — which meant "when we last checked with Stripe". **The risk it named
   itself:** a later card writing `synced_at = now()` on a webhook path — the obvious thing
   to do — silently disables the guard, and out-of-order messages start rolling a paid
   merchant's status backwards. Nothing fails loudly. The card adds a dedicated column,
   restores `synced_at`, and makes the meaning enforceable rather than conventional.
2. **Stripe's `incomplete` is stored as `incomplete_expired`** — mid-purchase recorded as
   gave-up. No behaviour change today; wrong data for any later card reading it.

The card is licensed to cross the usual lane boundary (`packages/db` **and**
`packages/core/src/billing` + the Stripe webhook route) for the reason above, and is
explicitly invited to decline either item if reading main §13 and §4.2 says the spec
intends otherwise — as `T2.0b` correctly did with `limited_intelligence`.

## Open from `T1.2` — two things with no owner

- **The plan screen has nowhere to get its price.** main §4.2 forbids hardcoding a dollar
  amount ("amounts live in Stripe only"), and the route table frozen by `T0.7` has
  `/api/billing/checkout` and `/api/billing/portal` and **no plan endpoint**. So the screen
  cannot show a price without either a new route (which means the integrator re-freezing
  the contract) or a build-time read. `T1.2` did not invent a route. The plan's *content* —
  intervals, the verbatim cap line, inclusions, cancellation facts — is ready in
  `packages/core/src/billing/plan.ts`. **This blocks Lane F's `T9.2` (the plan screen).**
- **`packages/ui/strings` does not exist and no card creates it.** The constitution says all
  user-facing copy lives there, keyed by its main Appendix A row. `T1.2`'s six billing
  strings are constants in one core module with snapshot tests — one copy of each string,
  but not where the rule says. Lane F owns `packages/ui`; creating the strings package is
  the natural first act of `T9.1`, which is the card currently blocked on the design file.

## D10 — Card `R4` (queued): finish the wiring

Three loose ends the remediation cards could not close, because each lives in a package its
card did not own. Small, and they belong together.

1. **Nothing writes to `spend_events`.** `R2` made every path through both paid-vendor
   wrappers hand its cost to a ledger — success, vendor error, rate limit, timeout, dropped
   connection, a stream cut off partway, a storage failure after a good answer. But the
   piece that inserts the row is a repository, and repositories live in `packages/db`, which
   `R2` was told not to touch. **Today the only ledger available is the deliberate no-op**,
   so a production process still records no spend to the database and card `T8.4` still has
   nothing to read. Roughly thirty lines, using the mapping function `R2` shipped.
2. **The `CostLedger` interface is in the wrong package.** The repo's layering rule (journalled
   under `T0.5`) puts seam definitions in `packages/core/src/contracts/`, beside the caching
   and analytics equivalents, precisely so the AI package and the vendor package need not
   depend on each other. `R2` could not write there, so it sits in `packages/providers` and
   `packages/llm` now depends on `packages/providers` to reach it — the coupling that rule
   exists to prevent. A pure move; no behaviour or shape change.
3. **The raw-table lint rule's list is stale.** `R1` added a rule stopping code from reaching
   database tables without naming a store. It works off a hand-maintained list of table names
   written before schema wave 2, and **names no wave-2 or wave-2b table at all** — `R3` found
   this when its own new file passed silently rather than being caught and consciously
   exempted. A guard with a stale list is worse than no guard, because it reads as protection.

Optional fourth, now unblocked: PostHog batches analytics events and nothing empties the batch
on shutdown, so the most recent are dropped on every deploy. One line in the worker's shutdown
handler — `packages/jobs/src/runtime/worker.ts`, free now that `R1` and `R3` have landed.

## Open questions raised by `R2` and `R3`

- **A failed vendor call's cost is an estimate, and the error probably leans one way.** Neither
  vendor says what a failed call cost. DataForSEO very likely does not bill for a request it
  rejected as malformed, so failure rows probably **over-count** there — and an over-counting
  meter trips a spending limit early, pausing the product for money never spent. The ledger
  stores an `outcome` column rather than one flat total precisely so the card that builds the
  limits (`T8.4`) can decide whether its window sums failures, discounts them, or ignores them.
  **That choice is a product decision and is still open.**
- **A ledger write that fails is logged, not raised.** Deliberate: on a successful call the
  vendor is already paid and its answer stored, so failing the job would discard work we bought;
  on a failed call, raising a database error would replace the vendor's own error, which is what
  decides whether the step retries. The cost: if the ledger is persistently unreachable, spending
  is under-counted quietly. Wants an alert on `spend_event_not_recorded` — observability card.
- **Job rows are no longer protected from deletion.** `R1` added a tripwire forbidding any
  deletion path from reaching them; `R3` repointed it at the ledger and deliberately made job-row
  deletion permissible again, since that is what the card buys — a "restart onboarding" feature
  no longer risks re-billing. **If those rows are wanted for a different reason — an audit trail
  of what a store's pipeline did — that is a separate requirement and its guard is now gone.**

## D11 — Preview spend must join to the account that later signs up (founder, 2026-09-01)

Card `T1.3` flagged that two normalisations disagree. The preview keys its cache and its
cost records on the exact host pasted, minus `www.`; domain claim (card `T1.4`) folds to the
registrable domain via the public-suffix list — `shop.example.com` becomes `example.com`. So a
visitor who previews `shop.example.com` and later claims `example.com` leaves preview spend
that never joins to their account, defeating main §14.7's rule that a domain's pre-signup
preview spend becomes visible once that domain connects.

`T1.3` judged this the right trade and reported it rather than deciding it. **Founder ruling:
costs must be traceable.**

**Recommended fix — no migration expected.** The fetch target and the attribution key do not
have to be the same value. A preview must fetch the exact address someone pasted, so that stays.
Record the **registrable domain** as the cost-attribution key on the spend event so the join
works, and keep the **exact host** on the PostHog event property, where it is what you would want
for spotting abuse. One value changes; nothing about fetching or caching moves.

**Owner:** a small card on Lane A's branch, alongside `T1.4`. Not folded into a running session —
the preview code belongs to Lane A and the ledger to `R4`, and having one reach into the other is
what caused yesterday's collisions. If the implementing session finds a migration is genuinely
needed, it must stop and report rather than adding one: two sessions are adding migrations on
separate branches right now and a third would collide at merge.

## D12 — Card `R5`: wire analytics in once (founder, 2026-09-01)

**PostHog has received zero events since the project began**, and would have continued to.
Card `R4` found the reason while checking a different finding: the audit said batched events were
dropped on every deploy, but **nothing in a running process ever constructs a PostHog client at
all**. The class is written and tested and has no caller outside its own tests. Nothing is dropped
because nothing is captured. `R4` correctly declined to fix it, because what is missing is not a
line of code but a decision every later call site would copy: where the process's single analytics
client lives and who hands it to the code that records events.

This is also the root of what the debuggability investigation found — three cost events have call
sites, the roughly twenty-seven others in main §14.7's taxonomy are spec prose, and every dashboard
and alert is scheduled for milestone 8.

**Founder ruling: do it now, as a small card.** The argument that decided it is the one that made
per-store logging cheap yesterday and would have made it expensive next month — every card from
here adds call sites, and each either follows a pattern that exists or invents its own.

**Scope:** decide and implement how the app supplies shared services to the code that needs them;
construct the analytics client once at process start; hand it to the existing capture points; prove
one real event actually arrives rather than asserting it does. Then wire the shutdown flush that
`R4` left as `NOT BUILT` — its hook already exists and is empty, and with a live client the batch
really would be dropped on every deploy.

**Constraint:** invariant 26 is unchanged — events carry identifiers, counts and flags only, never
product content, prompts, article text or tokens. And PostHog stays telemetry: invariant 17 means no
kill switch, cap or gate may ever read from it.

## Also open from `R4`

- **Prompt files and the deployment mode.** Prompt files reach production today because the deploy
  runs from the repository tree. If the web build is ever switched to the self-contained
  "standalone" output, they would need an explicit entry to be carried along — exactly as the rules
  config already has. Adding it now changes nothing; leaving it out is a trap later. `R4` recorded
  the condition in a comment rather than editing the web config unasked. **One line, on the
  founder's word.**
- **No standing guard on the prompt-loader build regression.** `R4` proved the fix by planting a
  route that imports the loader, then removed it — so today's build passes whether or not the bug
  is present. The guard becomes real the moment a genuine feature loads a prompt from the web side.
  An earlier guard would mean either a permanent throwaway route or a second build in CI; `R4`
  built neither unasked.

## D13 — No spec citations in code or commit messages (founder, 2026-09-01)

**Founder ruling.** The build is the source of truth. Where a decision changed during the build,
that decision governs — it gets flagged to the founder, in `DECISIONS.md` and in the session
report, and **not** documented in the code as a spec reference.

The reasoning, in the founder's words: a section number tells a reader nothing. It is the same
rule already applied to reports — a citation is evidence, not an explanation — extended to code.
It is also actively misleading, since it points at a document that may be out of date relative
to the code beside it, while looking like an explanation.

A survey found **726 spec citations** in non-test code. The representative pattern:

```
/** main §5 — the claim enqueues the ingestion run. */
// Invariant 20 / §14.3.6 — the raw envelope is stored before it is processed.
```

In each, the sentence is the useful half. Where a real reason exists it should be written out —
"so a crash after the vendor answered doesn't make us pay for the same answer twice" — and where
none exists the comment should go.

**Constitution amended today:** `CLAUDE.md`'s threshold rule now asks for a plain-language note
rather than a spec §; the commit-message format drops its § list; a new code-structure rule states
the policy. `docs/agent-work-plan.md` standing rule 1 amended to match.

**Kept:** the `Nearest spec` line in `DECISIONS.md` entries — that is the channel by which
deviations reach the founder.

**Cleanup: a dedicated sweep card, after integration.** Not now: ten branches are live, three of
them being actively written to, and a sweep would conflict on nearly every file. It waits until the
branches are merged and there is one tree.

**Unresolved, to settle during the sweep.** The API route table carries a `spec:` **data field** on
each of its 55 routes — machine-read by the contract checker and the generated API document, not
prose for a human. The founder did not confirm leaving it alone, which reads as "remove it too".
Before removing it: check whether the generated document exposes those values to consumers, because
Lane F's mock server is built from that document and a change there is a contract change needing a
re-freeze. If it is internal only, remove it with the rest.

**Consequence for audits.** The audit procedure reads the cited spec sections cold and compares the
code against them. With build-time decisions superseding the spec, an auditor must compare against
**spec plus the recorded decisions**, or it will report deliberate changes as defects. Audit briefs
updated accordingly.

## D14 — The two deploy facts, fixed (founder, 2026-09-01)

Both found by the coverage investigation (`docs/audits/coverage-gaps.md`), both one line,
neither owned by any card.

1. **Migrations were never applied on deploy.** `railway.toml`'s build installed and
   compiled; its start ran the server. Nothing anywhere ran a migration, so **the first
   deploy would have served code against a database with no tables** — against tech §5's
   "forward-only, applied on deploy before the new code serves traffic". Fixed with
   `preDeployCommand = ["pnpm db:migrate"]`, which Railway runs before the deployment
   takes traffic. Verified by running that exact command against a freshly created empty
   database: 41 tables.

   One dependency worth knowing: `drizzle-kit` is a devDependency and the build installs
   everything, so it is present at pre-deploy time. If anyone adds `--prod` to the install,
   this is what breaks — and it breaks the deploy rather than the running app, which is the
   right direction.

2. **The graceful shutdown was inert.** Card `R5` measured that Next installs its own
   signal handler and exits before ours finishes, so on every deploy in-flight jobs were
   killed rather than drained and the last analytics events were dropped. Fixed by setting
   `NEXT_MANUAL_SIG_HANDLE=1` on the start command, in `railway.toml` rather than a
   dashboard, so it travels with the repo.

   **The flip side, which is why `R5` referred it up rather than doing it:** Next no longer
   exits on the signal by itself, so one of our two paths must always register a handler
   that does. Both do, and I verified it — with the worker running, `installSignalHandlers`
   drains and exits (its `exit` option defaults to a real `process.exit`); with
   `WORKER_ENABLED=false`, the startup hook registers its own drain and exits. If that ever
   stops being true the process hangs until the platform kills it. Written at both sites.

### Flagged, not fixed: `railway.toml` is a deprecated format

Railway's own documentation now says Config as Code (`railway.json` / `railway.toml`) is
**deprecated**, replaced by Infrastructure as Code (`.railway/railway.ts`), with a hard
cutoff of **2026-12-01**. The line that matters more than the cutoff: **"New services
cannot opt into Config as Code."**

This project has never deployed, so its Railway service does not exist yet. If that
sentence means what it says, the file just fixed may be ignored entirely when the service
is first created — and both fixes above, plus the memory cap and the no-scale-to-zero
setting, would silently not apply.

Not acted on, because migrating the deployment format is a change to how the product is
deployed rather than a fix to what it does, and nothing deploys today. **Worth settling
before the first deploy, not after.**
