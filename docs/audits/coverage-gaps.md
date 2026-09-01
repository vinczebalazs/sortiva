# Coverage and structural risk — what is real, what is empty, what would break

Read-only investigation on `main` at `9a45f14`, after wave 1 was merged. Nothing
was changed. Everything below is either **verified** (I ran it or read it) or
marked as **inference**.

Terms I use repeatedly, defined once:

- **A card** — one unit of planned work in `docs/agent-work-plan.md`, e.g. `T2.1`.
  Cards are grouped into milestones `M0`–`M10`. Wave 1 delivered M0 and M1 plus
  the first card of M2.
- **A worker / background job** — slow work (pulling a store's catalogue,
  summarising products) done outside a web request. The queue is Graphile Worker,
  running inside the same Node process as the website.
- **A step** — one named stage of a store's onboarding (`detect`, `catalog_sync`,
  `distill`, …), stored as a database row with a state.
- **A cron entry** — a recurring job with a clock time, e.g. "every night at 02:00".
- **A stub** — a deliberate stand-in for a component a later card will build.
- **The specs** — three documents in `/docs`. I read the sections you named
  verbatim; I quote what they require in plain terms rather than citing them.

---

# Part 1 — What would most change the risk, in order

Five things. Two are **spec requirements** (the specs already demand them; only
the timing is yours to decide). Three are **proposals** — my judgement, not in
any spec or card, and therefore not work until you say so.

---

## 1. Nothing in a running product ever advances a merchant's onboarding. — spec requirement, and it is the single biggest gap

**Verified.** There is a complete, well-tested machine for running a store's
onboarding steps: a table of steps, rules for which step may start when, a
"have I already done this" ledger, retries, a dead-letter parking bay, and a
per-store lock. 60 tests cover it.

**Nothing calls it.** I grepped every production file for the two functions that
drive it — `dispatchableSteps` (which asks "which steps can run now?") and
`runStep` (which runs one). The only callers anywhere in the repository are the
chaos test harness and the unit tests. There is no code path in the deployed
application that takes a job row and executes it.

Separately, the recurring schedule is switched off. The worker enables its clock
only once *every* one of its 12 scheduled jobs has a handler; 11 have none, so
cron is disabled wholesale. That includes `subscription_reconciliation_nightly`
— the job that repairs a merchant's billing status when Stripe's webhook is
dropped. Its handler *is* written and registered; it simply never fires,
because it is hostage to the other 11.

So today: a merchant can pay, claim their domain, and land on a progress screen
whose steps will sit at "pending" forever. And if Stripe drops the "payment
succeeded" message, nothing ever notices.

**What it costs now:** the dispatcher is a small piece of work — read the
dispatchable steps for a job, enqueue one Graphile job per step, run it through
`runStep`. It is arguably already owned by `T2.1` (the first card that has a
step to run). The cron-gating rule is a one-line policy question: all-or-nothing
today, versus "enable cron for the entries that do have handlers." I'd
recommend the latter, because it lets the nightly billing repair start working
immediately and independently of eight unwritten cards.

**What it costs later:** if you build screens first, every screen past the
progress state has nothing behind it and no way to get anything behind it —
you'd be building against MSW mocks with no path to switching them off.

---

## 2. The kill switches, spend caps and auto-trips do not exist. — spec requirement, owned by `T8.4`, currently scheduled at the *end* of the build

**Verified.** The specs require (main §14.5) manual pause flags checked at every
job dequeue, and automatic trips: pause an account whose daily AI spend exceeds
10× its own median or a hard dollar cap; pause enrichment when the global
keyword-data spend exceeds a cap; pause the preview endpoint when *its* spend
exceeds a cap; pause everything when the quality judge starts failing 60% of
drafts.

What exists: the flags table (`ops_flags`), two functions to read a flag, one
function to raise one, and the money meter (`spend_events`) that every paid
vendor call already writes to. That last part works and is tested.

What does not exist: **nothing ever raises a flag.** `tripAccountFlag` has zero
production callers. **Nothing sums the meter.** No code anywhere reads
`spend_events` to compare a total against a cap. Only *one* flag is ever read in
a running app — `global.pause_preview`, by the preview endpoint. The other three
(`global.pause_all`, `global.pause_publishing`, `account.pause_generation`) are
read only to *display* "the service is paused" on the dashboard; nothing acts on
them, because there is no dequeue to check them at.

