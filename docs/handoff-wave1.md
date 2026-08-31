# Wave 1 handoff — going parallel

M0 is complete. This document is the instruction set for the sessions that come
next: what runs in parallel, what each one owns, what must not be touched, and
the exact prompt to start each with.

Written for the founder, who assigns the work, and for the agents doing it.

---

## The short version

**Six sessions can run now. Three of them read only.**

| # | Session | Kind | Owns | Blocked by |
|---|---|---|---|---|
| 1 | Audit T0.3 | read-only | — | nothing |
| 2 | Audit T0.4 | read-only | — | nothing |
| 3 | Audit T0.5 | read-only | — | nothing |
| 4 | Lane A — Platform & funnel | builds | auth, billing, preview, domain claim | nothing |
| 5 | Lane F — Frontend | builds | app shell, landing, signup, plan | nothing |
| 6 | Lane B — Store Intelligence | builds | Shopify, catalog, profile | its **second** card waits on Lane A |

The build plan caps concurrency at four *building* sessions; this uses three.
The audits are read-only and don't count against it.

**Do the audits first, or at least alongside.** Three M0 cards were flagged for a
cold read by a different session before anything was built on top of them. Work
is now standing on all three. Every hour that passes makes a finding more
expensive to act on.

---

## Why it divides this way

Three things make parallel work safe here, and all three landed in M0:

1. **Disjoint directories.** Each lane owns a set of folders and touches nothing
   else. The build plan §3 fixes the ownership; a session that edits another
   lane's directory has failed review regardless of whether the code is good.
2. **Frozen seams.** Where one lane's output is another's input, there is now a
   written interface and a working stand-in. A lane builds against the stand-in
   and never waits.
3. **Schema waves.** Nobody edits the database structure except a designated
   card. Two agents adding migrations at once is the failure this rule exists to
   prevent.

Without those, parallel agents don't go three times faster — they collide, and
the collisions surface at merge time, which is the worst possible moment.

---

## The one real dependency

**Lane B's second card needs Lane A's last card merged.**

Store Intelligence starts by looking at a store. It cannot look at a store until
a merchant has claimed a domain, and domain claim is Lane A's `T1.4`.

So Lane B starts on `T2.0` — the schema wave, which adds the database tables the
rest of its milestone needs and depends on nothing — then waits. In practice
Lane A will have merged `T1.4` by the time `T2.0` is reviewed.

Everything else in wave 1 is independent.

---

## Session 1–3: the three audits

Read-only. They produce a written report and change nothing. Run all three at
once; they don't interact.

An audit is not a code review. The auditor reads the spec sections **first**,
writes down what those sections require, and only then reads the diff — because
the session that wrote the code will have rationalised the spec as whatever it
built, and a second session reading code-first does the same thing.

**Prompt (replace the card ID):**

> Audit card **T0.3** per `docs/agent-work-plan.md` §7. Read its cited spec
> sections cold first and write down what they require. Only then read
> `git show 4ac2d17`. Report findings as
> `[severity] §ref — finding / spec requires / code does / proposed fix`.
> Change nothing.

The commits are `4ac2d17` (T0.3), `776d4b5` (T0.4), `c6cb4d3` (T0.5).

**What to point each auditor at.** The previous handoff lists seven things worth
attacking; these are the ones belonging to each card:

- **T0.3** — the account-scope escape hatch. Five tables are allowed to skip the
  "every query names an account" rule because they're written before we know
  whose data it is. Verify that's true of all five rather than a convenient
  story.
- **T0.4** — two things. Where "have I already done this work?" is recorded: it
  lives on the job rows themselves, so deleting a job erases the record and the
  work could run twice. And how work for one store is serialised: the spec names
  one Postgres locking mechanism and the code uses a different one. Check the
  release paths — a lock that leaks stalls a store silently and forever.
- **T0.5** — whether the cost accounting is actually complete. The build proves
  the vendor SDKs can't be imported outside their wrapper; it does not prove
  every path *through* the wrapper emits a cost event. Check what happens when a
  call fails partway.

---

## Session 4 — Lane A: Platform & funnel

**Owns:** `apps/web/app/api/{auth,preview,billing,domain,webhooks/stripe}`,
`packages/providers/{stripe,turnstile}`,
`packages/core/{account,domain,preview,billing}`

