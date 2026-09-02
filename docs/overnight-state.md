# Overnight state

Rewritten after **every** card lands or stops, and re-read before any card is
launched and before any merge. Its test: a completely fresh session, with none of
the conversation that produced it, could take over from this file alone.

**Last rewritten:** 2026-09-02, 18:55, by the integrator session running the night.
`main` is at `c9e787b` with a clean tree. Eight cards landed earlier today; `main`
was green at 1,362 tests and the built application starts and serves pages. **The
plan for the run is `docs/nightly-plan.md`** — read it after this file.

---

## Right now

**Status at 2026-09-02, 19:24.** `main` is at `fa7cff4`, clean, and fully green — see
the gate table below. **Four cards have landed tonight**, each merged and gated
separately: `T8.0`, `T-START`, `T-ANALYTICS`, `T3.4`. Tests are at **1,465**, up from
1,362 at the start of the night.

| Lane | Branch | Worktree | Where it is |
|---|---|---|---|
| B — Store Intelligence | `lane-b` | `../sortiva-lane-b` | `T-START` merged (`d34daa6`); **`T2.2` building** — the critical path, and the most consequential card of the run |
| C — Search Intelligence | `lane-c` | `../sortiva-lane-c` | `T3.4` merged (`fa7cff4`); **next is `T-EMAIL`**, then the lane is held for `T2.5` |
| F — Frontend | `lane-f` | `../sortiva-lane-f` | `T-ANALYTICS` merged (`42ddd50`); **next is `T9.3`** → `T9.4` → `T9.5` |
| G — Ops & notifications | `lane-g` | `../sortiva-lane-g` | `T8.0` merged (`6400b62`); **`T8.1` building**; then `T8.2`, after which an audit is scheduled |

**An audit is scheduled after `T2.2`** (build plan §7) and must run before `T2.3`
starts. Another is scheduled after `T8.2`. Audits are read-only and their findings are
held for the morning unless one blocks the next card in that lane.

**Every lane obeyed the one-card rule tonight**, including lane F, which broke it
earlier in the day. All four reported, stopped, and left clean worktrees.

**The gate flakes under concurrent lane load — re-run before believing a red.** It
happened twice tonight, in two different shapes, and both times an immediate re-run was
clean:

- **Every test passing and a non-zero exit**, on one Postgres `57P01` error
  ("terminating connection due to administrator command") from a test file's teardown.
  The cause is in `packages/db/src/testing.ts`, which force-drops each suite's own
  database and so kills a connection a suite forgot to close.
- **Two test *files* failing on 10-second hook timeouts** while all 1,404 tests passed.

Neither is a product failure and neither was caused by the card being merged. **The rule
to apply: if a gate goes red with every test passing, re-run once before investigating.**
Unactioned; it belongs to whoever next touches the test harness.

**Setup done at the start of this run, and one thing the previous state file got
wrong.** It recorded all lane worktrees as "clean and level with `main`". They were
clean, but 7, 39 and 44 commits *behind* — every commit fully merged, none carrying
unmerged work. All three were fast-forwarded before anything launched, so no lane is
building against a stale tree. Lane G's worktree was created for this run, `.env`
copied in, `pnpm install` run there (exit 0). The sleep hold was re-applied
(`caffeinate -dimsu -t 21600`, and an earlier one was still alive).

**`T8.0`'s deferred-column list was collected by the integrator before lane G started**,
so the lane inherited a list rather than a search. The lane then found the list wrong
about one item and refused to build it — that correction is in the `T8.0` section
below and is more consequential than the migration itself.

**Four decisions were taken on 2026-09-02 and all four are journalled with the
alternative that was rejected and why.** Do not re-argue any of them from memory —
read the entries. Three became cards (`T-START`, `T-ANALYTICS`, `T-EMAIL`); the
fourth is already built and merged (the change contract can now describe a blog post
or a static page being edited or deleted).

**Two questions are still open and neither blocks the run:** whether to switch the
recurring job schedule on, and the deployed start command that would not find the
build. Both are described in their own sections below.

**The learning loop is out of v1** on the founder's instruction.

**A warning about editing this file.** Two separate scripted edits have damaged it.
One replaced a span between two headings and swallowed five sections, including both
founder decisions; it was restored from git. Another used a pattern that matched
nothing, so the timestamp silently stayed eight hours stale while the body updates
landed. **Edit it by hand or by line position, verify the section list afterwards
(`grep -n '^## '`), and re-read the result.**

## Picking this up again

*This section described how to restart after the 08:10 stop. It is kept because
both restarted lanes are still working through the inherited state it describes.*

**Read `git status` in a worktree before doing anything in it.** Both resumed lanes
were killed mid-edit, so a file may be half-written; neither had run a gate, so
nothing in them was known to work when the sessions picked them up.

**Lane C — `T3.2`, the store's content inventory.** Two commits on `lane-c`:
reading a store's own pages into an inventory without crawling any of them, and
storing it one row per address. Uncommitted on top: changes across five files in
`packages/core/src/inventory/` and a new `packages/jobs/src/inventory/` directory.
It was stopped just before running a typecheck ahead of writing its integration
test. Resume by re-reading the card, then that uncommitted work, then gating it —
do not assume it compiles.

**Lane F — `T9.2`, the landing, preview, signup and plan screens.** Three commits
on `lane-f`, one of which (`e2c9e37`) is the unauthorised draft described below and
had still not been fully audited when the session stopped. Uncommitted on top: the
public route group under `apps/web/app/(public)/`, a stylesheet, and **a staged
deletion of `apps/web/app/page.tsx`** — the placeholder root page, whose address
the real landing page takes over. That deletion is deliberate but unverified: if it
is committed without the new page beside it, the site has no home page. Resume by
checking that pairing first.

**Nothing was pushed and nothing was forced.** The three lane branches are ordinary
local branches; `main` contains only merged, gated work.

**The machine's sleep hold was re-applied at 16:27** (six-hour expiry). It had been released while nothing was running. The note below explains why it exists.

**Previously:** the machine's sleep hold had been released. It was holding the laptop awake so
sessions would stop dying mid-response; with no lane running there is nothing to
protect, and leaving a laptop permanently awake is not this session's call to make.
**Re-apply it before launching anything** — see the section on it below.

