# Overnight state

Rewritten after **every** card lands or stops, and re-read before any card is
launched and before any merge. Its test: a completely fresh session, with none of
the conversation that produced it, could take over from this file alone.

**Last rewritten:** 2026-09-02, 07:10, by the integrator session. `T9.1` landed
and merged; the full gate is green on the merged tree. Lane F has moved to `T9.2`.
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
| B — Store Intelligence | — | `lane-b` | `../sortiva-lane-b` | **held**; `T2.1` merged |
| C — Search Intelligence | — | `lane-c` | `../sortiva-lane-c` | free; `T3.1` merged |
| F — Frontend | `T9.2` | `lane-f` | `../sortiva-lane-f` | building; `T9.1` merged |

**Lane B is deliberately held rather than moved to its next card.** `T2.1` is
finished and merged, but the card it raised a question about — how a merchant's
onboarding gets started at all — is the same question the operations card next in
that lane depends on. `docs/overnight-run.md` says a lane that stops for a decision
stays stopped until the founder answers. Starting the operations card first would
build the diagnosis script and the replay action into machinery that cannot run.

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

**Gate on the merged tree** (`T9.1` + `T2.1` + `T3.1`, commit `521679e`), each command run separately on 2026-09-02:

| | |
|---|---|
| `pnpm lint` | clean |
| `pnpm lint:prove` | **9** planted violations, all rejected (was 7; two are new) |
| `pnpm typecheck` | 9 packages |
| `pnpm test` | **1177 passing**, 80 files (was 914 at wave 2 start) |
| `pnpm contracts:check` | 56 routes; zod and OpenAPI agree |
| `pnpm build` | compiles; the gallery page and both Shopify routes present |
| `pnpm eval` · `pnpm chaos` | pass |
| `pnpm env:check` | `.env` and `.env.example` both declare 36 variables |
| `pnpm db:migrate` on an **empty** database | 41 tables, 3 guard triggers |

The migration row was re-run against a database created for the purpose and
dropped afterwards, not against the dev database. `T9.1` added no migrations, so
the numbers are unchanged from wave 1. Note if you re-check it: counting
`information_schema.triggers` gives **4**, because a trigger that fires on two
events has two rows. There are three triggers — the competitor cap, the
write-once idempotency ledger, and append-only spend events.

Earlier commits on `main`: `b0c1413` removed 1,007 spec references from the code;
`f6775dd` added the spend caps that pause the product before the bill arrives.

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

## Questions waiting on the founder

Neither blocks a lane today; both block something specific later.

**1. Nothing starts a merchant's onboarding, and there are two ways to fix it.**
Claiming a domain writes down the nine steps of work to be done and pushes nothing
onto the job queue — deliberately, because until `T2.1` no code existed that could
run step one. That code exists now. What is missing is the thing that pokes it.

- **(a) Switch the scheduled jobs on.** The worker refuses to run *any* recurring
  job until *every* one of the fourteen has a handler, and eleven still do not, so
  none run. Relaxing that to "run the ones that have handlers" is one line — and it
  also switches on two other finished, tested, currently dormant machines: the
  nightly billing repair, and the spend caps that pause the product before a runaway
  bill. Wider blast radius: three things start moving, not one.
- **(b) Have the domain claim push the job itself** the instant it commits. One
  line, no schedule involved, nothing else changes — but that line lives in Lane A's
  claim code, a directory `T2.1` does not own.

A merchant who *does* connect their store moves forward fine; the connect flow
resumes onboarding itself. It is only the very first step, detection immediately
after the claim, that has nothing to trigger it.

The integrator's recommendation, if (a) is chosen: run the entries that have
handlers and log loudly at every start-up for the ones that do not, so a job that
is not running says so. **Lane B is held until this is answered.**

**2. How does a browser send an analytics event?** Raised by `T9.1`, which found the
specs contradicting each other: the main spec says everything observable is emitted
server-side, and the UI spec requires seven events no server call can see — an
opportunity card being read, a veto clicked, a calendar drag. Two ways, and each
forecloses the other: the browser talks to the analytics vendor directly (needs a
browser SDK, a public key in the page, and session replay deliberately off on every
view showing store data), or the browser posts to an endpoint of ours which captures
server-side (needs a route that is not in the frozen API contract). `T9.1` built
neither and shipped the seam instead — one interface, a do-nothing default, a
recording double for tests — so every screen card is unblocked and binding a
transport later touches one file. **No screen's analytics is real until this is
answered.**

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
  outstanding rather than claimed. **Two more joined that list today**: the Shopify handshake in `T2.1` was proved against a local server standing in for Shopify, and the Search Console flow in `T3.1` against a stand-in that pages the way Google does. Five cards now need re-running against real keys.
- **Email sign-in is unfinished and unowned.** It shipped Google-only because no
  table existed for a magic link's single-use token. That table exists now. No card
  owns finishing it.