The practical consequence, and why I rank it second: the moment item 1 is fixed
and real work starts running, the product can spend money with no ceiling and no
brake. The preview is the one exception — its cache, its per-IP limits and its
one working kill switch are genuinely in place.

**What it costs now:** the caps are already written down as numbers in
`packages/rules/signals.config.yaml`, and the meter they read is already
populated. Building "sum the last 24 hours, compare, raise a flag, refuse to
dequeue" is small — much smaller than `T8.4`'s full scope, which also includes
incident records, four-eyes reset and PostHog dashboards.

**What it costs later:** the first month of real merchants is exactly when a
prompt regression or a runaway loop is most likely, and it is currently
unbounded. Note also the open product question already recorded in
`docs/audits/remediation.md`: a *failed* vendor call's cost is an estimate, and
probably over-counts — so a cap built naively could pause the product for money
never spent. That decision is yours and is still open.

---

## 3. Only the front door of the funnel is built; almost every screen's backend is a schema with no implementation. — fact, not a recommendation

**Verified by counting.** The API contract frozen in M0 declares **56 routes**.
Eight of them are implemented. The other 48 exist as: a request/response schema,
an OpenAPI entry, and a mock handler that returns fixture data. `pnpm
contracts:check` passes — because it checks that the schema and the OpenAPI file
agree with each other, not that anything serves them.

This is not a defect — it is exactly what M0 was for, and it is why Lane F can
start. But it changes what "build the screens" means: **the screens will run
entirely on mocks, and there is currently no card between now and M9 that turns
any of them off.** Every screen past the onboarding progress state (opportunities,
calendar, articles, products, performance, settings, notifications) has no
backend at all, not even a stub — the route file does not exist.

**Why I flag it at this rank:** the risk is not that the work is missing, it is
that the mock fixtures are *decided by the mock*, not by the domain. If a screen
is built against a fixture shape that the eventual backend cannot produce, that
is discovered in wave 3. Cheap mitigation now: when Lane F builds a screen,
have it record which fixture fields it depends on, so the backend card inherits
a contract rather than a surprise.

---

## 4. Nobody can answer "why is this store stuck", and nobody can un-stick it. — **proposal** (three of the four pieces are mine; one is a spec requirement)

**Verified.** There is no admin page, no operator script, and no support
tooling of any kind. Specifically:

- **Diagnosis is hand-written SQL.** To find out where a store is, you would
  connect to Postgres and join `accounts` → `domains` → `ingestion_jobs` →
  `job_steps` by hand. There is no command that takes an email or a domain and
  prints it.
- **The dead-letter replay has no caller.** The specs say (main §14.3.5) that
  operations "can replay a DLQ item with one action". The function
  `replayDlqEntry` is written and tested — and is called by nothing outside the
  test file. There is no action. **This one is a spec requirement, not my
  proposal.**
- **The kill switches can only be flipped by hand-written SQL** — see item 2.
- **The health check cannot fail.** `/api/health` returns `{ok: true}`
  unconditionally, with no reference to the database or the worker. Railway is
  configured to restart the service when this endpoint fails, so today Railway
  will happily keep a service alive whose database is unreachable. Verified in
  `apps/web/app/api/health/route.ts` and `railway.toml`.
- **No crash reporting reaches anyone.** The analytics wrapper has a
  `captureException` method, written and tested. It has **zero** callers in
  production code. An unhandled error in a route or a job goes to stdout and
  nowhere else.

All five were already identified as a group ("D8 — an operations card") in
`docs/audits/remediation.md`, accepted, and marked "to be carded at the wave-1
boundary" — which is now. No card in the build plan §6 owns them.

**What it costs now:** small — one script, one route change, one wired method
call, one CLI entry point. **What it costs later:** it is the difference between
a support question taking ten minutes and taking an afternoon, on the day you
have paying merchants and the least time to spare.

---

## 5. Two deployment facts would bite on the first real deploy. — one spec requirement, one **proposal**