**Two founder questions are open and both are recorded below**: what starts a
merchant's onboarding (this is what holds lane B), and how a browser sends an
analytics event (raised by lane F; it does not block, because the seam has a
do-nothing default).

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

## `T-ANALYTICS` LANDED — the browser reports, and what it may say is enforced

**Merged as `42ddd50` into `main`, four commits, full gate green.** This closes
the second founder question the run inherited. The browser now reports to PostHog
directly, binding the seam `T9.1` shipped deliberately unbound.

**The interesting part is not the transport — it is that the guard became structural.**
There is a standing audit finding that nothing stops product content reaching an
analytics event: secrets are redacted, article text is not. The card's answer:

- **Each of the ten browser events already listed its properties as types, which a cast
  defeats.** Every property now also declares *what kind of thing it may hold* — an
  identifier, a name from a fixed list we chose, a count, or a yes/no. That table exists
  at run time and everything a screen reports is filtered through it. **There is
  deliberately no kind for text**, so an article title, a body or a prompt is not
  expressible under any property name.
- **A vendor access token is identifier-shaped and would have slipped through**, so the
  same secret matcher the server-side wrapper uses rejects it — rejected, not redacted,
  because an id that is really a token is a bug and `[redacted]` in its place is a worse
  record than none.
- **The vendor library's own autocapture is off.** It records the text of whatever was
  clicked; on a product list that text is the merchant's catalogue, and leaving it on
  would have made every guard above beside the point.

**Session replay is off everywhere, held by three things**, because each alone is weak:
start-up options, a per-view answer, and a test that keeps the view list complete.
**Adding a new page under `apps/web/app` now fails until it is classified** in
`VIEW_CONTENT`, and the failure names the route and says what to do. The landing page
`/` is classified as store data despite being public, because its preview card renders a
shop's products.

**A lint rule makes `packages/ui/src/analytics` the only place allowed to import
`posthog-js`**, with a planted violation proving it bites. The gate's proof count is now
11.

**Two judgement calls the lane flagged rather than hid**, and the integrator agrees they
are worth a look rather than a nod. The shell's account object gained two *optional*
fields — optional keeps every existing construction valid and nothing rendered needs
them, but it means a backend that forgets them reports nothing and no test fails. And
the test that rejects content-shaped property *names* is a heuristic, not a proof: a
future card could add a one-word enum property that passes. The real protection is that
adding a property is a visible edit to one table.

**Files outside Lane F's directories:** `pnpm-lock.yaml` and `packages/ui/package.json`
(`posthog-js`), one entry in the shared lint plugin's SDK list (not `eslint.config.mjs`),
a new lint-proof file, and `.env.example`. **The integrator ran `pnpm install` and added
the new key to every worktree's `.env`** — see the gate note above.

**`T9.3` inherits:** call `useUiAnalytics()` and `capture(name, props)`; a new event
means a new row in the definitions table, and there is no autocapture safety net by
design; a new page must be classified or the build fails.

**Real-vendor evidence outstanding:** there are no PostHog credentials, so this is proved
against a fake vendor client. That is a **sixth** item on the list of work needing a
re-run against real keys.

## `T3.4` LANDED — the first four things the product actually notices

**Merged as `fa7cff4` into `main`, four commits, full gate green.** Everything Lane C
built before this was arithmetic; this is where it becomes signals. Four pure functions
over search history the product already stores — no database, no clock, no network. Each
answers "what is true"; **none says what to do about it**, which is constitution
invariant 7 (signal and action are never mapped 1:1) and is held by a named test.

- **Striking Distance** — pages Google already puts just off the first page, where the
  gap is an editing job rather than a new page. A traffic floor stops it listing
  everything: the page must already be shown at least as often as this store's middle
  page.
- **Low click-through at strong rank** — pages that rank well and are not clicked, so the
  title and description are what is losing the click. Compared only against *this
  store's own* curve, with searches for the shop's own name dropped first.
- **Content decay** — pages that used to work and no longer do, against the same four
  weeks a quarter earlier, needing clicks to have fallen *and* position to have slipped,
  on a page that was earning something before.
- **Cannibalization** — several of the store's own pages splitting one search.

**Five new thresholds, all in `packages/rules`, each with a plain-language note saying
what it decides and what changing it would do.** All five are marked UNSIGNED. The
done-when is held by a test that loads the real config file, edits a band in the text,
and shows the same page detected before and not after.

### Two signals are inert on a real store today, and neither is this card's fault

**Read this before planning `T3.5` or `T3.7`.**

1. **Cannibalization cannot validate.** The spec makes "both pages are doing the same
   job" a mandatory half of the test, and that comes from a column that exists in the
   schema and **nothing in the codebase writes**. Unknown fails closed — candidates come
   back held, with the reason, never dropped and never waved through — because the work
   this signal leads to is merging pages, and merging two that answer different people
   destroys something that works. **No card in the plan claims that column.** The natural
   producers are the inventory sync or the persona work. This is an unowned gap and
   somebody should own it.
2. **Decay cannot confirm.** "The decline must hold across two consecutive weekly runs"
   is history across runs, and nothing stores it. The detector takes it as an input and
   returns unconfirmed sightings as provisional, so with no history supplied it reports
   nothing — the safe direction. `T3.7` owns the fix and has two options: put the count
   in the open opportunity's evidence (no migration, but writes a row before
   confirmation), or ask for a small table (a schema wave).

**A shared fixture is wrong and no lane may fix it.** Worked example 5 states an
alternation its data does not contain — the 28-day window spreads every total evenly
across the days, so the leading page never changes. The lane worked around it by
re-arranging the same totals into weeks and asserting they still sum to the fixture's
figures, and deliberately did not touch `packages/core/src/fixtures/scenarios.ts`
because three lanes read it. **Whoever next owns that file should put weekly variation
into the 28-day window.**

**A trap that cost this lane time and can cost anyone's:** a stray control character got
into a test-support file and made git treat it as binary — no diff shown, and a merge
would have been resolved by wholesale replacement rather than by combining. The lane
caught and fixed it, and the integrator confirmed before merging that no file on the
branch is binary and that the file is clean UTF-8. Worth knowing it can happen.

