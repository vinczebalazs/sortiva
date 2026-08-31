# M0 handoff — partial milestone

Written for two readers: the founder, who decides but does not read the code or
the specs, and the integrator agent, which does. Every spec section number here
is evidence you can check, never the explanation itself.

---

## Status

**Cards T0.1 through T0.4 are complete and committed. T0.5, T0.6 and T0.7 were
not started.** The session stopped at the founder's request after T0.4.

A *card* is one unit of work from the build plan, with its own checkable
"done when" criteria. T0.7 is M0's **exit gate** — the card whose job is to prove
the milestone as a whole. It has not run, so **M0 is not complete**, and none of
the parallel workstreams that depend on it should start yet.

Five commits on `main`, one per card plus this document. The repository was
created (`git init`) at the start of this session; there is no remote.

---

## What needs your decision

Three things. None blocks anything today; all three get harder to change later.

### 1. Nine numbers I invented because the specs mandate the knob and state no value

The specs say "there is a configurable threshold here" and never say what it
should be. The card required those settings to exist, so I picked starting
values, marked each one `UNSIGNED` in the file, and recorded why in the decision
journal. They currently sit in `packages/rules/signals.config.yaml` and **nothing
reads them yet**, so each is a one-line edit until the features that consume them
get built.

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
  $2.90/day, so $5 means something has gone badly wrong. The preview cap is
  deliberately tight because the spec says this tripping at all means the
  anti-abuse measures are being defeated.
- **Intent-gap analyses: 10 per store per day.** A cap on an AI analysis the spec
  requires be capped without saying at what.
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
small extra wave. Nothing about the code changes either way. Flagging it because
bending a process rule quietly is how the rule stops meaning anything.

### 3. Four quality-bar numbers live somewhere my card didn't authorise

Before Sortiva publishes an article, a separate AI grades the draft on several
criteria, 1–5 each. Two are hard floors at 4 — *does this say anything the search
results don't already say*, and *is every product claim traceable to real catalog
facts*. The others need 3. The writer gets exactly one revision attempt.

Those four numbers **are** the quality bar. The house rule is that every threshold
lives in one config file, never hardcoded, so the standards are reviewable in one
place and every article records which version of the rules judged it.

My card listed which spec sections' numbers to move into that file, and the
draft-grading section wasn't on the list. But there is no other home for them. Had
I left them out, the content-engine work would hardcode `if (informationGain < 4)`
— and the automated check that catches stray thresholds only recognises SEO field
names like *position* and *impressions*, not judge scores. It would sail through.

**What I need:** keep or revert. Reverting is deleting one block from the config
and one from its schema; nothing reads them yet.

---

## What exists now

A working repository: eight packages laid out as the constitution requires, a
Next.js app that builds, a Postgres 16 database with the first wave of tables
applied, and a background-job runtime that survives being killed mid-work.

**181 automated tests pass.** Code style, type checking and the production build
are all clean.

The point of this milestone was *enforcement before features* — building the
machinery that turns "did the agent remember the rules?" into a build failure, so
it stops being a matter of vigilance for the rest of the project. That part is
real now:

- A hardcoded threshold number outside the one config file **fails the build**.
  Not by convention — the build plants a violation on every run and fails if it
  isn't caught.
- The core domain package **cannot import** the web framework or any vendor SDK;
  a test proves it by reading every source file.
- A database query that forgets to scope itself to one account **does not
  compile**. Account scope is a special type that only one function can create,
  so passing a bare id — which is exactly what a malicious request body would
  supply — is a type error.
- Two accounts cannot claim the same domain, a webhook cannot be processed twice,
  a Stripe event cannot be double-counted, and a notification cannot be sent
  twice — each enforced by the database itself, not by application code that
  someone could forget to call.
- A background job killed halfway through resumes where it stopped rather than
  starting over, and re-running work that already finished returns the stored
  result instead of paying for it again.

---

## Evidence, card by card

Each card carries "done when" criteria written before the work. Here is what
actually happened against each.

### T0.1 — Repo skeleton, package boundaries, lint, CI · `9fd5854`

