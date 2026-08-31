# M0 handoff — milestone complete

Written for two readers: the founder, who decides but does not read the code or
the specs, and the integrator agent, which does. Every spec section number here
is evidence you can check, never the explanation itself.

---

## Status

**Cards T0.1 through T0.7 are complete and committed. M0 is done.** Eight
commits on `main`, one per card plus this document. The repository has no git
remote.

T0.7 was the milestone's **exit gate** — the card whose job is to prove M0 as a
whole. It passed, which means the parallel workstreams can start: five lanes can
now build against frozen interfaces instead of against each other.

**361 automated tests pass.** Code style, type checking, the production build,
and five separate enforcement gates are all clean.

---

## What needs your decision

Four things. None blocks anything today; all four get harder to change later.
The first three carried over from the previous handoff and are unchanged.

### 1. Nine numbers I invented because the specs mandate the knob and state no value

The specs say "there is a configurable threshold here" and never say what it
should be. I picked starting values, marked each one `UNSIGNED` in the file, and
recorded why in the decision journal. They sit in
`packages/rules/signals.config.yaml` and **nothing reads them yet**, so each is
a one-line edit until the features that consume them get built.

The one that matters most:

- **Demand floor** — the minimum monthly Google search volume a keyword needs
  before Sortiva will write an article about it. This directly decides which
  topics get admitted, so it is visible to the merchant. The spec requires it to
  vary by language ("50/mo in Danish ≠ 50/mo in English") and gives no table. I
  set English to 100/month and scaled down roughly by market size: German,
  French, Spanish 60 · Italian, Portuguese 50 · Dutch, Polish 40 · Swedish,
  Danish, Norwegian, Finnish, Czech, Hungarian, Romanian, Greek 20 · Slovak 15 ·
  Slovenian, Estonian, Latvian, Lithuanian 10.

The rest, briefly:

- **Winnability fallback: 0.25.** How likely we assume a store is to rank when
  Search Console isn't connected and we have no evidence to judge from. Scale is
  0 (hopeless) to 1 (certain). The spec says "a conservative constant".
- **Substance floor: 8 distinct facts, from at least 3 products, each with 4+
  populated fields.** How much concrete product information a topic needs behind
  it before we'll write about it — the guard against thin, padded articles.
- **Spend caps: $5/day per store on AI generation, $50/day total on DataForSEO**
  (the keyword-data vendor), **$10/day on the public preview.** These are
  loud-failure ceilings that pause work, not budgets — a $89/mo plan earns about
  $2.90/day, so $5 means something has gone badly wrong.
- **Intent-gap analyses: 10 per store per day.** A cap the spec requires without
  saying at what.
- **"Impressions not collapsed": 0.5.** When judging whether a page improvement
  worked, we don't credit a CTR gain if impressions halved.

**What I need:** a nod, or different numbers. The demand floors are the ones
worth actually thinking about.

### 2. I added a database table outside the process that governs them

Only designated "schema wave" cards are allowed to change the database structure
— that rule exists so parallel agents never collide on the schema. T0.3 was the
schema wave. T0.4 was not, and I added a table in it anyway.

The table is `job_dlq`, a **dead-letter queue**: the place permanently-failed
background jobs land so a human can see them and re-run them. Without it, a
catalog sync that fails at 2am simply stops, the merchant's onboarding hangs, and
the only symptom is that nothing happens. The spec describes this behaviour in
detail but its data-model chapter never lists a table to hold it, and T0.4's
completion criteria explicitly require one.

It landed as `0001_wave1_addendum_job_dlq.sql`, minutes after wave 1, in the same
milestone, by the same session — so no other agent could have been affected.

**What I need:** the integrator either folds it into wave 1 or accepts it as a
small extra wave. Nothing about the code changes either way.

### 3. Four quality-bar numbers live somewhere my card didn't authorise

Before Sortiva publishes an article, a separate AI grades the draft on several
criteria, 1–5 each. Two are hard floors at 4 — *does this say anything the search
results don't already say*, and *is every product claim traceable to real catalog
facts*. The others need 3. The writer gets exactly one revision attempt.

Those four numbers **are** the quality bar. The house rule is that every threshold
lives in one config file, never hardcoded, so the standards are reviewable in one
place. My card listed which spec sections' numbers to move into that file, and
the draft-grading section wasn't on the list. But there is no other home for them,
and the automated check that catches stray thresholds only recognises SEO field
names, not judge scores — so leaving them out would have let them be hardcoded
invisibly.

