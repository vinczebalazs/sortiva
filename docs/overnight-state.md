# Overnight state

Rewritten after **every** card lands or stops, and re-read before any card is
launched and before any merge. Its test: a completely fresh session, with none of
the conversation that produced it, could take over from this file alone.

**Last rewritten:** 2026-09-01, 23:00, by the integrator session. No card has
landed. What changed: the founder said start, and three lanes are now building.

---

## Right now

**Three lanes are building.** The founder said "start on the work" at 22:56 on
2026-09-01. Each lane is a separate session in its own worktree, created from
`73c9fb9`, with dependencies installed and `.env` copied in. A Postgres for the
tests has been running in Docker throughout (`sortiva-postgres`, port 54329); the
test harness gives every process its own database with a random suffix, so three
lanes on one server cannot destroy each other's runs.

| Lane | Card | Branch | Worktree | State |
|---|---|---|---|---|
| B — Store Intelligence | `T2.1` | `lane-b` | `../sortiva-lane-b` | building |
| C — Search Intelligence | `T3.1` | `lane-c` | `../sortiva-lane-c` | building |
| F — Frontend | `T9.1` | `lane-f` | `../sortiva-lane-f` | building |

**`T8.0` was deliberately not launched**, though the order lists it as the fourth
parallel card. Two reasons. It is schema wave 4, whose entire content is "the
columns earlier cards deferred" — and collecting those is the integrator's job,
not done yet. And two of the documents disagree on how many sessions may run at
once: `overnight-run.md` says four, `handoff-wave2.md` says two or three. Three
satisfies both. Machine load was 2.04 across 12 cores at launch.

**The founder is awake and directing.** The unattended rules in
`docs/overnight-run.md` describe how to work when they are not; while they are,
ask rather than assume. Each lane was told explicitly: a product choice with no
documented default stops the lane and gets reported, never guessed.

**One question is already known to be waiting inside `T2.1`** and was put to the
founder at launch rather than left for the lane to hit: the worker turns its
schedule on only when all twelve scheduled jobs have a handler, and eleven have
none — so nothing scheduled runs at all, including the nightly billing repair,
whose handler is written and tested. All-or-nothing, or enable the entries that
have handlers? Three separate pieces of machinery wait behind that one line.

The stale branches `night-b`, `night-c`, `night-f` still exist, all pointing at an
ancestor of `main`, and hold nothing. The founder has not said whether to delete
them.

## The thing that keeps killing lanes

**This machine sleeps mid-response and it kills whatever session is running.**
Confirmed on 2026-09-02: three lanes died at once with no progress, were resumed,
and two died again with the explicit error "your computer went to sleep
mid-response". The idle-sleep timer is set to **one minute**, and a `caffeinate`
was already running without holding it — a bare `caffeinate` does not assert
display or system sleep, and a closed lid sleeps regardless.

A stronger hold (`caffeinate -dimsu`) was started at 06:20 with a six-hour
expiry. **If lanes start dying again, check that first** (`pgrep -fl caffeinate`,
`pmset -g | grep sleep`) before suspecting the work.

Nothing is lost when it happens — the worktree survives — but an interrupted
session may have written half a file. Every lane has been told to commit early
and often, by explicit path, for exactly this reason: a committed half is
recoverable, an uncommitted half is a guess.

## What is on `main`

Wave 2 has not started. The last four commits are the wave-1 close-out plus two
cards that landed on their own:

| Commit | What it was |
|---|---|
| `6fb14a5` | docs — re-ordering what remained after the sweep |
| `b0c1413` | `T-SWEEP` — removed 1,007 spec references from the code, left 15 in shipped migrations |
| `c71f023` | docs — the hard rules for unattended work |
| `f6775dd` | `T8.4a` — spend caps that pause the product before the bill arrives |

**Gate result on this tree** (from `docs/handoff-wave2.md`, each command run
separately): lint clean · 7 planted lint violations all rejected · typecheck 9
packages · **914 tests passing** · 56 API routes agreeing with the API document ·
build 9 routes · eval and chaos pass · migrations on an *empty* database produce 41
tables and 3 guard triggers.

That last row is the one worth re-checking after any schema work: a migration that
only ever runs against a database which already has the tables has not been tested.

## Where the order stands

From `docs/handoff-wave2.md` §"The order":

1. Four lanes in parallel, none waiting on another: **`T2.1`** (B), **`T9.1`** (F),
   **`T3.1`** (C), **`T8.0`** (G). **Three are running; `T8.0` is not — see above.**