**Files outside Lane C's directories: none.**

## `T-START` LANDED — a claimed domain now starts moving by itself

**Merged into `main` as `d34daa6` on 2026-09-02 at 19:12, three commits, full gate
green.** This closes the founder question that had been open since `T2.1`.

**What was actually wrong.** Claiming a domain wrote the *record* of a store's
onboarding — the run and its nine step rows — and asked nobody to do any of it. A
merchant who connected their Shopify store moved forward, because the OAuth callback
resumes onboarding itself; but the very first step, reading their storefront to see
what it is built on, had nothing to trigger it. Nothing in the running product started
a merchant's onboarding.

**What changed.** The claim now puts "move this store along" on the job queue **inside
the same transaction that writes the run**. Both halves commit together, so a claim can
never land without work behind it, and a queued nudge can never outlive a claim that
rolled back. Two files carry it: a new `packages/jobs/src/ingestion/queue.ts`, which
imports drizzle and nothing else, and three lines in the claim path.

**Why the queue call is its own near-empty file.** The dispatcher it names pulls in the
Shopify steps, the LLM wrapper and the threshold config. A route importing that to
queue one job would drag a file-reading config loader into a bundle with no filesystem
— the exact failure `T-BOOT` repaired, where the build passes and every test passes and
the server serves nothing. The Search Console and inventory queues are split the same
way; this follows them. **Any lane whose route enqueues background work should copy this
shape.**

**Repeat claims get one job, not two.** The job key is derived from the account, so a
merchant who pastes their address again after nothing seemed to happen nudges the
existing job rather than stacking work behind it. Derived from the input, never random —
which is what makes it hold across separate requests as well as within one.

**Proved by mutation, not just by passing.** With the enqueue line removed, all four new
tests fail and all nine pre-existing claim tests still pass. The transactional property
is shown by rolling back: inside the transaction there is 1 domain, 1 run, 9 steps and
1 queued job; after rollback, zero of each.

### The one consequence worth a second pair of eyes

**A database no worker has ever started against now *fails* a claim, where before it
would quietly claim and start nothing.** The claim writes into the queue's own tables,
and those are created by the worker at start-up rather than by our migrations. In
production this is satisfied — the worker runs inside the web server's own process — and
a route already queued work this way before this card. But running with the worker
disabled against a fresh database, which is how someone might work on screens locally,
now breaks the claim. It fails in the safe direction and it is journalled, but it is a
real change to a developer's experience. Closing it properly means putting the queue's
tables into our own migrations, which is a schema wave, not this card.

### What `T2.2` inherits

- **The claim is no longer inert.** `T2.2`'s catalog sync sits behind `detect` and
  `oauth_wait` in the same run, and that run now actually starts when a domain is
  claimed. Anything tested end to end will have a worker trying to move it.
- **Any test that claims a domain now needs the queue's tables.** Call
  `installQueueSchema(url)` from `@sortiva/jobs/runtime/testing` in `beforeAll`, and
  `TRUNCATE_QUEUE_SQL` in `beforeEach`. That file is new and lives in
  `packages/jobs/runtime`, which no lane owns; it exists so the two Lane A test suites
  could install the queue without `apps/web` taking a dependency on `graphile-worker`,
  which would have changed `pnpm-lock.yaml` — the known merge hazard.

### Files touched outside Lane B's directories

Authorised by the `T-START` journal entry, which is the founder decision itself:
`apps/web/app/api/domain/_lib/store.ts` and its two test files (**Lane A** — three lines
of production code plus comments), `packages/jobs/src/runtime/steps.ts` (one comment
that had come to say the opposite of the truth), and the new
`packages/jobs/src/runtime/testing.ts`. No migration. No lockfile change. `DECISIONS.md`
is union-merged.

**The integrator verified before merging** that the claim path's only behavioural change
is the enqueue, that the new queue file imports drizzle alone, and that the dispatcher's
task-name constant moved to that file rather than being duplicated.

**No audit is scheduled after this card** (build plan §7). The lane judged one
unnecessary and the integrator agrees; the item deserving scrutiny is the queue-tables
consequence above, which is recorded rather than resolved.

## What is on `main`

**`T3.1` landed on 2026-09-02** — a store's search history can now be pulled in.
Twelve commits, merged as `521679e`; the merge conflicted in one file (both this
card and `T2.1` register background jobs at the same start-up hook) and both sides
were kept.

Search Console is Google's free report of what people searched for before they
landed on a store's pages, how often each page was shown, and where it sat in the
results. It is the only honest answer to "what does this store already rank for",
and the engine is meant to consult it before proposing anything so it never writes
a new page for something an existing page already serves.

- **A property for the wrong website is refused outright, not warned about.** A
  merchant's Google account often reads sites they run for other people; attaching
  one of those makes every later conclusion about the wrong website, with nothing
  in the product to reveal it. A lookalike that merely *ends* with the claimed
  domain is refused too.
- **Declining stays first-class.** Skipping is recorded and the rest of onboarding
  carries on untouched.
- **The nightly pull takes the last seven days, not yesterday.** Google keeps
  revising recent days for about a week; a single-day pull would freeze the first,
  lowest figure it ever reported.
- **The sixteen-month history imports newest first**, a month at a time, each
  month handing the rest to a fresh job — so a crash costs one month, not the
  import. A merchant who confirms their profile while it is still running already
  has the months the signals weigh most heavily.
- **When Google permission dies, reporting stops and nothing else does** — proved
  by taking the steps of a live run before and after and showing none moved.

**A done-when in the card is wrong and was not implemented as written.** `T3.1`
asks the skip path to set `account_settings.limited_intelligence`. There is no such
column and there should not be: mini-wave `T2.0b` was asked to add it, read the
spec and declined, because running-without-Search-Console is defined as the state
an account is *in* while it has no connection — one entry condition and one exit
condition, both about whether a connection exists. A stored flag is a second source
of truth that can disagree: the badge outlives the connection the merchant just
made, or reads "fine" with nothing to read. Implemented as derived, no column, no
migration. **The card text should be corrected.**