**a) Database migrations are not applied on deploy.** — spec requirement
(tech §5: "Migrations forward-only, applied on deploy before the new code serves
traffic"). **Verified:** `railway.toml`'s build command installs and builds; its
start command is `next start`. Neither runs `pnpm db:migrate`. Nothing anywhere
in the deploy config applies a migration. The first deploy would serve code
against a database with no tables.

**b) The graceful shutdown does not work as deployed.** — proposal (the fix is a
config line; the diagnosis is already recorded in the code). **Verified:** the
worker installs its own shutdown handler so that in-flight jobs drain and
buffered analytics flush before Railway kills the process. A comment in
`apps/web/instrumentation.ts` states — from measurement, per DECISIONS
2026-09-01 R5 — that this only works if the process is started with
`NEXT_MANUAL_SIG_HANDLE=1`, and that "the deploy config does not set it yet." I
confirmed it appears in no config file, no `.env.example`, and no
`railway.toml`. Consequence: on every deploy, in-flight jobs are killed rather
than drained, and the last few seconds of analytics are lost. Because every step
is resumable, this is a nuisance rather than data loss — but it means the
drain machinery you paid for is inert.

Both are single lines. Neither is owned by a card.

---

# Part 2 — The map of what is real

Legend: **built & exercised** = code exists and a test runs it. **built, never
exercised** = code exists, no test and no running process reaches it. **declared
only** = a type, schema, interface or scheduled name with nothing behind it.
**absent** = not there at all.

## Sign-in and account scoping