2. **The operations card**, after `T2.1` and before `T2.2`. The reasoning, from
   `docs/overnight-run.md`: `T2.1` is what makes background steps actually run, so
   it is the first moment a diagnosis script can be tested against a store that is
   genuinely stuck rather than a fixture — and `T2.2` is the card most likely to
   strand one.
3. Then the dependency order, which lane B sets.

Each lane merges into `main` and runs the full gate before that lane starts its
next card. A lane never runs two cards at once.

## Decisions taken, and what depends on them

**Nothing here was assumed.** Both content decisions below were made by the founder
directly, in conversation on 2026-09-01. No default from
`docs/founder-decisions.md` §C has been taken, by any card, so far.

**1. Prices live in articles as a reference to the current value, never as a
number.** An article body never stores a price, stock state, sale status or product
URL as text; it stores a placeholder that is filled in from the live store at the
moment of publish or republish. The reader still sees a real figure — it is simply
always the current one.

Two things travel with it: prose may not build an *argument* on a price ("the
cheapest in the range"), because a figure rendering correctly does not make a
sentence reasoning about it true; and a price change stops triggering a refresh,
because there is nothing left to correct. The out-of-stock trigger is unchanged — a
product unavailable long enough makes the *recommendation* wrong, not just a number.

*Why it mattered enough to decide now:* the plan sells at most one article a day,
and a refresh spends that day exactly like a new article. A merchant running a sale
across a range was losing a day per affected article to fix nothing but a number.

*Depends on it:* **`T4.0`** must create the reference storage — migrations are only
added by schema-wave cards, so an article published before `T4.0` would carry
literal prices that cannot be retrofitted. Also folded into `T4.3` (writing rule),
`T5.1` (export resolves references), `T5.2` (publish-time resolution), `T5.3`
(price-drift trigger retired).

**2. A draft with nothing new to say is rejected outright, with no repair attempt.**
Of the quality criteria, information gain — does a reader get anything here they
would not get from the pages already ranking — is the one whose failure ends the run
immediately. Every other criterion keeps its single repair attempt. The reasoning:
the others fail for reasons a rewrite can fix; this one fails because the evidence
had nothing distinctive in it, and rewriting adds no material that was never
gathered.

This does **not** contradict invariant 11's "one repair loop max" — that is a
ceiling, and this criterion now sits at zero. *Depends on it:* **`T4.4`**.

Both are journalled in full in `DECISIONS.md`, titled with the card ID so the
grep the launch prompt prescribes finds them.

**Also worth knowing:** `docs/handoff-wave2.md` still lists "do the spend caps count
failed vendor calls?" as an open decision. It is no longer open — the `T8.4a` entry
in `DECISIONS.md` closed it with a documented default (they *do* count), and named
the single boolean that flips it. The handoff is stale on that one line.

## The content spec, and what to trust in it

`docs/content-spec.md` arrived from the cofounder on 2026-09-01. **It was written
against a different codebase** — every package, file, table and baseline commit it
cites is absent here, so its `[SHIPPED]` / `[BUILD]` / `[BLOCKED]` markers and its
gap register describe some other tree and must not be planned from. Three things it
calls blocking are already built or already settled here: per-query Search Console
data, the `opportunities` table, and the Shopify `read_products` permission.

Its *content* substance is good and has been extracted into
**`docs/content-pointers.md`**, which is the file to read — the claim model, the
citation rule, structure shapes with named failure conditions, the passage rules,
the banned-language inventory, the free checks that run before any paid one, the
contradiction check, and how an article is kept true after publish. The M4 and M5
cards now cite it by section.

**One piece of it is not done and needs a founder answer before it can be:** the
banned-language list is half Hungarian, because that is what it was tested against.
A list of tells does not translate — each launch locale needs its own, written by
someone who reads that language. Noted in `content-pointers.md` §6.

**One piece deliberately not folded in:** the typed refresh diagnosis — deciding
*why* an article decayed before choosing how much of it to rewrite — belongs in
`T7.2`, which is far enough out that it was left alone. `content-pointers.md` §9
holds it.

## `T8.0` — what schema wave 4 actually contains

The card says "any columns deferred via DECISIONS entries from waves 1–3
(integrator-collected)". Collected, on 2026-09-02, by reading every `DECISIONS.md`
entry that mentions a migration or a column. **It is thin — an hour of work, not a
lane's worth**, which is the other half of why it was not launched alongside the
three building cards.

**Genuinely deferred and still wanted — two partial unique indexes**, both
requested by the `T1.4` entry of 2026-09-01 as "defence in depth":

- on `domains.release_after`, `WHERE release_after IS NULL`. Today a domain is
  released for someone else to claim only because a sweep job deletes the row; the
  index would make the release a fact in the database rather than a consequence of
  a job running. If that sweep never runs, the domain stays blocked forever — safe
  (nobody is handed someone else's domain) but not what was promised.
- the matching one on `shopify_conns.invalidated_at`, for the same reason.

**Asked about and deliberately declined** — do not revive these without a reason:

- `spend_events.price_unknown`. `R2` names the gap and says it is not requested: a
  call we could not price is already identifiable as zero cost with no cache hit,
  and the check that would produce one now runs at start-up instead, so the row
  cannot occur.
- `idempotency_ledger.account_id`. `T2.0b` and `R3` both declined it, and `R3`
  gives the strong reason: an account column would hand a future data-deletion path
  a way to erase the record of paid work by account, which is the one thing that
  table exists to prevent.

**Already built, so no longer outstanding:** `verification_tokens` (the table email
sign-in was blocked on) exists as of mini-wave 2b.

**Not a migration and therefore not this card:** `R1`'s durable fix — stopping
`@sortiva/db` from exporting raw tables and giving the job tables scoped helpers.
That is a `packages/db` refactor and needs its own card.

## A trap waiting inside `T3.1`, found before the lane hit it

`T3.1`'s last done-when says the skip path "sets `limited_intelligence = true`" on
`account_settings`. **That column does not exist and was deliberately not created.**
Mini-wave `T2.0b` was asked to add it, read the spec, and declined: main §7.11 and
§6.7 describe Limited Intelligence as a *state an account is in while it has no
Search Console connection*, not a flag somebody writes — and a stored copy of a
derived fact is a second source of truth that drifts. The column that does exist is
`opportunities.limited_intelligence`, which is a different thing: a stamp on each
opportunity recording that it was found without Search Console data.

So the card's done-when cannot be met literally, and the resolution is dictated
rather than open: the specs are law and they say derived. `T3.1` implements it as
derived and reports the card text as wrong — it never adds the column, because
migrations belong to schema waves and because the spec does not want one.

Lane C was told this when it was resumed.

## Audit findings, unactioned

Six investigations ran during wave 1; all reports are in `docs/audits/`, and
`remediation.md` indexes them and records what was decided. The blockers and major
findings were fixed during wave 1.

**Four remain open**, from `docs/audits/false-confidence.md`. Each is small, and each
is best taken by the card that next touches that area — not as a sweep:

| Finding | Whoever next touches |
|---|---|
| The single-writer guard on billing status is defeated by aliasing the import | billing |
| The threshold rule is defeated by naming the constant instead of writing the literal | `packages/rules` |
| Nothing structurally stops product content reaching an analytics event — secrets are redacted, article text is not | analytics, and any card that emits article events |
| The caching argument on the vendor wrappers silently defaults to off, unlike the cost ledger beside it, which is required | `packages/providers` |

Nothing has been acted on beyond recording it here.

## Lanes stopped, and the question that stopped them

None yet. Three are building; see the table at the top for which.

## What the next card must know

- **`T2.2`** reads main §14.1 for change detection. §14.1 still contains the
  price-drift row that decision 1 retires — the spec has not been rewritten, by
  convention: `DECISIONS.md` records departures and audits promote them later.
  `T2.2` builds the event emitter, not the refresh policy, so this does not reach
  it; the card that must not build it is `T5.3`, and its card text says so.
- **Anything in M4 or M5** should read `docs/content-pointers.md` before the card,
  as the cards now instruct.
- **The spec is stale in two known places**: §14.1's price-drift row (above), and
  the subscription status list, which enumerates four values where the code has five
  — a fifth was added because storing "card still being authorised" as "gave up"
  corrupted the signup funnel. Both are for the spec keepers, neither blocks a card.
- **Still no vendor credentials.** Stripe, Turnstile, Anthropic and PostHog work is
  built and tested against fakes, and the real-vendor evidence is recorded as
  outstanding rather than claimed. Three cards need re-running against real keys.
- **Email sign-in is unfinished and unowned.** It shipped Google-only because no
  table existed for a magic link's single-use token. That table exists now. No card
  owns finishing it.