| Criterion | Result |
|---|---|
| The build rejects a smuggled-in raw AI SDK import | **PASS** |
| The build rejects a hardcoded threshold outside the config package | **PASS** |
| Core package cannot reach the web framework or vendor SDKs | **PASS** — 4 tests |
| Continuous integration passes on the empty app | **PASS, run locally** |
| Railway config deploys the app and database to a throwaway environment | **PARKED** |

The first two are proved by a script that writes the two forbidden patterns into
throwaway files on every build and fails if the checker lets either through —
so the protection can't quietly stop working months from now.

"Run locally" is a real caveat: there is no git remote, so GitHub's servers have
never executed the pipeline. I ran each of its steps by hand instead.

**Parked, and why:** the Railway deploy. Railway is your hosting provider, and
your account is authenticated in this session, but deploying creates real
infrastructure that bills you. I asked; you said leave it. The configuration file
is written and committed — one application service with memory capped so a leak
crashes loudly instead of quietly inflating the bill, a health check, and no
scale-to-zero (the public preview page is the top of the funnel and a cold start
would kill it). The database service is created from Railway's own template
because Railway cannot declare databases in repository config.

**Nothing downstream depends on this.** It needs you to authorise the spend.

### T0.2 — Rules & config module · `1dbaf87`

Every threshold number the product uses now lives in one file with its source
noted beside it, and that file's fingerprint is stamped on every decision the
system makes — so you can always ask "which version of the rules produced this?"

| Criterion | Result |
|---|---|
| A test lists every threshold the specs name and proves each one exists | **PASS** — 100 entries |
| A malformed config file stops the system from starting | **PASS** — 5 failure cases |
| The fingerprint changes when any value changes | **PASS** |
| A readable snapshot of the loaded settings is committed | **PASS** |

117 tests. The malformed-config cases include a typo'd key name, which matters
more than it sounds: without that check, misspelling a setting would silently
mean it was never applied and the default silently governed instead.

### T0.3 — Schema wave 1 + constraint tests · `4ac2d17` · **needs audit**

All 16 first-wave database tables — accounts, billing, domains, the preview
cache, Shopify connections, job tracking, kill switches, notifications and email.

| Criterion | Result |
|---|---|
| Two accounts claiming the same domain conflict | **PASS** |
| A repeated webhook conflicts | **PASS** |
| A repeated Stripe event conflicts | **PASS** |
| A repeated notification conflicts | **PASS** |
| A query without an account scope fails to compile | **PASS** |

21 tests against a real Postgres 16.15, not a simulation — a constraint asserted
in TypeScript is not a constraint.

The compile-failure proof works by writing deliberately-wrong code annotated as
"this line must not compile". If any of them ever *does* compile, the type checker
reports the annotation as unnecessary and the build fails. A clean type check is
therefore the proof.

### T0.4 — Worker runtime & step state machine · `776d4b5` · **needs audit**

The machinery that makes background work safe to interrupt. Store ingestion is a
sequence of steps — detect the platform, sync the catalog, distill products,
group them into families, build the store's profile, find keywords — and any of
them can fail or be killed by a deploy.

| Criterion | Result |
|---|---|
| A second worker grabbing the same step stops instead of duplicating work | **PASS** |
| Re-running finished work returns the stored result without redoing it | **PASS** |
| Two workers on one store take turns; different stores run in parallel | **PASS** |
| A step killed halfway resumes where it stopped | **PASS** |
| Failures retry after 1, 5 and 25 minutes, spread ±20% | **PASS** |
| Failed-for-good jobs land in a queue carrying enough to re-run them | **PASS** |
| A shutdown signal lets in-flight work finish | **PASS** |

39 tests. Two worth calling out:

The resume test syncs a five-page catalog, crashes at page three, and then proves
pages one to three are **not** fetched again — which is what stops a retry from
re-paying for AI work already done.

The shutdown test starts a real job queue, gives it a slow job, signals the
process mid-job, and confirms the job finished (401 ms) and left the queue empty
before exit. The ±20% spread on retries exists so that when a vendor comes back
from an outage, every waiting job doesn't stampede it simultaneously.