**Cards, in order:** `T1.1` → `T1.2` → `T1.3` → `T1.4`

This is the funnel: a stranger lands on the site, pastes their URL, sees what we
understood about their business, signs up, pays, and connects their domain. At
the end of it an ingestion job is queued and the rest of the product has
something to work on.

**Why it goes first:** every other lane's work is invisible until an account can
exist. `T1.4` is also the one hard dependency in the wave.

**Watch for:** `T1.2` (billing) is audit-flagged. `T1.3` builds the single
SSRF-guarded page fetcher that four later cards reuse — it is more load-bearing
than "the preview endpoint" suggests.

**Needs credentials:** Stripe test mode with test clocks, Cloudflare Turnstile,
an Anthropic API key. See the decisions document.

---

## Session 5 — Lane F: Frontend

**Owns:** `apps/web/app/(app)/**`, `apps/web/app/(public)/**`, `packages/ui`

**Cards, in order:** `T9.1` → `T9.2`

**This lane needs no backend at all.** T0.7 froze all 55 API endpoints and
generated a mock server that answers every one of them with realistic data. Lane
F builds against that. When the real endpoints land, the mocks are swapped out
and the screens don't change — that's what the contract bought.

`T9.1` is the app shell: six navigation items, the locked state before a store is
connected, the banner stack, and every string externalised from day one.
`T9.2` is the landing page, the preview card, signup, and the plan screen.

**Watch for:** several exact sentences are load-bearing and snapshot-tested — the
preview teaser, the pricing cap line, the Shopify read-only trust copy. They live
in the main spec's Appendix A and are used verbatim, never paraphrased. If one
reads awkwardly, that's a founder decision, not an implementation choice.

---

## Session 6 — Lane B: Store Intelligence

**Owns:** `packages/providers/shopify`,
`packages/core/{catalog,distill,families,persona,keywords}`,
`packages/jobs/ingestion/*`, `apps/web/app/api/{shopify,profile}`