**What I need:** keep or revert. Reverting is deleting one block from the config
and one from its schema; nothing reads them yet.

### 4. What we assume DataForSEO charges (new)

DataForSEO is the vendor we buy keyword and search-results data from. They bill
per request, at different rates per endpoint. Two things depend on knowing those
rates: the daily spend cap that pauses work when something runs away, and the
"what is this store costing us" reporting.

I put three prices in the code — 5¢ per keyword-volume lookup, 0.2¢ per
search-results check, 1.1¢ plus 0.01¢ per row for a competitor's ranked keywords
— marked them **UNSIGNED**, and made an unpriced endpoint fail loudly rather than
report zero. They set the *scale* of the $50/day cap; if they're wrong by 10×,
the cap is wrong by 10× and nobody would notice until the bill arrived.

**What I need:** the real figures from your DataForSEO account, before the first
production spend. Nothing needs them before then.

---

## What exists now

A working repository: eight packages laid out as the constitution requires, a
Next.js app that builds, a Postgres 16 database with the first wave of tables
applied, a background-job runtime that survives being killed mid-work, one
instrumented path to each outside vendor, four test harnesses, and every seam
between the parallel workstreams frozen as a typed interface.

The point of this milestone was *enforcement before features* — building the
machinery that turns "did the agent remember the rules?" into a build failure, so
it stops being a matter of vigilance for the rest of the project. That part is
real:

- A hardcoded threshold number outside the one config file **fails the build**.
  Not by convention — the build plants a violation on every run and fails if it
  isn't caught.
- The core domain package **cannot import** the web framework or any vendor SDK;
  a test proves it by reading every source file.
- A database query that forgets to scope itself to one account **does not
  compile**. Account scope is a special type that only one function can create.
- Two accounts cannot claim the same domain, a webhook cannot be processed twice,
  a Stripe event cannot be double-counted, and a notification cannot be sent
  twice — each enforced by the database itself.
- A background job killed halfway through resumes where it stopped, and
  re-running work that already finished returns the stored result instead of
  paying for it again.
- **An AI call or a paid data lookup cannot escape cost tracking** — the vendor
  SDKs can only be imported inside their one wrapper, and importing them anywhere
  else is a build failure.
- **A vendor token cannot reach a log line.** Secrets are redacted by shape, by
  field name, and by exact value — every secret the app reads at startup is
  registered with the redactor.
- **The API and its documentation cannot disagree**, because the documentation is
  generated from the same definitions the code uses, and a stale copy fails CI.

---

## Evidence, card by card

Each card carries "done when" criteria written before the work.

### T0.1 — Repo skeleton, package boundaries, lint, CI · `9fd5854`

| Criterion | Result |
|---|---|
| The build rejects a smuggled-in raw AI SDK import | **PASS** |
| The build rejects a hardcoded threshold outside the config package | **PASS** |
| Core package cannot reach the web framework or vendor SDKs | **PASS** — 4 tests |
| Continuous integration passes on the empty app | **PASS, run locally** |
| Railway config deploys the app and database to a throwaway environment | **PARKED** |

The first two are proved by a script that writes the forbidden patterns into
throwaway files on every build and fails if the checker lets either through — so
the protection can't quietly stop working months from now.

"Run locally" is a real caveat: there is no git remote, so GitHub's servers have
never executed the pipeline. I ran each of its steps by hand instead.

**Parked, and why:** the Railway deploy. Deploying creates real infrastructure
that bills you. I asked; you said leave it. The configuration file is written and
committed. **Nothing downstream depends on this.**

### T0.2 — Rules & config module · `1dbaf87`

Every threshold number the product uses lives in one file with its source noted
beside it, and that file's fingerprint is stamped on every decision the system
makes — so you can always ask "which version of the rules produced this?"

| Criterion | Result |
|---|---|
| A test lists every threshold the specs name and proves each one exists | **PASS** — 100 entries |
| A malformed config file stops the system from starting | **PASS** — 5 failure cases |
| The fingerprint changes when any value changes | **PASS** |
| A readable snapshot of the loaded settings is committed | **PASS** |

117 tests. The malformed-config cases include a typo'd key name, which matters
more than it sounds: without that check, misspelling a setting would silently
mean it was never applied.

### T0.3 — Schema wave 1 + constraint tests · `4ac2d17` · **needs audit**