*Consequence worth knowing:* `GET /api/account` had been returning
`limitedIntelligence: true` unconditionally — correct while nothing could connect
Search Console, and a badge that never goes away the moment something can. It is
now wired to the real value.

**`T2.1` landed on 2026-09-02** — a merchant's store can now actually be connected.
Eleven commits, merged as `73ca6c9`. In plain terms:

- We work out whether a site is a Shopify store from marks its storefront leaves —
  a response header, theme files on Shopify's own network, the object every theme
  defines — and only spend a second request on the product feed if none appear.
  Anything else is parked with the agreed explanation, keeping its domain, and the
  seven later onboarding steps are marked skipped so the progress screen stops
  showing work that will never start.
- **We ask for four read permissions and nothing else, and we check the answer.**
  If Shopify hands back a grant carrying any write permission, the token is thrown
  away rather than stored — because the app's permissions are configured in
  Shopify's dashboard, outside this repository, so a misconfiguration there could
  otherwise hand us the write access the screen promises we will never take.
- The token is encrypted before it reaches the database. A test reads the raw
  column and proves the token is not in it, and that a different key cannot read it.
- Shopify rejecting our token and the merchant uninstalling are handled as one
  event: the store moves to the reconnect screen, the merchant is told exactly once
  however many times the event is processed, and everything already made for them
  stays readable. Nothing goes to the failed-work queue, because no operator could
  fix it — only the merchant can.

**Not satisfied, and it must be before launch:** the card's dev-store handshake.
There are no Shopify Partner credentials, so the whole exchange was run against a
real local HTTP server standing in for Shopify instead. **This card needs re-running
against a real dev store**, and it now joins Stripe, Turnstile, Anthropic and
PostHog on that list.

**Two things `T2.2` should inherit rather than rewrite:** the Shopify request
signature check, which is written and tested here including that it verifies the
exact bytes received rather than a re-serialisation; and the fact that
`awaiting_shopify_auth` alone does not say which screen to draw — first-time
connect versus reconnect-after-loss is decided by whether a connection row exists,
and `shopifyConnectionState` answers it.

**`T9.1` landed on 2026-09-02** — the app shell and, more consequentially, the
string catalogue. Eight commits, merged as `6613241`.

What it changed that everyone inherits:

- **`packages/ui/strings` now exists**, and a lint rule makes text typed into a
  component a build failure — including the text a person actually reads out of an
  attribute, like a tooltip or an accessible label. Every card from here on puts
  its sentences there. The thirteen sentences the product may not reword are keyed
  to the spec's canonical-copy table and asserted character for character.
- **Billing's copy still lives in its old home** (`packages/core/src/billing/copy.ts`),
  because moving it means editing another lane's directory. A test asserts the two
  homes say the same thing, so drift is a red test. **Deleting the duplicate is a
  mechanical follow-up nobody owns yet.**
- **A locked navigation item renders with no web address at all** — not a greyed-out
  link that still works. Cards adding screens should keep that property.
- **Two files outside lane F's directories changed**: `eslint.config.mjs` (the new
  rule, plus an exemption for gallery pages) and `apps/web/app/page.tsx` (one word,
  forced by the new rule). `tools/eslint-plugin-sortiva/index.js` gained two lines.
  `pnpm-lock.yaml` changed — `packages/ui` now depends on React. **That lockfile is
  the merge hazard for lanes B and C if they added a dependency.**