---

## Audit status

The build plan flags certain cards for a cold read by a *different* session
before anything is built on top of them — the reasoning being that the session
that wrote the code will rationalise the spec as whatever it built.

**T0.3 and T0.4 are both flagged and neither has been audited.** T0.5 is also
flagged and wasn't started.

The five things most worth attacking, in order:

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
3. **The system-scope escape hatch.** Five tables genuinely have no account
   attached when they're written. Verify that's actually true of all five rather
   than a convenient story.
4. **The step ordering graph.** Where the Search Console step sits is a judgement
   call: it must run after keyword discovery but must never block onboarding when
   a merchant skips it.
5. **Whether any threshold escaped into code anyway.** The automated check matches
   field *names*; a number reaching a comparison through a differently-named
   intermediate variable is not caught.

---

## Contradictions I surfaced rather than resolved quietly

Four places where the instructions, the specs and reality didn't line up.

**"Make `.env` identical with empty values" vs. not breaking a fresh clone.**
Blanking the local database address and the "use the fake vendor, don't spend
money" switch would stop the project running out of the box. I left secrets blank
and kept the harmless local defaults, and added a check that fails if the two
files' key lists ever drift apart.

**"Every database method requires an account scope" vs. five tables that have no
account.** A webhook is verified and stored before we know whose it is; a preview
happens before signup; the shared cache is keyed by request, not by customer.
Rather than carve a hole in the rule, those five take a different scope type that
carries a written reason — so system-level access is explicit and greppable
instead of merely absent.

**Two spec requirements that cannot both hold.** The concurrency section names a
lock that lasts for one database transaction; the resumability section requires
long jobs to save progress as they go. Progress only visible after the job
commits is not progress. I took the concurrency section's own escape clause
("or equivalent").

**The dead-letter table and the schema-change process** — item 2 above.

---

## The decision journal

26 entries in `DECISIONS.md`, all dated 2026-08-27, none yet classified by an
audit. Every choice the specs didn't dictate is recorded there with its reasoning
and the nearest spec section, so an auditor can reconcile them later.

By card: **T0.1 (9)** covering build tooling, the custom rule-checking plugin, and
environment files. **T0.2 (8)** covering the invented numbers and how the config
layers by language. **T0.3 (9)** covering the database toolkit (**your decision,
asked and answered in session — Drizzle**), the account-scope type, and five
columns the data-model chapter doesn't list but the behaviour requires.
**T0.4 (9)** covering the locking choice, the dead-letter table, the step
ordering, and why scheduled jobs stay switched off until their handlers exist.

That last one is worth a line: all 13 recurring jobs the architecture calls for
are registered, but the scheduler refuses to run until every one has real code
behind it. A schedule pointing at a job nobody wrote is a task that silently never
runs — discovered a month later when it turns out nothing was ever cleaned up.

---

## What's left in M0

**T0.5 — Provider wrappers** (audit-flagged). The single instrumented path to each
outside vendor — AI, keyword data, email, analytics — so no call site can escape
cost tracking or caching. Plus token encryption and a scrubber that keeps secrets
out of logs. `.env.example` already documents the variables it will need, all
currently blank. Note: **analytics is PostHog only; Sentry is not to be wired.**

**T0.6 — Test harnesses.** The crash-injection harness, the AI evaluation runner,
a synthetic store generator for the eight worked scenarios, browser-test
scaffolding, and the analytics provisioning script.

**T0.7 — Contracts & API schemas.** M0's exit gate. Every seam between parallel
workstreams as a typed interface with a stand-in implementation and sample data,
request/response schemas for every API route, mock handlers so frontend work can
start, and a report listing which stand-ins are still wired in.

---

## Running it

```
pnpm install
pnpm db:up            # Postgres 16 in Docker, on port 54329
pnpm db:migrate       # applies both migrations
pnpm lint && pnpm lint:prove && pnpm typecheck && pnpm test && pnpm build
```

Tests that need a database create their own and **fail loudly** rather than
skipping when Postgres isn't running — a silently-skipped constraint suite reports
green while proving nothing.