All 16 first-wave database tables. 21 tests against a real Postgres 16.15, not a
simulation — a constraint asserted in TypeScript is not a constraint.

| Criterion | Result |
|---|---|
| Two accounts claiming the same domain conflict | **PASS** |
| A repeated webhook conflicts | **PASS** |
| A repeated Stripe event conflicts | **PASS** |
| A repeated notification conflicts | **PASS** |
| A query without an account scope fails to compile | **PASS** |

### T0.4 — Worker runtime & step state machine · `776d4b5` · **needs audit**

The machinery that makes background work safe to interrupt. 39 tests.

| Criterion | Result |
|---|---|
| A second worker grabbing the same step stops instead of duplicating work | **PASS** |
| Re-running finished work returns the stored result without redoing it | **PASS** |
| Two workers on one store take turns; different stores run in parallel | **PASS** |
| A step killed halfway resumes where it stopped | **PASS** |
| Failures retry after 1, 5 and 25 minutes, spread ±20% | **PASS** |
| Failed-for-good jobs land in a queue carrying enough to re-run them | **PASS** |
| A shutdown signal lets in-flight work finish | **PASS** |

The resume test syncs a five-page catalog, crashes at page three, and proves
pages one to three are **not** fetched again. The shutdown test starts a real job
queue, signals the process mid-job, and confirms the job finished (401 ms) and
left the queue empty before exit.

### T0.5 — Provider wrappers · `c6cb4d3` · **needs audit**

One instrumented path to each outside vendor — the AI model, the keyword-data
vendor, email, analytics — so no piece of code can call them without being
counted. Plus encryption for the access tokens we hold on merchants' behalf, and
a redactor that keeps secrets out of logs. 64 tests.

| Criterion | Result |
|---|---|
| A crash after the vendor answered replays without paying twice | **PASS** — proved separately for the AI model and the data vendor |
| A retried AI call replays the identical answer rather than re-rolling it | **PASS** |
| A replayed call is recorded as costing zero | **PASS** |
| A token never reaches log output | **PASS** — message, field, nested field, and stack trace |
| The fake vendors used in tests account for what real ones would have cost | **PASS** |

Two things here are worth your attention.

**Cached AI answers are recorded at zero cost, deliberately.** If a job crashes
after the model answered, the retry replays the stored answer. Charging that
replay to the store again would make the cost dashboards — the thing the spend
caps are set from — wrong in the direction of panic. It also means a resumed job
cannot get a *different* answer than the run it is resuming, which matters when
the answer is the store's business profile.

**The tokens we hold are encrypted with a per-row key.** Each merchant's Shopify
token gets its own encryption key, and that key is itself encrypted by a master
key held in the deploy secrets. Rotating the master key then means re-encrypting
one short key per row rather than every token — and the code can tell you which
rows are still on the old key.

**Analytics is PostHog only. Sentry is not wired**, per your instruction.

### T0.6 — Test harnesses · `10f2490`

The four suites the specs require, each running on its own schedule, all green
before there is anything for them to test — so the cards that add real cases only
have to add cases. 31 tests.

| Criterion | Result |
|---|---|
| The crash-injection harness runs an empty scenario green | **PASS** |
| The AI evaluation runner runs with no sets declared | **PASS** |
| The eight worked scenarios generate identical data every run | **PASS** |
| The analytics provisioning check passes on an empty definitions folder | **PASS** |

**The crash-injection harness** is the one the spec calls "the specification's
teeth". It runs a piece of work, kills it at a randomly chosen moment, restarts
it from the top, and repeats — then checks that the end state is identical to a
run that was never interrupted, and that nothing was paid for twice.

Worth telling you plainly: **my first version of it was broken in a way that
would have reported green while proving nothing.** It picked a moment to kill the
work before knowing how long the work was, so when it picked a moment past the
end, nothing was killed and the run was reported as a successfully-survived chaos
run. A test caught it, the harness now narrows its aim to fit the run, and a
regression test holds that.

**The eight scenarios** are the spec's own worked examples — a page ranking at
position 7.3 with 9,402 impressions, a page that slid from 3.8 to 7.1 over three
months, a store whose product descriptions are all marketing copy. Each generates
a complete fake store, identically every time. They carry the *evidence* but not
the *expected answer*: the answer is what the Opportunity Engine has to work out,
and a fixture that also contained it would let the engine be written to match the
fixture rather than the spec.