**Gate on the merged tree, after four cards** (`T9.1`, `T2.1`, `T3.1`, `T3.2`, `T9.2`,
`T-OPS`, `T3.3`, plus tonight's `T8.0`, `T-START`, `T-ANALYTICS`, `T3.4`), each command
run separately on 2026-09-02 at 19:19–19:21, never chained:

| | |
|---|---|
| `pnpm lint` | clean |
| `pnpm lint:prove` | **11** planted violations, all rejected |
| `pnpm typecheck` | 9 packages |
| `pnpm test` | **1465 passing**, 108 files |
| `pnpm contracts:check` | 56 routes; zod and OpenAPI agree |
| `pnpm build` | compiles |
| `pnpm smoke:boot` | `GET / -> 200`, `GET /api/health -> 200`, in 0.7s |
| `pnpm eval` · `pnpm chaos` | pass |
| `pnpm env:check` | `.env` and `.env.example` both declare **37** variables |
| `pnpm db:migrate` on an **empty** database | 41 tables, 3 guard triggers (run after `T8.0`, the only card tonight touching migrations) |

**Every test count reconciles.** 1,362 on `main` at the start of the night → `T8.0` +7
(1,369) → `T-START` +4 (1,373) → `T-ANALYTICS` +31 (1,404) → `T3.4` +61 (1,465). A
discrepancy the previous state file carried is also settled: its header said 1,362 and
its gate table said 1,357; lane B noticed the five-test gap and correctly declined to
chase it. The header was right, the table was five stale.

**One integrator action was needed to keep the gate green and it is worth knowing.**
`T-ANALYTICS` added `NEXT_PUBLIC_POSTHOG_KEY` to `.env.example`. `.env` is per-worktree
and gitignored, so the integrator had to add the key to the main folder's `.env` by hand
before `pnpm env:check` would pass. **Any lane worktree created before tonight has the
36-variable `.env` and will fail `env:check` until the key is added there too.** Lane G's
`.env` was copied at 18:46 and is also short of it.

The migration row was run against a database created for the purpose and dropped
afterwards, never against the dev database. Wave 4 adds no table, so 41 is unchanged;
it replaces an index. Both indexes were read back from the live database to prove the
migration did what it says: `shopify_conns_shop_handle_key` is now conditional on
`invalidated_at IS NULL`, and `domains_domain_normalized_key` is deliberately still
unconditional. Note if you re-check the triggers: counting
`information_schema.triggers` gives **4**, because a trigger that fires on two events
has two rows. There are three — the competitor cap, the write-once idempotency ledger,
and append-only spend events.

**A flake worth knowing about before it wastes someone's night.** The first `pnpm test`
run of this gate reported **all 1369 tests passing and then exited non-zero**, on a
single Postgres error (`57P01`, "terminating connection due to administrator command")
raised out of `packages/jobs/src/runtime/crash.test.ts` during teardown. An immediate
re-run was clean and exited zero. The cause is in `packages/db/src/testing.ts`: a suite
closes by issuing `DROP DATABASE ... WITH (FORCE)`, which deliberately kills any
connection the suite forgot to close — and under the load of four lanes building at
once, that kill surfaced as an unhandled error instead of being swallowed. **It is a
teardown race, not a product failure, and it is not caused by `T8.0`.** If a gate goes
red this way — every test passing, one `57P01`, non-zero exit — re-run before
investigating. Left unactioned; it belongs to whoever next touches the test harness.

Earlier commits on `main`: `b0c1413` removed 1,007 spec references from the code;
`f6775dd` added the spend caps that pause the product before the bill arrives.

## What `T3.2` added, and the two things it left for someone to decide

**`T3.2` landed on 2026-09-02**, merged as `1b3ee0a`, seven commits. The product
can now answer "does this store already have a page about X?" — which it could not
before, and which every later recommendation depends on.

**One row per web address the store publishes, built without visiting a single
page.** Everything comes from lists a merchant could open in their own Shopify
admin: collections, products, static pages, blogs and their posts. Each row records
what kind of page it is, its title, the two fields Google shows in search results,
its headings in order, which of the store's own pages it links to, which product
families it covers, and a **checksum** — a fingerprint of the page's words that
moves the moment a merchant edits them and stays still when nothing changed. That
fingerprint is what stops us re-running paid analysis on hundreds of unchanged
pages every night.

It stays current two ways: a nightly walk through the whole store, a hundred pages
per run, handing a resume marker back to the queue when its budget runs out — a
large store is a twenty-minute read at Shopify's one-request-a-second, and it must
survive being killed halfway. And a reaction to changes the store reports, which
re-reads only what changed. Price and stock changes are dropped: neither can move a
page's words.

**Two decisions it surfaced rather than took.**

1. **The frozen change contract cannot say a blog post was edited.** The card
   assumed it could. The contract has six change kinds and all six are about
   products and collections, so a blog-post edit is picked up by the nightly walk
   within a day instead of within minutes. Bounded and one-directional — staler
   blog data, never wrong data. But **it is worth settling whether that contract
   gains an "article edited" kind before `T2.2` is written**, because adding it
   afterwards means changing a seam two lanes already consume. The lane correctly
   did not touch the frozen contract.
2. **A page the merchant deletes keeps its inventory row.** Deleting the row loses
   the only evidence the address ever existed; marking it gone needs a column no
   card may add outside a schema wave. Harmless today, because nothing reads the
   inventory yet. **It stops being harmless at `T3.5`**, the existing-target check,
   which would otherwise propose improving a page that no longer exists.

**Two things it deliberately left unwired**, each for a good reason. Nothing
schedules the nightly walk: the scheduled task whose description covers it belongs
to the catalog lane, and the function is exported and ready for it to call. And the
change-stream consumer is built but not registered with the worker, because its
producer is `T2.2` and wiring a stand-in into production would be a false green.

## FIXED — the application would not start

**FIXED on 2026-09-02 by `T-BOOT`, and proved rather than asserted.** The
configuration file is now located and read by the first piece of work that needs a
number, not when the module loads. A lint rule rejects the old shape in both
packages that read files off disk, with a planted violation proving the rule bites
(`pnpm lint:prove` is now 10 of 10). And the gate gained `pnpm smoke:boot`, which
starts the built application and asks it for a page — the one check nothing did.

Evidence, from the merged tree:

```
$ pnpm smoke:boot
PASS  GET /            -> 200
PASS  GET /api/health  -> 200
The built application started and served both pages in 0.6s.
```

The lane proved each half by breaking it: restoring the old loader made the smoke
step fail with the original error; corrupting the config file left both pages at 200
and produced one clear error naming the file; deleting the file produced another;
restoring the old code shape produced a lint error. A useful by-product it
journalled: **deferring the read alone was not enough** — a variant that deferred but
still wrote the path in the form the bundler rewrites booted fine and would have
failed at the first threshold read. The path had to stop being written that way too.

**One consequence accepted knowingly:** a missing or malformed config file is now
discovered at the first call needing a threshold rather than at start-up. This
contradicts tech §2 and main §7.10, which say the config is validated at worker
start. Journalled under `2026-09-02 — T-BOOT`; if start-up validation is wanted back
it is a deliberate call in the start-up hook and a founder decision, not a bug.

---

### The original diagnosis, kept for the history

**Every request answers 500, including the landing page and the health check.** This
is true on `main` right now, it predates today's work, and `pnpm build` passes while
it is true.

Two lanes found it independently on 2026-09-02 — `T9.2` and `T-OPS` — each by the
same method: temporarily patching the cause, watching the app boot cleanly, and
reverting. **The integrator then confirmed it a third time by starting the built
app** at commit `894c1dc`:

```
Ready in 214ms
Failed to prepare server TypeError: An error occurred while loading
  instrumentation hook: Invalid URL
  code: 'ERR_INVALID_URL',
  input: 'signals.config.yaml',
  base: '/_next/static/media/index.ab74d0d8.ts'

GET /api/health -> 500
GET /           -> 500
```

**What is happening, in plain terms.** All the product's tunable numbers — the
thresholds that decide when a page counts as decaying, when a position is worth
chasing — live in one configuration file, `signals.config.yaml`, deliberately kept
out of the code so they can be changed without a deploy. The code that loads it
works out where that file sits on disk **from its own module address, at the moment
the module is first loaded** (`packages/rules/src/load.ts`, lines 8-11, both paths
computed at the top level). When the web application is bundled for production, a
module's address is no longer a place on disk, so the calculation produces nonsense
and throws.

It throws during the start-up hook, and Next treats a failed start-up hook as a
failed server, so **nothing** is served. The chain is
`apps/web/instrumentation.ts` -> the `@sortiva/jobs` barrel -> its Search Console
job -> `@sortiva/rules`. Nothing catches it: the build compiles, and all 1,285 tests
pass, because tests run in Node where module addresses really are file paths.

**Why the gate did not catch it.** `pnpm build` proves the code compiles, not that
the server starts. Nothing in the gate starts the built application. That gap is the
reason this survived six cards.

**What has already been tried around it.** `T3.1` hit the same loader from a route
that queued background work, and split the queue call into its own near-empty module
to keep the loader out of that bundle. That was a local dodge, not a fix - the
start-up hook reaches the same loader by a different path. `T1.3` wrote up the
identical problem for the prompt loader some time ago and named the shape of the
fix. **This is the third time the same defect has been worked around rather than
repaired.**

**Three ways to fix it, and they are genuinely different choices.**

1. **Read the configuration through an import the bundler can see**, so the file
   becomes part of the bundle rather than something looked up at runtime. Numbers
   would then change only with a deploy, which contradicts the reason the file
   exists.
2. **Mark `@sortiva/rules` external to the server bundle**, so at runtime it is a
   real file on a real disk again. Keeps deploy-free tuning; costs a build setting
   that has to stay correct and is invisible when it rots.
3. **Move the loader off the start-up path.** The hook only registers jobs; the jobs
   need thresholds when they run, not when they are registered. Loading on first use
   rather than on import keeps both properties and is the smallest change, but it is
   a discipline nothing enforces, so a future import in the wrong place brings this
   straight back.

**RESOLVED as of 17:30 on 2026-09-02.** The founder chose the third option — load on
first use — **together with a lint rule**, because the weakness of that option is
that it is only a discipline, and a discipline nothing enforces is how this defect
returns. It is carded as `T-BOOT` in build plan §6 and journalled in full in
`DECISIONS.md` (`2026-09-02 — T-BOOT`), including the two rejected alternatives and
why each was rejected, so nobody re-opens it from memory.

**Lane C is building it alone, and lanes B and F are idle on purpose.** The card
edits the shared lint configuration, the proof registry, the root `package.json` and
the CI workflow — the exact files the `T3.3` session declined to touch while other
lanes were building, for exactly this reason. Two idle lanes for one small card is
cheaper than three-way conflicts in the files that enforce every other rule.

**One more thing the gate should gain either way:** a check that starts the built
application and asks it for one page. Every command in the gate passed while the
product served nothing but errors.

## BLOCKER — the deployed start command would not find the build

**Found by `T-BOOT`, deliberately not fixed by it, and confirmed by the integrator
reading `railway.toml` line 37.** The start command runs the server from the
repository root:

```
startCommand = "NEXT_MANUAL_SIG_HANDLE=1 node --max-old-space-size=384 \
                apps/web/node_modules/next/dist/bin/next start -p $PORT"
```

`next start` looks for the build output in its working directory. The build output
is in `apps/web/.next`. Run exactly as written from the repository root, the server
exits with *"Could not find a production build in the '.next' directory"*.

**`pnpm smoke:boot` does not catch this**, because it starts from the application
directory — which is the right thing for a local smoke check and the wrong thing for
proving the deploy. So the gate is green and the deploy would still fail.

Two fixes, both one line: pass the application directory to `next start`, or set the
service's working directory. Which is right depends on what working directory the
platform actually gives the service, and the project has never been deployed, so
nobody knows. **It is not in any card's scope.** It should be settled with the other
deployment questions — the platform's config format is also deprecated and the
project's old service was deleted.

## What `T3.3` added — the arithmetic every search signal reads

**`T3.3` landed on 2026-09-02**, six commits. Nothing here is visible to a merchant;
each piece is something a later signal reads.

**A cluster is one search intent.** A store is not shown for "waterproof hiking
boots" — it is shown for that, and "hiking boots waterproof", and "best waterproof
hiking boots", each with a handful of impressions. One spelling at a time, none is
worth acting on, and two of the store's own pages splitting the same intent is
invisible. Pooled, both become obvious. The row keeps the head search and every
phrasing folded into it, which is the **lineage** an article written from it points
back at a year later.

**A curve is how often this store's listings actually get clicked at each Google
position.** It answers "this page ranks well — is it getting the clicks it should?".
Comparing against a published industry table would be close to meaningless for one
store: the rate at any position swings with the device mix, with how much traffic is
people typing the brand name, and with whatever else Google puts on the page. So the
comparison is against the store itself. Searches for the store's own name are left
out — someone searching the brand was going to click whatever the listing said, and
leaving them in flatters the curve until every ordinary page looks under-clicked
beside it.

**A share is how much of one intent a single page holds.** One page holding almost
all of an intent while sitting just off the first page is worth improving. Two pages
each holding a large slice of the *same* intent is the store competing with itself,
with Google splitting its confidence between two of the merchant's own URLs so
neither wins.

**Thirteen numbers went into `packages/rules`, and one deserves the founder's eye:**
the twenty-row fallback click-rate table. It is what every store with too little
history of its own is judged against, so its shape decides how often the
low-click signal fires for a new store.

**Two decisions in it worth knowing.** What makes two searches the same intent is
word containment — chosen because it fails in the safe direction: it can leave a
variant on its own, but it cannot merge two unrelated searches and have us tell a
merchant to consolidate pages that should stay apart. And the related-search
expansion comes from the store's own search history rather than the SEO vendor,
because the frozen vendor interface has no related-keywords call and widening a
frozen seam is not a feature card's to do.

**Two gaps it recorded rather than hid.** The filler-word list used for pooling is
English only, so a Danish or Hungarian store's searches pool slightly less tightly —
it costs recall, never correctness, and it is the same shape as the banned-language
gap `content-pointers.md` §6 records. And it did **not** take the open audit finding
that the threshold rule can be defeated by naming a constant instead of writing the
literal, though it touched `packages/rules`: that is a change to the shared lint
plugin, and two other lanes were building at the time.

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

## `T8.0` LANDED — what schema wave 4 changed, and the two things it refused

**Merged into `main` as `6400b62` on 2026-09-02 at 19:06, two commits, full gate green
(see the gate table below).** Schema wave 4 is closed. `T8.1` and `T8.2` may not add a
migration; if either needs a column it writes a `DECISIONS.md` entry and negotiates a
mini-wave with the integrator.

### What it changed — one thing, and it is user-visible

**Losing a Shopify connection now frees the store instead of holding it forever.**

Before this, the store's handle — its `shop.myshopify.com` name — was unique across
every connection row that had ever existed. So when a merchant uninstalled the app, or
deleted their account and came back later under a new one, the abandoned row still
owned that store and nothing in the product could clear it. The next attempt to connect
that same store, by them or by anyone, died on a database constraint the merchant could
do nothing about. Uniqueness now applies to *live* connections only: two live
connections to one store are still impossible, a dead one stops holding the store, and
its row is kept as evidence rather than deleted. Whoever reconnects still has to pass
Shopify's own install, so a store is never handed to someone the merchant did not let in.

**One consequence the lane found and fixed in the same commit.** Two rows may now carry
the same store handle — one dead, one live — so the lookup answering "whose store is
this?" for an incoming Shopify webhook is no longer single on its own. It now asks for
the live row. Left alone it could have routed an uninstall to the abandoned account and
silently done nothing to the one that actually has the store. **Anything new that
queries by store handle must ask for the live row too.** The integrator verified before
merging that `findAccountByShopHandle` is the only lookup by handle in the tree — every
other read reaches the connection through the account — and that the save path conflicts
on the account, not the handle, so the narrowed index does not disturb it.

Files: `packages/db/migrations/0007_wave4.sql`, `packages/db/src/schema/domains.ts`,
`packages/db/src/repositories/connections.ts`, new test
`packages/db/src/constraints-wave4.test.ts`.

### The collected list was wrong about one item, and the lane was right to refuse it

**This correction matters more than the migration.** The integrator's collected brief
(and the `T1.4` journal entry it came from, and `docs/nightly-plan.md`) called a partial
unique index on `domains.release_after` "defence in depth", and said it would deliver
the seven-day release the spec promises. **It would deliver the opposite, and the lane
stopped rather than build it.**

A conditional unique index permits strictly *more* rows than an unconditional one — it
is a deliberate relaxation, never an extra guard. The domain row carries a "may be
released after" date, set when an account is deleted. Making uniqueness conditional on
that date being empty frees the domain **the instant the date is set**, which is at
deletion — whereas the spec sets that date precisely to hold the domain for seven days
first, so a squatter cannot take it the same hour. Postgres cannot put a deadline inside
an index condition, so there is no version of this index that both survives the release
sweep never running and keeps the grace window.

Three further reasons it was refused, each independent: delivering both would mean the
claim path starts reading a deadline it deliberately ignores today, in **another lane's
directory**, pinned by a test asserting the opposite; two rows could then exist for one
domain, so every lookup by domain would need to disambiguate; and unlike a Shopify
store, claiming a domain has no external gate — anyone can type it, so the grace window
is the only thing between a deleted account and a squatter.

**Deferred, not declined.** It is now a founder question — see "Questions waiting on the
founder" below.

### It also stopped on the inventory deletion marker, as instructed

The one item in the wave with a card waiting on it. Stopped because the shape is an
interface `T3.5` consumes. Also now a founder question below. **Nothing in lane G is
blocked by it** — `T8.1` and `T8.2` do not read the inventory.

### What the wave closed without building

Re-checked against the migrations rather than the journal, and recorded in the lane's
fourth `DECISIONS.md` entry:

- **Already built:** `verification_tokens` and the durable completed-work ledger
  (`idempotency_ledger`, both in migration `0004`). **`docs/audits/remediation.md` lines
  103–109 and `docs/nightly-plan.md` are both still stale on the ledger**, calling it
  undecided. Neither was edited — that is a spec-keeper's correction, not a lane's.
- **Every table `T8.1` and `T8.2` need already exists**: `notifications`, `email_sends`,
  `email_suppressions`, `notification_prefs`. Verified in the migration files.
- **Declined earlier on substantive grounds:** `spend_events.price_unknown` (the check
  that would make such a row possible still runs at module load, verified at
  `packages/providers/src/seo/pricing.ts:103`), and `idempotency_ledger.account_id` (an
  account column would hand a future data-deletion path a way to erase the record of
  paid work account by account, which is what that table exists to prevent).
- **"Retention bookkeeping"** in the card's scope line has no column behind it. Tech
  §1.7's pruning rules — notifications at 90 days, `email_sends` at 12 months — are
  sweep behaviour belonging to `T8.3`, and both tables already carry the timestamp a
  sweep reads.

### Card-text correction, confirmed

`T8.0` says to read "`DECISIONS.md` (class-b entries tagged `schema`)". **No such
tagging exists** — the `Class (filled by audit):` line is present and empty almost
everywhere. The card should point at an integrator-collected list instead. Unactioned;
it is a build-plan edit, not a lane's.

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

## Questions waiting on the founder

**Four are open. None blocks a lane tonight; each blocks something specific later.**
Questions 1 and 2 came from `T8.0` this evening. Questions 3 and 4 are the two the run
inherited. The question that used to be here about *what starts a merchant's
onboarding* is **answered and built** — `T-START`.

**1. When a merchant deletes a page from their store, how should we record that it is
gone?** The product keeps one row per web address the store publishes — its inventory.
When a merchant deletes a page, the row stays and nothing says the page is gone.
`T3.2` chose that deliberately: deleting the row destroys the only evidence the address
ever existed, and marking it needed a column no card outside a schema wave may add.
`T8.0` was the schema wave, and it stopped rather than choose the shape, because
whatever shape is chosen is read by card `T3.5`.

Two shapes. **A single date field** meaning "this is when the page disappeared" —
smallest change, and empty means the page is live. **A status field** naming which
condition the row is in — live, gone, or something added later such as "moved" or "we
cannot reach it". The date is simpler now; the status field costs nothing extra today
and avoids a second migration if a third condition ever appears.

*What is blocked:* `T3.5`, the check that stops the product proposing a new page for
something an existing page already covers. Without this it would recommend improving a
page that no longer exists. Lane G is **not** blocked — `T8.1` and `T8.2` never read
the inventory. Schema wave 4 is closed, so building it means a mini-wave.

**2. When an account is deleted, should its domain be claimable by someone else
immediately, or should the seven-day hold stay?** The spec holds a deleted account's
domain for seven days before anyone else can claim it, so a squatter cannot take it the
same hour. Today that hold is delivered by a cleanup job deleting the row when the week
is up — which means if that job never runs, the domain stays blocked forever. Safe
(nobody is handed someone else's domain) but not what was promised.

An earlier journal entry recommended a database rule to fix it and called it "defence
in depth". **`T8.0` checked and it is the reverse.** The proposed rule would free the
domain the *instant* the account is deleted — a zero-day release, not a seven-day one —
because the deadline cannot live inside the rule. So the choice is genuinely between
the two behaviours, and the recommendation as written should be struck either way.

If you want both — hold for seven days, then release even if the cleanup job never runs
— that is a small change to the claim path in another lane's territory and should be
its own card, not an index.

*What is blocked:* nothing today. It matters the first time an account is deleted.

**3. Should the recurring job schedule be switched on?** The worker refuses to run
*any* recurring job until *every* one of the fourteen has a handler, and ten still do
not — so **none of them runs**. Two of the dormant ones are finished, tested and
merged: the nightly billing repair, and **the spend caps that pause the product before
a runaway bill arrives**. Relaxing the rule to "run the ones that have handlers" is one
line.

This used to be bundled with "what starts a merchant's onboarding". That is now
answered and built (`T-START`, which has the claim queue its own first step), so this
stands alone as its own question.

*Why it is worth answering during the run rather than after it:* `T2.2` is the first
card that spends real money at scale, and it is the next card in lane B. The spend caps
are among the jobs that do not currently run.

The integrator's recommendation if you switch it on: run the entries that have handlers
and log loudly at every start-up naming the ones that do not, so a job that is not
running says so rather than being silently absent.

**4. The deployed start command would not find the build.** `railway.toml` runs the
server from the repository root while the build output is in `apps/web`, so the server
would exit with "Could not find a production build". Two one-line fixes; which is right
depends on what working directory the platform gives the service, and the project has
never been deployed, so nobody knows. **This stops a deployment, not a build**, and
`pnpm smoke:boot` cannot catch it because it starts from the application directory. It
is in no card's scope and should be settled with the other deployment questions — the
platform's config format is also deprecated and the project's old service was deleted.
Full detail is in the "BLOCKER — the deployed start command" section above.

## A lane broke the one-card rule, and it cost something

**Lane F did not stop after `T9.1`.** Its brief said "do not start another card"
and the build plan says one card per session; it reported `T9.1` finished and then
went on to write a commit of copy plus nine uncommitted component files for
`T9.2` — unplanned, ungated, and with nothing journalled.

Nothing was lost and nothing reached `main`: it all sat on the lane's own branch.
The cost is that the `T9.2` session now has to audit somebody else's unverified
draft before it can write its own, and has been told exactly that — read every line
against the card, keep what is right, replace what is not, and say which was which.

Worth knowing because the same instruction was given to all three lanes and only
one ignored it. If it happens again, the fix is probably to end each session at the
commit rather than trusting the sentence.

## Loose ends the three landed cards left

Small, real, and each belongs to a named next card rather than to a sweep.

- **Two lanes parked user-facing copy outside the string catalogue** because
  `packages/ui/strings` did not exist when they started: billing's wording sits in
  `packages/core/src/billing/copy.ts`, Search Console's in
  `packages/core/src/search/copy.ts`. `T9.1` created the catalogue and left a test
  that fails if billing's two homes ever disagree. Moving both is mechanical.
- **A build failure the tests cannot catch.** A route that queues background work
  pulled in the threshold config's file loader, which reads a YAML file off disk —
  in a bundle that has no disk. `pnpm build` failed while every test passed. Fixed
  in `T3.1` by splitting the queue call into its own near-empty module. **Any lane
  whose route enqueues background work will hit this**, so it is worth knowing
  before it is diagnosed a second time.
- **`pnpm test` and `pnpm lint:prove` must not run at the same time.** The proof
  script plants and deletes a file that a billing test reads off a `git ls-files`
  listing, so the test crashes on a file that vanished underneath it. Harmless
  when the gate is run one command at a time, as the rules already require — but a
  real trap for any CI that parallelises the two.
- **A long-dead Search Console connection never starts counting as limited.** A
  store whose permission died months ago goes on reasoning from ageing data with
  nothing saying so. Bounding it needs a staleness horizon nobody has specified;
  it belongs with the detection cards that would read it.
- **The Search Console callback is not in the frozen API table**, deliberately —
  it is Google's browser redirect answering with a 302, never called by our own
  code, the same exception `/api/auth/*` already has. A five-line addition if the
  integrator wants it listed.
- **Resolved without anyone needing to decide it:** `T3.1` had to guess where a
  merchant lands after connecting and chose `/settings/connections`; `T9.1`
  independently pointed three separate places at the same path. They agree.

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

## The learning loop is out of v1

**Founder decision, 2026-09-02: `M7` does not ship in the first deployment.** Both
its cards (`T7.1`, `T7.2`) stay in the plan and stay unbuilt, and the build plan is
marked accordingly. Nothing depends on them — the milestone-10 exit gates do not
read outcomes — so deferring costs no other card.

**What the product gives up until they are built:** it never learns from what it
published. Every article is written from evidence, none from what worked last time.
No verdict is ever attached to a published piece, and no pattern is ever drawn from
the store's own results. The product still works; it simply does not improve itself.

## Lanes stopped, and the question that stopped them

**None.** All three are building; see the table at the top.

Lane B was held from 08:00 to 16:40 on a question that, on checking, its next card
did not actually depend on. Recorded because the mistake is worth not repeating:
the hold was taken from a caveat in `docs/handoff-wave2.md` rather than from
reading what the card needed. **A hold should be justified against the card, not
against a remembered sentence about it.**

The two founder questions remain open either way — see "Questions waiting on the
founder" above. Neither now blocks a lane.

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
  outstanding rather than claimed. **Two more joined that list today**: the Shopify handshake in `T2.1` was proved against a local server standing in for Shopify, and the Search Console flow in `T3.1` against a stand-in that pages the way Google does. Five cards now need re-running against real keys.
- **Email sign-in is unfinished and unowned.** It shipped Google-only because no
  table existed for a magic link's single-use token. That table exists now. No card
  owns finishing it.