| Piece | Status |
|---|---|
| Google sign-in | **built & exercised** — 5 tests on the config, 3 on signup |
| Email (magic-link) sign-in | **absent**. The specs (main §4.1) ask for "email + OAuth (Google)". Only Google exists. A comment in `apps/web/app/api/auth/_lib/config.ts` explains why: Auth.js will not start an email provider without a table to store single-use tokens. That table (`verification_tokens`) has since been created by schema mini-wave 2b — so the blocker named in the comment is gone, and nothing has gone back to finish it. **No card owns this.** |
| Sessions | **built**, as JWTs, because there is no database session adapter. Consequence, stated in the same comment: **a session cannot be revoked before it expires** (currently 24 hours). Relevant to account deletion and to "log out everywhere". |
| Account scoping (one merchant cannot read another's rows) | **built & exercised, and structurally enforced.** This is the strongest area in the codebase. Every repository function takes a "scope" value that only one function can create, from the session; a plain string will not type-check. A test walks every route file and fails if a new one skips the session wrapper. A lint rule rejects importing a database table directly. Eight tables that legitimately have no owner (a webhook stored before it is routed, a pre-signup preview) take an explicit "system scope" carrying a written reason, so unscoped access is greppable rather than invisible. |

## Billing and entitlement

**Built & exercised — the most complete area after scoping.** ~80 tests across
checkout, the customer portal, webhook receipt, the status worker, entitlement,
and reconciliation. The rules the specs care about are all enforced and tested:
entitlement reads only our own database row (never a live Stripe call in a
request), read access is never revoked whatever the billing state, no card form
is ever rendered, and the plan cap sentence is snapshot-tested verbatim.

Two corrections to things the previous handoff listed as broken — both are now
**fixed** and I verified it: the plan endpoint's price lookup (`fetchPrices`) is
implemented in the real Stripe provider, so the plan screen no longer answers
503; and the same-second webhook ordering race was closed.

The one gap: **the nightly reconciliation never runs** (item 1 above). Its
handler is written, registered and tested; the schedule that would call it is
disabled.

Also worth knowing: `stripe_event_drain` is a registered background job that
nothing ever enqueues — the webhook receiver drains inline instead. Harmless
dead code today, but it is a job that has never run.

## The public preview and its guarded fetcher

**Built & exercised — and this is genuinely production-shaped.** It is the only
part of the product that constructs a real AI client, writes to the real cost
ledger, and reads a real kill switch. 34 tests on the fetcher alone, against real
HTTP servers and real DNS: redirects into private address ranges, hostnames that
resolve to private addresses, decimal and hexadecimal spellings of loopback, and
rebinding between the safety check and the connection. Plus 29 on the preview
flow, 13 on the route, 11 on rate limiting, 10 on extraction, 9 on URL handling.

**Correction to a premise in the brief:** the AI client *is* constructed outside
tests — by the preview endpoint. It is the keyword-data client (DataForSEO) and
the email client (Resend) that are never constructed anywhere but tests.

Two limits worth knowing (both deliberate, both recorded in DECISIONS):

- The per-IP rate limit and the outbound-fetch concurrency cap live in the
  process's memory. **Verified.** With one instance that is correct; with two,
  both limits double. `railway.toml` pins one instance, so it holds today.
- The preview keys its cache and its cost records on the exact host pasted; the
  domain claim folds to the registrable domain. So a visitor who previews
  `shop.example.com` and later claims `example.com` leaves preview spend that
  never joins to their account. A founder ruling on this is recorded as D11 in
  `docs/audits/remediation.md`.

## The domain claim

**Built & exercised.** Normalisation (including `.co.uk` and the `myshopify.com`
exception), the transactional claim, and the conflict path. A test fires eight
simultaneous claims for one domain and asserts exactly one row survives — and a
companion test removes the unique index and proves both would get through
without it. That is real evidence, not a green tick.

## The background-work runtime

**Built and heavily tested — and reached by nothing.** 60 tests: guarded state
transitions, the completed-work ledger, per-store locking, checkpointing,
retry timing, dead-letter entries, and a real SIGTERM drain against a real
Graphile worker. It is the most thoroughly tested machinery in the repository.

And it is **built, never exercised** in the sense that matters: no production
code path calls it (item 1). The nine onboarding steps exist as names and
dependency rules; **not one has a handler.** The chaos test — the thing the
specs call "the specification's teeth" — currently contains exactly **two**
scenarios: an empty one that does nothing, and one that kills a process
mid-step. The full run the spec describes (ingest → scan → generate → publish →
repair, with random kills, asserting exactly one remote article per publish)
cannot exist yet, because none of those stages does.

## Cost recording

**Built & exercised.** Every path through both paid-vendor wrappers records what
it cost to our own database — on success, and on every failure that reached the
vendor (a rejection, a timeout, a dropped connection, a stream cut off partway).
Cache replays are recorded at zero rather than omitted. The database refuses a
row claiming a cache hit cost money. 14 tests.

The meter is populated. **Nothing reads it** (item 2).

## Analytics

**Built, barely exercised.** One PostHog client is constructed once per process
at startup, and a test proves an event travels over HTTP and arrives. Secret
values are registered with a log scrubber before anything can log.

Seven named events exist in code (`signup_completed`, `domain_claimed`,
`checkout_started`, `subscription_activated`, `payment_failed`,
`subscription_canceled`, `dlq_entry_created`) plus preview events. The specs
describe roughly thirty. The rest are **absent**, because the code that would
emit them does not exist.

`ops/posthog/definitions` — where the dashboards-as-code live — is **empty**.
`pnpm posthog:check` passes by saying so out loud. Dashboards land with `T8.4`.

`captureException` — the crash-reporting path — has **zero** callers.

## The database constraints

**Built & exercised — 72 tests across four constraint suites**, and they test
the database, not TypeScript's opinion of it. Verified enforced at the database
level: one domain per account and one account per domain; at most five
competitors per account (a *sixth insert is rejected by Postgres*, not by a
validation rule); one open opportunity per signal per entity; duplicate webhook
ids, Stripe event ids and notification triples all conflict; the money ledger
refuses a free row with a non-zero cost.

Two things about the shape rather than the tests:

- **41 tables exist; the product needs more.** Schema wave 3 (`T4.0`) has not
  run, so there is no `articles`, no `topics`, no `publish_intents` (the table
  that makes publishing exactly-once), no `article_labels`, no `pattern_stats`.
  Comments in the schema files point forward to it correctly.
- **Every database-backed test skips silently when Postgres is unreachable.**
  Verified: 14 test files are wrapped in `describe.skipIf(!available)`. A skip is
  green. If the CI database service ever fails to start, or the connection URL
  changes, roughly 250 tests — including every constraint test, the whole worker
  runtime suite, and the end-to-end funnel — vanish and CI stays green. Cheap
  fix: fail rather than skip when running in CI.

---

# Part 3 — What the specs require that nothing yet does

I read main §14.3, §14.4, §14.5, §14.6 and tech §5, §6 verbatim. For each
requirement: what it is in plain terms, its status, and which card owns it.

## main §14.3 — idempotency and resumability

| Requirement, in plain terms | Status | Owner |
|---|---|---|
| Onboarding is a state machine of steps with guarded transitions | **built & exercised** | `T0.4` ✅ |
| "Have I already done this work" keys computed from the inputs, so a retry produces the same key and returns the stored answer | **built & exercised** | `T0.4` ✅ |
| All work for one store runs single-file (per-account lock) | **built & exercised** | `T0.4` ✅ |
| Any step over 60 seconds saves its place | **built & exercised** as a facility; **no step uses it**, because no step exists | `T2.2` |
| Retries at 1m / 5m / 25m with jitter; dead-letter queue carrying full replay context | **built & exercised** | `T0.4` ✅ |
| Ops can replay a dead-lettered item "with one action" | **built, never exercised** — the function has no caller and there is no action | **nobody** (D8) |
| Billable vendor reads cached before the answer is processed | **built & exercised** | `T0.5` ✅ |
| Two-phase publish so a crash cannot produce two posts | **absent** — no `publish_intents` table, no protocol, no code | `T5.2` (wave 3) |
| Webhook events stored by unique id and processed from the table | **built** for Stripe; **absent** for Shopify | Stripe ✅ / `T2.2` |
| A chaos test that kills workers through a full ingest-and-publish run | **declared only** — the harness is built and runs; it contains an empty scenario and one mid-step kill. The full run has nothing to run | `T10.1` (final) |

## main §14.4 — degrade to pause, never to lower quality

Every row of the spec's degradation table is **absent**, because the dependency
it degrades does not exist yet.

| Dependency | Status | Owner |
|---|---|---|
| Keyword data (DataForSEO) — circuit breaker, stale-but-stamped cache, never gate on stale data | **absent**. The provider class exists and is tested with a mock; nothing constructs it outside tests | `T2.6` |
| AI provider — pause and queue, never substitute a smaller model for the judge | **absent**. The judge itself is a stub that passes everything | `T4.4` |
| Shopify rate limiting at 1 request/second honouring `Retry-After` | **absent**. `packages/providers/src/shopify/index.ts` is literally `export {}` | `T2.2` |
| Shopify token invalid → park the account, pause generation, show a reconnect banner | **absent** | `T2.1` |
| Search Console token expired → reporting stops, content pipeline continues | **absent**. `packages/providers/src/gsc/index.ts` is literally `export {}` | `T3.1` |

Only the *principle* is enforced anywhere today: the plan endpoint answers 503
rather than showing a stale or guessed price. That is the right instinct, applied
in the one place that currently can apply it.

## main §14.5 — kill switches and circuit breakers

Covered as item 2 above. Summary by requirement:

| Requirement | Status | Owner |
|---|---|---|
| Manual flags checked at every job dequeue within 60s | **declared only** — the flags table and readers exist; there is no dequeue | `T8.4` |
| Global flags need a second operator to reset; every flip logged with actor and reason | **declared only** — the columns exist, nothing writes them | `T8.4` |
| Account AI spend > 10× its median, or > a hard cap → pause that account | **absent** | `T8.4` |
| Global keyword-data spend > cap → pause enrichment | **absent** | `T8.4` |
| Preview spend > cap → serve cache, generic card on a miss | **built & exercised** ✅ — the one trip that works end to end | `T1.3` ✅ |
| Judge failing > 60% of the last 50 drafts → pause everything and page | **absent** | `T8.4` |
| Publish errors > 20% in an hour → pause publishing | **absent** | `T8.4` |
| Every trip creates an incident record and never auto-resets | **declared only** | `T8.4` |

`T8.4` is the last card of milestone 8, in wave 3.

## main §14.6 — lifecycle, deletion and GDPR

| Requirement | Status | Owner |
|---|---|---|
| Vacation mode (halt generation, keep sync alive) | **absent** | `T8.3` |
| Cancellation: published articles untouched, generation stops at period end, read access kept — stated wherever cancellation is offered | **partly built.** The behaviour is built and tested (read access is never revoked). The three facts as user-facing copy exist as constants in the billing module with snapshot tests, but not in `packages/ui/strings` where the constitution says copy lives — because that directory does not exist | `T8.3` / `T9.1` |
| Account deletion: cancel Stripe immediately, revoke both tokens, purge within 30 days, release the domain after a 7-day grace | **partly built.** The 7-day grace window *is* implemented and tested — a test proves a domain stays blocked at day 6 and is free at day 8. Everything else is **absent**: no deletion endpoint, no token revocation, no purge | `T8.3` |
| Shopify's mandatory GDPR webhooks (`shop/redact`, `customers/redact`, `customers/data_request`) | **absent.** The route is declared in the contract and mocked; there is no implementation. **This is an app-store listing requirement** — Shopify will not approve the app without it | `T8.3` / `T10.4` |
| "We hold no customer data", asserted by a test | **structurally true, not asserted.** No table anywhere has a customer-level column, and the order ingestion that would strip them does not exist yet. The test the spec asks for lands with the code it guards | `T2.2` |
| Retention sweeps (webhook payloads 30d, notifications 90d, search-console roll-ups 16 months, email records 12 months) | **declared only** — `retention_sweep_daily` is in the schedule with no handler, and the schedule is off | `T8.3` |

`T8.3` is in wave 3. **The GDPR webhooks are the one item here I would not let
slip past the point where you apply for the Shopify listing** — they gate
approval, not just compliance.

## tech §5 — environments and delivery

| Requirement | Status |
|---|---|
| dev / staging / prod as Railway environments, staging on demand | **absent** — `railway.toml` declares one production environment. Nothing has ever been deployed from this repository |
| CI gates every merge on typecheck, tests, lint, and the PostHog check | **built & exercised** ✅ — plus two gates the spec does not ask for and which are the best thing in the CI file: `pnpm lint:prove` plants seven deliberate violations and fails if the lint rules do not catch them, and `pnpm env:check` fails if a new environment variable is missing from the example file |
| The prompt eval suite runs when a prompt or model id changes | **built, empty** — the runner works and discovers zero sets, because no prompt with an eval set has been written. It reports the emptiness rather than hiding it |
| The signal-detection fixtures run when the rules config changes | **partly**. The eight worked examples from the spec exist as fixture data with 14 tests over the *data*. Deliberately, no test asserts what action each produces — that is the detection card's job, and encoding the answer now would let the implementation be written to the fixture instead of the spec. Correct call; just know the fixtures currently prove the data is shaped right, not that anything reads it |
| The chaos test runs nightly | **built & exercised** ✅ — a nightly GitHub workflow exists and runs the two scenarios that exist |
| Migrations applied on deploy before new code serves traffic | **absent** — item 5a above |

## tech §6 — the testing strategy table

Row by row, since this table is the spec's own definition of "tested":

| Row | Status |
|---|---|
| Gate thresholds and scoring as pure-function tests | **absent** — the gates do not exist |
| Prompt behaviour via frozen eval sets | **built, empty** |
| Crash safety / exactly-once publish via the nightly chaos test | **partly** — crash safety yes, publish no (nothing publishes) |
| Customer-field stripping | **absent** — order ingestion does not exist |
| Notification dedupe via unique-constraint conflict tests | **built & exercised** ✅ at the database level; the notification writer itself is a stub |
| Email matrix versus preferences | **absent** — no email is ever sent |
| UI flows via Playwright | **declared only.** The scaffold exists and runs two smoke assertions (the landing page returns 200; the health endpoint says ok). It is **not in the CI workflow** — `pnpm e2e` is defined and never invoked by any gate |
| Shopify integration via a dev-store smoke suite | **absent** |
| Signal detection and action selection | **absent** (fixtures only, as above) |
| Existing-target check table test | **absent** — the function is a stub that always says "no match" |
| Opportunity dedupe, expiry and status guards | **partly** — the database constraints are tested; the lifecycle code does not exist |
| OPTIMIZE recommendation lints | **absent** |
| Rules config: schema validation, no-threshold-literals lint, version stamped on every row | **built & exercised** ✅ — 17 tests, and the lint rule is proved by a planted violation |

---

# Part 4 — The end-to-end story, and where it stops

There is one test that walks a whole merchant through the funnel:
`apps/web/app/api/domain/_lib/funnel.test.ts`. It is the milestone-1 exit gate.

**What it proves.** One merchant, in order, against a real Postgres with real
migrations applied: signs up (an account row is created, the analytics event
fires); reads the dashboard and sees no domain and no subscription; starts
checkout and gets a Stripe-hosted URL back; Stripe's "checkout completed" and
"subscription active" webhooks arrive and are processed; the dashboard now says
active; the merchant claims `https://www.Acme-Supply.co.uk/collections/all` and
it is stored as `acme-supply.co.uk`; the dashboard now shows a domain in state
`ingesting`; and a job with all nine onboarding steps exists in the database with
every step `pending` and `detect` as the only one ready to run.

It goes through the real route handlers, the real session wrapper, the real
repositories and real SQL. Only Stripe and the analytics client are doubles.

**What it does not prove.** It is not a browser test — no screen exists to drive,
so it calls the HTTP handlers directly. It does not prove the Stripe signature
verification against real Stripe, does not prove entitlement gates anything
(nothing is gated yet), and it stops the instant a job row exists.

**What happens next for that merchant today.** Nothing. Traced concretely:

1. The claim writes an `ingestion_jobs` row and nine `job_steps` rows, all
   `pending`. **Verified — this happens.**
2. Something should now notice that `detect` is dispatchable and run it. **No
   such code exists in the application** (Part 1, item 1). The only callers of
   the dispatch function are the test suite and the chaos harness.
3. Even if a dispatcher existed, there is **no handler for `detect`** — nor for
   any of the other eight steps.
4. Even if a handler existed, it would need the Shopify client to look at the
   store. `packages/providers/src/shopify/index.ts` contains one line:
   `export {}`.

So the merchant sits on a progress screen — once that screen exists — watching
nine steps that will never move, forever, with no timeout, no error, and no
notification. Silently: there is no crash reporting wired, so nobody learns.

**Which card resumes it.** `T2.1` — "Tech detection, parked state, Shopify
read-only OAuth". It builds the `detect` step (is this a Shopify store?), the
"we don't support this platform" parked state, and the read-only Shopify OAuth
that everything downstream needs. It is the first unblocked card of milestone 2
and its only dependency — the domain claim — is merged. It is the natural next
piece of work, and it is also where the dispatcher from item 1 would have to
land, because it is the first card with a step to dispatch.

---

# Part 5 — The stubs

`pnpm stubs:report` lists six deliberate stand-ins. The mechanism is good: each
stub reports itself, records a `stub_used` telemetry event, and CI prints the
list on every build. Nothing is hidden.

The column that matters is the last one.

| Stub | What the product does while it is wired | Would anything look broken? |
|---|---|---|
| **`existingTargetCheck`** — should decide, before writing any new page, whether the store already has a page that should be improved instead. Always answers "no existing page". | Every opportunity would come out as "write a new page" and none as "improve this one". | **No — and this is the dangerous one.** It is a silent "yes" to the one check the constitution puts hardest (*"No CREATE without the existing-target check"*). The product would look like it is working and would be quietly recommending merchants publish pages competing with their own collections. Its own stub description says so. Filled by `T3.5`, wave 2. **Nothing downstream consumes it yet**, so no harm is being done today — the exposure begins the moment `T3.6` starts creating opportunities. If `T3.6` were to land before `T3.5`, that is the one ordering mistake in this list that would produce wrong output rather than absent output. |
| **`JudgeLite`** — should grade a draft article against the quality bar and reject it. Passes everything with fixed scores. | Nothing is ever rejected. | **No.** Same shape of danger: the quality gate is the product's central claim, and a stub that passes everything is indistinguishable from a gate that is working. Filled by `T4.4`, wave 2 — but the stub is scheduled to survive until M6, meaning the OPTIMIZE path in wave 3 would be built against a judge that grades nothing. Worth confirming that is intended. |
| **`OpportunitySource`** — should return the store's detected growth opportunities. Returns a fixed fixture pool. | Every store sees the same made-up opportunities. | **Yes, obviously** — the moment a real store's data is on screen and the opportunities are about somebody else's shoes. Safe. Filled by `T3.6`/`T3.7`. |
| **`CatalogEvents`** — should stream "a product changed" events from Shopify. Replays a fixed list. | Nothing reacts to real catalogue changes. | **Yes** — no consumer of it exists yet, and when one does, the fixed list is visibly fake. Safe. Filled by `T2.2`. |
| **`TopicScheduler`** — should place an approved topic on the calendar. Records the intent and does nothing. | The calendar stays empty. | **Yes** — an empty calendar is an empty calendar. Safe. Filled by `T4.2`. |
| **`NotificationEmitter`** — should write a notification and send an email. Records it in memory. | No bell badge, no email. Includes the **payment-failed email** — a merchant whose card fails is told nothing. | **Partly.** A missing bell is visible. But the payment-failure email failing silently is not, and it is the one case where the stub's absence costs a real merchant something real (they lose service without warning). It is in-memory, so it does not even survive a restart. Filled by `T8.1`, wave 2. |

**The pattern:** the two stubs that would *not* look broken — `existingTargetCheck`
and `JudgeLite` — are exactly the two that disable a rule the constitution calls
an invariant. That is the right thing to be nervous about, and the reason the
`stubs:report` gate exists. My recommendation is narrow: **treat "no consumer
exists yet" as the thing that keeps you safe, and check it deliberately at each
merge** — the report tells you a stub is wired, not whether anything is relying
on its answer.

---

# Part 6 — Risks that are not about tests

## Verified single points of failure and unbounded resources

1. **One process does everything.** Website, API, and every background job run in
   one Node process on one Railway instance, capped at 384 MB of heap. This is
   the spec's deliberate choice (tech §2.1, cost discipline) and the code is
   written for it — splitting the worker out is described as a start-command
   change. Worth knowing rather than changing: a runaway job competes for memory
   with the web server that serves your funnel.

2. **The per-process limits hold only on one machine.** Confirmed: the preview's
   per-IP rate limit, its outbound-fetch concurrency cap, and the plan screen's
   price cache all live in that process's memory. `railway.toml` pins
   `numReplicas = 1`, so they are correct today. Scaling to two instances
   silently doubles every limit — including the one guarding the only
   unauthenticated, money-spending endpoint in the product. There is no test and
   no assertion that would notice. **Proposal:** whatever else you do, treat
   "raise the replica count" as a change that requires reading `DECISIONS
   2026-09-01 T1.3` first.

3. **The health check cannot fail** (Part 1, item 4). Railway restarts the
   service on health-check failure, so this disables the platform's own recovery.

4. **No error reporting reaches a human.** `captureException` has no callers.
   Combined with the absent operator tooling, the first sign of a problem is a
   merchant complaining.

5. **The test suite is slow and near a CI ceiling.** Verified by running it: 200
   seconds in parallel, 978 seconds serially on this machine. The CI job has a
   20-minute budget for lint, typecheck, the whole suite, contracts, stubs,
   PostHog and the build. It fits now. It is worth watching, because the
   database-backed suites each create and migrate a fresh database, and that cost
   grows with every migration.

6. **The suite is not currently green on this machine.** 13 files fail in
   parallel and 2 fail serially — every failure a 10-second setup-hook timeout
   while creating a test database, not an assertion. Run individually, they pass.
   **Inference, not verified:** this is local Docker slowness rather than a code
   defect, and CI's Postgres service is faster. But the 10-second hook budget is
   thin enough that a slow CI runner would produce a red build that looks like a
   real failure. **Proposal:** raise the hook timeout.

## Things nobody can do when it goes wrong

Covered as Part 1 item 4: no diagnosis command, no DLQ replay action, no way to
flip a kill switch except hand-written SQL, no health signal, no crash reports.

## Two smaller items with no owner

- **`packages/ui/strings` does not exist**, and the constitution says every
  user-facing string lives there. Three cards have now parked copy elsewhere.
  The natural owner is `T9.1`, the first frontend card — worth making explicit
  before Lane F starts, because a fourth card parking copy elsewhere means a
  migration later.
- **The email sign-in blocker is stale.** The reason recorded in the auth config
  for shipping Google-only was a missing database table. That table now exists.
  Nothing has revisited it, and no card owns it.

---

# Appendix — the numbers

- **873 tests** in 56 files. 831 pass; the rest are environment timeouts (above).
- **41 database tables**, 7 migrations, 746 lines of SQL.
- **72 constraint tests** run against a real Postgres.
- **56 declared API routes; 8 implemented.**
- **12 scheduled recurring jobs; 1 has a handler; 0 ever run.**
- **9 onboarding steps; 0 have handlers.**
- **2 chaos scenarios**, one of which is empty.
- **0 eval sets, 0 PostHog dashboard definitions, 0 `.tsx` files that are not
  Next.js scaffolding.**
- **7 planted lint violations**, all correctly rejected — the check that proves
  the other checks work.