**The exception is scenario 7**, where one assertion is made: that store must
genuinely fail the substance floor. If the generator ever drifts into producing
well-specified products there, "hold this topic back" would silently become the
wrong expected answer, and the scenario would stop testing anything.

### T0.7 — Contracts & API schemas · `fb2e02a` · **M0 exit gate**

The point where the project stops being serial. Every place where one
workstream's output becomes another's input is now a written interface with a
stand-in implementation, and every API endpoint has a defined request and
response. 85 tests.

| Criterion | Result |
|---|---|
| Every contract has a stand-in and sample data | **PASS** — 6 seams |
| The API definitions and the API documentation agree | **PASS** — 55 routes |
| A mock server answers every route with a valid response | **PASS** |
| The stand-in report lists all of them | **PASS** — 6, as expected |

**The check found a real inconsistency on its first run.** I had classified
"your subscription isn't active" as the same kind of error as "someone else
changed this while you were looking at it". They are not: one is a state
conflict, the other is a payment state. The check noticed that one error code was
declared but unreachable, which is exactly the symptom. Fixed.

**The stand-in report is the thing to keep an eye on.** Six pieces of the system
are currently fake. The most dangerous is the one that checks, before writing a
new article, whether the store already has a page that could rank for that
search — the rule the spec calls "the single most important in the merge". While
it is fake it always answers "no such page", so every article looks unopposed.
Nothing about the product would appear broken. Each stand-in records which card
replaces it and the milestone by which it must be gone, and the report can fail
the build per milestone.

**Two product rules are now impossible to break by accident**, because the API
has no field to break them with:

- No count anywhere can carry a denominator or a target. The daily article cap is
  a ceiling, not a promise, so there is no "3 of 30" to render — there is no
  field to put the 30 in.
- Every user-facing explanation ("why is this being suggested?") is a template
  name plus numbers, never a sentence. An AI cannot write one, because there is
  nowhere to put a sentence.

---

## Audit status

The build plan flags certain cards for a cold read by a *different* session
before anything is built on top of them — the reasoning being that the session
that wrote the code will rationalise the spec as whatever it built.

**T0.3, T0.4 and T0.5 are all flagged and none has been audited.** All three now
have work built on top of them, so the audits are overdue rather than pending.

The seven things most worth attacking, in order:

1. **Where "have I already done this work?" is recorded.** Each unit of work gets
   a fingerprint derived from its inputs, and finished work is recognised by that
   fingerprint. I store it on the job-step rows themselves rather than in a
   separate ledger. Deleting a job erases those records, so work whose fingerprint
   lived only on a deleted run would execute a second time. I argued this is
   acceptable because runs aren't deleted in normal operation — worth a second
   opinion, because this is the mechanism the whole no-duplicate-work guarantee
   rests on.
2. **How work for one store is serialised.** The spec names one Postgres locking
   mechanism; I used a different one, because the named one cannot coexist with
   saving progress mid-job. Check the release paths in particular — a lock that
   leaks stalls a store silently and forever.
3. **Whether the cost accounting is actually complete.** Every AI call and paid
   lookup is supposed to be counted. The lint rule proves the *SDKs* can't be
   imported elsewhere; it does not prove every code path through the wrapper
   emits a cost event. Check the paths where a call fails partway.
4. **The system-scope escape hatch.** Five tables genuinely have no account
   attached when they're written. Verify that's actually true of all five rather
   than a convenient story.
5. **The step ordering graph.** Where the Search Console step sits is a judgement
   call: it must run after keyword discovery but must never block onboarding when
   a merchant skips it.
6. **Whether any threshold escaped into code anyway.** The automated check matches
   field *names*; a number reaching a comparison through a differently-named
   intermediate variable is not caught.
7. **Whether the 55 API routes are the right 55.** They were derived from the UI
   spec's screens, which describe surfaces and states rather than endpoints. A
   missing route is a lane discovering mid-build that its seam was never frozen.

---

## Contradictions I surfaced rather than resolved quietly

Six places where the instructions, the specs and reality didn't line up.

**"Make `.env` identical with empty values" vs. not breaking a fresh clone.**
Blanking the local database address and the "use the fake vendor, don't spend
money" switch would stop the project running out of the box. I left secrets blank
and kept the harmless local defaults, and added a check that fails if the two
files' key lists ever drift apart.