**Cards, in order:** `T2.0` → *(wait for Lane A's T1.4)* → `T2.1` → `T2.2` →
`T2.3` → `T2.4` → `T2.5` → `T2.6` → `T2.7`

This is the deep read of a merchant's store: connect Shopify read-only, sync the
catalog, turn marketing copy into factual product sheets, group products into
families, build the store's business profile, and find its keywords and
competitors.

**Start with `T2.0` immediately.** It is schema wave 2 — twenty-one database
tables that Lanes C, D and E all need later. It depends on nothing, and it is the
only card in the wave allowed to add migrations.

**Watch for:** `T2.2` is audit-flagged and carries one of the product's hardest
privacy rules — order data is read for revenue ranking, and every customer field
is stripped *at read time*, before anything is stored. A test asserts no customer
field reaches storage; the GDPR webhooks answer "no data held" because it is
literally true. `T2.3` quarantines raw product HTML so it can never reach the
article writer.

---

## What every session must not do

These are review failures regardless of code quality:

- **Editing another lane's directories.** Cross-lane needs go through the frozen
  contracts, or they wait.
- **Adding a database migration outside a schema-wave card.** If a card needs a
  column, it writes a `DECISIONS.md` entry and either waits for the next wave or
  asks the integrator for a mini-wave. It never adds one itself. (This rule was
  bent once in M0, deliberately and flagged — see decision 3 in the decisions
  document.)
- **Putting a threshold number in code.** Every number the product decides with
  lives in `packages/rules`. The build plants a violation on every run and fails
  if the checker misses it, so this is caught rather than trusted.
- **Putting user-facing copy in a component.** All strings live in
  `packages/ui/strings`.
- **Changing a contract.** The seams were frozen by T0.7. A lane that needs a
  different shape stops and asks the integrator to re-freeze it, because someone
  else is already building against the current one.
- **Two cards in one session.** Finish or explicitly park before starting
  another.
- **Working from memory of the specs.** Open and read the exact sections the card
  cites, verbatim, before writing code.

---

## The six stand-ins, and who replaces them

Six parts of the system are deliberately fake right now. Each records the card
that replaces it. `pnpm stubs:report` lists them.

| Stand-in | What it does instead | Replaced by |
|---|---|---|
| `existingTargetCheck` | always says "no existing page" | Lane C, `T3.5` |
| `CatalogEvents` | replays fixed fake events | Lane B, `T2.2` |
| `OpportunitySource` | returns a fixed sample set | Lane C, `T3.6/T3.7` |
| `TopicScheduler` | records the intent, no calendar | Lane D, `T4.2` |
| `JudgeLite` | passes everything | Lane D, `T4.4` |
| `NotificationEmitter` | records in memory, nothing sent | Lane G, `T8.1` |

**One of these is dangerous and worth understanding.** Before writing a new
article, the system is supposed to check whether the store already has a page
that could rank for that search — and if so, improve that page instead of
creating a competitor to it. The spec calls this the single most important rule
in the merge. While the stand-in is wired it always answers "no such page", so
every article looks unopposed and nothing about the product appears broken.

None of the wave 1 lanes consume it. It becomes urgent in wave 2, when the
content engine starts using it. The report can fail the build per milestone, so
this is caught rather than remembered.

---

## When the wave ends

The integrator (a founder is recommended for the first few) does four things at
the milestone boundary:

1. Merges the lane branches in dependency order.
2. Runs the milestone exit gate — the card whose job is to prove the milestone as
   a whole, not the sum of its cards. For M1 that's `T1.4`; for M2, `T2.7`.
3. Runs the invariant sweep: every rule in `CLAUDE.md` mapped to a named
   mechanism, each one actually run. The output is "zero invariants without
   teeth" or a list of cards.
4. Triages `DECISIONS.md`. Every entry gets classified: fine as-is, promote into
   the spec, or contradicts the spec. **Class-c entries block the next wave.**

Wave 2 (the Opportunity Engine, the content engine, onboarding screens,
notifications) needs M1, M2 and the schema wave merged before it starts.

---

## Session mechanics

One git worktree per lane, so the sessions never see each other's uncommitted
work:

```
git worktree add ../sortiva-lane-a lane-a
git worktree add ../sortiva-lane-b lane-b
git worktree add ../sortiva-lane-f lane-f
```

Each session starts in its own worktree with `CLAUDE.md` loaded automatically.

**Kick-off prompt — paste verbatim, replace the ID:**

> Implement card **T1.1** from `docs/agent-work-plan.md` §6. Follow `CLAUDE.md`.
> First: read the card, then read every section it cites verbatim from `/docs`,
> then grep `DECISIONS.md` for this area. Write a short plan (files, order, which
> done-when each step satisfies, invariants touched) before any code. Journal
> undictated choices in `DECISIONS.md` as you go. Finish by running every
> done-when check and reporting the evidence. Do not start another card.

**Each session ends with:** what was built, done-when evidence (actual test
output, not an assertion that it passed), the `DECISIONS.md` entries it made, the
next card in order, and whether an audit is required.

**Never paste chat history into a session.** If a card can't be done without it,
the card is wrong — fix the card, not the session.

---

## Running the gates

```
pnpm install
pnpm db:up && pnpm db:migrate && pnpm db:seed

# every merge
pnpm lint && pnpm lint:prove && pnpm typecheck && pnpm test && pnpm build
pnpm contracts:check && pnpm stubs:report && pnpm posthog:check

# own schedule
pnpm chaos     # nightly
pnpm eval      # when a prompt or model id changes
pnpm e2e       # needs: pnpm exec playwright install chromium
```

361 tests currently pass. Tests needing a database create their own and fail
loudly rather than skipping — a silently-skipped constraint suite reports green
while proving nothing.

---

## Still open — and a standing caveat

Founder decisions, credentials and provisioning are collected in
[`docs/founder-decisions.md`](founder-decisions.md). **None of it blocks wave 1** —
the lanes have what they need to work for weeks.

**It does block launch, and that document is the gate.** Sortiva is not finished
while any item marked ▲ there is unresolved, however complete the code is: a
price nobody has set, vendor rates nobody has confirmed, a privacy policy nobody
has written, and a Shopify listing nobody has submitted are not engineering
problems and will not be solved by shipping more cards.

Any session, agent or human, that is about to report the product as done should
read that document's **Definition of done** first, and report against it.