**"Every database method requires an account scope" vs. five tables that have no
account.** A webhook is verified and stored before we know whose it is; a preview
happens before signup; the shared cache is keyed by request, not by customer.
Rather than carve a hole in the rule, those five take a different scope type that
carries a written reason.

**Two spec requirements that cannot both hold.** The concurrency section names a
lock that lasts for one database transaction; the resumability section requires
long jobs to save progress as they go. Progress only visible after the job
commits is not progress. I took the concurrency section's own escape clause
("or equivalent").

**The dead-letter table and the schema-change process** — item 2 above.

**The spec asks for PostHog's automatic AI-call tracking, and for three things it
cannot do.** The automatic version hooks into the AI client and records each call
as it happens. But the spec also requires that a *replayed* answer — served from
cache after a crash, with no call made — be recorded, at zero cost. There is
nothing for an automatic hook to catch. I record every call by hand instead, so
live calls and replays go through one path. Same data, same property names, one
code path.

**Two harnesses had to be written before the things they test exist.** The eight
worked scenarios need product and search-data tables that schema wave 2 will add;
the frozen contracts describe opportunity records that the same wave will add.
Waiting would have blocked both cards; inventing the tables would have broken the
schema-wave rule a second time. Both define their own shapes, and the cards that
add the tables map to them. The cost is one mapping layer each.

---

## The decision journal

61 entries in `DECISIONS.md`, none yet classified by an audit. Every choice the
specs didn't dictate is recorded there with its reasoning and the nearest spec
section.

By card: **T0.1 (9)** build tooling and environment files. **T0.2 (8)** the
invented numbers and how the config layers by language. **T0.3 (9)** the database
toolkit (**your decision, asked and answered in session — Drizzle**), the
account-scope type. **T0.4 (9)** the locking choice, the dead-letter table, the
step ordering. **T0.5 (10)** where the vendor interfaces live, the hand-rolled
cost tracking, the model version pinning, the encryption format, the redactor.
**T0.6 (8)** the four separate test gates, the crash-injection design, why the
scenarios carry evidence but not answers. **T0.7 (7)** generating the API
documentation from the code, the error-code split the check caught, enforcing two
product rules in the data shape.

---

## What comes next

The lane-by-lane instructions are in
[`docs/handoff-wave1.md`](handoff-wave1.md); the founder decisions and
provisioning that launch depends on are in
[`docs/founder-decisions.md`](founder-decisions.md).

**One standing caveat, recorded here so it is not lost between handoffs:**
M0 being complete means the foundation is correct, not that the product is near
ready. Sortiva is not finished while any item marked ▲ in the decisions document
is unresolved — a price nobody has set, vendor rates nobody has confirmed, a
privacy policy nobody has written, a Shopify listing nobody has submitted. None
of those is an engineering problem, and none will be solved by shipping more
cards.

M0 is complete, so **wave 1 can start: three lanes in parallel.**

- **M1 — Platform & funnel** (Lane A): auth, Stripe billing, the public preview
  endpoint, domain claim. Depends only on M0.
- **M2 — Store Intelligence** (Lane B): Shopify connection, catalog sync, product
  distillation, families, the store's business profile, keywords. Needs M1's
  domain claim (card T1.4) merged first.
- **M9.1–9.2 — App shell and public pages** (Lane F): builds against the mock
  server T0.7 just froze; needs no backend.

Before any of that: **the three overdue audits**, by a fresh session, since all
three cards now have work standing on them.

The build plan caps concurrency at four implementers. Wave 1 uses three.

---

## Running it

```
pnpm install
pnpm db:up            # Postgres 16 in Docker, on port 54329
pnpm db:migrate       # applies both migrations
pnpm db:seed          # a deterministic development account

# the per-merge gates
pnpm lint && pnpm lint:prove && pnpm typecheck && pnpm test && pnpm build
pnpm contracts:check  # the API definitions and their documentation agree
pnpm stubs:report     # which parts of the system are still stand-ins
pnpm posthog:check    # analytics dashboards match the repo

# the gates that run on their own schedule
pnpm chaos            # nightly: kill work at random, prove it converges
pnpm eval             # when a prompt or model changes: AI output quality
pnpm e2e              # browser flows (needs: pnpm exec playwright install chromium)
```

Tests that need a database create their own and **fail loudly** rather than
skipping when Postgres isn't running — a silently-skipped constraint suite reports
green while proving nothing.
