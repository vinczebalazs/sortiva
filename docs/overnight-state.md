# Overnight state

Rewritten after **every** card lands or stops, and re-read before any card is
launched and before any merge. Its test: a completely fresh session, with none of
the conversation that produced it, could take over from this file alone.

**Last rewritten:** 2026-09-03, 12:05, by the integrator session running this run,
after the `T3.5` audit landed (read-only, findings recorded, nothing merged). `main`
is still at `e698033`, unchanged since this run started — three build sessions
(`T2.7`, `T9.7`, `T4.0`) are still running. **Everything from here down to "Picking
this up again" is the previous run's report and is kept as history; read "Right now"
first for what has actually changed since.**

---

## The run stopped on a rate limit at 20:25, and RESUMED at 21:59

**What happened.** At about 20:25 on 2026-09-02 both then-running lane sessions died at the
same instant with "You've hit your session limit · resets 9:50pm (Europe/Budapest)". An
account-level limit on the model — not a fault in the work, and not the machine sleeping.
The integrator's own commands kept working throughout, so `main` was never at risk.

**What the integrator did during the stop:** checked both worktrees before touching
anything, recorded exactly what was in each, confirmed `main` was clean and green, wrote
this file up as a complete handoff, and waited. **It did not commit lane F's uncommitted
work, did not merge lane G's incomplete card, and did not relaunch anything early.**

**Resumed at 21:59**, once the window reopened. The sleep hold was extended at the same
time (a fresh `caffeinate -dimsu -t 21600`; the earlier one would have lapsed around
00:46).

### The one lesson worth keeping from it

**Two lanes hit the identical crash and came out in completely different shape, and the
only difference was whether they had been committing in halves.**

- **Lane G had committed five times. Its worktree was clean and nothing was lost.** It
  resumed from its own commits, needing only to finish the composition-root wiring and the
  route tests.
- **Lane F had committed nothing.** Its work survived only as uncommitted changes — a
  modified copy file and four new untracked files — and **it did not compile**, having been
  stopped part-way through fixing type errors. Its successor had to audit an unverified
  draft before it could build, which is exactly the cost the `T9.2` session paid earlier
  today for the same reason.

**The instruction to commit in halves is not hygiene. It is the difference between
resuming and re-auditing.** Every lane brief should keep saying so, with this night as the
evidence.

### What was relaunched at 21:59

| Lane | Card | Resumed how |
|---|---|---|
| B | `T2.3` — product distillation | **Fresh card.** Its predecessor `T2.2` is merged, green, and audited; the audit explicitly answered that nothing blocks `T2.3`. Told the two things the audit said it must be told rather than discover: the checksum covers words but not price or stock, and **metafields are not being fetched**, which caps the fact-sheet richness this card is graded on |
| F | `T9.4` — the opportunities list | **Taking over an unverified draft**, with instructions to audit all five inherited files against the card first, keep what is right, replace what is not, and say which was which. `why.ts` flagged for particular attention against invariant 8 (every user-facing "why" renders from templates, never from a language model) |
| G | `T8.2` — the email pipeline | **Resuming its own five commits**, told to treat them as plausible but unverified since no gate has been run on them, and that it now owns the whole card rather than the remainder |

**Lane C stays held** — `T3.5` needs `T2.4`–`T2.5`, and lane B stopped at `T2.2` as planned.

### For the record, what each killed lane actually had on disk at the stop

**Lane G — five commits, worktree clean.** Listed above. Its own last words on what
remained: "Now the wiring in the composition root, and the route tests." No gate had been
run on any of it and none of the card's done-when checks had been run, so its successor
was told to treat the five commits as plausible but unverified and to own the whole card.

**Lane F — nothing committed.** Its work existed only as uncommitted changes: a modified
`packages/ui/strings/en.json` (490 keys against `main`'s 331, so roughly 159 lines of new
copy, and it still parsed), and an untracked `packages/ui/src/opportunities/` holding
`OpportunityCard.tsx`, `list.ts`, `types.ts` and `why.ts`. Its last words were "Now fixing
the remaining type errors in `list.ts`" — **so it did not compile.**

**The integrator deliberately did not commit lane F's work.** Committing another session's
half-finished code is what caused the damage of 2026-09-01, and a commit would also have
made an unverified draft look like progress. It stayed in the worktree, which is where a
killed session's work is supposed to sit, and its successor was told to audit it file by
file before trusting any of it.

## `T8.2` LANDED — Sortiva sends email, and decides which events deserve one

**Merged as `0bf5897` into `main`, seven commits across two sessions, full gate green.**
Tests **1,829**. This card was killed by the rate limit and resumed; the story of that is
below and matters more than the feature.

**One event, up to two places.** When any lane records something worth telling a merchant,
it calls one function. That writes the bell entry it always wrote, and now also decides
whether the same event becomes an email. **Three separate things can stop it and they mean
different things**: the *kind* of event never emails; the *merchant* switched that kind
off; or the *address* bounced. The last still writes a row marked "stopped", so "why did I
never get that" has an answer. **No lane has to know whether its own event is emailed.**

**Sending is two halves.** A sweep every minute turns each queued email into its own job;
the job sends one, under that account's lock. **Per row rather than per batch, so one
address the vendor keeps rejecting cannot hold up everyone else's mail**, and a send that
runs out of attempts dead-letters alone. Three layers stop a duplicate: the row is only
sent while it still says queued, the mark-as-sent is a guarded update, and the vendor is
handed our own `(account, type, dedupe key)` triple as its idempotency key.

**What an email says is looked up when it is sent**, never read from the stored row, which
holds identifiers only. An article deleted in between produces "a draft is ready for your
review" rather than the name of something that no longer exists.

**Scheduled mail runs hourly, not on its nominal schedule** — the monthly summary must land
at 08:00 in the store's own morning and a crontab is server time, so each hourly run asks
per account whether it is locally the first at eight. The 24-hour and 7-day reminders sweep
the same way. All three are safe to run repeatedly because the dedupe key is derived from
the event.

**Two hard rules held by tests.** The monthly summary states no count against a total — no
slash, no "of", no target vocabulary — and **the check runs against the copy with
placeholders still unfilled**, so it judges our sentences rather than a merchant's article
title. And the canonical sentences are reproduced character for character from the
catalogue.

### The resumed session audited the inherited half and found six faults

**This is the most valuable thing in the card.** The first session was killed before running
a single check, so its five commits had never been verified by anything. The second
session's first act was to read them against the card. All six are fixed:

1. **A failure to queue an email could roll back the thing the email was about.** The
   fan-out caught its own errors, reasoning that losing mail beats losing the state change
   — but **in Postgres any failed statement aborts the whole transaction**, so the catch
   left the caller's transaction poisoned and the gate decision or publish rolled back:
   the exact outcome the catch existed to prevent. **Now wrapped in a savepoint**, proved
   by a trigger that refuses every email insert — without it the transaction dies, with it
   the bell rings and only the mail is lost. The integrator read this fix before merging.
2. **Two declared gaps were invisible in the stub report that exists to declare them**,
   because that script only names stubs whose module it imports. 7 → 9 on the branch.
3. A type hole letting a caller assemble an email with a different database handle than the
   one settling the row.
4. The unsubscribe route held its own handler, which the route-import rule forbids.
5. The vendor receiver held a raw database handle, banned outside `packages/db`. Fixed with
   a new port rather than a lint exemption.
6. The wordmark was typed into a template instead of the string catalogue.

### The ruling on where email copy lives

**In `packages/ui/strings/en.json`, like every other word a merchant reads.** Three reasons,
journalled: a copy fix reaches mail queued *before* the fix, because the lookup happens at
send time; a canonical sentence is held character-for-character in one place; and the
denominator rule can be checked against catalogue entries with placeholders unfilled, which
is the only form that does not fail on a topic called "A History of Wool".

**Consequence for another lane:** `T-EMAIL`'s sign-in copy, parked beside the auth code
explicitly pending this ruling, now belongs under `email.signIn.*` in the catalogue.
**The lane correctly did not move it — those are lane C's files.** This is a small
follow-up nobody owns yet.

### Two things it surfaced for the founder rather than the audit

- **A merchant who unsubscribes from the monthly summary silently loses the per-article
  digest too.** There is only one preference column and no third to add without a schema
  wave. **The fix is one boolean.** It is a silent, user-visible loss.
- **`T8.3` cannot send a deletion-confirmation email at all.** The suppression bypass that
  lets such mail through to a suppressed address is built and tested, but the type column
  is the notification-type enum and **has no value for it**.

### What the following audit should look at hardest

The lane's own list, which the integrator endorses: whether **any other lane's emission
point does the same swallow-inside-a-transaction without a savepoint**; that a missing
configuration variable produces a **misleading error** — the monthly summary held for want
of an unsubscribe link records the same last-error as "the article was deleted"; the single
preference column above; that **`webhook_events` now has a third producer**, so `T8.3`'s
retention sweep must prune by arrival time and shape rather than assuming one producer; one
copy key outside the denominator check because it is chrome; and that two notification kinds
**only ever exercise their generic wording in production**, because article titles resolve
to nothing until schema wave 3.

**Files outside Lane G's directories:** `apps/web/instrumentation.ts` and
`packages/jobs/src/runtime/crontab.ts` (both integrator-resolved ordered files — the
integrator confirmed the merge kept every registration), `packages/ui/strings/en.json` (92
lines, one contiguous hunk at the end — **this produced the night's second hand-resolved
conflict**), the stub report, core's banned-import list, three union-merged barrels, and
`packages/providers` plus `packages/jobs` gaining React and JSX for the mail templates.
**The lockfile changed.** No migration.

**Real-vendor evidence outstanding:** no Resend credentials and **nothing has ever been
sent**. Unproven end to end: a genuine send and its returned message id, a genuine signed
webhook delivery, **and SPF/DKIM/DMARC on a dedicated sending subdomain, which tech §1.4
requires before the first production send.** React Email's markup has never met a real mail
client.

## `T9.4` LANDED — every opportunity a scan finds is now a card a merchant can judge

**Merged as `930a5b2` into `main`, two commits, full gate green.** Tests **1,909**.

### The inherited draft, and a correction worth recording

This card took over the uncommitted, unverified draft its rate-limited predecessor left.
**The predecessor's last words — "fixing the remaining type errors in `list.ts`" — were
stale: the four files did compile.** What they had never done was run a test or a lint
gate, and one of those found a real defect.

| Inherited file | Verdict |
|---|---|
| `types.ts` | **Kept unchanged**, after being audited field by field against the frozen response schemas. It matches exactly. |
| `why.ts` | **Kept unchanged**, audited specifically against invariant 8 — and it complies. It takes the template key the engine stamps on the row plus a bag of numbers, looks the sentence up in the catalogue, and fills the placeholders. **No model output can reach it: the API sends a key, never a sentence.** Its one clever move is right — the canonical existing-page sentence is *aliased* to its Appendix A key rather than copied, so the snapshot that pins that sentence still guards it. |
| `list.ts` | **Kept with three fixes.** Sorting by confidence compared only the band, so a store where everything scored "high" would not reorder at all. |
| `OpportunityCard.tsx` | **Kept with three fixes**, including a hardcoded number where copy should be parameterised, and confidence direction conveyed by colour alone — now announced too. |
| the copy file | **Mostly kept; two sentences reworded.** **The real find:** the repo has a test forbidding any string matching "x of y", because the daily cap is a ceiling and not a target — and **two of the draft's sentences tripped it.** Neither was a denominator in meaning, but both matched. `pnpm test` was red the first time it ran against the draft. |

**Everything else the card asks for did not exist** — the list screen, the drawer,
dismiss with undo, the conflict path, the wiring, every test, the screen contract and the
stylesheet.

**The lesson for the next handover:** a killed session's *description* of where it got to
is the least reliable thing it leaves behind. The files were further along than it said,
and less verified than they looked.

### What it does

Every opportunity renders as a card a merchant can judge without opening anything: what to
do, how big, how sure we are and the arithmetic behind that, two or three numbers with
where they came from and over what period, one sentence of reasoning, and one button whose
words change per action type. Around them: five sets of filter chips, three sort orders, a
group-by toggle that always draws the five sections in the same order, and **empty states
that distinguish "the scan found nothing" from "you filtered everything out"**.

Opening one shows the case in the order that decides whether the product is believed:
**evidence first** — every fact with source, window and age — then who else ranks, then
what to change. That last part differs per type: page copy to paste with a copy button per
field and downloads; a deterministic instruction list that **says outright we will not
touch the theme**; or, for HOLD, the facts only the merchant can supply.

**Dismissing offers the card back for five seconds.** Any request can come back with a
conflict — the weekly scan re-scores things under a merchant who has the page open — which
ends in the list being re-read plus a sentence, **worded differently for "re-scored" and
"already moved on"**.

### One thing that needs the founder, and it is small but real

**The header can say Tuesday while the empty state promises Monday.** The card's own
done-when pins the empty-state sentence word for word — *"the next scan runs Monday"* — but
the API sends an actual next-scan timestamp, and the lane used it in the header rather than
hardcoding a weekday, because a store whose scan lands elsewhere would otherwise be told
something untrue every week.

**If scans will never move off Monday, this is harmless.** If they can, the empty-state
wording needs changing — and it is quoted copy, so the lane correctly did not feel free to
change it. **This is founder question 6.**

### Five things the backend must get right, registered in the screen contract

1. **`why.templateKey` must be a key the catalogue holds.** The reason sentence is rendered
   from the catalogue, never sent as text; an unknown key replaces the product's
   explanation with an apology. The existing-page case must stamp the specific key that is
   aliased to the canonical sentence.
2. **Every evidence fact needs its source, and its window where the measurement has one** —
   a fact with neither reads as a number from nowhere.
3. **The entity label must be the humanised name**, not a URL or an id — it is the card's
   title and the only thing a merchant recognises at a glance.
4. **A failed recommendation must arrive with no fields at all**; the screen shows no
   partial output.
5. **The schedule response's date is what the toast names** — one topic per day means the
   day asked for and the day given can differ.

**Two gaps the response cannot fill today**, both recorded rather than faked: HOLD has no
per-product deep links because nothing in the response carries product ids, so it sends the
merchant to Products; and FIX has no impression-share numbers, so it renders an instruction
list rather than the design's picture of competing URLs.

**Files outside Lane F's directories: none.** Copy additions sit as one contiguous block.
**This produced the night's third hand-resolved conflict in the copy file.**

**No audit is scheduled after this card** (build plan §7), and the lane did not request one.

**For `T9.5`:** the calendar's topic chips link back to the originating opportunity, and
the veto flow is specified as also dismissing the opportunity behind it under the same
undo — **reuse the existing dismiss-with-undo mechanism rather than rebuilding it**. The
toast strip is already styled. **Pagination is not built**: the list renders whatever one
response returns.

## `T2.3` LANDED — a product's words become facts, and the marketing dies on the way

**Merged into `main`, five commits.** Tests **1,948**. **Nine of the ten gate commands are
green and `pnpm eval` is red by design — read the section below on what that changes.**

**Onboarding's fourth step now runs.** After a store's catalogue is read, every product
description is turned into a fact sheet — what it is made of, how big it is, what it works
with, what the page actually claims — and the marketing is thrown away. *"Premium quality
Italian leather"* becomes `leather`. *"Perfect for any occasion"* becomes nothing. Each
store also gets a **richness score**: how much its own product pages actually state, which
is the difference between a store we can write honestly about and one we cannot.

**Three things it deliberately refuses:** it never infers — an unsupported field stays
empty, and **empty is an answer**; it never asks the model for a price or variant data we
already hold exactly; and **it never lets the model count its own facts.**

**Onboarding now carries a store from domain claim through detect → connect → catalogue
read → distillation, and stops at family grouping (`T2.4`).**

### The quarantine on raw descriptions, and how a reader checks it

Invariant 3 says the raw product description is never an input to persona, topics, evidence
or recommendations — only distilled fact sheets flow downstream. **This is the card that
makes that true, so it is the card most able to break it.**

The test scans every TypeScript file in `packages` and `apps` **with the TypeScript
scanner, so comments are exempt and only code paths count**, and fails on any file outside
an explicit six-file allowlist that names the raw column. **Proved to bite by mutation:**
adding a stray reference to an unrelated file turned it red, and the file was restored. Two
further cases prove it is not vacuous — the allowed files really do mention it, and the
distillation module itself, which is the one place that *needs* descriptions, never names
the column.

**One decompressor exists**, and its read for distillation returns text with markup
stripped, entities resolved and a length cap — no field a caller could get raw bytes from.

### Caching (invariant 20), proved by simulating the crash it exists for

The wrapper writes the cache row **before** processing the answer. The test distils two
products, **deletes every ledger row** — a crash after the vendor answered but before
anything recorded it — and re-runs. Both products go to the client again, every one of
those calls reports a cache hit, and **the total cost is unchanged.** Production is wired
with the same two components.

### `pnpm eval` is now red without a real key, and that is deliberate

**The card's third done-when is not met and the lane refused to score itself against a
lower bar.** `distillation.eval` exists — 50 cases, 7 languages, graded at F1 ≥ 0.85 with
zero fabricated field values — and its runner builds the **real** client. With no key,
`pnpm eval` fails by name rather than passing against a stand-in, because *"a stand-in
would report a pass that means nothing."*

**This is the standing no-vendor-credentials gap surfacing in a new place, not a new
decision.** The integrator checked `.github/workflows/ci.yml` before merging:

- The eval job is **pull-request only** (`if: github.event_name == 'pull_request'`), so
  **merging does not make CI red on `main`**.
- It is **path-gated** — it runs only when a prompt file, a model id or an eval set changed.
- It takes `ANTHROPIC_API_KEY` **from repository secrets**. The design always assumed a real
  key; the repo simply has none, which is the gap already recorded against eight cards.

**What this changes for the rest of the run: `pnpm eval` can no longer pass locally.** The
integrator's gate is now **nine of ten commands green plus one that is red for a documented
reason**, and every subsequent card inherits that. **A gate report that says "eval passes"
from here on is wrong.**

**The three ways out, none of which the integrator chose:** supply a key; make the eval skip
loudly rather than fail when no key is present; or leave it failing as the honest signal
that the model side has never been tested. **This is founder question 7.**

Everything *around* the model call is proved in `pnpm test` — the set loads, every case has
an expected sheet, the prompt renders and is stamped with its version and model, the schema
contract refuses a bad completion after exactly one repair attempt, the threshold bites, and
one invented material fails its own case while the set's aggregate score stays high.

### Two decisions worth reading, of twelve journalled

- **The model is never asked for a price, a variant axis, or its own fact count** — a
  departure from the spec's literal object shape, flagged rather than hidden.
- **Metafields are still not fetched**, journalled as the integrator instructed after the
  `T2.2` audit raised it. **It caps richness for exactly the best-organised stores** — the
  ones that keep real attributes there.

**No migration.** Two places wanted a column and did without: which checksum a sheet was
made from (the ledger answers it), and the populated-field count (recomputed from the sheet).

### What `T2.4` must know

- Fact sheets are one row per product, stamped with prompt version and model id, with the
  timestamp that becomes `T2.4`'s idempotency key.
- **`variant_axes` is always empty, and family axes are `T2.4`'s subject.** Shopify's
  `options` field — which *names* the axes — **is not requested by the catalogue sync and is
  stored nowhere.** If `T2.4` needs axis names, that field list has to change first. Axis
  *values* can be split positionally out of variant titles; **the names cannot.**
- Products whose page says nothing have a real row with a zero fact count and no model id —
  rows, not absences. That is the sparse-product guardrail's input.
- The richness roll-up is computed, not stored: the only column for it belongs to a row that
  does not exist until `T2.5`.
- **`pnpm chaos` still has no "kill during distillation" scenario** — the plan gives that to
  `T2.7`, and the step is built for it.

**Files outside Lane B's directories:** the prompt file and eval set in `packages/llm`
(allocated to this card by name in that package's own README), the eval runner registry
entry (whose comment names this card), two `packages/db` repository files plus union-merged
barrels, and **`packages/jobs/package.json` with the lockfile** — a dev dependency so the
step's test can drive the wrapper's own double. `apps/web/instrumentation.ts` was **not**
touched.

**Real-vendor evidence outstanding: the whole model side.** The eval has never run against a
real model, the prompt has never been tested against one, no real completion has ever been
schema-validated, and the wrapper's caching, cost figures and retry behaviour are proved only
against its double. Everything else — the ledger, the checkpointing, the quarantine, the
roll-up, the repository writes — ran against real Postgres.

## `T2.4` LANDED — a catalogue stops being a list and becomes a handful of subjects

**Merged as `f1614a1`, three commits.** Tests **1,994**. Onboarding now carries a store from
domain claim through detect → connect → catalogue read → distillation → **family grouping**,
and stops at the business profile (`T2.5`).

**Forty similar shoes cannot support forty shoe articles.** Products are now grouped into
families, and everything after this point reasons about families rather than rows. Four
signals run, cheapest and most trustworthy first: what the merchant filed the product as;
rows that are one product published several times ("Trailblazer — Red" and "— Blue");
products whose facts match except along a few attributes; and, only for a store where none
of that found anything, a guess **flagged as one**. Every family records which signal
produced it and how far to trust it.

**A merchant can now say we got it wrong** — families are read-only in v1, so the report
endpoint is the whole of their recourse. It keeps what they typed in our own record and
sends **ids and counts** to analytics, never their words.

### The axis-name question was better answered than the integrator asked it

The integrator handed this card a flagged blocker: Shopify's `options` field, which names a
product's variant axes, is not fetched and is stored nowhere, and axes are this card's
subject. **The lane found the premise wrong and did not change the field list.**

**`options` names the wrong axes.** It names what *one product's variants* differ along —
"Size", "Colour". The spec asks what a *family's members* differ along — "terrain, drop,
width". Those are different questions over different sets of products, and the spec derives
the second from attribute sets that match except along one or more axes — **that is, from
fact sheets, not from variant metadata**. `T2.3` was right that axis names cannot come from
variant titles; what this card found is that they were never going to come from `options`
either. And there is nowhere to put it: the field-list change would have bought a value we
could not store, to answer a question it does not answer.

**So axis names come from three places we already hold:** a tag the merchant wrote as
`terrain:technical` — their own word for the axis, present today on every synced store with
**no backfill needed**; a fact-sheet field name; and the variant word a split-variant title
carried. **Nothing is inferred.** A store that names no attributes gets fewer axes, which is
true rather than convenient.

**What it costs, and it is real:** a store keeping its attributes in Shopify metafields or
option names yields fewer axes. The family is still correct; it simply says less about what
distinguishes its members. **The lane calls a `products.options` / `products.metafields`
column plus two words of field list the single highest-value schema-wave addition here** —
and it would work only from each store's next full sync, which is another reason it belongs
in a wave rather than a feature card.

### Two decisions it took that depart from the spec, both journalled

- **Collections are not a grouping signal**, though the spec calls them the primary
  candidate — **nothing in this build stores which products are in a collection.** The
  catalogue sync does not fetch them, and the content inventory reads a collection's members
  but keeps their *families*, which would be circular. The product type carries the taxonomy
  signal instead, with the promotional-name blocklist the spec asks for.
- **The messy-store fallback compares title words, not embeddings.** There is no embeddings
  vendor in this build and adding one is a provider decision with a bill attached. Left
  unbuilt, a messy store gets two hundred families of one. Its families record the method
  used **so no reader is misled**, and swapping in a real embedder replaces one function.

### A real bug its own tests caught

The colour word that distinguishes "Trailblazer — Red" from "— Blue" was being counted as
*disagreement* in the very check that decides whether the two rows are one product — **so
the merge rejected exactly the case it exists to recognise.** Found by the split-variant
test and fixed.

**The quarantine guard also fired on the card's own test file**, because seeding a product
through the repository meant naming every field of one. **The lane fixed the test rather
than adding a seventh file to the allowlist** — grouping genuinely never touches a
description, and that is worth keeping provable. The integrator agrees, and it is the right
instinct: an allowlist that grows to accommodate tests stops being a guard.

**A contradiction it surfaced:** the frozen route contract names three grouping sources
where the spec and the database have four. Journalled, not resolved.

**Files outside Lane B's directories:** two `packages/db` files plus union-merged barrels,
one assertion in a shared ingestion test that `T2.3` wrote naming this card, and
`apps/web/app/api/products/**` — **a directory no lane owns in the ownership table**, though
the card's scope names the endpoint and the route is in the frozen contract. Worth the
integrator's eye. `apps/web/instrumentation.ts` was **not** touched.

**No new real-vendor evidence outstanding** — this step makes no network call and pays
nobody, and ran against real Postgres throughout.

**What `T2.5` inherits** is written into its brief: merged fact sheets per family, the
richness column that has had nowhere to be written since `T2.3`, the walk's end marker to
move, the analytics port already bound, and the rule that a family's name is its identity
across runs.

## `T9.5` LANDED — the calendar, the library, and one article

**Merged as `c4b853f`, three commits.** Tests **2,157**. Three screens under Content, the
module where the plan gets executed: a month grid of everything scheduled, the articles
library with its export affordances, and one article shown exactly as it would publish
alongside the judge's report and the decisions left.

### How it makes invariant 14 *visible* rather than merely not violating it

The invariant says at most one topic dequeues per account per day, gaps stay gaps, and
missed days are never back-filled as bursts. A calendar is the one screen that could quietly
contradict that by implying a shortfall. It does not:

- **A day that has passed with nothing on it renders literally nothing** — no marker, no
  ghost, no tally, nothing to click. The cell keeps its height so the month still looks like
  a month.
- **A day still ahead shows a faint `+`** and, on hover, says it will be filled at the next
  replenishment.
- **Today shows neither, and accepts nothing** — the day's job may already have run, and
  offering to fill it is exactly the catch-up the product refuses. **That was a judgement
  call and is journalled.**

Under the legend sits one sentence saying empty days are normal and a quiet day is never
made up for later. **Three tests and a browser flow assert the absence**, including that the
grid contains no "missed" and no "x of y".

### It repaired a harness defect that would have silently broken every future browser flow

**A page rendered on the server has no browser, so it works out where to call itself from
the `Host` header it was asked on.** The fixture site rewrites that header so the app's own
reads land on fixtures — but `Host` is a header the fetch standard **forbids setting**, so
the assignment was being dropped in silence. Every authenticated page rendered as though the
merchant had no data, and the navigation locked itself, **with nothing failing loudly**.

It went unnoticed because the only flows through that server were public pages, which
answered acceptably either way. **Every future Lane F browser flow on an authenticated
screen depended on this being found.**

### Six fixture requirements, and two are subtle enough to be worth restating

- **A performance figure must stay null until the 28 days are up.** Null is what makes a row
  read "too new"; a zero would look like a failure. Same shape for a published address on an
  exported article: null raises "waiting for your URL", and a guess would silence it.
- **The topic's opportunity id must be the opportunity that actually produced it**, because
  vetoing dismisses that opportunity — **a wrong id silently removes work the merchant never
  asked to lose.**
- The quality report **does not say which criteria failed**, so the screen infers it from
  which criteria the judge wrote a justification for. The floors live in `packages/rules` and
  **the screen deliberately never re-derives them**. A `failedCriteria` field would close it
  properly.

### What the whole lane leaves the backend cards

**Everything runs on mocks** — no calendar, article, opportunity or profile endpoint exists.
The screen contract is the specification those cards inherit. Known gaps, all recorded
rather than hidden: **no pagination anywhere** (the cursor is read and ignored, so a store
with hundreds of articles shows one page); **dragging has no keyboard equivalent**, which is
a genuine accessibility gap the popover could close with a date control; "today" is the
server's day rather than the store audience's; a swap is two requests and can half-apply;
and the FIX and HOLD drawers stay generic because the response carries neither per-URL
impression shares nor per-product deep links.

**Files outside Lane F's directories:** the copy file — **209 keys in one contiguous block at
the tail**, taking it to 804 — plus the browser-flow server and Playwright config that this
lane created itself. **Nothing in `packages/core`, `packages/db`, `packages/rules`, the lint
config, the start-up hook, or any migration.**

**The copy file did not conflict on this merge**, and that is worth noting: `T8.3` inserted
its ten keys **next to the related block rather than appending**, precisely because this file
had already produced three hand-resolved conflicts. That care is why the fourth did not
happen.

## `T8.4` LANDED — a job can no longer escape the kill switches. **M8 is closed.**

**Merged as `634f420`, three commits.** Tests **2,270**. This is M8's exit gate.

### The finding inside it is larger than the card

**The gate that reads the kill-switch table existed but had no production caller at all** —
only tests. **Raising `global.pause_all` genuinely changed nothing, anywhere.** The
mechanism the whole safety story rests on was decorative.

Every task handler is now wrapped **at the moment it is registered**, so the switches are
read from the database when a job starts and **no lane can ship a job that forgets to
ask**. That placement matters: it went into the shared registration path rather than into
any lane's dispatcher, partly because the lane's directory was not this card's to touch —
and it turned out to be the stronger design anyway. **A paused job returns having done
nothing and does not throw**, so an operator's pause does not become a backlog of
dead-lettered work.

**Six jobs keep running while everything else is paused**, each named with its reason: the
spend-cap sweep (**pausing the product must not switch off the brake that catches the next
runaway**), the retention sweep and account close (deletion deadlines are legal, with a
clock), billing reconciliation, the payment drain, and the mail queue. **Anything not on
that list is gated** — the safe direction. The worker now refuses to start if nothing
installed a way to read the switches.

**Four eyes, and an operator command.** Lowering a global switch takes two different named
people and records both; nothing automatic may lower anything. `pnpm switch` makes the
manual half reachable — **without it an operator writes SQL by hand, which is how a flip
gets recorded with no reason and the four-eyes rule gets bypassed.**

**Invariant 17 proved properly.** The test's analytics double **throws on every call**
rather than silently dropping — which would have proved nothing — asserts it was actually
called, and then reads all three switches back as active **from our own database**.

**The dashboards are files now**, and the provisioner writes them: applied twice, the
second run creates nothing; a hand-edited dashboard makes check mode fail by name and
re-applying puts it back.

### The dormant list is now exact, and this card made it worse

**Founder question 4 is the single most expensive open question in the build.** Cron is off
because some crontab entries still have no handler, so **none of this runs in production,
however correct it is:**

| Dormant | What silently never happens |
|---|---|
| the spend-cap sweep | **nothing ever reads the money meter — spend is unbounded** |
| per-account model runaway trip | one store can bill us without limit |
| global search-data cap | that invoice has no ceiling |
| preview spend cap | **the one paid path a stranger can trigger has no brake** |
| judge fail-rate trip *(new)* | a prompt regression mass-produces rejects, or mass-publishes garbage |
| publish error-rate trip *(new)* | a platform outage keeps being hammered |
| per-account intent-gap caps *(new)* | a merchant can click these without limit |
| retention sweep | nothing pruned; **no deleted account ever erased**; store-erasure requests never honoured |
| the scheduled mail | no summary, no reminders, nothing goes out |
| billing reconciliation | a missed payment webhook is never repaired |

**The manual switches do work today** — the gate runs at dequeue whether or not cron is on,
so anything queued by a request or a webhook is gated. **It is the automatic trips that
never fire, because nothing evaluates them.**

**And the number changed in a way that changes the answer.** The card counted **four**
handlerless entries, not the eight its predecessor recorded — other lanes have landed
handlers since. All four belong to Lanes C and D. **So the answer to question 4 may now be
"wait for two more cards" rather than "relax the rule".** The lane did not relax it.

### Two mechanisms that are built and cannot see

The judge fail-rate and publish error-rate trips are complete — arithmetic, thresholds,
switches, fixtures — but **nothing records a draft's gate decision or a publish attempt
yet.** Each reads through a declared port whose stand-in returns **"not measurable" rather
than a healthy zero**, both are in the stub registry, and the sweep logs that it could not
measure on every run. That distinction is the whole point: a healthy zero would have read
as "nothing is failing".

**Stubs went 7 → 9** for this reason, which is the registry working as intended.

### What M8's exit gate actually proves, and what it does not

It proves the ops layer's **mechanisms**. It does not prove they run. Beyond the dormant
table: a merchant who deletes their account **still gets no email** (the type column has no
value for it — one enum value, so a mini-wave); three of the attention list's five
conditions and both article-shaped email facts are stubs awaiting the articles table; there
is **zero real-vendor evidence for email** — the pipeline runs end to end with an empty
outbox, and a production deploy that loses the mail key mails nobody and says so only in a
log line; **the analytics project has never been touched**, all 32 definitions proved
against a stand-in; four eyes is a policy rather than a workflow, since one operator who
knows a colleague's name can type it; and there is no incidents table, so there is nowhere
to record what an operator *found* when they investigated a trip — only what raised it.

**An invariant test caught the card mid-build and it fixed its own side rather than the
test:** importing a flag's name from the preview module violated invariant 2's blanket ban
on importing preview code into the rest of the product. The catalogue now carries its own
copy of that one string, **pinned by a test that reads the preview module as text** — a pin
with no dependency. That is the right instinct, and the same one `T2.4` showed when it
fixed its test rather than widening the quarantine allowlist.

**Files outside Lane G:** the start-up hook and the crontab — **both integrator-resolved
ordered files** — plus unowned runtime files and append-only repository additions. **The
copy file was untouched**, because the user-facing side of an outage is already a canonical
string and everything this card added is operator-facing. **`.env.example` gained one
variable**, and the integrator added it to `main`'s gitignored `.env` to keep the gate green.

## `T3.5`, `T9.6` and `T2.6` LANDED — the last three of the night

### `T3.5` — the existing-target check. **The seam invariant 6 rests on is filled.**

**Merged, three commits.** Until this card the seam was a stand-in that answered "nothing
found" to every question, **so every proposed page looked uncontested.** `existingTargetCheck`
is now off the stub list.

**Three ways of looking, deliberately not overlapping:** what Google actually showed is final
for the pages it reported; what the store publishes decides for pages Google said nothing
about; and what the search vendor says the domain ranks for, **only** for a store with no
Search Console connection and **named as a proxy in the evidence** rather than passed off as
a measurement. A page found but too weak to take the work over does not block the new page —
**it gets linked to it**, so the two support each other instead of splitting the search.

**The CREATE guarantee is structural, not conventional.** The check returns a value that
cannot be constructed anywhere else — the type brand cannot be named outside the module and
a forged object is rejected at runtime. It **names the topic it was issued for so it cannot
be carried across**, and carries a weak match's linking task *inside* it so honouring the
match and honouring the link cannot come apart. **The honest limit the lane stated itself:
neither caller exists yet**, so what changed today is that no caller can get a silent "no
match" any more.

**A spec contradiction it followed rather than resolved, and it breaks the next card.**
§7.3 requires the competitor-gap signal to find "no position ≤ 20"; the same row's action
column and §7.8 both describe "competitor gap + a URL at #18 → improve it". **#18 is ≤ 20 —
both cannot be obeyed.** Following the rule leaves positions 11–20 producing nothing, and
**`T3.6`'s stated done-when expects exactly that fixture to yield an OPTIMIZE at #18.**
Either the threshold moves to 10 or `T3.6`'s done-when names 21–30. **Nobody can build
`T3.6` honestly until this is settled.**

**On deleted pages (founder question 1) it surfaced a second option nobody had.** The
inventory already stamps when the nightly walk last saw each row, so "not seen by the last
completed walk" could stand in for a column — **but only if something records that a walk
completed**, because an interrupted walk would mark live pages as gone and produce exactly
the competing pages the rule exists to stop. Meanwhile the check fails safe and says so in
the evidence rather than asserting a page exists. Its reasoning for the asymmetry is right:
**treating a live page as gone publishes a competitor to it and raises no error anywhere;
treating a gone page as live costs one dismissed suggestion.**

**An empty column is quietly weakening the check on every real store.** The column recording
what a page is *for* is written by nothing, so a page selling the right products with no
recorded purpose scores a **weak** match. **No card in the plan claims that column** — this
is the third card to report it.

### `T9.6` — dashboard, products and performance

**Merged, two commits.** The one to read: **it rendered all four screens and looked at
them**, which found three real defects no test would have caught — date labels hanging off
both edges of the chart, two marker labels colliding because the spacing rule compared marker
positions rather than the labels' own widths, and a compact chart reserving room for labels
it does not draw.

**It refused the design canvas's headline figure.** The canvas draws "Attributed articles —
51 of 58"; invariant 23 admits no exception, **and that figure is also the most misleading on
the page** — the difference is exported articles nobody has confirmed a URL for, which the
spec says must never count as failures. **Its denominator check reads the finished markup,
not the copy file**, because a denominator assembled at render time out of two innocent
values is exactly how this comes back.

**"Too new" is separated from "did badly" structurally:** an unrated result gets **no figures
at all** — em dashes — plus a dashed chip saying we wait 28 days, and is dimmed rather than
coloured, **so an absence of judgement never looks like a judgement.**

**Two colour decisions worth keeping:** two chart panels rather than two lines on one plot,
because forty clicks and two thousand impressions have no shared scale and a second axis
makes the gap between the lines look like a finding; and ink lines with coloured markers,
because **the canvas's brand indigo and its publish-marker purple are the same colour under
the commonest form of colour blindness** — measured separation 0.4 against a floor of 8.

**A copy contradiction it did not resolve silently:** Appendix A — which invariant 24 makes
binding — writes the growth headline one way, and main §7.12 and ui §4 both write it another
for the dashboard. It used the pinned sentence on both screens, **because adding a second
near-identical sentence to the catalogue is exactly how two copies of a pinned string
drift.** If the dashboard should name the product where Opportunities says "we", **Appendix A
needs a second row, not a second copy of the first.**

### `T2.6` — keywords bought, competitors proposed, and the brake read

**Merged, three commits. The first card that spends money with the search vendor.**

**A SERP domain is structurally prevented from becoming a competitor by four things**, not
one: the snapshot table **has no account column at all** (asserted against
`information_schema`), so a row in it belongs to a *search* and not a merchant; the only
writer to the competitors table takes an explicit source and no code path reads a snapshot
and calls it; **one ranking function serves both places a domain is ever named**, because two
would drift and the drift would be a marketplace offered in one place and hidden in the
other; and computing a suggestion **writes nothing**, asserted directly.

**The five-cap is enforced twice and cannot disagree.** The database trigger is the
authority — it locks the account row before counting, which application code cannot do — and
the constant in the repository exists only to turn the refusal into a specific message. **The
test fills the account through the repository, then inserts the next row with raw SQL and
asserts the database itself raises.** Change the constant without the trigger and it fails.

**The crash the cache exists for is simulated, not asserted:** a step killed part-way through
the results pages reads the three already bought back from the database and buys only the
remainder. A second test **deliberately bypasses the completed-work ledger** — which would
have made the run free without proving anything — leaving only the product's own memory.

**An invariant reading the integrator checked rather than accepted.** The lane flagged that
its ingestion draft list writes competitor rows automatically, which the constitution's
invariant 5 could be read to forbid. **The integrator read main §7.2.1 directly and the lane
is right:** the spec defines a business competitor as *"auto-proposed at ingestion, hard cap
5"* and attaches *"nothing is ever auto-added"* specifically to the **ongoing** suggestion
mechanism from *confirmed* keywords. **Two distinct mechanisms; the constitution compresses
them lossily.** The code matches the spec exactly. **`CLAUDE.md`'s invariant 5 wording should
be corrected by the spec keepers** — it is the constitution that is imprecise, not the build.

**`global.pause_enrichment` had existed since the ops schema wave with nothing reading it.**
Both this step and the enrichment job now check it before any vendor call and **stop rather
than degrade** — no shallower page, no older snapshot. The caps behind it are still dormant
because the schedule is off.

**`packages/rules` gained a block, which changes `rules_version` for every lane** — intended
behaviour of that mechanism, but worth knowing at merge time.

## Right now

**Status at 2026-09-07, 13:55 — a new integrator session (`sortiva-a8 [57107b]`) took the role over
from `sortiva-d4`, which ended about half an hour earlier.** `main` at `71b3beb`, clean; all six lane
worktrees clean and none carrying an unmerged commit, so nothing was lost in the handover. **Twenty-four
cards merged, 3,597 tests, `pnpm chaos` 10 of 10.** `M2`–`M6`, `M8`, `M9` closed.

**The founder's instruction this session, and it changes what "done" means:** *finish everything in
code, and defer only the blank `.env` credentials to the last step.* So there is no card being held
back for capacity reasons any more — the queue is worked until it is empty. Deployment stays out (the
founder's earlier choice) and `T10.4` still cannot run without the Shopify development store they
deliberately deferred.

### Fourteen cards landed. `main` at 304 test files, 3,840 tests, gate eleven of eleven

`R-EXPORT-WIRE` was the fourteenth, and the three held copy strings are now applied — the merge it was
waiting for has happened, and this file went in cleanly.

**The pattern is now named four times over, and it is the single most useful thing found today.**
`R-EXPORT-WIRE` found that **nothing tested the download buttons at all** — no test touched the handler
or the browser-side file builder. That is why a screen could build a file out of a response designed to
answer empty, with nothing anywhere going red. The lane put it best: *the producer was tested, the
consumer was not, and the defect lived in the join.*

The four instances, all found today, all the same shape:

1. **Ten endpoints** declared in the contract, called by finished screens, built nowhere.
2. **A signal explanation** filed under a key the engine never produces, so written copy sat unreachable.
3. **An error envelope** written flat by a lane while every screen reads `{error:{code}}` — caught by
   that lane on itself, by writing the test against the screen's reader rather than its own handler.
4. **The download buttons**, untested end to end.

**The method that finds it**: check the consumer, never the producer's own account of itself. Every one
of the four looks correct from the producing side.

`R-EXPORT-WIRE` also deleted 81 lines of a **second implementation of the export format** that nothing
called once both screens stopped using it — reachable only from its own tests, and certain to drift from
the server's. Callers verified by name before removal.

### Thirteen cards landed. `main` at 303 test files, 3,836 tests, gate eleven of eleven. **All six serverless screens now have servers.**

`R-API-PERFORMANCE` was the thirteenth and closed the set found this afternoon: the Performance screen,
its Search Console tables and the opportunity drawer all read endpoints that did not exist.

### A merge broke `main` into invalid TypeScript without ever conflicting — read this before the next merge

`packages/db/src/index.ts` is marked `merge=union` in `.gitattributes`, deliberately, so two lanes adding
different exports both survive rather than colliding. **Two lanes added adjacent blocks and the union
deduplicated the `export {` line they shared**, leaving one block with no opening statement.

- The lane was **green in its own worktree**. Nothing before the merge could have caught it.
- It **never conflicted**, so there was nothing to hand-resolve and nothing to review.
- The gate caught it loudly: lint could not parse the file, typecheck gave four errors, and **94 test
  files failed at setup while every test that did run passed** — 2,928 passed, 0 failed, 94 files dead.
  **That shape is the tell**: passing tests and failing files means a module is broken, not a behaviour.

**The general point, worth carrying:** union merge is chosen so lanes never collide on an append-only
list, and its price is that it can produce a file nobody wrote and nobody reviewed. It is not a reason to
stop using it — hand-resolving these merges is what dropped work in wave 1 — but **after any merge that
touches two barrels, the gate is the only thing standing between that and `main`.**

### Three copy strings owed, held deliberately until `lane-f` merges

`R-API-PERFORMANCE` needs three sentences in `packages/ui/strings/en.json` for the drawer's HOLD section;
only one of the four blocker codes has copy today and the rest fall back to a generic line. **Not applied
yet, because a session is building in `lane-f` right now and that file is not union-merged** — the trap
above is the reason for the caution. Apply after that merge:

- `template.precondition.catalog_richness_gap` — "add material, dimensions, use case and compatibility to the products on the Products page"
- `template.precondition.indexing_issue` — "fix the indexing problem on this page before we write about it"
- `template.precondition.pending_repair` — "a repair is already running on this page — we'll pick this up once it finishes"

### Twelve cards landed and merged green. `main` at 301 test files, 3,809 tests, gate eleven of eleven

`R-OVERRIDE-JUSTIFICATION` and `R-API-SETTINGS` were the eleventh and twelfth.

**The largest single thing found today, and it was found in passing.** `R-API-SETTINGS`'s lane discovered
that the "grant posting permission" button pointed at the **read-only install flow**. A merchant pressing
it went round a consent screen that cannot grant posting permission and came back no further forward —
so **auto-publish could not be enabled by anyone, by any route.** The whole publishing half of the
product was unreachable from the interface. It is one line, and it was found only because the card asked
the screen to be moved onto the addresses that were actually built.

**A second instance of the two-halves-that-each-look-right shape, caught by the lane on itself.** Its
handler answered errors in a shape the screen cannot read; every other route answers `{error:{code}}` and
it had written the code flat. A merchant hitting either auto-publish conflict would have got a generic
failure instead of being told to grant permission or choose a blog. **It was caught by writing the test
against the screen's actual reader rather than against the handler** — which is the general lesson, and
the same one that found the signal name filed under a key the engine never builds.

**`R-OVERRIDE-JUSTIFICATION` was a read defect with four callers and two meanings.** One database read
answered "the most recent gate-3 decision"; publishing anyway writes a second gate-3 row that records the
overruling and judges nothing. Four callers asked that question, two of them meaning "the decision that
judged the words". There are now two reads with the two meanings in their names. The write was correct
throughout and is unchanged, and the calibration query was checked and left alone — it excludes
overridden articles by the article's own flag, so invariant 12 is intact.

### Ten cards landed and merged green. `main` at 300 test files, 3,794 tests, gate eleven of eleven

`R-SIGNAL-COPY` was the tenth: nearly every card on the Opportunities screen said "the reasoning for this
one isn't available yet", and all twelve of the weekly scan's signals now explain themselves.
**One of the two supposedly missing signal names was worse than missing** — the copy existed, filed under
a key the engine does not build, so written words sat unreachable while the merchant read a
machine-prettified key. Third instance of declared-and-consumed-but-never-compared, and the nastiest,
because both halves look present from every direction anyone had checked.

**On the sign-in test, and on running a gate on a contended machine.** Six tests failed on one full run
and two on the next, all at a five-second timeout, all in the known wall-clock set. Load average reached
**199 on twelve cores** — other, unrelated sessions were running on this machine. Established rather than
assumed: names captured first; all the files pass in isolation in about a second; and **a final full run
on a quiet machine passed all 3,794.** `apps/web/app/(public)/_lib/signin-wire.test.ts` is the fifth
member of `R-TESTDB`'s residue and the **most** load-sensitive of the five — it failed in two of three
runs. It builds real Auth.js handlers and does a full anti-forgery exchange, so it is heavy by
construction rather than slow by accident.

**One unexplained event, recorded rather than smoothed over.** In one chained gate invocation `pnpm build`
produced no output and `pnpm smoke:boot` then reported no production build in `apps/web/.next`. Run
again on their own, both passed. **The cause was not established** — the machine was at load 199 at the
time, and that is a correlation, not an explanation. Worth knowing if it recurs.

### Nine cards landed and merged green. `main` at 300 test files, 3,790 tests, gate eleven of eleven

Landed since the handover, each merged and gated separately: `R-SCANCOPY`, `R-PAGE-GONE-READ`, `T7.2`,
`R-API-PRODUCTS`, `R-CONTRACT`, `R-REPAIR-COPY`, `R-REFUSAL`, `R-ARTICLE-OURS`, `R-API-ARTICLES`.
From 289 files / 3,597 tests at the handover. `pnpm chaos` 10 of 10 throughout. `pnpm eval` never run —
no Anthropic key, the standing red.

### The gate caught a real invariant violation, and this is what it looked like

`R-API-ARTICLES` merged clean on lint, typecheck and its own targeted tests, and **failed the full gate
on invariant 3** — the guard that keeps a merchant's own marketing copy out of everything downstream. A
new test had seeded a real product description to give an article something to rest on. It never
asserted on it and passes with the field null, so the copy is gone and the file is on the exemption list
with the honest reason: the product input requires the key even when it holds nothing.
**Worth keeping as the example of why lanes do not gate their own work.** Nothing about that test looked
wrong, the lane had no reason to suspect it, and the check that caught it runs only on the merged tree.

### Three test failures that were load, not regression — and how that was established rather than assumed

A full run during the `R-ARTICLE-OURS` merge failed three tests: `providers/shopify` "paces real requests
and carries the cursor from one page to the next", and both of `apps/web/app/(public)/_lib/signin-wire.test.ts`
"pressing Continue with Google…". **Names captured before anything was re-run**, which is the discipline
a previous integrator broke and recorded.
Established by three separate observations rather than one re-run: both files pass in isolation in under
a second against a five-second timeout; a second full run passed all 3,753 under a load average of 27;
and both files are wall-clock-sensitive by construction. **`signin-wire.test.ts` is now confirmed as the
fifth member of `R-TESTDB`'s named residue** — Lane B reported it as a candidate earlier the same day and
this is the second independent sighting. Treat a failure in these five as unproven; anything else is a
regression.

### Four cards landed and merged green in one pass — `R-SCANCOPY`, `R-PAGE-GONE-READ`, `T7.2`, `R-API-PRODUCTS`

`main` at `8b9644e`+. **Full gate eleven of eleven after every one of the four merges** (`pnpm eval`
not run — no Anthropic key, the standing red). **296 test files, 3,718 tests**, up from 289/3,597 at the
handover. `pnpm chaos` 10 of 10 throughout.

**On test counts, because two reported numbers did not reconcile and it is worth knowing why.** Lane C
reported 3,639 tests in its own worktree; the merged tree gained exactly 9 from its files, which is
exactly what its two changed files contain (8 + 1, counted directly). So nothing was lost in the merge —
one of the *reported baselines* is simply wrong, not the tree. The measured numbers on `main` are the
only ones anyone should quote.

**What each card did, in one line:**

- **`R-SCANCOPY`** — the empty state stops promising Monday. Its own section below.
- **`R-PAGE-GONE-READ`** — a page the merchant deleted stops attracting work: it no longer blocks a new
  article on the subject it covered, is no longer suggested for a rewrite, is no longer **bought and
  compared against a competitor at our expense**, and stops counting as coverage that suppresses a
  replacement. Four call sites, all Lane C: the lane named two, this integrator found a third while
  checking the report, and the lane found the fourth itself (`scan/intent-gap.ts:95`, the paid
  comparison shortlist). One reader deliberately still sees deleted rows, with a comment saying why —
  the existing-target rule decides by reading presence *off* the row, so filtering there would have
  turned every deletion back into a live page and silently undone the card.
- **`T7.2`** — an article we published can be sent back to be rewritten, and an improve-this-page press
  landing on one of our own articles stops being a dead end. **The correction underneath is the
  important part: nothing in the product wrote the rewrite history the sixty-day cooldown reads.** The
  rule was right in tests and could never have been true in production, with no way to notice from
  outside.
- **`R-API-PRODUCTS`** — the first of the six serverless screens gets its server.

**Two integrator-applied lines**, both on lane reports: the `template.freshness_opportunity.*` sentences
`T7.2` needed in `packages/ui/strings/en.json` (Lane F's file, Lane F idle at the time), without which a
queued rewrite renders a blank why-line.

### Four findings from those four cards, all carded, none acted on

- **`R-REWRITE-PLACE` — BLOCKED on a founder decision, and it is the one that matters.** A rewrite
  currently publishes a **second article competing with the first** for the same search, because nothing
  downstream reads that a topic is a rewrite. That is cannibalization — the exact thing invariant 6
  exists to prevent — arriving by the one route the existing-target check does not guard. Pre-existing,
  but `T7.2` makes it the ordinary path rather than a corner. **No rewrite should reach a live merchant
  until the founder answers whether a rewrite replaces the article in place or goes out as a new post.**
  The in-place machinery already exists (`R-PUBLISH-2` built a conditional update that never falls back
  to create), so neither answer is a large build.
- **`R-ARTICLE-OURS`** (Lane C, dispatched) — nothing anywhere marks a store page as one we published,
  so `T6.3`'s refusal and `T7.2`'s pool routing are both **correct, tested, green and unreachable for a
  real merchant**. The single thing between `T7.2`'s founder done-when and being true live.
- **`R-TASK-DONE`** (Lane C) — the Products screen's completed-tasks section can never fill: a merchant
  who fixes their thin product pages leaves an expiry whose recorded reason is indistinguishable from a
  keyword losing its search volume. The endpoint returns null deliberately rather than congratulating
  merchants for work they never did.
- **`R-REPAIR-COPY`** (Lane F, dispatched) — the repair path's explanations render blank, and the
  renderer answers a missing key with silence, which is how they went unnoticed.

### `R-SCANCOPY` LANDED — the empty state stops promising Monday, and the sentence that replaces it is dormant

Merged `7096a1a`. **Full gate green, eleven of eleven** (`pnpm eval` not run — no Anthropic key, the
standing red). Tests **3,652** in **290 files**, up from 3,597 in 289. `pnpm chaos` 10 of 10.

**What changed for a merchant:** two screens told a merchant with nothing to act on that "the next scan
runs Monday". A store is scanned on its own local Monday and a paused or re-queued account moves even
that, so the sentence was untrue for some stores every week — and on Opportunities it sat one line under
a header printing the *real* next-scan date, so the two could visibly disagree. Both now count days to
the date the header names, in the same clock.

**The part that needs carrying forward, because it makes the card's visible effect a removal rather than
a replacement:** `GET /api/opportunities` returns `nextScanAt: null` unconditionally
(`apps/web/app/api/opportunities/_lib/handlers.ts:191`) — verified independently at merge, not taken from
the lane's report. Nothing in the product computes a next-scan date for an account. So the interval is
built, tested and reaches nobody; what a merchant reads today is "No open opportunities right now" with
no timing at all. **Carded as `R-NEXTSCAN` (Lane C).** The lane was right to build the merchant-facing
half rather than guess a cadence in the browser, and the card says so explicitly, because guessing is
exactly what the founder's decision removed.

**One live falsehood left, deliberately, and it needs a founder answer.** The monthly summary email still
says "Your next scan runs Monday". The lane's reasoning, which I accept: a screen is drawn when the
merchant looks at it, so an interval is true as they read it; an email is composed when we send it and
read whenever it is opened, so "in 3 days" becomes *newly* untrue in the inbox in a way a weekday does
not. A day-agnostic wording ("at your next weekly scan") is new quoted copy nobody has approved, so the
lane did not invent one. A test now pins that sentence as the **only** remaining weekday in the whole
catalogue, so the exemption is on the record rather than a string someone missed.

**Two stale sentences in the specs, which are law and not the integrator's to edit** — flagged for the
founder: `docs/sortiva-ui-spec.md:138` and `:325` still give the empty state as "next scan runs Monday",
and `:136` still gives the header as "next: Monday" (already overridden by `T9.4` on 2026-09-02). The
build plan's own stale copy of that string was corrected at `T9.4`'s done-when. A design mockup
(`docs/design/sortiva-ui-mockups.html:1027`) also still shows it.

**Three sessions building, at the four-session cap counting the integrator:**

| Session | Worktree | Card |
|---|---|---|
| lane session | `sortiva-lane-c` | `R-ARTICLE-OURS` — nothing marks a page as one we published |
| lane session | `sortiva-lane-d` | `R-API-ARTICLES` — the articles screens and the override button have no server |
| lane session | `sortiva-lane-f` | `R-REPAIR-COPY` — the repair path's explanations render blank |
| this integrator | `sortiva` (main) | `R-CONTRACT` — its own card by rule |

**Still open after those four**: `R-RUNWAY`, `R-QUOTA`, `R-STOREFRONT`, `R-DRAFT-PROMPT` (all Lane D,
so they serialise behind `T7.2` unless separately authorised), `R-REJECTION-REASON` (Lane C params +
Lane F key), `R-PAGE-GONE-OPTIMIZE` (Lane E, new — see below), the Lane F half of `R-REFUSAL` which
waits on the integrator's contract half, and `T10.1`–`T10.3`.

### The scope decision taken on `R-PAGE-GONE-READ`, and the third call site the lane had not found

The lane asked whether to fix only its named file, or also the two places in its own lane that produce
improve-this-page suggestions from every store page including deleted ones. **Answered: the wider
scope** — the card's third done-when says a suggestion is never produced for a deleted page, and a
done-when is the card. It stays inside Lane C and changes no other lane's behaviour.

**Verifying the lane's report before answering found a third call site it had not named**:
`packages/jobs/src/scan/assemble.ts:550`, inside `assembleFamilyCoverageInput`. That one feeds the
signal that proposes a *new* page for a product family nothing covers — so a deleted page still counts
as coverage there and the product stays quiet about a family it should now be told to cover. **Note the
direction is opposite to the other two**: those produce a suggestion that should not exist, this one
suppresses one that should. Three call sites in that file: lines 130, 550 and 630.

This is the third time in two days that a report naming "two" or "three" of something has undercounted
it. The rule that keeps working: verify anything whose truth would change what you do next.

### A new card, from a finding the lane correctly refused to fix

**`R-PAGE-GONE-OPTIMIZE`** (Lane E) — the improve-a-page machinery reads deleted pages too, in three
files of Lane E's ground, so a merchant can press "improve this page" on a page that is gone and we
spend a paid model call writing advice about nothing. Verified independently before carding it. The
lane found it, stopped at its lane boundary, and was right to.

*Superseded status lines kept below for the sequence:*

**Status — twelve cards merged, `M5` and `M6` closed, and every founder decision has been taken.**
Tests **3,488**, from 3,265 at the start. Gate green: nine of eleven, with `eval` red for want of a
key and one named chaos scenario red — **and a lane is fixing that one now, so the chaos suite may
go fully green for the first time in this project.** **Four lanes running**: `R-STRANDED` (D),
`R-REVOKE` (G), `R-RECO-QUALITY` (E), `R-HOLD` (B). **Twelve cards queued**, two of them the
integrator's (`R-CONTRACT`, `R-REFUSAL`). **Nothing is blocked on a decision** — the constraint is
lane capacity, which the operating rules cap at four. *Superseded lines kept below for the sequence:*

**Status at 2026-09-04, 13:00 — every founder-authorised card has landed and `M6` is closed.**
Tests **3,422**, up from 3,265 at the start of the day. `main` clean, gate nine of eleven.
`R-OPTIMIZE-WIRE` is running in Lane E; `R-CONTRACT` is the integrator's and not started. **Six
questions are back with the founder**, four from the docket and three raised by today's work (one
overlaps). *Superseded status line below, kept for the sequence:*

**Status at 2026-09-04, 12:40 — five of the six founder-authorised cards have landed.** Tests
**3,369**, up from 3,265 at the start of the day. `main` is clean and the gate is green: nine of
eleven. **`T6.3` is running in Lane E — the last card in M6.** `R-CONTRACT` is the integrator's
and not started. Two decisions are blocked on a schema mini-wave (`D7` a fifth article state,
`D10` a sessions table), and **three new founder questions came out of today's work**: which of a
store's addresses is canonical for attribution, whether a merchant may dismiss work already
running, and how the intent-gap allowance is shared between its two spenders. What was decided,
what it unblocked, and what is still stopped is in the section **"2026-09-04 morning — five
founder answers, and what checking them changed"** at the end of this file. **Read that before
anything else.** The night's end state, which everything below still describes, follows.

### The night's end state, kept because it is still what is on `main`

**Status at 2026-09-04, 02:25 — the night's work is finished, and it finished because it ran
out of things it was allowed to decide, not out of capacity.** `main` is at `53ba96c`, clean.
Tests **3,265**, up from **3,049** at this session's start — **216 added**. Full gate green on
the merged tree after every one of the eight merges: nine of eleven commands, with `pnpm eval`
and the single named chaos scenario red for their documented reasons and nothing else.

**M2, M3, M4, M8 and M9 are closed. M7 is deferred out of v1. M5 and M6 are each one card from
complete, and both of those cards are blocked or stopped.** No lane is running. **There is no
card that can be dispatched without a founder answer** — that is the state, and the next
session should not invent work to fill four idle lanes.

### What landed tonight, in order

| Card | Lane | Tests after |
|---|---|---|
| `R-ARTICLES` | G | 3,062 |
| `R-DELIVER` | D | 3,069 |
| `T6.1` | E | 3,093 |
| `T6.2` | E | 3,140 |
| `R-INTENTGAP-JOB` | E | 3,146 |
| `T5.1` | D | 3,195 |
| `R-INTENTGAP-SCAN` | C | 3,205 |
| `T5.2` | D | 3,265 |

Plus **two scheduled audits** (`T6.2` and `T5.2`), both read-only, both recorded unactioned,
and **three cards written by this integrator** (`R-ARTICLES`, `R-DELIVER`, and the two halves
of the intent-gap wiring).

### Six founder answers came in before he slept

All journalled in `DECISIONS.md`. In order: take **both halves** of the override delivery fix;
**build** the draft-ready notification (question 13's first half — its second half stays open);
an article belongs to **the day it appears** (question 16); and the intent-gap comparison runs
as **its own job feeding the scan**. Every one of them is now built and merged.

### Everything is stopped, and here is exactly why

- **`T5.3`** (M5 exit gate) — blocked. Its whole input is the `CatalogEvents` change stream,
  whose reader the founder deliberately left unwired to be judged together with switching the
  recurring schedule on. **The `T5.2` audit has now made those the same question.**
- **`T6.3`** (M6 exit gate) — **stopped by the `T6.2` audit.** Its done-when drives an OPTIMIZE
  opportunity through its states, and the state graph it will read does not contain the
  transitions `T6.2` performs. Correcting the graph is acting on a finding.
- **M10's exit gates** need both of the above.
- **Lanes B, F and G** have no milestone work left.

### The three things the founder should read first

1. **The `T5.2` audit's CRITICAL.** The founder's own condition for switching the recurring
   schedule on is **one string rename** from being met, and it looks met. Verified end to end
   by this session, including checking and discarding a false second mismatch. **The lane's own
   note about it was wrong in both halves.**
2. **The `T6.2` audit's CRITICAL.** The OPTIMIZE feature is connected to nothing, and that is
   far worse than it sounds: two presses of the button permanently disable it for that account.
   **This is why the job was not wired**, and the reasoning first recorded for holding it was
   weaker than the real one.
3. **Ten endpoints now sit at addresses the frozen contract does not know**, and
   `contracts:check` passes throughout because it never compares the contract to the routes on
   disk. The root cause is that `apps/web/app/api/settings` is a directory **no lane owns and
   no card builds**; three cards have deferred it.

### Integrator actions ready and deliberately NOT taken

Three registrations, each one line in `apps/web/instrumentation-node.ts`, each held for a
different reason — set out in full in the handoff and in each card's own section. **None was
taken.** One rule breach was accepted rather than reverted (`T5.1` edited the crontab and the
composition root after being told not to); both edits were reviewed line by line and kept, and
the reasoning and the resulting asymmetry are recorded in that card's section.

### The previous run's end state, kept as history

**Status at 2026-09-03, 08:10 — the run has ended.** `main` is at `a3b8d4b`, clean, and
every worktree is clean with nothing unmerged. **Twenty cards landed overnight**, plus the
bell wiring: `T8.0`, `T-START`, `T-ANALYTICS`, `T3.4`, `T8.1`, `T-EMAIL`, `T9.3`, `T2.2`,
`T8.2`, `T9.4`, `T2.3`, `T2.4`, `T8.3`, `T9.5`, `T2.5`, `T8.4`, `T3.5`, `T9.6`, `T2.6`.
Tests **2,513**, up from 1,362 — **1,151 added**. Copy catalogue **956 keys**, from 331.

**`pnpm eval` is red and stays red** until founder question 6 is answered. Every other gate
command is green on the merged tree. **Do not describe this tree as fully green.**

### How the run ended

**A second account rate limit at about 01:00, resetting 02:50.** The session did not schedule
a wake-up, so it stayed idle until morning rather than resuming — the run simply stopped
there. **Nothing was lost.** Two sessions were killed and neither had produced work: the
`T3.5` audit had written its expectations and not yet read the diff, and `T9.7` had not
started. **All four worktrees are clean, with nothing unmerged.**

The first rate limit, at 20:25, is written up further down along with the one lesson that
mattered: **the lane that had been committing in halves resumed from its own commits; the one
that had not left a draft its successor had to audit file by file.**

| Lane | Branch | Where it stopped |
|---|---|---|
| B — Store Intelligence | `lane-b` | `T-START`, `T2.2`–`T2.6` merged. **Idle. `T2.7` closes the milestone** and is unblocked |
| C — Search Intelligence | `lane-c` | `T3.4`, `T-EMAIL`, `T3.5` merged. **Idle and BLOCKED — `T3.5`'s scheduled audit never ran**, and build plan §7 makes it required before `T3.6`. `T3.6` also has a broken done-when (see `T3.5` above) |
| F — Frontend | `lane-f` | `T-ANALYTICS`, `T9.3`–`T9.6` merged. **Idle. `T9.7` was killed before it began** and can simply restart. Then `T9.8`, the milestone's exit gate |
| G — Ops & notifications | `lane-g` | `T8.0`–`T8.4` all merged. **Idle — milestone complete.** Nothing left in M8 |

### What to do first when picking this up

1. **Run the `T3.5` audit.** It is scheduled, required, and blocking `T3.6`. Nothing else is
   waiting on it.
2. **Settle the §7.3 / §7.8 contradiction** before `T3.6` starts, or that card cannot meet its
   own done-when. Either the threshold moves to 10 or the done-when names 21–30.
3. **Restart `T9.7`** — it lost nothing and is a clean start.
4. **`T2.7`** closes M2 and is unblocked.

### Milestones

**`M8` is complete** — its exit gate landed. **`M2` is one card from complete** (`T2.7`).
**`M9` is two** (`T9.7`, `T9.8`). **`M3` is blocked** on an audit and a spec contradiction.
**`M4` (the content engine) has not started** and is what the whole night was clearing the way
for — `T2.5` unblocked it, and `T4.0` is a schema wave.

**Scope, honestly.** 63 cards defined, 2 deferred by founder decision. **51 now done.**
The estimate written at 23:20 was "around 45 of 63" and the run reached 51 before it was cut
short by the limit rather than by anything in the work.

### Five audits were scheduled; four ran

`T-EMAIL`'s (lane-requested), `T2.2`'s (**scheduled — found the critical privacy defect**),
`T8.2`'s (**scheduled — found two high defects**), and none outstanding for `T9.x`. **`T3.5`'s
is scheduled and did not run.** All findings are held, unactioned, in the audit section
below. **No audit stopped a lane.**
### Three remediation cards now exist in the build plan

Build plan §7 says findings become cards. **None is fixed** — acting on a finding still needs
the founder — but each is now a card with a done-when rather than prose in a report.

- **`R-PRIVACY`** (Lane B) — the webhook receiver stores shoppers' email and phone while we
  answer Shopify "no customer data held". **Should land before any Shopify Partner
  credential exists.**
- **`R-STREAM`** (integrator to assign) — the change stream has a producer, no consumer, and
  the check that would have said so was switched off.
- **`R-DEV`** — **FIXED 2026-09-03 (`c1d2541`), and the diagnosis recorded here all run was
  wrong. See the `R-DEV` LANDED section at the end of this file.** What this entry used to
  say — "`next dev` cannot start at all" — was carried by three sessions, including into
  lane briefings by this integrator, and was never true: the server starts fine and every
  page then answers 500. The real cause was the Edge runtime, not the config loader.
  **Original text kept below for the record, because acting on it is what cost the time:**
  *"`next dev` cannot start at all. Found by `T9.5`, reproduced directly by the integrator:
  the start-up hook pulls the job library and, through it, a config loader Next cannot
  bundle for dev. The production build is fine and `smoke:boot` is green, which is exactly
  why no gate catches it."*

### A merge broke and was repaired, which is what merging concurrent lanes costs

Typecheck went red on the merged tree after `T8.3`: it had added a revocation method to the
Shopify provider interface and updated every inline test double that existed **when it
started**, and `T2.4` landed an hour later carrying a new test file with its own double.
Neither card could have seen the other. Fixed mechanically, matched to sibling doubles.
**This is the argument for gating the merged tree rather than trusting green branches.**
### The founder widened the integrator's authority at 23:10

**"Carry on with whatever you can without my supervision; wait till the morning only with
what's absolutely necessary."** Two things followed from it, both done and both gated:

1. **The bell is plugged in.** The Shopify composition root now hands out the real
   notification emitter instead of the in-memory stub, so a notification reaches an actual
   row and — for the kinds that are emailed — a real queued send. **Deep-imported**, because
   that file's barrel drags the threshold config into a bundle with no disk, which is the
   defect `T-BOOT` repaired. The stub report stops listing the seam, following the precedent
   already in that file — **but unlike the catalogue-events case, whose line was removed
   while its consumer was still unwired, this one was verified end to end first**: the
   emitter is constructed in the composition root, not merely exported.
2. **The two `T2.2` audit findings became cards**, which is what build plan §7 says findings
   become — `R-PRIVACY` and `R-STREAM`, both in the build plan under M8. **Neither is
   fixed.** Acting on an audit finding still needs the founder; carding one is the process.

**What is still deliberately held**, because it needs judgement rather than permission: the
seven founder questions, and the `R-PRIVACY` fix itself — which sits in territory lane G is
building in **right now**, making a quiet fix exactly the wrong move.

### Honest scope: "all cards by morning" is not reachable, and why

63 cards are defined; **31 were done before tonight's last three began**, 2 are deferred by
founder decision (the learning loop). **The constraint is not speed — it is that what
remains is mostly one chain.** The content engine cannot start until `T2.5` lands;
publishing needs the content engine; the exit gates need everything. That chain alone is
about thirteen strictly serial cards, several with audits scheduled between them, and it is
longer than the night.

**What is realistically reachable:** finishing store intelligence (`T2.5`–`T2.7`), the rest
of search intelligence (`T3.5`–`T3.7`), the remaining screens (`T9.5`–`T9.8`), lifecycle and
kill switches (`T8.3`, `T8.4`), and a real start on the content engine — roughly 45 of 63.
**Lane B reached `T2.2` and stopped there, which is what the plan asked for.** The one
mid-run decision the plan told the runner to watch for — whether lane B would reach `T2.5`
and free lane C's `T3.5` — did not arise.

### Two integrator actions are ready and deliberately NOT taken

Both are recorded in full in their own sections. Neither is an oversight; each would
change behaviour, and the overnight rules say to ask for an action in one plain sentence
and wait rather than infer permission.

1. **Plugging in the bell.** `T8.1` built the notification writer and could not wire it —
   the one-line swap lives in a file lane B was building in. **Lane B is now finished and
   out of that file, so it is unblocked.** It switches on notification writes in
   production from a writer that has never run there, inside the caller's transaction, so
   if it throws, the decision it was reporting rolls back with it. Nothing tonight needs
   it. **One line plus a full gate re-run whenever the founder says go.**
2. **The change stream's missing consumer**, found by the `T2.2` audit. The producer is
   real; nothing in production reads it, and the stub report was edited to stop saying so.
   Whether lane B wires it, lane C does, or the check is restored until someone does, is
   an integrator decision the integrator has not taken — because taking it is acting on an
   audit finding.

### Two audits ran tonight and both are recorded, unactioned

`T2.2`'s was **scheduled and required**; `T-EMAIL`'s was **requested by its own lane** and
took lane C's idle slot. **The `T2.2` audit found a critical privacy defect and the
integrator verified it independently before recording it.** Read the audit section first
in the morning. A third audit is scheduled after `T8.2` and cannot run until that card is
finished.

**Every lane obeyed the one-card rule tonight**, including lane F, which broke it earlier
in the day. Every card that finished reported, stopped, and left a clean worktree.

**The gate flakes under concurrent lane load — re-run before believing a red.** It
happened twice on the integrator's gates and once inside lane B's, and every re-run was
clean. Two shapes: every test passing with a non-zero exit, on one Postgres `57P01`
teardown error; and test *files* failing on 10-second hook timeouts. **If a gate goes red
with every test passing, re-run once before investigating.** But note that lane B's re-run
then surfaced a *genuine* regression underneath the flake, which it fixed — **re-running is
not the same as ignoring.** Unactioned; it belongs to whoever next touches
`packages/db/src/testing.ts`, which force-drops each suite's own database and kills a
connection a suite forgot to close.

**A build warning that is expected and should not be chased.** `pnpm build` prints
"Critical dependency: the request of a dependency is an expression" from `cosmiconfig`,
reached through `graphile-worker`'s own config loader. The worker runs **in-process with
the web server by design** (tech §2), so the job library is in the server bundle and its
vendor config loader comes with it. Pre-existing, and `pnpm smoke:boot` proves the built
app still starts and serves. Same *shape* as the defect `T-BOOT` repaired, which is why it
is written down rather than left to be rediscovered.

**A trap the integrator created and then repaired.** `.env` is gitignored and lives
per-worktree. When `T-ANALYTICS` added `NEXT_PUBLIC_POSTHOG_KEY` to `.env.example`, the
integrator copied the new `.env` into every worktree — including two whose branches
predated the `.env.example` change, so `env:check` failed there with 37 against 36. Lane G
hit it and correctly refused to guess a default; lane B was warned mid-card not to "fix"
it, and did not. **The lesson: refresh a worktree's `.env` only when its branch also has
the matching `.env.example`, or fast-forward it first.**

**A mistake the integrator made editing this file, and caught.** Replacing a section by
line position cut an adjacent heading along with it — exactly the damage this file's own
warning describes. It was caught by the `grep -n '^## '` check the warning prescribes,
restored from git, and the full heading list was then diffed against the previous commit
to prove nothing else was missing. **Do the section-list check after every edit. It works.**

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

## `T2.2` LANDED — a merchant's store is actually read

**Merged as `a870e0e` into `main`, seven commits, full gate green.** Tests 1,748. This
was the critical path and the most consequential card of the run.

**Onboarding's third step now pulls a merchant's whole catalogue and ninety days of
orders from Shopify**, works out what they sell most of, and records which pages their
buyers arrived on. Before this, a connected store sat there and nothing happened to it.

Five things make it safe rather than merely working:

1. **It is paced.** Every read goes at one request a second per store — half what Shopify
   allows — so walking a large catalogue can never crowd out the merchant's own admin. A
   rate-limit response holds that store back for exactly as long as Shopify asked, not
   for a guess. **The pacing lives inside the single Admin client, so Lane C's content
   inventory inherits it — it was previously unpaced, and that is a visible change for
   them.**
2. **It survives being killed.** Roughly eight minutes for a five-hundred-product store,
   the longest thing the product does over a network. **The page is written first, then
   the cursor is committed** — a crash between them costs one page re-read onto rows it
   already wrote, where the other order would silently skip a page of the catalogue.
3. **It holds nothing belonging to a shopper.** An order is reduced at the moment it is
   read to line items and a landing path. **Enforced by construction, not by care**: the
   reduced order is built from a fixed list of fields, so a field Shopify adds next year
   is dropped by default, and we never ask for the others. The integrator read this
   module before merging — it is invariant 4 and it is a legal obligation.
4. **Edits reach us in minutes.** Shopify now has a receiver. It proves the message
   genuine against the exact bytes sent, writes it down, and answers — nothing else,
   because Shopify drops a subscription whose owner answers slowly.
5. **A nightly re-read catches what those messages drop**, which they do routinely and
   silently.

**The change stream two other lanes were built against is no longer a stand-in.** It
answers with what merchants actually changed, including the four blog-post and
static-page kinds the founder decision added this morning. **The stub count fell from 7
to 6.**

**Proved by mutation, not assertion.** With the saved position ignored, the chaos
scenario fails with "the walk restarted from the beginning 3 times; a resume must
continue from its saved position." `pnpm chaos` is now 3 tests, up from 2.

### What the scheduled audit should look at hardest

The lane named five things and the integrator agrees with the list:

1. **The change stream's home.** No table existed and a feature card may not add one, so
   it lives in `webhook_events` — two row shapes in one table told apart by topic, with
   the account inside the JSON. **The per-store read therefore cannot use an index on the
   account.** Journalled, small at v1 volumes, and named as the thing most likely to want
   revisiting: if it stops being small the fix is a column in the next wave.
2. **The deletion check** — "products the sweep did not see" is answered by stamping every
   seen product with the walk's start moment, which couples the sweep to a field the
   catalog sync also writes with a different value.
3. **The order aggregation's day-settling**, whose correctness depends on Shopify
   honouring the sort order we ask for.
4. **The chaos scenario resets the step's attempt counter** between kills, because the
   harness kills more often than the production retry budget allows. Documented; an
   auditor should agree it is a fair test rather than a weakened one.
5. **Invariant 21** — no write scope was acquired or used, and a cold read confirming it
   is cheap.

### Two things it decided that need someone

- **`shop/redact` is received and recorded, but nothing is erased.** Purging a store's
  data is account-lifecycle work. **No card owns it today and one must before launch.**
- **A product the store stopped listing keeps its row**, mirroring `T3.2`'s decision for
  deleted pages and inheriting its open question — which is founder question 1.

### The schedule moved, and it moved the wrong way for the money

`T2.2` took the crontab from **5 of 14 jobs having handlers to 7**, registering the daily
reconciliation sweep and the landing-revenue aggregation. **Seven remain unowned**, and
because the worker refuses to run *any* recurring job until *every* one has a handler,
**none of them runs — including the nightly sweep this card just built, and the spend
caps.** That matters more now than it did this morning: this is the first card that
spends a store's request budget at scale. The lane built the enforcement points as the
spec requires and correctly changed nothing about the all-or-nothing rule. **This is
founder question 4.**

**Real-vendor evidence: this card is now the largest single piece of it in the build.**
Everything Shopify-side is proved against stand-ins — an in-memory store that pages the
way Shopify pages, and a real local HTTP server for the rate limiter and cursor headers.
**Not proved:** Shopify's real cursor format, actual retry-after behaviour, real product
and order field shapes, real webhook headers, and whether the field lists we send are
accepted. **`T2.2` must be re-run against a Partner dev store before launch.**

**Files outside Lane B's directories**, all journalled: two new `packages/db` repositories
plus a union-merged barrel; one chaos-harness entry the harness's own comment says `T2.2`
would add; two task registrations in `apps/web/instrumentation.ts`; one line in the stub
report; and one `T2.1` test assertion that said "the next step belongs to a later card" —
this being that card. **No migration.**

**The integrator checked `apps/web/instrumentation.ts` after the merge**, because it is an
ordered file that is deliberately not union-merged. All registrations survived, including
the inventory sweep call that `T3.2` left waiting for the catalog lane to make.

## `T9.3` LANDED — setting a store up now has screens, end to end

**Merged as `b6945f9` into `main`, three commits, full gate green.**

The dashboard is now the container for every stage of connecting a store — **there is no
wizard route**, so which stage is on screen follows the state of the domain, and closing
the tab lands the merchant back where they left off. Address field, a seven-row progress
list following the run live over a stream with a poll fallback, the Shopify card carrying
the read-only trust copy verbatim, the Search Console card with "Skip for now" always
visible, two parked states, the seven-section confirmation review, the first-scan wait,
and the activation landing on the opportunities screen.

**A row over a minute old says so; a failed row stays calm because retries are automatic,
and only a step that has *stopped* retrying offers a person.**

### The conflict the integrator predicted, and how it was resolved

`packages/ui/strings/en.json` is **not** union-merged, and `T8.1` and `T9.3` each appended
a block at the same point. Resolved by hand: the two sides were checked for shared keys
(**none** — 30 notification and attention keys against 147 onboarding keys), both blocks
kept, one missing comma added at the join, and the result verified to parse with both
blocks present. **331 keys total.** Recorded because a hand-resolved merge is exactly
where somebody's work gets silently dropped.

### Two things blocked on other lanes

1. **No route reports the first scan's progress.** The UI spec wants sub-lines mirroring
   the signal run over a stream; the frozen 55-route contract has neither a scan-status
   read nor a stream, and this lane cannot add one. **The card names the five stages
   without ticking them** — a progress bar moving on a timer would be a fabrication on
   the one screen whose job is to earn trust. A single prop is the plug-in point when the
   route pair exists.
2. **Google returns the merchant to Settings mid-onboarding.** The Search Console callback
   (Lane C's file) redirects to a settings screen. During setup the property picker is a
   step in the progress list on the dashboard, so a merchant who connects mid-setup is
   dropped out of setup onto a screen that does not exist yet. **The dashboard already
   reads the return parameter and shows the picker — it works the moment the return
   address points back at it.** One line, in another lane's file.

**Three mock-fixture requirements that will bite the backend card if ignored**, all
registered in the screen contract: the Shopify connection field must read `broken` (not
`none`) after a token revocation, because two opposite screens share one domain state and
this field is the only thing separating "never connected" from "connection lost"; the
last-scan timestamp must stay null until the first scan has actually *produced*
opportunities, or the merchant is sent to an empty list; and each step's start time must
be when *that step* began, not the run, because it is what the elapsed clock counts from.

**Files outside Lane F's directories: none.**

## `T-EMAIL` LANDED — sign in with a link, and one done-when deliberately not met

**Merged as `0b84ffa` into `main`, three commits, full gate green.** Tests 1,562.

**A merchant can now sign in by typing their email address instead of using Google.**
They get a one-time link; opening it signs them in and, the first time, creates their
account. Google sign-in is unchanged, and both routes land on the same account, because
the account **is** the email address — which is what the unique index on the address
already said.

### The card's premise was wrong, and the correction saved the night's work

The card — and `T1.1` before it — said the auth library refuses an email provider without
a **database session adapter**. **That is two requirements read as one.** The lane
verified it in the library's own configuration check rather than taking it on trust: a
magic-link provider needs storage for a single-use link and a way to look an account up
by address. The session-storage functions are demanded only when the session strategy is
set to `database`. Ours is tokens, so they are never asked for.

**So email sign-in was buildable with the tables we already have, and is built. Sessions
were never the price.** The state file said this card was "larger than adding a provider
looks"; that framing came from the same misreading and is now corrected.

### What is parked, and why it is a founder decision

**A session still cannot be revoked before it expires.** That is the card's fourth
done-when and **it is not met**. The lane did not fake it, and the reason is not
reluctance: **there is no `sessions` table anywhere in the schema.** Waves 1 to 4 create
forty tables and none holds a session. A session has to *be* somewhere before it can be
deleted, wave 4 is closed, and a feature card does not add its own migration.

*Today's consequence, plainly:* signing out clears the cookie in that browser and nothing
else. A copied session cookie stays good until it lapses, at most a day after it was
issued.

**Session lifetime stays at 24 hours, decided by the lane on its own authority and
journalled** — the card explicitly permitted "kept with a journalled reason". The
reasoning: a session that cannot be revoked must expire soon enough to bound the damage;
that is still exactly the situation, so the number that was right for it is still right.
Revisiting it is the second half of moving sessions into the database, not something to
do first.

### Two things worth looking at

**1. Google is now told to match by email address, and the danger is fenced rather than
accepted.** With an adapter present the library runs a linking step it used to skip: it
asks storage which account owns a given Google identity, and we have nowhere to answer
from. Its default answer for an unknown identity whose address already has an account is
to **refuse** — which would have locked out every existing Google user. So the Google
provider now carries `allowDangerousEmailAccountLinking`. What removes the actual danger:
the sign-in guard turns away any provider that states it has **not** verified the address.
A *missing* statement is deliberately not treated as a "no", because that would lock
everyone out silently. This is not a policy change — sign-in has resolved accounts by
lowercased address since `T1.1`. **The lane recommends an audit on this pair and the
integrator agrees.**

**2. The branded sign-in screen's Google button cannot work — proved, not inferred.**
`packages/ui/src/public/SignIn.tsx` posts without the anti-forgery token the library
requires and comes back with an error. The lane hit it writing tests, which have to fetch
that token first, and correctly left it alone because it is Lane F's component and lane F
is editing that area tonight. **Consequence for the founder decision that email sign-in
ships in v1: it is built and reachable at the library's own page, but our `/signin` screen
still offers only Google.** Making it reachable is a small frontend change — an address
field, a hidden token, a different post target, and two or three strings — and it fixes
the Google button in the same edit. **No card owns it.**

**A number the founder may want to move:** a sign-in link lasts **15 minutes**. The
library's default is a full day. It is one constant plus the sentence generated from it.

**The sign-in email deliberately bypasses the notification queue**, and the reasoning is
sound: the queue's row needs an account id and the requester may not have an account yet,
and asking for a second link *must* send a second email — so the dedupe rule that
protects every other send would suppress exactly the send being requested. Invariant 25
is still satisfied: the send goes through the instrumented `EmailProvider` wrapper, not
the library's own mail transport.

**A knowing departure from `CLAUDE.md`, flagged rather than hidden:** the email's words
live with the auth code rather than in `packages/ui/strings/en.json`, pending a ruling on
where email copy lives once `T8.2` decides. **`T8.2` is building right now** — the
integrator should reconcile these two when it lands.

**One behaviour change to note:** a new sign-up through Google now records its provider as
`oauth` rather than `google` in the funnel.

**No collision with lane G** — the lane touched nothing in `packages/core/notifications`,
`packages/core/email` or `packages/providers/email`, and said so explicitly.

**Files outside Lane C's directories:** the auth library files (Lane A — granted by the
card), two `packages/db` files plus a union-merged barrel, and **`vitest.config.ts`**, a
shared root file, which gained one setting so the library's Next wrapper can be loaded in
a test at all. That one is the merge hazard for any other lane touching the root test
configuration.

**Real-vendor evidence outstanding — three items, taking the list to eight cards:** no
email has ever been sent through Resend; the Google linking flag and the verified-address
guard have never met a live Google response; and nothing has been exercised in a browser,
because no screen offers email sign-in yet.

## `T8.1` LANDED — the bell writes a row, and it refuses to store words

**Merged as `44177e4` into `main`, three commits, full gate green.** Tests 1,541.

**The bell.** Every lane already calls one function when something happens; until now
that call went into a stub that kept things in memory. It now writes a row. **Two
attempts at the same event produce one notification**, because the key it deduplicates
on is worked out from the event itself — the article's id, the week a scan ran in, the
month a summary covers — never generated. A retried job recomputes the same key and its
second insert does nothing. The caller is told which of the two happened, and can hand
in an open transaction so a notification about a decision commits with that decision or
not at all (proved by a rollback test).

**It refuses to store words, and this is the second structural answer to the standing
audit finding.** A payload may hold identifiers and short tokens only; a caller passing
an article headline gets an error rather than a stored row. Checked on the way in, which
is the only place the rule holds without every future emission point having to remember
it. Note the pairing: `T-ANALYTICS` did the same for events leaving the browser, and this
does it for records that outlive the thing they describe.

**What the bell says is produced when it is opened**, from a copy key plus values looked
up at that moment — so reworded or translated copy applies to notifications already
sitting in a merchant's bell, and a thing since deleted falls back to a line that still
says what happened ("An article was published") rather than naming an article that no
longer exists. The fallback is **per type**, keeping the verb and losing only the name.

**The attention list is five live reads, no stored rows**, and nothing on the interface
could write one. Approving a draft stops the query matching it; that is the whole
mechanism. **Four routes**, none gated on billing — a merchant whose payment failed still
needs to be told so. Someone else's notification id is answered exactly as a deleted one.

### Three things this card left for someone else's hand

**1. The bell is built but not plugged in — and this one is the integrator's.** The
production wiring still hands out the in-memory stub, because the one-line swap lives in
`apps/web/app/api/shopify/_lib/config.ts` — **Lane B's directory, and Lane B is building
in it right now** on `T2.2`. The change is `notificationEmitter()` returning
`new DbNotificationEmitter(db)` instead of `new StubNotificationEmitter()`; that file is
already exempt from the raw-database lint rule. **Until it is made, no notification
reaches a real row in production**, and `pnpm stubs:report` correctly still lists
`NotificationEmitter`. **Do this after `T2.2` merges, as its own commit, so it cannot
collide with lane B's work.** It turns on notification writes in production, so it is
worth naming in the morning report rather than doing quietly.

**2. The attention list is two-fifths real.** Two conditions read real tables and are
proved against Postgres. The other three — a draft awaiting review, an article needing
repair, an exported article whose published address we were never told — all read the
`articles` table, **which does not exist**; schema wave 3 (`T4.0`, lane D) creates it.
They return nothing and *announce* it: `pnpm stubs:report` now names
`AttentionSources.articles` and any call reaching one emits `stub_used`, because an
attention list that cannot see drafts is otherwise indistinguishable from an account with
no drafts. **The stub count is now 7, up from 6.**

**3. A conflict is coming in the copy file.** The card added 34 lines to
`packages/ui/strings/en.json`, which is **not** union-merged, and **lane F is writing
screens in it right now**. The added block is contiguous at the end of the file, which is
the best case for resolving it. Expect to hand-resolve when `T9.3` merges.

**A judgement call flagged for the `T8.2` audit rather than settled:** the two reminder
windows (7 days, 14 days) are named constants in `packages/core`, not entries in
`signals.config.yaml`. That is a judgement about where invariant 9's boundary falls —
whether "no threshold literal outside `packages/rules`" reaches a reminder delay or only
the numbers that decide what the engine detects.

**A bug worth knowing because it looked like something else.** The bell's thirty-second
poll compares timestamps **truncated to milliseconds**. Postgres keeps microseconds and
JavaScript cannot, so a plain "greater than" hands the browser back the very row it used
as its mark, on every poll, forever. It was found by a test that first looked like clock
skew.

**For `T8.2`:** the channel matrix already carries the email column, the default-on flag,
the toggleable flag and which preference column governs each row, all tested against the
UI spec — read `notificationChannels(type)` rather than re-deriving it. `queueEmail`
already enforces the same unique triple. Three types reach the inbox only through the
monthly summary and get no email of their own. **The payload guard applies to
notifications only:** if a monthly-summary email needs article titles, it must look them
up at send time, never read them from a stored row.

**Files outside Lane G's directories:** `packages/ui/strings/en.json` (the conflict
above), `scripts/stub-report.mjs` (five lines — the shared registry the build plan says
lanes extend), and `packages/db` barrels, which are union-merged.

**An `env:check` failure this card reported was the integrator's fault, not the card's.**
`T-ANALYTICS` added `NEXT_PUBLIC_POSTHOG_KEY` to `.env.example` after lane G's branch
point; the integrator had refreshed the worktree's gitignored `.env` to 37 variables while
its `.env.example` still had 36. The lane correctly refused to guess a default and
reported it. It passes on the merged tree. **Lane B is exposed to the same mismatch on
`T2.2` and has been told not to "fix" it.**

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

**Gate on the merged tree, after eleven cards tonight**, each command run separately on
2026-09-02 at 22:45–23:15, never chained:

| | |
|---|---|
| `pnpm lint` | clean |
| `pnpm lint:prove` | **11** planted violations, all rejected |
| `pnpm typecheck` | 9 packages |
| `pnpm test` | **1948 passing**, 145 files |
| `pnpm contracts:check` | 56 routes; zod and OpenAPI agree |
| `pnpm build` | compiles |
| `pnpm smoke:boot` | `GET / -> 200`, `GET /api/health -> 200`, in 0.7s |
| `pnpm chaos` | 3 tests, pass |
| `pnpm env:check` | `.env` and `.env.example` both declare **37** variables |
| `pnpm stubs:report` | **8** wired stubs |
| `pnpm db:migrate` on an **empty** database | 41 tables, 3 guard triggers (run after `T8.0`, the only card tonight touching migrations) |
| **`pnpm eval`** | **RED, by design, since `T2.3`** — see below |

### `pnpm eval` is red and that is not a regression

**Do not report this gate as fully green, and do not "fix" the eval by making it pass.**
`T2.3` added the first evaluation set that grades what a real model produces, and its
author made it **refuse to run against a stand-in** rather than report a pass that means
nothing. There is no Anthropic key, so the command fails by name.

**CI on `main` is unaffected** — the integrator checked `.github/workflows/ci.yml` before
merging: that job is pull-request-only, path-gated to prompt/model/eval changes, and takes
its key from repository secrets. The design always assumed a real key.

**What it changes is this local gate**, permanently, until a key exists or someone decides
otherwise. **It is founder question 6.**

**Every test count reconciles, card by card.** 1,362 on `main` at the start of the night
→ `T8.0` +7 (1,369) → `T-START` +4 (1,373) → `T-ANALYTICS` +31 (1,404) → `T3.4` +61
(1,465) → `T8.1` +76 (1,541) → `T-EMAIL` +21 (1,562) → `T9.3` +93 (1,655) → `T2.2` +93
(1,748). **386 tests added tonight.** A discrepancy the previous state file carried is
also
settled: its header said 1,362 and its gate table said 1,357; lane B noticed the
five-test gap and correctly declined to
chase it. The header was right, the table was five stale.

**The `.env` handling this required is written up under "Right now" above**, including
the mistake the integrator made doing it and how to avoid repeating it. Short version:
`.env` is gitignored and per-worktree, `T-ANALYTICS` added a variable to `.env.example`,
and refreshing a worktree's `.env` without also moving its branch forward makes
`env:check` fail with 37 against 36.

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

**Twelve questions now exist. Three are answered — 1, 4 and 8 — by the founder directly,
at 12:40 this run, in a second session (`sortiva-85`) running alongside this one. Fourteen
remain open: 2, 3, 5, 6, 7, and 9–17 — the last nine raised by the `T4.4` and `T4.5`
audits and by `T4.6`'s exit gate, and listed at the end of this section. `R-PRIVACY`, `R-STREAM` and `R-DEV` have all since been
authorised and fixed.** Verified
independently before recording: `git log` shows the three commits
(`d3758c7`/`ec2f213`/`5a6b46d`) actually on `main`, authored by the founder's own git
identity, each with a `DECISIONS.md` entry read in full. **Five remain open — 2, 3, 5,
6, 7** — and none of them blocks a card today. Questions 1 and 2 came from `T8.0`,
question 3 from `T-EMAIL`, question 5 from `T9.4`, question 6 from `T2.3`, question 8
from `T3.5`'s audit; questions 4 and 7 are the two the run inherited. The question that
used to be here about *what starts a merchant's onboarding* is **answered and built** —
`T-START`.

**A fourth thing was decided in the same batch, not one of the original eight:**
`R-PRIVACY` (the critical privacy finding from `T2.2`'s audit — shoppers' email and
phone stored while telling Shopify we hold none) is **authorised, now**, rather than
held until Shopify credentials exist. `sortiva-85` has claimed it in lane B, dispatched
the moment `T2.7` merged (its only stated blocker — Lane B being mid-card in the same
directories — expired at that merge). **`R-STREAM` and `R-DEV` remain un-authorised**
and stay untouched by this session.

**1. ANSWERED 2026-09-03, 12:40 — a status field, not a date. Carded as `T4.0a`, a
schema mini-wave, unbuilt.** The founder chose the status field over a single
deleted-at date (costs nothing extra today, avoids a second migration if a third
condition appears) and rejected inferring deletion from "not seen by the last
completed walk" (only safe once something also records that a walk *completed*).
`T4.0a` is migration-only — nothing writes the new value or reads it yet; the producer
and teaching `T3.5`'s existing-target check to use it are explicit follow-ups, neither
a founder question. Full detail: `DECISIONS.md` `2026-09-03 — FOUNDER — A deleted
store page gets a status field`. **Original question kept below for context.**

*Original question: when a merchant deletes a page from their store, how should we
record that it is gone?* The product keeps one row per web address the store publishes
— its inventory.
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

**3. Should a signed-in session be revocable before it expires?** Right now signing out
clears the cookie in that browser and nothing else — a copied session cookie stays good
until it lapses, at most a day after it was issued. `T-EMAIL` could not fix this and
parked it: **there is no `sessions` table anywhere in the schema**, and a session must
exist somewhere before anything can delete it. Wave 4 is closed, and a feature card does
not add its own migration, so the lane wrote it up instead of reaching for one.

*What it buys:* "sign out everywhere", and instant lockout when an account is deleted or
a password-equivalent is compromised. Both are genuinely absent today.

*What it costs:* **a database read on every authenticated request**, on a platform chosen
for being cheap. That is the whole trade, and it is why this is a founder call rather than
an obvious improvement.

*The shape if you say yes:* a mini-wave adding one small table, then a change of session
strategy. The 24-hour session lifetime should be revisited in the same breath — it is
short *because* revocation is impossible, so the reason for the number goes away with it.

*What is blocked:* nothing tonight. It is a security property the product does not have,
not a broken feature.

**4. ANSWERED 2026-09-03, 12:40 — wait. Nothing changed.** The crontab stays off and the
worker's all-handlers-present rule is not relaxed. The four remaining handlerless
entries (`generation_cycle_daily`, `signal_scan_weekly`, `replenishment_monthly`,
`publish_intent_recovery_sweep`) belong to Lanes C and D, whose cards are next in line
anyway, which is what made waiting a real option rather than a stall. What stays
dormant is unchanged from the table below — nothing reads the spend meter, the preview
cap has no brake, no deleted account is erased, no scheduled mail goes out. The manual
kill switches still work at dequeue regardless. Full detail: `DECISIONS.md`
`2026-09-03 — FOUNDER — The recurring job schedule stays off until the four missing
handlers land`. **Original question kept below for context.**

*Original question: should the recurring job schedule be switched on — or is the
answer now just "wait"?*
**This is the most expensive open question in the build, and the night changed both its cost
and its likely answer.**

The worker refuses to run *any* recurring job until *every* crontab entry has a handler.
**The count was ten handlerless when the run started. `T8.3` took it to eight. `T8.4`
counted it again and found four** — other lanes landed handlers in between. **All four
belong to Lanes C and D** (`generation_cycle_daily`, `signal_scan_weekly`,
`replenishment_monthly`, `publish_intent_recovery_sweep`).

**So the answer may now be "wait for two more cards" rather than "relax the rule"** — which
is a much cheaper answer, and it was not available this morning.

*What is dormant until then, exactly.* The list is in the `T8.4` section above and it is
worth reading in full, because it is longer than it sounds. The headline: **nothing ever
reads the money meter, so spend is unbounded**; the preview cap — **the one paid path a
stranger can trigger** — has no brake; **no deleted account is ever actually erased and
nothing is ever pruned**; and no scheduled mail goes out at all.

*What does work today:* the **manual** kill switches. `T8.4` put the check at the moment a
job is dequeued, whether or not cron is running, so anything queued by a request or a
webhook is gated and an operator can stop it. **It is only the automatic trips that never
fire, because nothing evaluates them.**

*The integrator's recommendation, unchanged in shape but cheaper now:* if you do switch it
on, run the entries that have handlers and **log loudly at every start-up naming the ones
that do not**, so a job that is not running says so rather than being silently absent. But
given the count is four and falling, waiting is now a real option rather than a stall.

**5. Can the weekly scan ever fall on a day other than Monday?** A canonical sentence the
product may not reword tells a merchant with no open opportunities that *"the next scan
runs Monday"*. But the API sends a real next-scan timestamp, and `T9.4` used that in the
screen's header rather than hardcoding a weekday — because a store whose scan lands on a
Tuesday would otherwise be told something untrue every week. **So the header can say
Tuesday while the empty state promises Monday.**

*If scans will never move off Monday*, this is harmless belt-and-braces and nothing needs
doing. *If they can* — a store in a distant timezone, a scan deferred by a pause or a spend
cap — then the empty-state sentence needs rewording, and **it is quoted copy, so only you
can change it.**

*What is blocked:* nothing. It is a sentence that can contradict the line above it.

**6. `pnpm eval` now fails without an Anthropic key. Leave it failing, make it skip, or
supply a key?** `T2.3` added the first evaluation set that grades what a real model
actually produces — 50 products in 7 languages, marked against hand-written answers. Its
author made it **refuse to run against a stand-in**, on the grounds that a stand-in would
report a pass meaning nothing. There is no key, so the command now fails by name.

**Nothing is broken by this and CI on `main` is unaffected** — the eval job is
pull-request-only and path-gated, and takes its key from repository secrets, so the design
always assumed a real key. **What it changes is the local gate**, which is now nine of ten
commands green plus one red for a documented reason. Every card from here inherits that,
and a report claiming "eval passes" would be false.

*The three ways out.* **Supply a key** — the eval then does what it exists for, and costs
real money each time a prompt changes. **Make it skip loudly** when no key is present —
the gate goes green again, at the price that "the model side has never been tested" stops
being visible every time anyone runs it. **Leave it failing** — the most honest signal, and
the most likely to be tuned out.

*What is blocked:* nothing, but this is the only part of the product whose quality nothing
has ever measured, and it is the part the whole content engine rests on.

**7. The deployed start command would not find the build.** `railway.toml` runs the
server from the repository root while the build output is in `apps/web`, so the server
would exit with "Could not find a production build". Two one-line fixes; which is right
depends on what working directory the platform gives the service, and the project has
never been deployed, so nobody knows. **This stops a deployment, not a build**, and
`pnpm smoke:boot` cannot catch it because it starts from the application directory. It
is in no card's scope and should be settled with the other deployment questions — the
platform's config format is also deprecated and the project's old service was deleted.
Full detail is in the "BLOCKER — the deployed start command" section above.

**8. ANSWERED 2026-09-03, 12:40 — the threshold moves to 10, opening positions 11–30.
Changed, gated, committed as `d3758c7`.** `our_absent_position_max` in
`signals.config.yaml` moves from 20 to 10; the detector already read the number, so no
code changed. `rules_version` moved with it (`9fb26ae9…` → `2bd23161…`), the committed
config snapshot was regenerated, and `packages/rules` plus the signals suite are green.
**`T3.6` is unblocked and its done-when stands exactly as written** — the #18 fixture
it names is now producible. Full detail: `DECISIONS.md` `2026-09-03 — FOUNDER — The
competitor-gap signal fires unless we already rank in the top 10, not the top 20`.
**Original question kept below for context.**

*Original question: should the competitor-gap signal fire at position 18, or only
below 10?* The spec
says one thing in its rule (main §7.3: fire only when we hold **no position 20 or better**)
and another in its own worked example and action column (main §7.8 and the same row: a page
of ours at **#18** should be improved). Both can't be true — #18 is inside "20 or better."
`T3.5` shipped the literal rule, which means a store sitting at position 11–20 for a
competitor-covered search produces **no signal at all today**, confirmed by running the
detector against a live position-18 input. `T3.5`'s scheduled audit re-derived the same
contradiction independently before reading the card's own journal entry.

*Two one-line fixes, genuinely different in effect.* Move the config threshold
(`our_absent_position_max` in `signals.config.yaml`) from 20 to 10, matching the
competitor's own threshold — this opens the whole 11–30 band to the signal, which is more
detections than the spec's rule as literally written allows. Or leave the threshold and
rewrite `T3.6`'s stated done-when to name a position in 21–30 instead of #18 — cheaper,
and it accepts that positions 11–20 simply produce nothing.

*What is blocked:* `T3.6` cannot be built as its own done-when is currently written —
that done-when names exactly the #18 fixture the shipped code can never produce. Lane C
stops after the `T3.5` audit and does not start `T3.6` until this is answered.

**9. Where does an article go when the merchant overrules the quality gate?** Today it
returns to `draft` and rejoins the ordinary delivery path. It has to leave `rejected` or
nothing would ever deliver it, and no state means "rejected but publish anyway". **The
`T4.4` auditor's assessment, which this session agrees with: the reasoning is right and
the state is the weak part.** `draft` already means "written, not yet graded", so that one
value now covers three situations, and the only thing separating them is a flag whose
meaning is "excluded from learning", not "cleared to deliver". If publishing later asks
"which drafts go out today", it gets un-graded articles too unless every query remembers
to join the gate-decision table. *Options:* keep `draft`, or add a fifth state meaning
"cleared to deliver" in the next schema wave — **cheaper now than after `T5.1` builds on
it.** *Either way, a second question:* should an overridden article still pass through
draft review on accounts that have review turned on?

**10. May the judge's own sentences be shown to the merchant verbatim?** The constitution
says every user-facing "why" renders from templates, never from a model. The spec says
the rejection card and the override dialog restate the judge's failing criteria in plain
language. Gate 3 currently interpolates the model's own sentence into the merchant's
reason card. **This is a contradiction between the constitution and the spec, not a coding
mistake** — it needs a ruling either way. (Note: a justification may also come back in
the store's own language inside an otherwise-English sentence.)

**11. Is a weaker quality bar for non-English stores acceptable at launch?** A Danish
store's drafts are checked for numbers, measurements, percentages and durations, but not
for superlatives, absolutes, attributed statements or comparisons — and the merchant
cannot see the difference. It *is* recorded on every gate decision, so it is auditable
rather than silent. *Options:* accept for launch and say so, or fund per-locale word lists
before the first non-English store.

**12. Should the judge's model be lockable?** An operator can point the judge at the cheap
model today with one environment variable that ships in `.env.example`, and neither the
code nor CI would notice — **and the spend would be misreported, since the expensive price
list is kept.** Invariant 11 says never substitute a smaller model for the judge; the code
honours that everywhere except this one configuration route.

**13. HALF-ANSWERED 2026-09-03, 23:25 — build the emission. Carded as `R-DELIVER`, Lane D, in progress.** The founder chose the auditor's and both sessions' recommendation over hiding the toggle or shipping it broken; it is placed in Lane D rather than Lane G because the call site is in Lane D's directory and `T5.1` is about to edit the same file. **The second half of this question stays open: should an overridden article still pass through draft review on accounts that have review turned on?** Today it rejoins the ordinary path. Full detail: `DECISIONS.md` `2026-09-03 — FOUNDER — The draft-ready notification is built now`. **Original question kept below for context.**

*Original question: does draft review ship without any way to be told a draft is waiting?* The toggle
exists, defaults to off, and switching it on today makes articles disappear: nothing emits
the notification, the dashboard's attention list is a live stub returning empty, and the
screens that would list the draft are not built. *Options:* build the emission first (the
smallest — the type, the copy and the email template are all already written, only the
sending is missing); hide the toggle in Settings until it exists; or ship it and accept
that anyone who finds it gets a broken experience. **The auditor's recommendation and
this session's: build the emission — it is the smallest of the three and the only one that
leaves the product honest.**

**14. Should throwing away a draft also mean "stop suggesting this subject"?** Today it
does not: discarding closes the calendar day but leaves the subject available for future
planning, on the reasoning that rejecting one weak article about a subject is not
rejecting the subject. **The auditor agrees and so does this session** — but it is an
undictated product choice that changes what merchants get, journalled rather than asked.

**15. Six hours of runway before publication — is that the right number?** New, specified
by nobody. It decides how much room the writer, the checks, the judge and the one repair
attempt have before the article is due out. A reasonable first guess; **never measured
against a real run.**

**16. For a store that publishes at 02:00, which day's article is it?** The one written
the evening before, or the one dated the morning it appears? The code answers "the evening
before", which leaves the calendar and the store **permanently one day apart** for any
store publishing before 06:00. Whichever answer is chosen, the MEDIUM day-skew finding
needs it. **This is `T5.1`'s subject matter and the fix belongs in that card rather than
as a patch afterwards.**

**17. `pnpm chaos` is now red on one scenario. Leave it failing, or resolve it?** `T4.6`
wrote a chaos case proving `T4.5`'s HIGH finding: a generation run killed before the
store's local midnight is never picked up once the retry lands the next day — the article
is written, never graded, the calendar day sticks on "generating", and **the queue records
the retry as a success**. It is one named scenario of eight; the other seven pass.

*Why it was not simply fixed:* every way of converging is a product decision. Finishing
yesterday's draft today puts an article on a day the calendar never scheduled, which
brushes invariant 14. Abandoning it means deciding what the merchant is told about a day
that silently produced nothing. A sweeper is a third shape with its own cadence. It is also
not one clause — the resume is only consulted when today has no planned topic at all, so a
store with a full calendar never reaches it either.

*The recommendation, from the card and endorsed by this session:* a sweeper that finds
topics stranded past their own day, finishes the one furthest along, and dead-letters the
rest.

*The cost of leaving it red:* the same cost `pnpm eval`'s red has — a gate with a standing
failure trains people to skim it. **Mitigated by it being one *named* scenario:** a failure
anywhere else in `chaos` is a genuine regression and still visible as one. The precedent is
exactly `pnpm eval`, left failing all run as the honest signal rather than made to pass.

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

### `T5.2` — the scheduled audit, run 2026-09-04, read-only. **One CRITICAL, three HIGH. The CRITICAL is one word long and the integrator verified it end to end.**

Required by build plan §7. Pinned to `1d66186..0681cda`. Expectations written from the spec
before the diff was opened.

**[CRITICAL] The founder's own condition for switching the recurring schedule on is now ONE
STRING RENAME from being met — and it looks met when it is not.**

*The integrator verified every step of this himself rather than relaying it, and corrected the
audit's framing once on the way. The facts:*

- The worker refuses to enable **any** scheduled job unless **every** scheduled entry has code
  registered under exactly that name (`bootstrap.ts`: `enableCron = missing.length === 0`). One
  mismatch disables the whole schedule, silently, with a single log line.
- **Founder question 4, answered 2026-09-03, chose to wait** for the four then-unanswered
  entries rather than relax that rule: `generation_cycle_daily`, `signal_scan_weekly`,
  `replenishment_monthly` and `publish_intent_recovery_sweep`. **So the schedule being off is
  the founder's own decision, not a surprise, and the audit's framing of it as "the product's
  entire clock is off" overstates the news.**
- **What is new:** three of those four have since landed. The fourth was `T5.2`'s to fill.
  `T5.2` built the sweep, tested it and registered it — under the name **`publish_recovery_sweep`**
  (`packages/jobs/src/publish/tasks.ts:34`), while the schedule has named
  **`publish_intent_recovery_sweep`** since M0 (`crontab.ts:116`). The two strings do not match.
- **It is now the only mismatch.** The integrator diffed the full schedule against every
  registered name and got exactly one — and checked a false positive before reporting it: a
  first pass suggested `subscription_reconciliation_nightly` was also unanswered, but that
  handler is registered from `apps/web/app/api/webhooks/stripe/_lib/tasks.ts`, outside the
  directory the first grep covered. **The audit's "only one" claim is correct.**

*Why this is worse than the lane reported.* `T5.2`'s own journal says the crontab "has no
entry for it… so nothing goes red; the sweep simply never runs", and offers a verbatim entry
to add. **Both halves are wrong.** The entry has existed since M0; it is the handler that is
misnamed. And **adding the suggested line would have made it worse** — two entries, one still
unanswered, and the schedule still off.

*The fix, when the founder authorises it:* rename the constant at
`packages/jobs/src/publish/tasks.ts:34` to `publish_intent_recovery_sweep` (the smaller of the
two directions — that file is Lane D's, while the crontab is integrator-resolved). **Then add
the check that would have caught it**: today a name mismatch *disables* the schedule; it should
*fail*. That is a reporter that cannot fail wearing a green tick, and it belongs with `T10.2`.

**[HIGH] The "did my post already land?" check reads one page of the blog, so on an
established blog it can answer "no" when the answer is yes — and post a second copy.** The
lookup fetches up to 250 recent articles in a single request, with no paging and no
server-side filter, and searches that page for our marker. A blog with more than 250 posts —
ordinary for a store that already blogged, or after a year of this product — may not include
ours. The sweep then concludes the post never landed and re-sends it: **exactly the duplicate
the whole two-phase protocol exists to prevent.** No test can see it, because the fake shop
searches its entire in-memory map with no page limit — **the fake cannot fail the way a real
shop fails.**

**[HIGH] The sweep looks for the post in whichever blog is the target *today*, not the blog
the post was sent to.** Main §9.5 explicitly allows changing the target blog later and says
doing so never moves already-published articles. If a merchant changes it while a publication
is unsettled, the sweep searches the new blog, finds nothing, and re-sends — a duplicate, in a
different blog. **The claim row has no column recording which blog the post went to**, so this
cannot be fixed without a schema wave.

**[HIGH] Any transient Shopify failure at the moment of posting strands that article for
ever, and a rejected token is never reported to the merchant.** There is no error handling
around the post itself. A rate-limit, a 500, a network blip or a revoked token throws out
after the claim row is already open; the retry collides with its own claim, reports
"already claimed", and does so every day thereafter. Only the recovery sweep could free it —
and that is the sweep the CRITICAL disables. Separately, the product already has the machinery
for a rejected Shopify token (it drives the reconnect banner and the 24-hour email) and **the
publishing path does not use it**, so that merchant gets silence. Invariant 22 requires
degrading to a *visible* pause.

**Seven MEDIUM.** (1) The address recorded for every published article uses the blog's numeric
id where Shopify uses its name-slug — **the lane suspected this and was right**; the correct
value is already stored and unused, and the damage lands later, because that address is what
Search Console attribution matches traffic against, so a working article would appear to earn
nothing for ever. **The fake builds the same wrong address**, which is the clearest sign it was
written from the code rather than from the vendor. (2) When publishing stops — permission
withdrawn, blog deleted, connection broken — **the merchant is not told**; a store can sit in
auto-publish mode publishing nothing, indefinitely, with no problem shown. (3) The contract
divergence is **five endpoints**, not one, and the Settings screen's "grant posting permission"
button points at the **read-only install flow**, which would loop for ever without ever
granting write access. (4) A live post can end up with no record of it, if the merchant
discards the article in the window between sending and recording. (5) **A republish overwrites
what the merchant did to the post** — their tags, the article's address, and their choice to
unpublish it. Latent until `T5.3`, which is the next card. (6)/(7) as recorded in the full
report.

**Seven LOW**, including: "give up after three tries" is derived from a clock rather than a
counter, so a slower sweep abandons after one look; a signing key falls back to a literal
string in source; and **46 spec citations in code comments across four lanes**, which
`CLAUDE.md` forbids — systemic, not this card's.

**The chaos case is sound and the auditor proved it rather than assuming.** It genuinely kills
the worker at the one instant that matters — the post is on the merchant's site and nothing of
ours has recorded it — the kill is deterministic and cannot be seeded somewhere safer, and the
assertions count creates on the fake shop so a duplicate would fail loudly. **But the suite
around it discards `result.kills`**, so a scenario whose kill never fires is indistinguishable
from one that passes. Pre-existing; another reporter without teeth.

**What it verified sound.** Invariant 21 holds in substance: the install path is untouched and
still *throws away* a token carrying any write scope; the second grant is a separate route,
consent screen, callback and signed value with its own purpose stamp; the store name comes
from the connection the merchant already made, so a signed-in merchant cannot be walked into
granting access on someone else's store; and auto-publish's two conditions are a `WHERE` clause
in the database, so it is a property of the data rather than of one code path, while switching
*off* is always allowed. **Grepped for theme, asset, redirect and script-tag writes: there are
none anywhere in the provider.** Invariant 19 holds on every path that could be exercised: the
claim precedes the send, a unique index decides who holds it, the marker is derived from the
article's id and never random, confirmation is a guarded update, adopting takes precedence over
giving up, and **there is no create path out of the update function at all**. Invariant 18
holds. Entitlement, vacation and kill switches are all read from local state with no Stripe
call in the path. Product values genuinely are re-resolved from the store at publish and again
at republish, through the same code the download uses, so a download and a post cannot
disagree.

**What it could not check, stated plainly.** Anything needing a real Shopify store — there is
no development-store credential in this environment. Its judgement on the fake: **good evidence
for our own protocol, and no evidence at all about Shopify.** The fake cannot rate-limit,
cannot reject a token, cannot rewrite a colliding slug, cannot paginate, and cannot refuse a
metafield — **and the entire "fall back to a tag" design exists for that last case and is
untested.** Done-when claims resting entirely on the fake: the chaos case, the
remotely-deleted-article case, and the dev-store smoke, which is simply **not met**. Claims
that stand on their own, all database-backed: price-changed-before-publish, deleted-product,
no-blog-no-auto-publish, and the read-only-grant re-assertion.

**Five founder decisions buried here.** (1) **Every article Sortiva posts carries a visible
`sortiva-<id>` tag in the merchant's own Shopify admin**, which can surface in storefront tag
lists — journalled as a technical necessity, never put to the founder. (2) **A republish
overwrites the merchant's own changes** — a "we own this post once we make it" stance nobody
chose. (3) **Who owns the Settings API** — three cards have now deferred it; it is a question
of which lane gets the ground, not a coding question. (4) **Whether a Shopify development
store is procured before M5 closes** — the card's first done-when cannot be met without one.
(5) **Auto-published articles have no images**, against main §9.2.

**Consequences the integrator took:** none beyond recording. `T5.3` was already blocked on the
`CatalogEvents` decision, so no new stop was needed. **Nothing here has been acted on.**

### `T6.2` — the scheduled audit, run 2026-09-04, read-only. **One CRITICAL, four HIGH. It stops `T6.3` and it vindicates not wiring the job.**

Required by build plan §7 before `T6.3`. Pinned to `c46812d~1..6be6f95` so later work on the
branch could not confuse it. Expectations written from the spec before the diff was opened.

**[CRITICAL] The feature is switched on nowhere, and the first two attempts to use it break
the account permanently.** The integrator already knew the job was unregistered; **the
consequence is far worse than "nothing happens", and this is the part nobody had.** Pressing
the button marks the opportunity `executing` *before* queueing. Nothing ever picks the work
up, so: the merchant watches a spinner that never resolves; the daily allowance counts
`executing` rows as spent, so **two presses consume the store's allowance of two for ever,
not just for the day**; and the transition guard only admits `new`/`accepted` → `executing`,
so those opportunities can never be retried — the API answers 409 from then on. **Recoverable
only by editing the database.**

**[HIGH] There is no way out of "generating" when the work is refused or crashes.** The job
returns the opportunity to `accepted` on exactly two paths — success and validation failure.
`paused` (the store's call type is switched off), `skipped` (page not in the inventory) and
any exception leave the row where it is. Grepped: no sweeper, no timeout, no reaper exists
anywhere. **This survives fixing the registration**, and produces the identical permanent
stuck state.

**[HIGH] The nightly spend sweep switches OPTIMIZE off permanently for ordinary use — the
lane's reading was right, and incomplete.** It counts **model calls**, not generations; it
trips at `used >= cap` rather than above it; and the flag is sticky until an operator clears
it. So a merchant who uses both of their two daily recommendations — **or one recommendation
that needed its single automatic retry** — has OPTIMIZE switched off for good. Two things the
lane did not say: the same defect applies to the intent-gap call type, and **when it fires the
merchant is shown the outage copy** — "we paused this action rather than continue with
lower-quality or stale data" — which tells them we protected their quality when they in fact
hit an accounting bug. The operator-facing incident text also states a count that is wrong.
Lane G's file.

**[HIGH] One of the four signals that produce an OPTIMIZE opportunity carries no search term,
so the pipeline buys a Google results page for a URL.** Three signals record a query cluster;
`missing_or_weak_metadata` records none, and the pipeline falls back to **the page's own web
address as the search**. It then pays the search vendor for results for
`https://store.example/collections/boots` as though it were a search, tells the model "The
search: <that URL>", and measures keyword stuffing against the words in a URL. Likely end
state: a failed recommendation, after spending the merchant's allowance and our vendor money.
Nothing logs it. Spans two lanes, so the fix is the integrator's to place.

**[HIGH] The four endpoints are not in the frozen contract, and nothing can detect that.**
Already known; the audit adds what makes it worse. The frontend's mock server is **generated
from that table**, so Lane F would build the drawer against two endpoints that do not exist
and have no mock for the four that do, including the download ui §5.3 requires. There is **no
test anywhere comparing shipped route files against the contract** — the one test that walks
route files skips any path the table does not declare, so these four escape even the
account-scoping safety net (they are correctly scoped; nothing checks it), and they bypass the
contract-level test that enforces invariant 8.

**Five MEDIUM.** (1) The card performs three status transitions the project's own state
machine forbids (`new`/`accepted` → `executing`, `executing` → `accepted`) and nothing throws,
because the database helper never consults the graph — the auditor judges **the code right and
the graph wrong**, but it is unjournalled and `T6.3` will read that graph as truth. (2) The
"why we suggested this title" field is a free-form string the model invents, validated against
nothing, with no matching copy in the catalogue — so whatever phrase the model puts there is
what a merchant risks seeing. (3) A canonical Appendix A sentence was **retyped inline**
instead of read from the catalogue, so the snapshot test that guards it cannot see this copy
and the two will drift. (4) The duplicate-paragraph check is blind past ~6,000 characters and
that number is not in `packages/rules`, so on a long page the product can confidently tell a
merchant to add a section their page already has. (5) Nothing stops one of our **own published
articles** entering this path, which main §10.5 forbids — and the code contains a written
brief inviting it.

**The "no Shopify writes" check is real, not vacuous — with one hole.** Asked specifically to
test whether it could fail, the auditor probed it: it catches importing the client, naming a
write scope, a GraphQL mutation and the publish-intent table, and it fails loudly on an empty
directory. **It does not catch a REST write through a client handed in as a dependency**, and
it has no positive control, so if the provider class is renamed all four patterns quietly stop
matching and the test stays green.

**Six LOW**, including: a failed recommendation records `model_id: 'unknown'` though the model
was known; two copies of the same helper disagree, so a downloaded document can name a
different search than the one the recommendation was written for; and `eslint.config.mjs` — an
ordered, integrator-resolved file — was edited without the report saying so.

**What it verified sound, since it is load-bearing.** The fabricated-citation test is a
genuine negative — it plants a plausible product reference the evidence pack never held and
asserts the check names it. Nothing writes to the merchant's store, in substance and not only
by grep. The quarantine holds: the page body comes from the inventory's stored text, product
facts arrive only as distilled sheets. Nine thresholds landed in `packages/rules` with
plain-language notes and `rules_version` moved with them. **The grader is deliberately
stricter than the article grader** — the card ignores the shared seam's verdict and re-decides
on the minimum against its own floors, which is what the spec requires and what the shared
seam would have quietly under-delivered. Account isolation is joined through the opportunity
and tested. One retry then stop. Supersession, never deletion. The download escapes every
variable before writing HTML. All 64 tests were re-run by the auditor rather than taken on
trust.

**Three founder decisions were made silently and need a ruling**: (1) the grader's verdict is
final with no second chance, so a merchant's daily allowance can be consumed by our failure;
(2) a suggestion may be grounded **entirely in what competitors say**, with nothing from the
merchant's own store behind it — sound reasoning, journalled, but it widens what "grounded"
means in a product whose pitch is that it does not make things up; (3) **where model prose may
reach a merchant** — the drawer and download carry a model-written paragraph, which the spec
explicitly asks for and which is therefore right, but it is the exact boundary invariant 8
exists to police and it was set without comment.

**Consequences the integrator took, which is all he is permitted to take:**

- **`T6.3` is STOPPED.** Not for a technical reason — the auditor's (a): `T6.3`'s own
  done-when drives an OPTIMIZE opportunity through its states, and the state graph it will
  read does not contain the transitions `T6.2` performs. It would trip over that or silently
  copy it. The graph is Lane C's file and correcting it is acting on a finding.
- **The M6 exit gate must not be allowed to pass while the job is unregistered**, because the
  gate's whole job is to re-run the consumer's tests against the real implementation and there
  is no reachable implementation.
- **Not wiring the job was right, for a bigger reason than the one recorded earlier.** The
  earlier reasoning was "it switches on a paid pipeline that has never run". The real reason is
  that wiring it without the stuck-state fix would make the CRITICAL reachable rather than
  theoretical.

### `T4.5` — the scheduled audit, run 2026-09-03, read-only. **Two HIGH findings; one blocks `T5.1`/`T5.2`. It also corrects a claim this file made.**

Required by build plan §7 before `T4.6`. **Cleared `T4.6` to start**, ran 151 tests across
26 files against real Postgres, and verified every load-bearing claim independently.

**[HIGH] An override-published article can never be delivered — and this blocks the
publishing cards.** **AUTHORISED AND BEING FIXED 2026-09-03, 23:25 — the founder took both halves of the fix; carded as `R-DELIVER`, Lane D, in progress. `T5.1` is unblocked the moment it merges and gates.** Independently re-verified by `sortiva-92` against the code before dispatch: the finding is exactly right. When a merchant overrules a quality rejection, the article returns to
`draft` with the override flag set, exactly as `T4.4` and `T4.5` both intended. But
`articlesReadyForDelivery` — **the read `T5.1`/`T5.2` are explicitly told to build on** —
returns an article only if its topic has a Gate 3 decision whose outcome is literally
`passed`. **An overridden article's only decision is a rejection.** So the article is
excluded, and the "publish anyway" path would be built, tested against a passing draft,
and silently do nothing for the one case it exists to serve. Nothing is broken in
production today (the override route is not built yet). **Fix is one clause plus a test,
in `packages/db`, and should land before `T5.1` starts.**

**[HIGH] A run interrupted late in the day is abandoned silently, and the retry reports
success.** The cycle resumes a dead attempt by looking for a topic left `generating` **on
today's date only**, and deliberately re-reads the store's clock rather than trusting the
queued date (right, for avoiding back-filled bursts). The unstated consequence: **once the
retry lands after local midnight, yesterday's half-finished topic is unreachable forever**
— nothing else ever looks at a `generating` topic (grepped: no such sweep exists). And it
does not fail loudly: the retry finds nothing planned for the new today, returns "skipped",
and **the queue marks the job green**. No dead letter, no alert, no user-visible error —
just a calendar slot stuck on "generating", a draft paid for and never delivered, and a
lost article-day. **Ordinary rather than exotic** for a store whose writing starts in the
evening (see the day-skew finding). *Also:* `T4.6`'s own chaos done-when ("kill
mid-generation converges") **will pass without exercising this** unless it advances the
clock past midnight.

**[MEDIUM] A store that publishes before 06:00 gets the wrong calendar day's article.**
Writing starts six hours before the publish hour, wrapping backwards over midnight
(deliberate and tested). But the *day whose topic is taken* is the local date when writing
starts. For a 02:00 publisher, Tuesday's topic is written Tuesday evening and appears
**Wednesday** — permanently one day out between calendar and reality. The publish hour is
merchant-settable with no lower bound, so this is configuration, not a corner case. One
line: derive the day from the clock at the *publish* moment.

**[MEDIUM] The reused draft is matched to the new plan by position, not content — and the
claim made about it, including in this file, is not accurate.** Claim ids are purely
positional (`c1`, `c2`…). The reuse check only asks whether each cited id *exists* in the
new plan, so **a re-planned set of the same length — different facts, same count — passes,
and the stored draft is graded with its citations silently re-pointed at different
facts.** It catches only a plan that got *shorter*. Partly mitigated downstream: Gate 3
verifies any *number* in a sentence appears in the claims it cites, so numeric
mis-binding is caught; a superlative, an attributed statement or a qualitative product
fact is not. **This section previously repeated the landing session's stronger claim; that
was wrong and is corrected here.**

**[MEDIUM] "One topic per day" has no database constraint behind it.** The ledger key is
derived from **topic plus date**, not **account plus date**, so the guarantee rests
entirely on there never being two `planned` topics on one date — which rests on a
check-then-insert in the manual-add route with **no unique index on `(account_id,
scheduled_date)`**. Two simultaneous adds both pass the check and both insert; that day
could then dequeue twice. **This is the exact shape invariant 1 rejects for domain
claims** ("insert-with-conflict, never check-then-insert"). Fix: derive the key from
account plus local date; separately, a partial unique index in the next schema wave.

**[MEDIUM] Daylight saving can skip a store's day.** On spring-forward one local hour does
not exist; a store whose writing hour is that hour is never matched and gets no article,
silently, with no log line saying why. (Autumn's repeated hour is safe — the ledger key
stops the second pass. Traced specifically.) One lost day per year per affected store.

**[MEDIUM] Two guarded updates ignore their zero-row result.** If the merchant vetoes a
topic while its article is being written — the race main §8.7 explicitly describes — both
updates match zero rows, the draft is already discarded, and the cycle **nevertheless
reports that the merchant was asked to review it** and emits an analytics event saying so.
Nothing is corrupted; the outcome recorded is false. It matters more once something emits
the "your draft is waiting" notification from that branch.

**[MEDIUM] Draft review is unusable, and the M4 stub gate now fails.** The landing
session's flag is **accurate and if anything understated**, verified independently:
nothing emits `draft_ready_for_review` (only tests reference it); the dashboard's
attention list is a *live* stub returning empty and recording "stub was used"; and
`GET /api/articles` and `/api/articles/{id}` are in the frozen contract but do not exist
as files. **New fact the landing report did not have: `pnpm stubs:report --milestone=M4`
FAILS**, listing seven stubs overdue at M4 — one (`TopicScheduler`) is stale bookkeeping
since production uses the real implementation, but the attention stub is genuine. **The
auditor's verdict: a launch blocker, but a narrow one** — review defaults to off, so it
blocks nothing for a merchant who never touches it, "but shipping a settings toggle whose
only effect is to make articles vanish is worse than not shipping the toggle."

**Four LOW findings:** a missing store profile strands the day *after* the dequeue (check
belongs above it); nothing structurally prevents two article rows for one topic
(unreachable today, but the constraint would make the adoption checkpoint provably rather
than inspectably safe); the no-editor guarantee is genuinely strong on bodies (one writer
in the whole repository) but its route scan covers only one folder; and "stops before
spending anything" is proven for model calls only — true by structure for search calls
too, but not asserted.

**The residual re-spend, quantified — and a correction to `DECISIONS.md`.** A full run is
three model calls (plan, writer, judge), plus a fourth if the document has candidate
contradictions and a fifth for the repair, plus one billable search request. **Inside 24
hours with byte-identical inputs it is genuinely free.** Outside that, or once the
catalogue or the search results move, a crash costs **roughly four fifths of a second
article** — everything except the writer's call. That is a real improvement on the "whole
second article" the `T4.4` audit found, but the journal's word "free" is doing more work
than the mechanism supports: the prompt is built from a pack containing live search
results, so a same-day retry after the search cache expired is not free.

**The three questions:** (a) **`T4.6` is not blocked** — but two of its own exit criteria
are at risk: its chaos case passes without exercising the HIGH resume finding unless the
clock crosses midnight, and the M4 stub gate does not pass today. It is also the natural
card to ask the integrator for the missing one-topic-per-day index. (b) **`T5.1`/`T5.2`
are blocked by the override finding** — fix it in `packages/db` first. They also inherit
the day-skew (squarely their subject) and a verified-sound approve path. (c) **Four
founder decisions — see questions 13–16 below.**

**What it verified sound, since it is load-bearing:** all five dequeue checks present, in
order, each stopping before the pipeline is entered at all — before the evidence pack, the
search request and the page fetches, not merely before the model call; entitlement read
only from the local subscription row with no Stripe call anywhere in the path; the spend
cap reaching dequeue as an operator flag written by our own sweep over our own counters,
no analytics service in the path; the idempotency key genuinely derived and never random;
a completed key returning stored output without running anything; the ledger refusing
updates at database level so a replay cannot get a different answer; the whole run
genuinely inside the per-account lock; future topics unreachable by construction; and no
editor — two routes, no change-shaped methods, one writer of an article body in the
entire repository.


### `T4.4` — the scheduled audit, run 2026-09-03, read-only. **Two HIGH findings, and four decisions for the founder.**

Required by build plan §7 before `T4.5`. It has run, changed nothing, and **cleared
`T4.5` to start**. It verified every claim independently rather than reading the report —
including running the checks against sample sentences to find what they miss.

**What it confirmed sound, and these are the load-bearing ones:** the ordering claim
genuinely holds (no model call can be spent before every free check passes — every branch
read, no path around it); the judge is genuinely blind, on the first grade *and* the
regrade; a third repair attempt is unreachable within a run and cannot be bought by
raising the config number; information gain's exception ends the run with zero repair
calls; the calibration exclusion is correct and correctly account-scoped, including the
`NOT IN`-with-NULL trap that would have silently emptied it; the citation check really is
independent of the writer's markers; and `judge.eval` genuinely discriminates — a
degenerate judge scoring everything 4 posts errors of 0.95–1.70 against a 0.5 ceiling and
12 false passes.

**[HIGH] A Gate 3 decision does not record which thresholds decided it.** Invariant 9
requires `rules_version` — the hash of the numbers file — stamped on every gate decision,
which is the whole point of logging them to audit drift. The audit blob carries scores,
justifications and failed criteria, but no rules version, and the table has no column for
one. **Repo-wide, not new here** (Gates 1 and 2 are the same), but `T4.4`'s own
calibration query is the first consumer that needs it. Fix is one line into the existing
JSON blob — no migration.

**[HIGH] The self-contradiction check is skipped on a repaired draft.** Every other free
check re-runs on the revision; this one does not. **A repair is a rewrite of exactly the
sections the judge objected to — the most likely moment for a second, different figure to
appear** — and the regrade that follows never asks about internal consistency. The revise
prompt asks the writer not to contradict itself; nothing verifies it.

**[MEDIUM] The contradiction ruling fails open.** Only verdicts marked `contradiction` are
kept, and nothing requires one verdict per candidate pair — a model returning an empty
array, or silently dropping the pair that mattered, reads as "no contradiction".

**[MEDIUM] The judge can still be downgraded, through configuration.** In code it is
properly locked: the request names no model, a per-call override is refused for judging.
But the tier resolves through `ANTHROPIC_MODEL_SONNET`, an environment variable shipped in
`.env.example`, which accepts any model id. Pointing it at Haiku silently downgrades the
judge **and misreports the spend**, since the Sonnet price list is kept.

**[MEDIUM] The title, meta description and every heading escape the citation and strength
checks.** The checks walk intro, section bodies and FAQ answers only — confirmed by
running it. So *"The 5 best hiking packs under 2 kg"* as a title carries a number and a
superlative, uncited, and passes. **The title is the most-read line and the one that
appears in search results.**

**[MEDIUM] The checkable-content detector misses several common ways of stating a fact** —
verified by running it: `"IP67 rated"` (spec codes), `"holds twenty litres"` (written-out
numbers), `"the quietest motor"` / `"our top-rated option"` (only a fixed 21-word
superlative list, no general `-est`), `"half what the Beta does"`. Each is a sentence that
can then assert anything with no citation. **The mechanism is right; the word lists are
the gap.**

**[MEDIUM] Near-duplicate detection against the ranking pages cannot realistically fire.**
Similarity is measured as the share of the *draft's* five-word runs found in the
comparison text, and the stored competitor excerpt is capped at ~250 words — so a
1,200-word draft that copied it verbatim scores ~0.20 against a 0.6 threshold. The
own-articles half compares full bodies and works. **A check that cannot fire looks exactly
like a check that is passing.**

**[MEDIUM] The override exists as parts and nothing binds them.** The flag write, the audit
payload and the dialog copy all exist and are tested, but nothing calls any of them (no
`/api/articles` route exists yet) and `'overridden'` is never written to `gate_decisions`
by any path. Whoever wires it must remember two calls, in order, in one transaction.
Not a defect in what shipped — the shape most likely to be got wrong later.

**[MEDIUM] The generation pipeline has no idempotency — a retry pays for a whole second
article.** No derived key, no lock, no checkpoint; a re-run after a crash creates a second
article row (`keyword-2`) and pays again for the claim plan, draft, contradiction ruling
and judge. **Nothing re-enters it today** (it is not registered as a job), so this is a
handoff requirement for `T4.5`, which owns orchestration — not a `T4.4` defect.

**Four LOW findings:** two `judge.eval` gold cases can't catch a false pass (gold
`informationGain: 3` is below the live floor, so humans failed them too, but neither is
marked `passed: false`); the eval's error metric treats `passed` as a phantom criterion;
three of four word lists match on substrings, so *"That claim is misleading"* reads as a
superlative and *"Our bestselling pack"* likewise — false rejects, the acceptable
direction, but each costs an article; and one reason string says "a revision didn't fix
it" on a path where no repair was attempted.

**The three questions, answered:** (a) **Blocks `T4.5`? No** — but `T4.5` must own
idempotency, and should know a passed article's state is `draft`, the same value it had
before grading, so only the `gate_decisions` row distinguishes "graded and passed" from
"never graded" after a crash. (b) **Blocks another lane? No** — `JudgeLite` is usable as
frozen by `T6.2`; `T5.1`/`T5.2` inherit the override's landing state; whoever builds
pattern learning must reproduce invariant 12's exclusion by hand, as there is no shared
helper. (c) **Founder decisions: four — see the section below.**

**Nothing here has been acted on. That is deliberate** — the overnight rules permit
stopping a lane on a finding and nothing else. **The `T-EMAIL` auditor was asked
directly whether any finding should block the next card in any lane and answered no**, so
no lane was stopped.

### `T3.6` — the scheduled audit, run 2026-09-03, read-only.

Build plan §7 requires this audit before `T3.7` starts. It has run, changed nothing, and
found one real gap worth a founder's attention before real data flows through it.

**[HIGH] A technical blocker discovered *after* an opportunity is already auto-accepted
never actually blocks it.** Plain terms: main §7.9 says a CREATE/OPTIMIZE opportunity
touching the same page as an open, blocking technical problem must sit at `blocked`
until that problem clears. The auditor traced a concrete, reachable case: a REFRESH
opportunity (one of our own articles) auto-accepts on first detection with no known
problem. If a later weekly scan finds a technical issue on that same URL, the write
that updates the row's evidence and its `preconditions` list **deliberately never
touches `status`** — a design choice made to protect a merchant's in-progress work from
being silently reset backward (the one case this *is* documented and tested for). But
the same mechanism also means the opposite, unsafe direction is silent: the row stays
`accepted`, and Lane D's calendar reads only `status` to decide what to auto-schedule —
so a now-blocked opportunity can still be picked up and generated. **`T3.6`'s own
`DECISIONS.md` entry names this exact trade-off but only defends the safe half of it**;
the auditor found no entry addressing the unsafe half. Verified independently, not
taken from the landing report — traced through `upsertOpportunity` and
`acceptedContentOpportunities` directly.

**[MEDIUM] Cannibalization always resolves to FIX, though main §7.8's own row allows
either FIX or OPTIMIZE.** Already flagged by the landing session as worth a second
look; the auditor confirms it's real, deliberate, and well-reasoned — not a defect —
but notes it changes which pipeline handles the opportunity (FIX/technical vs. the
OPTIMIZE recommendation flow) and is exactly the shape of choice the constitution asks
to be escalated rather than logged alone.

**[MEDIUM] The fallback score for `missing_or_weak_metadata` is a dead tie across
every candidate of that type.** The traffic-magnitude fallback (`T3.6`'s own documented
workaround for signals main §9.6.4/§9.6.5 give no formula for) reads the largest
impressions-shaped number in a signal's evidence — but `missing_or_weak_metadata`'s
evidence never carries one (only page type and field-name lists), so every metadata
opportunity a store has scores an identical raw `1`. Cannibalization's fallback, by
contrast, does vary meaningfully — its evidence does carry impressions. **Consequence:**
a merchant looking at ranked metadata opportunities has no signal for which page's
missing title tag actually matters more; they'll all land at the same low tier. Real
gap, not theoretical — traced against the actual evidence shape `metadata.ts` produces.

**[LOW] No stale-task cleanup on re-detection.** `insertOpportunityTasks` has no
"clear the old set first" step; nothing calls it outside tests yet, so this is latent —
whoever wires a re-detection loop to call it repeatedly (likely `T3.7`) needs to either
insert only on first sighting or replace the set, or task rows accumulate unboundedly.

**Two things the auditor verified sound, not just read:** the `entity_type` (`url`) vs.
the frozen contract's `EntityRef.kind` (`page`) mapping — confirmed correct, covers all
five values, 5 passing tests, not merely asserted; and the merge-conflict resolution in
`packages/db/src/repositories/opportunities.ts` — confirmed both halves genuinely kept,
`packages/db`/`packages/jobs` typecheck clean against the combined file, the real
Postgres-backed suite passes.

**The three questions, answered:** (a) **Blocks `T3.7`?** No — everything `T3.7` needs
exists, typechecks, and passes its tests. But `T3.7`'s own done-when ("running the
weekly scan twice converges") should consciously address the HIGH finding rather than
let it surface as a silent bug or slip through untested. (b) **Blocks another lane?**
No hard block; whoever builds the FIX/technical execution layer (main §11) should know
cannibalization only ever arrives as FIX; Lane F still owes copy for the new
`reason_template_key` values (already known, not new). (c) **Founder decision needed
before real data?** Two: whether the HIGH finding needs fixing before touching a real
store, given it's a genuine "never auto-publish past an unresolved technical problem"
gap; and whether cannibalization-always-FIX is acceptable as a permanent product
decision, since the spec deliberately left it open.

### `T3.5` — the scheduled audit, run 2026-09-03, read-only. **Its HIGH finding is resolved — the founder answered founder question 8, see above — kept for the rest of its findings.**

Build plan §7 requires this audit before `T3.6` starts. It has run, changed nothing, and
confirms rather than contradicts what `T3.5`'s own landing session had already found and
journalled — the auditor re-derived it independently, including by running the detector
against a live position-18 input, before reading `T3.5`'s own journal entry.

**[HIGH] The competitor-gap rule contradicts its own worked example, and `T3.6` cannot be
built as written until this is settled.** Plain terms: one signal — "a competitor ranks for
a search and we don't" — is defined by main §7.3 to fire only when **we hold no position 20
or better**. The same spec's own worked example, and the action the spec says that signal
should trigger, both describe a store that *does* hold a position — #18 — being told to
*improve* that existing page. Both cannot be true; #18 is inside "20 or better." **The code
followed the literal rule** (a config number, `our_absent_position_max: 20`), so a store
sitting at position 11–20 for a competitor-covered search produces **no signal at all** —
confirmed by actually running it, not just reading it. `T3.6`'s own done-when, already
written into the build plan, names exactly this scenario ("competitor-gap fixture yields
... OPTIMIZE with a URL at #18") — a fixture the shipped code can never produce. **Two
one-line fixes, and picking one is the founder's or the integrator's call, not a lane's**:
move the config number to 10 (matching the competitor side's own threshold, which opens the
whole 11–30 band), or rewrite `T3.6`'s done-when to name a position in 21–30 instead of #18.

**[MEDIUM] The empty `store_pages.intent_class` column caps the existing-target check at
"weak," never "strong," on every real store — confirmed independently, third card to report
it.** One half of the check that decides "does the store already have a page for this" reads
the *purpose* Shopify's own admin never asked the merchant to state explicitly. The database
column for it exists and nothing writes it — traced directly to the line that reads it
(`packages/jobs/src/scan/existing-target.ts:131`) and confirmed always null. The code's own
handling is sound (an unknown purpose reads as "weak," not a false yes or no, which is the
safe direction), but the practical ceiling is real: this lookup can currently never answer
"strong" on a real store. Same open gap `T3.4` and `T3.5`'s own session already named — this
is the third independent confirmation.

**[LOW] Deleted-page detection still reads every page as "still there."** Already an open
founder question from `T3.2`/`T8.0` (see below) — the auditor confirms the current handling
is the safer of the two possible mistakes and flags it only for visibility, not as new.

**[LOW] A shared test fixture contradicts one of its own worked examples' premises.** Worked
example 3 assumes "no suitable existing URL," but the shared synthetic-store fixture (used by
three lanes) auto-generates a collection page for every product family, including the one
example 3 uses — so the fixture's own generated page list actually contradicts the example's
setup. `T3.5` built its own test input by hand rather than from the fixture's generated list,
so its own tests are unaffected — but if `T3.6` or `T3.7` ever feeds that fixture's generated
pages straight into the check for this example, it will silently get OPTIMIZE instead of the
intended CREATE. Worth telling whoever picks up `T3.6` rather than letting them discover it.

**What the audit verified sound, not just read:** all of `T3.5`'s own test suites pass (826
tests in `packages/core` plus the scan package), including the specific cases the card's
done-when names; the contract stub report no longer lists `existingTargetCheck`; the check's
return shape matches the frozen cross-lane interface exactly; `T3.5` touched only its own
lane's directories; and the structural guarantee that nothing can create a page without
running the check first (a value only the check itself can produce) holds up under a
dedicated test.

**The three questions, answered:**
(a) **Blocks `T3.6`?** Yes — the HIGH finding. Everything else `T3.6` needs from this card
(the check itself, the other four signal detectors, evidence shapes) is sound and ready.
(b) **Blocks another lane?** No. `T4.1` (Lane D, the other consumer of the check) is not due
to start yet by the plan's own sequencing.
(c) **Needs a founder decision before real data?** Two: the position-20/#18 contradiction
above, and whether/how `store_pages.intent_class` gets populated — no card in the plan claims
it, and this is now the third card to say so (see the `T4.0` preparation section at the end
of this file, item 8, which records the same gap as needing an owner rather than a column).

**Consequence for this run: `T3.6` does not start.** Lane C stays held pending a founder
answer to the position-20/#18 contradiction, exactly as `docs/handoff-next.md` anticipated.

### `T8.2` — the scheduled audit, run 2026-09-02, read-only

Build plan §7 schedules an audit after `T8.2`. It has run. **Two high findings, neither
blocking any lane**, and the auditor answered the three questions it was asked.

#### HIGH — a permanently failing email retries for ever and never gives up

The spec wants three retries at widening intervals and then a dead letter. **The attempt
count lives only in the queued job's payload**, because the table has no column for it —
journalled at the time. But **the drain runs every minute and re-files every still-queued
row under the same job key with the attempt reset to 1.** The queue library's conflict
behaviour overwrites the payload and preserves only the run time, so the counter never
advances.

**Consequence:** a send the vendor keeps rejecting loops at roughly one-minute intervals
indefinitely. The row never reaches failed, **no dead letter is ever written, so the alert
that watches dead-letter depth never fires**, and the vendor is called once a minute per
stuck row. The dead-letter test passes a high attempt number by hand, so nothing catches
it. **Latent only because there are no credentials and the double never fails unprompted.**

#### HIGH — a monthly summary that cannot be assembled is lost, not delayed

When there is no signing secret the assembler deliberately declines to build the summary,
because without it there is no unsubscribe link and the mail would be unlawful. **But the
sender treats every decline as "the subject is gone" and marks the row failed.** The row
leaves the queue for ever, the unique triple refuses a replacement, and the hourly sweep
re-emits into a no-op.

**So a deploy briefly missing one secret silently destroys that month's summary for every
account** — and records the cause with the same sentence used for a deleted article. The
finishing session flagged that misleading message; the auditor found the damage behind it
is worse than the message.

#### The mediums, in one line each

- **Email sends take a *blocking* account lock and can starve the worker.** Emails are
  queued inside pipeline runs that hold the same lock, and a catalogue sync holds it for
  about eight minutes. Four such jobs and the process does no generation, no publishing and
  no sweeps until they clear. **The lock buys nothing the guarded update does not already
  buy.**
- **A link scanner can silently unsubscribe a merchant.** The unsubscribe performs the
  change on a plain GET, and the same address is both the header target and the visible
  link in the body. Corporate mail-security products follow body links. **This is the one
  finding that can change a merchant's settings without them acting.**
- **The no-denominator rule reaches only the copy keys one test fixture happens to
  produce**; three summary keys in the catalogue are checked by nothing. And the function
  written to enforce it at send time **has no caller anywhere**, while a comment claims it
  is called by the render. *The auditor agrees with where the check was placed* — judging
  our sentences with placeholders unfilled, rather than rendered text, is the only version
  that survives a merchant's article being called "A History of Wool".
- **The preference default written to the database contradicts the spec's default**, and
  the journalled contradiction describes the wrong harm. Every merchant who saves any
  setting is recorded as opted into a weekly digest. Nothing reads that column yet, so no
  mail goes out — **the real cost is deferred: the day the digest is built, a population is
  already subscribed without having asked.**

#### The answers to the three questions

**(a) Nothing blocks `T8.3` or any other lane.** Three things `T8.3` must be told: the
**deletion-confirmation email has nowhere to be recorded** (the suppression bypass is built
and tested, but the type column is an enum with no value for it); retention must prune
`webhook_events` by arrival time and tolerate **three** row shapes; and email sends are
12-month retention and cascade on account delete.

**(b) Five things before the first real email**, in the auditor's order: **the pipeline is
inert in production**, because the bell is still not plugged in — the one-line swap this
integrator deliberately left; **sending identity** (SPF, DKIM and DMARC on a dedicated
subdomain, plus the fact that a deploy losing either mail variable mails nobody and says so
only in a warning); the preference-column ruling; whether a GET may unsubscribe; and the
retry defect above, because **the first vendor outage otherwise becomes an unbounded call
loop with no alert.**

**(c) All six of the resumed session's fixes are real, and none introduced a new defect.**
On the specific question this integrator asked it to check — whether the
swallow-inside-a-transaction shape exists uncaught anywhere else — **it does not.** There
are exactly two other emission points and neither wraps the call in a catch; both go
through the same emitter, so the savepoint covers them.

**One caveat the auditor added, and it is worth knowing:** the transactional variant of the
emit **has no production caller** — only tests use it. So the tech spec's "written inside
the same transaction as the state change" **is not honoured at any live emission point
today**. That is a `T8.1`-era gap rather than this card's, and it is why the savepoint fix
is currently proved rather than exercised.

**On the copy ruling, the auditor agrees** — and adds the cost: moving `T-EMAIL`'s copy
into the catalogue makes a **fourth** hand-resolved conflict in a file that is not
union-merged. **"The ruling is right; the `.gitattributes` setting on that file is what
should change."**

**On whether the test double hides a real failure:** it enforces the idempotency contract,
which is the property that matters. **Two shapes it cannot show:** the path where the
vendor accepted a key and our own recording then failed, and the vendor rejecting a reused
key with a changed body — **which is reachable here, because copy is resolved at send time,
so a copy edit between two attempts changes the payload under an unchanged key.**

### `T2.2` — the scheduled audit, run 2026-09-02, read-only. **Its CRITICAL finding is fixed — `R-PRIVACY`, see above — kept for the rest of its findings.**

Build plan §7 requires this audit before `T2.3` starts. It has run. **It found one
critical defect, and the integrator verified that finding independently before recording
it rather than taking the auditor's word for it.**

#### CRITICAL — we store shoppers' email addresses and phone numbers while telling Shopify we hold none

**The finding, in plain terms.** Shopify sends every app two privacy messages: "a shopper
asked what data you hold about them" and "a shopper asked you to erase it". Our whole
answer to both is *we hold nothing about your shoppers* — and that answer is meant to be
true by construction, not by policy. It is true on the orders path: an order is reduced
the moment it is read, built fresh from a fixed list of fields, and the test that proves
it plants a full Shopify order with a customer block and shows none of it survives.

**But the webhook receiver stores the entire message body, verbatim, for every topic it
accepts — and those two privacy messages carry a `customer` object containing that
shopper's email address and phone number.** The code then logs the literal answer "no
customer data held" about a row that holds exactly that. Nothing deletes it.

**Why no test caught it.** The invariant-4 test scans *column names*; this data sits
inside a JSON blob in a column called `payload`. And the card's own webhook test uses a
fixture body of `{ shop_id: 1 }` — no customer block, so the failure is invisible.

**Verified by the integrator, not taken on trust:** the receiver writes
`payload: { shop_handle, body }` with the body unreduced
(`apps/web/app/api/webhooks/shopify/[topic]/_lib/receiver.ts:88-96`), and
`customers/redact` and `customers/data_request` are both accepted topics
(`packages/core/src/catalog/webhooks.ts:32-33`).

**Nothing is at risk tonight.** There are no Shopify Partner credentials, the app has
never been deployed, and no real Shopify traffic has ever reached this receiver. **The
exposure begins the first time a real store connects.**

**Not fixed, deliberately.** `docs/overnight-run.md` puts "act on an audit finding" on the
list of things this session may never do without asking. The fix is small — reduce the
stored body for the three privacy topics to the non-personal envelope, or store no body
for them, and extend the invariant-4 test to plant a realistic body through the receiver
and assert none of the shopper's values survive. **It should be the first thing done in
the morning, before any Shopify credential exists.**

#### The two HIGH findings

**1. A webhook that fails, or arrives while its store is busy, is discarded for ever.**
The module's own comments say such a row "keeps its place for the next pass". It does not:
the failure path stamps the row as processed, and the query that finds work skips
processed rows. **The busy case is not exotic** — it fires whenever a webhook lands during
the nightly walk of that same store, which is precisely the burst the design was written
for. No test covers the failure path. The nightly sweep would eventually re-find the
underlying change, so this is lost freshness rather than lost data.

**2. The change stream has no production consumer, and the check that should have said so
was switched off.** `T2.2`'s headline deliverable is filling this seam, and the producer
is real. But nothing in production registers or enqueues the consumer, and
`scripts/stub-report.mjs` — the gate whose job is to fail a milestone when the product is
running on a stand-in — had the corresponding line removed on the grounds that the seam is
filled. **Net effect: a seam that is now neither stub nor wired, reported as done.**
Lane C's event-driven inventory freshness is silently dark; the inventory is only as
current as the nightly walk. **This is an integrator decision — whether lane B wires it,
lane C does, or the stub-report line is restored until someone does — and the integrator
has not taken it, because it is acting on an audit finding.** Lane C is held for other
reasons, so nothing tonight changes either way.

#### The medium findings, in one line each

- **Order revenue's day-settling rests on a sort parameter Shopify's cursor-paginated
  orders endpoint does not document and may ignore.** A late order for an already-settled
  day would silently *replace* that day's total rather than add to it — an undercount. The
  stand-in cannot expose this: it returns rows in the order it was handed them and every
  fixture is already sorted. **Unverifiable without a real store.**
- **The nightly landing-revenue job permanently loses each day's earliest orders**, because
  its lookback window is UTC-relative while the day key is the store's own calendar day,
  and it replaces rather than merges. Nothing displays this in v1, so no merchant sees it —
  but the captured history is wrong and there is no backfill path.
- **Every product a store deletes is re-reported as newly deleted, every night, for ever**,
  because the deletion is keyed on the sweep's own clock rather than on the product. A
  store that has deleted 200 products adds 200 rows a night, indefinitely, to an unindexed
  table. The code's defence is a comment asserting the consumers collapse it, which is
  enforced nowhere.
- **A revoked Shopify token during the nightly sweep does not park the account.** The
  onboarding sync routes a dead token to the reconnect screen; the sweep has no such
  wrapper, so a store whose token dies without an uninstall message is swept and fails for
  ever.
- **The landing-revenue job can run for two minutes without checkpointing**, against the
  rule that any step over 60 seconds must. A crash loses the whole pass. (**The catalogue
  sync itself does checkpoint correctly** — the auditor verified the page-then-cursor order
  and that the chaos scenario proves the resume.)
- **The uninstall path mutates account state outside the account lock**, against the rule
  that all of an account's work serialises.
- **An analytics event is attributed with a Shopify shop handle where an account id
  belongs**, so those events cannot join the group the spec makes canonical — and sends the
  string `system` as an account id in one branch. No product content leaks.
- **The reconciliation sweep is scheduled 90 minutes *after* the generation cycle**, where
  the spec puts it before, and on UTC rather than the store's own clock. The crontab lines
  predate `T2.2`, but this is the card that put a real handler behind them.
- **Product metafields are not fetched**, though the spec names them and gives a reason.
  Does not block `T2.3`, but caps the fact-sheet richness `T2.3` is graded on, and nothing
  currently records the omission.

#### What the audit tested and found sound

Worth reading, because it is most of the card. **Pacing** holds and is called the
strongest part — one limiter per store inside the single client, shared by both callers,
with the rate-limit pause proved against a real local HTTP server. **Resume after a kill**
holds for products; the chaos scenario asserts the first page is requested exactly once
across all kills, which is the assertion that would fail if a restart began from the
beginning. **Customer stripping holds on the orders path** and is genuinely
by-construction, with a non-vacuity test proving the fixture really contained the values.
**The deletion check is correct**, contrary to the auditor's initial worry. **Invariant 21
holds** — the client exposes no write method at all. **Invariant 20's deliberate
non-application is correct** and the auditor would not change it: the spec's own table
classifies Shopify catalogue reads as pure reads needing no protection. **Invariant 26
holds.** **Signature verification is correct** — raw bytes, length-checked, constant-time.
**Sweep convergence holds.** And on the question the lane raised itself: **resetting the
attempt counter between chaos kills is fair, not weakened** — the scenario's assertions are
about resume and exactly-once, none of which concerns the retry budget. The real weakness
there is that the scenario never kills through the *order* phase, which carries the most
fragile checkpoint.

The auditor called the journalling exemplary — fourteen entries each naming what it cost.
**The one thing that happened without a journal entry is the privacy-webhook body
storage.**

#### The three questions the audit was asked to answer

- **Does anything block `T2.3`? No.** The path it reads is sound and untouched by every
  finding. **Two things `T2.3` should be told rather than discover:** the product checksum
  deliberately covers words but not price or stock, which is a *superset* of the spec's
  key and means distillation re-runs slightly more often than the spec implies; and
  **metafields are not being fetched**, so fact sheets will be built without them.
- **Does anything block another lane? Yes, lane C** — the unwired change stream above.
  Lane C is already held, so nothing changes tonight. Two further notes for it: its nightly
  inventory walk is now paced at one request a second and will take proportionally longer,
  and **lane G's retention card must learn that `webhook_events` now holds two row shapes
  before it writes a delete.**
- **Must a founder decide anything before this runs against a real store? Three things.**
  (1) The privacy-webhook storage must be fixed first — not a judgement call. (2) **Who
  owns account deletion and the store purge**, which must land before the app listing;
  recording a redaction request without erasing is defensible only while no real merchant
  data is held, and the only durable record of such a request is a row the not-yet-built
  retention policy would delete at exactly 30 days, when the obligation matures. (3)
  **Whether to obtain Partner dev-store credentials before or after `T2.3`** — two
  assumptions in this card would fail *silently* rather than loudly without them: that the
  orders endpoint honours the sort we ask for, and that Shopify's cursor carries our field
  filter forward. If it does not, order pages after the first would return the full object
  including the customer block; the reduction would still drop it, but the data would cross
  the network, which the code's comment explicitly promises it does not.


### `T-EMAIL` — a fresh read-only audit run tonight, 2026-09-02

**Not scheduled by the build plan.** The lane that built the card asked for one on a
specific pair of changes, and the integrator agreed under build plan §9 rule 6 (flagged
cards get a fresh-session audit). It used lane C's idle slot, since that lane is held.

**On the two things it was asked to look at hardest:**

- **The account-linking guard is correctly placed, and its stated justification is
  weaker than claimed.** The auditor verified in the library's own source that the
  sign-in check runs *before* anything creates or links an account, on every path
  including the email one, and found **no path today where an unverified address reaches
  account resolution**. But the reasoning behind its shape does not survive checking —
  see the medium findings.
- **The lane's claim that the card's premise was wrong is correct**, verified in the
  library's own assertion code rather than from the lane's summary. Only three storage
  functions are required for an email provider; the ten session ones are demanded only
  when the session strategy is `database`. `T1.1` read two requirements as one.

| Severity | Finding |
|---|---|
| **high** | **A session cookie issued *before* this change breaks the next sign-in, stickily.** With no adapter, the token carried Google's numeric id; now the library looks that id up as a UUID, Postgres rejects it, and sign-in fails. Retrying does not help — the bad cookie is still sent — until it lapses (≤24 h) or the user clears cookies. **Traced by reading both code paths, not executed.** Blast radius today is near zero: the app served errors on every route until `T-BOOT` and there is no evidence of real signed-in users. It would bite on a deploy following real sign-in traffic. Suggested fix is three lines — reject a non-UUID id and return nothing, which the library already handles by falling through to matching on address. |
| **medium** | **The only fence in front of the dangerous linking flag has no test.** The field it checks appears in exactly one line of the whole repository and in no test. The existing sign-in tests pass no provider, so the new branch is never entered — **deleting the guard turns nothing red.** |
| **medium** | **The guard is a denylist where an allowlist was available, and the reason given for that does not hold.** It refuses only an explicit "not verified"; a missing claim passes, justified as avoiding a silent lockout. But Google always returns that field, and it is the only provider configured — requiring an explicit "yes" would have locked out nobody. It also misses the string `"false"` and `0`, which non-conforming providers do emit. **What keeps it at medium:** the flag is read per-provider, so a future provider added without it is refused rather than linked — the exposure needs a future lane to both add a provider and set the flag on it. |
| **medium** | **"Every existing Google sign-in test passes unchanged" is satisfied vacuously.** Those tests build a configuration with no email dependency, so **no adapter is attached** — which is no longer the production shape. In production the Google path now runs through the adapter, records signups differently, and depends on the linking flag. **No test covers any of that.** |
| low | The dangerous flag is load-bearing for *every* returning Google user, not only for cross-method linking — removing it would lock all of them out, not merely refuse linking. Recorded so nobody "cleans it up". |
| low | A test still asserts account creation through a path production can no longer produce for a new user. Harmless, but it reads as coverage it is not. |
| low | The sign-in email's queue bypass is justified and one consequence is unstated: with no queued row, the delivery webhook has nothing to update, so "the link never arrived" leaves no trace in our own records. Bounces still reach suppression, so compliance survives. For `T8.2`. |
| low | Contract-doc drift on the idempotency key's documented shape. Nothing parses the field. For `T8.2`. |
| low, **a proposal, not a defect** | **The sign-in endpoint is unauthenticated and unthrottled**: anyone can request unlimited links to any address — an outbound-mail cost and a way to aim our verified sending domain at a third party. The product already owns the rate limiter and the bot check used on the preview endpoint, and neither sits in front of this route. **It does not enable account enumeration** — an unknown address gets an identical response and creates no row, which is tested. Out of the card's scope; **a founder decision, not a silent addition.** |
| low | Signing in as a different account while already signed in silently does nothing. Not a security issue — you cannot become someone else — but a trap once a switch flow exists. |
| low | The shared root test config gained one setting; genuinely necessary, global in effect, no correctness concern. Already named as a merge hazard. |

**What the audit explicitly cleared:** the parking of the revocation done-when is honest
and the gap is exactly where the lane said (no `sessions` table exists — checked against
the schema and every migration); invariant 25 holds and no path sends mail outside the
instrumented wrapper; single-use links are atomic and cannot be double-spent by racing
requests; and lane boundaries were respected.

**Read first in the morning:** the high finding. **The one needing a decision rather
than a fix:** the shape of the verified-address guard.

### An audit is scheduled after `T2.2` and has not run yet

Build plan §7 requires it **before `T2.3` starts**. What it should look at hardest is
listed in the `T2.2` section above.

### Wave 1, still open

Six investigations ran during wave 1; all reports are in `docs/audits/`, and
`remediation.md` indexes them. The blockers and major findings were fixed then.

**Four remain open**, from `docs/audits/false-confidence.md`. Each is small, and each is
best taken by the card that next touches that area — not as a sweep:

| Finding | Whoever next touches |
|---|---|
| The single-writer guard on billing status is defeated by aliasing the import | billing |
| The threshold rule is defeated by naming the constant instead of writing the literal | `packages/rules` |
| Nothing structurally stops product content reaching an analytics event — secrets are redacted, article text is not | **Substantially addressed tonight** by `T-ANALYTICS` (a run-time kind for every property, with no kind for text) and `T8.1` (stored payloads refuse words). Neither claims to close it; the wording of the original finding should be revisited against both. |
| The caching argument on the vendor wrappers silently defaults to off, unlike the cost ledger beside it, which is required | `packages/providers` |

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

**No lane stopped on a question tonight. Not one of the eight completed cards hit a
product choice it could not answer from a document** — which is worth recording, because
the run was set up expecting that to happen.

**What stopped the run was an account rate limit, not the work.** Two lanes were killed
mid-card at about 20:25; see the section at the top of this file.

Where each lane actually stands and why:

- **Lane B — finished `T2.2`, idle and clean.** Not stopped by a question. Its scheduled
  audit has run and **explicitly answered that nothing blocks `T2.3`**. It could start
  `T2.3` the moment the rate limit lifts.
- **Lane C — held by dependency, exactly as the plan instructed.** `T3.5` needs
  `T2.4`–`T2.5` from lane B, and lane B stopped at `T2.2` as planned. The nightly plan
  named "if lane B reaches `T2.5` while the night is still young, `T3.5` becomes
  available" as the one mid-run decision to watch for. **It did not arise.**
- **Lane F — killed mid-`T9.4`**, with no commits and uncommitted work that does not
  compile.
- **Lane G — killed mid-`T8.2`**, with five commits and a clean worktree.

**Five questions are waiting on the founder** and none of them stopped a lane — see
"Questions waiting on the founder". Two came from `T8.0`, one from `T-EMAIL`, two were
inherited. `T-EMAIL` also parked one of its own done-whens rather than fake it, which is
the closest anything came to a stop.

**A hold that was wrong, kept from an earlier run because the mistake is worth not
repeating.** Lane B was held from 08:00 to 16:40 on a question that, on checking, its next
card did not depend on. The hold was taken from a caveat in `docs/handoff-wave2.md` rather
than from reading what the card actually needed. **A hold should be justified against the
card, not against a remembered sentence about it.**

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

## This run resumed 2026-09-03 — what was verified before touching anything

**All four worktrees were level with `main` at `e698033`, clean, before any lane
launched** — verified directly (`git status --short` in each), not assumed from this
file. `sortiva-fd`, the previous integrator session, confirmed the same independently
and left `docs/handoff-next.md` as the kick-off prompt for this run; it matches this
file's own "Picking this up again" instructions and added no new information beyond
restating them, except naming the file itself. All four worktrees were then
fast-forwarded from `main` (docs-only commits) before any card launched.

**Order followed, per `docs/handoff-next.md` and this file's "What to do first"**:
(1) the `T3.5` audit, (2) `T2.7` in lane B, (3) `T9.7` in lane F, (4) prepare and start
`T4.0` in a new Lane D worktree. `caffeinate -dimsu -t 21600` re-applied before
launching anything.

## `T4.0` preparation — the collected deferral list, each item verified against the code

**Schema wave 3 is partly "the columns earlier cards were told to defer."** Collecting
that list is the integrator's job, not the lane's — the same pattern `T8.0` followed.
**Every item below was checked directly against `packages/db/migrations/*.sql` and the
code that would consume each column, not taken from memory of this file or of
`DECISIONS.md`** — `T8.0`'s own collected list had one item that was wrong (a "defence
in depth" index that would have done the opposite of what it was named for), and the
lane was right to refuse it, so this list does not get the benefit of the doubt either.
**If the `T4.0` lane finds one of these wrong, the instruction is the same as it was for
`T8.0`: stop and report, don't build it anyway.**

1. **A `notification_type` enum value for a deletion-confirmation email.** Verified: the
   enum (`packages/db/migrations/0000_wave1.sql:10`) has no such value, and
   `email_sends.type` is that same enum. `T8.2` built the suppression bypass that would
   let such a mail through (`EmailAudience.securityEmail`) and `T8.3` found nobody can
   call it — a merchant who deletes their account gets no email at all today. **A second
   half, found by `T8.3` and worth restating so `T4.0` doesn't have to rediscover it:**
   `email_sends` and `notifications` both cascade-delete from `accounts`
   (`packages/db/migrations/0000_wave1.sql:188` and the sibling FK on `notifications`),
   so even once the enum value exists, the record of "we told them" is erased seven days
   later by our own retention sweep — exactly the record account-deletion mail most
   needs to survive. **The precedent already in this schema for exactly this shape**:
   `spend_events.account_id` carries no foreign key to `accounts` and is pruned by age
   only, specifically so deleting the payer doesn't erase the record of the payment
   (`DECISIONS.md`, 2026-08-31, `R4`/`T2.0`). `T8.3`'s own recommendation was the same
   treatment for this row. Whether to apply it is still this wave's call to make and
   journal, not a founder question — it's an implementation shape, not a product change.

2. **`products.options` / `products.metafields`.** Verified: `products`
   (`packages/db/migrations/0002_wave2.sql:55`) has no such columns. `T2.4` named this
   "the single highest-value schema-wave addition here" — without it, a store that
   states its attributes in Shopify metafields or option names (rather than tags or
   descriptions) yields fewer family axes; the family is still correct, it just says
   less about what distinguishes its members. Works retroactively for nothing — a
   store's existing rows only carry it after their next full sync.

3. **A monthly roll-up table for Search Console history.** Verified: no such table
   exists (`gsc_daily`/`gsc_query_daily` schema at `packages/db/src/schema/search.ts:45`
   carries only the comment "kept for 16 months, then rolled up to monthly" with nothing
   built to do the rolling). `T8.3`'s retention sweep prunes at 16 months with nowhere to
   roll into, journalled as a known loss: Google itself serves only 16 months, so a
   pruned row can never be re-fetched — the first store to cross that age loses its
   earlier history for good, non-recoverably. **This card only needs to add the table.**
   The job that fills it before `T8.3`'s prune runs is a separate follow-up, per
   `T8.3`'s own journal entry.

4. **An `article` column on `spend_events`, so `article_cost_finalized` can attribute
   costs to one article.** Verified: `spend_events`
   (`packages/db/migrations/0002_wave2.sql:279`) has no such column, and
   `packages/core/src/ops/article-cost.ts` — built by `T8.4`, fully implemented — has
   zero production callers (confirmed by grep: only its own barrel export references
   it). Follow the same shape as `spend_events.account_id`: a plain column, no foreign
   key to `articles.id`, so deleting an article doesn't erase what it cost to produce.

5. **An incidents table.** Verified: no such table exists (confirmed no `CREATE TABLE
   "incidents"` in any migration). `T8.4` built `incidentFrom()` and `listActiveFlags()`
   in `packages/core/src/ops/kill-switches.ts` to read `ops_flags` rows as an
   open-incident list instead, with a comment naming the reason: "there is no incidents
   table and this card may not add one." What it can't do: record what an operator
   *found* when they investigated a trip — only what raised it. This is a plain
   addition, not a founder question; nothing about it changes existing behaviour.

**Two items are founder questions (1 and 3) — collect the need, do not build either:**

6. **A `sessions` table.** Founder question 3. Verified still absent (no `CREATE TABLE
   "session`/`"sessions"` anywhere). Needed for "sign out everywhere" and instant
   lockout; costs a database read on every authenticated request. **Do not add this in
   `T4.0`** — if the founder says yes later, it is its own mini-wave, because it also
   means changing the session strategy, which is Lane A territory.
7. **A marker for a deleted inventory page.** Founder question 1. Verified
   `store_pages` (`packages/db/migrations/0002_wave2.sql:107`) has no status/deleted-at
   column. Two shapes are on the table (a single date field, or a status field with
   room for "moved"/"unreachable" later) and the founder hasn't picked either. `T3.5`
   surfaced a second option worth carrying forward if this ever gets built: "not seen by
   the last completed walk" could stand in for a column, but only once something also
   records that a walk *completed* — an interrupted walk would otherwise mark live pages
   as gone. **Do not add this in `T4.0`.**

**One item is not a column at all, and `T4.0` should not try to make it one:**

8. **`store_pages.intent_class` exists and nothing writes it.** Verified: the column is
   present (`packages/db/migrations/0002_wave2.sql:121`) and three separate cards have
   now reported that nothing populates it — `T3.4` (cannibalization's same-intent check
   fails closed on every row because of it), `T3.5` (weakens the existing-target check
   the same way, on every real store), and this integrator's own read of both. **It
   needs an owner who writes it — a producer — not a column, which already exists.** The
   natural owners, per `DECISIONS.md`'s own suggestion, are the inventory sync (Lane C)
   or the persona/families work (Lane B); neither has claimed it. Left here as an open
   item for whoever next has room, not part of the schema wave.

## `T9.7` LANDED — settings screens and the notification bell

**Merged as `5d2e321` into `main`, two commits, full gate green** (nine of ten commands;
`pnpm eval` red by design, unchanged). Tests **2,566**, up from 2,513 — **53 added**.

Four Settings screens (Publishing, Store profile, Connections, Account) and a
notification bell in the app shell's toolbar, all built against a route/schema/copy
contract that earlier cards (`T1.2a`, `T8.1`–`T8.3`) had already written without a
consumer — this card is mostly a real backend meeting mock fixtures for the first time,
not new plumbing. Auto-publish's delivery-mode toggle drives an inline write-grant →
blog-picker flow; the billing card renders the three cancellation facts verbatim; account
deletion is type-to-confirm; the bell polls every 30 seconds with seen/read tiers.

**Inspected before merging, not taken on trust:** diffstat confirmed every changed file
sits inside Lane F's directories (`apps/web/app/(app)/**`, `packages/ui`); the copy
addition (95 lines) is one contiguous block inserted after the billing keys, not
appended at the tail, matching the standing instruction to reduce collision risk; `git
diff` on `DECISIONS.md` read in full — six entries, each a real, well-reasoned choice
with a nearest-spec citation, none silently deciding something outside the lane's
authority.

**One flake on the merged-tree gate, re-run and confirmed clean.** The first `pnpm test`
run failed one timing-sensitive test
(`packages/providers/src/shopify/limiter.test.ts`, a real-wall-clock pacing assertion,
84ms measured against a ≥90ms floor) — the documented concurrent-load shape, not a
regression. Ran the file alone (clean, 314ms) and the full suite again (clean, **2,566
passing, 182 files**) before trusting it. Three other sessions were building at the time
(`T2.7`, `T4.0`, and the now-finished `T3.5` audit).

**Two real gaps found and correctly not built around**, both outside Lane F's directories:

1. **Auto-publish's write-scope OAuth grant has no backend.** The Shopify provider
   hard-codes read-only scopes into its one `authorizeUrl`, and the callback actively
   discards any write scope Shopify returns (an existing invariant-21 test). The
   "Grant access" button is wired to the only OAuth-start route that exists, which
   cannot deliver what the button promises. **Needs a second start/callback pair in Lane
   B's directories** (`apps/web/app/api/shopify`, `packages/providers/shopify`) plus a
   route-table addition.
2. **Store profile's business fields render read-only.** The only write route,
   `POST /api/profile/confirm`, refuses a second call once confirmed — there is no
   later-edit route for description/language/country/audience/tone or the top-seller
   order, though main §6.8 and ui §9.2 both call this screen "permanently editable".
   Keywords, competitors and the family report stay fully live on their own existing
   routes. **Needs a profile-update endpoint in Lane B's `apps/web/app/api/profile`**,
   or the spec's "permanently editable" scoped down to what already is.

**A smaller, self-contained finding also journalled:** the bell currently renders every
notification's generic line (`renderNotification` was built with a `resolved` parameter
for exactly this and has no caller anywhere yet), because resolving a reference — an
article's title, a page's name — into display text needs a lookup nothing provides. Not
a defect in this card; the renderer's own designed degrade path, now actually visible
because this is the first thing that calls it.

**Files outside Lane F's directories: none.** No migration. `pnpm stubs:report`
unchanged at 8. `env:check` unchanged at 38/38.

**Next in lane F: `T9.8`, the M9 exit gate** — end-to-end Playwright flows against
staging (or `next start` locally, since `pnpm dev` still cannot boot). **Launched
after this section was written** — see the "Right now" note at the top of this file.

## `T4.0` LANDED — schema wave 3: the content engine's tables, plus the wave's deferred columns. **M4 can now start.**

**Merged as `9137904` into `main`, five commits, full gate green** (nine of ten
commands; `pnpm eval` red by design, unchanged). Tests **2,594**, up from 2,566 —
**28 added**. 55 tables now (41 + 14 new), verified directly against a fresh empty
database, not taken from the lane's report (see below).

**What it adds.** The card's own scope — `topics, articles, gate_decisions,
article_product_refs, article_claims, article_labels, pattern_stats, refresh_log,
not_interested, publish_intents` — plus every item from the integrator's collected
deferral list except the two founder-question items and the one non-item, exactly as
instructed: `products.options`/`.metafields`; `gsc_monthly`/`gsc_query_monthly`
roll-up tables; `spend_events.article_id` (no foreign key, ledger-shaped, same
reasoning as `spend_events.account_id`); `incident_findings` (what an operator found
investigating a kill-switch trip, separate from `ops_flags` itself); and
`deletion_confirmation_emails` plus one new `notification_type` enum value
(`account_deletion_confirmed`), so the account-deletion email's send record survives
the account row it confirms — the same no-foreign-key ledger shape, verified directly
in the migration SQL (no `ALTER TABLE ... ADD CONSTRAINT` targets this table's
`account_id` anywhere in the file).

**`article_product_refs` is shaped around the founder's product-reference decision**
(2026-09-01: prices live in articles as a reference to the current value, never a
number), superseding main §13's literal `price_at_write` column — it carries
`placeholder_key`, `fields_rendered`, `resolved_values_json` instead. `article_claims`
enforces at the database level that a claim cannot exist without at least one evidence
entry (a `CHECK` on `jsonb_array_length(evidence_json) >= 1`); a reference row must
name at least one field to render (`CHECK` on `cardinality(fields_rendered) >= 1`).
Both are the card's own named done-when items, confirmed firing in
`packages/db/src/constraints-wave3.test.ts` (28/28 passing).

**Correctly did not build the two founder-question items or the one non-item.**
Verified directly in the diff: no `sessions` table, no deleted-page marker on
`store_pages`, no column touching `store_pages.intent_class`.

### Inspected before merging, not taken on trust — one real discrepancy found and corrected

Diffstat confirmed every file outside `packages/db` was a necessary mechanical
consequence of the new enum value (`packages/core/src/contracts/opportunities.ts`'s
`NOTIFICATION_TYPES` list, `packages/core/src/notifications/matrix.ts` and
`render.ts`, `packages/jobs/src/notify/assembler.ts` — all in Lane G's directories,
each adding one row to an exhaustive `Record<NotificationType, ...>` the type checker
already forces on every consumer, each with a clear comment, none touching Lane G's
actual business logic). Read the full `DECISIONS.md` diff (nine entries) end to end —
every choice traces to a precedent already in the codebase or an explicitly flagged
open question, nothing decides anything a founder should have been asked, and two
entries (the `article_product_refs.product_id` FK behaviour, the `gsc_monthly` roll-up
dropping device/country) name real, stated costs rather than hiding them.

**The one thing that didn't hold up: the lane reported `pnpm db:migrate` as
"unreliable in this sandbox" and verified correctness a different way instead** (the
same migrator function `packages/db/src/testing.ts` already uses for every constraint
suite, against three fresh databases). **Checked independently and this is wrong** —
`pnpm db:migrate` against a genuinely empty database works cleanly, both on `main`
before this merge (41 tables) and on the merged tree after it (55 tables), confirmed
twice with separate scratch databases. Whatever the lane's session hit, it wasn't a
defect in the migration or a real sandbox limitation — recorded here so nobody carries
the false claim forward. Not chased further since it doesn't change anything: the
migration is correct and the standard gate step now confirms it directly.

**Files outside Lane D's directories, all reviewed as legitimate:** the four
notification-registry files above (Lane G — mechanical, enum-forced); `packages/ui/strings/en.json`
(one line — the `account_deletion_confirmed` bell copy key, auto-merged); `packages/db/src/testing.ts`
(added the 14 new tables to the shared truncate list, child-first, the same pattern
`WAVE_2B_TABLES` already established — a shared registry every schema wave extends);
`packages/core/openapi.json` (regenerated, one enum value, verified by hand to be
exactly that). No lane-boundary violation found.

**Two invariant tests caught real consequences of the new table/enum and both were
fixed correctly:** `no-customer-data.test.ts` flagged `deletion_confirmation_emails.email`
as looking like a shopper field — it's the merchant's own address, added to the
allowlist with the same reasoning `accounts.email` already carries; `openapi.json` had
drifted from the new enum value, regenerated and hand-verified to differ by exactly
that one value.

**What `M4`'s next cards inherit:** the tables exist; nothing populates them yet.
`T4.1` (topic model & Gate 1) is the next card and can now start — it is not blocked by
`T3.6`/`T3.7` (which stay held on founder question 8) since `T4.1` only needs the
`existingTargetCheck` contract `T3.5` already filled, not the signal/opportunity
pipeline `T3.6` would add. Two open shape questions explicitly left to whoever writes
through these tables first, not settled here: `gate_decisions.outcome` is free text
(no spec fixes its vocabulary yet); `article_claims.staleness` is a new three-band enum
that may prove too coarse.

## `T2.7` LANDED — confirmation API, the SSE progress stream, two chaos scenarios. **M2 is closed.**

**Merged as `49506ea` into `main`, five commits, full gate green** (nine of ten
commands; `pnpm eval` red by design, unchanged). Tests **2,599**, up from 2,594 —
reconciles exactly against T2.7's own +5 over its 2,513 branch point. This was the M2
exit gate — onboarding now runs, unattended, from a claimed domain all the way to the
merchant's review screen, and confirming it hands the account off with nothing further
this milestone owes it.

**What it closes.** A new `awaiting_confirmation` step moves the domain
`ingesting → needs_confirmation` and fires the review-ready notification once keywords
and competitors are discovered — deliberately not gated on Search Console, which is a
sibling step, not a dependency, so skipping GSC never stalls a merchant's onboarding.
`GET /api/profile` assembles the whole review screen; `POST /api/profile/confirm` does
the guarded `needs_confirmation → ready_for_planning` transition and, **only if that
transition wins its race**, writes the merchant's edits — a losing double-click or
retry touches no table. `GET /api/ingestion/status`/`stream` fill two routes that were
already sitting in the frozen contract with a real consumer (Lane F's onboarding
stepper, built weeks of build-time ago against a mock) and no owner — no lane's
directory list named them, and this is the first card positioned to.

**A real bug found and fixed in the chaos harness itself, not just in this card's own
scenarios.** The harness guesses how many checkpoints a scenario has (previously a
hardcoded 8) and narrows that guess once a clean pass reveals the true count. A
scenario with genuinely fewer checkpoints than the guess — both new ones, at 1 and 6 —
could have its very first kill-point draw overshoot, let the pass run to completion
undisturbed, and then have every *retry* find the step already fully ledgered and
report **zero kills exercised** despite being asked for several — a false "converged"
with nothing actually interrupted. Fixed generally with an optional `initialCeiling`
scenarios can declare; every existing scenario was unaffected because catalogue sync's
per-page walk already has close to 8 checkpoints, which is exactly why nobody had hit
this before. `pnpm chaos` is now 5 tests, up from 3.

**Two design choices worth knowing about, both journalled rather than silently
decided:**
- `keywords.confirmed` — the column `T3.3` already reads, that nothing before this
  card ever set — is now written **account-wide, all at once, by "Confirm profile."**
  There's no per-keyword confirm control on the screen to key it off anything finer.
  **One consequence flagged rather than hidden:** competitor suggestions read confirmed
  keywords, so a merchant's very first visit to the review screen — before they've
  clicked Confirm — sees an empty suggestions list. Pre-existing gap, not introduced
  here, just newly visible now that the column's meaning is pinned down.
- `T2.4`'s flagged four-into-three family-grouping-source mismatch (the database enum
  has four values, the frozen `familySchema` contract names three) is resolved for the
  first screen that exposes it: `collection`→`taxonomy` (the more honest name for what
  that value already means, per `T2.4`'s own reasoning), `split_variant` and
  `fact_cluster` both →`fact_clustering` (closer in kind to each other than to either
  other value), `embedding` unchanged. An approximation on the merchant-visible badge,
  not a hidden one — `split_variant` should get its own contract value at the next
  re-freeze.

**One open question recorded, not answered — worth carrying forward the way `T-START`
was for the equivalent gap upstream.** Confirming a profile does the guarded
transition and nothing else; main §6.9 says reaching `ready_for_planning` is supposed
to start the Opportunity Engine's onboarding run, which seeds the first calendar —
but that machinery (`signal_runs`, `TopicScheduler`) is `T3.7`'s and doesn't exist yet
on any branch. **Same shape as `T2.1`'s open question that `T-START` eventually
closed**: the handler that would react to this state doesn't exist, so nothing can
call it yet. Whoever lands `T3.7` (blocked on founder question 8 in the meantime)
inherits deciding whether `confirmProfile` gains a callback port or a sweep picks up
every `ready_for_planning` account.

**Files outside Lane B's directories, flagged and reviewed as legitimate:**
`apps/web/app/api/ingestion/**` and `packages/db/src/stores/ingestion.ts` — verified
directly in `packages/core/src/api/routes.ts` that both routes were already in the
frozen contract, and in the lane ownership table (build plan §3) that no lane's row
claims `apps/web/app/api/ingestion` at all — an omission in the table, not a
deliberate exclusion, and no other lane plausibly owns the ingestion pipeline's own
progress screen. No migration.

**M2 is now complete: `T-START` → `T2.1` → `T2.2` → `T2.3` → `T2.4` → `T2.5` → `T2.6`
→ `T2.7`, all landed.** Nothing left in this milestone. Lane B is idle (until
`sortiva-85`'s `R-PRIVACY` — see below).

## The founder joined a second session mid-run, and answered four questions directly

**At 12:40, a second Claude session (`sortiva-85`) started on this same machine, with
the founder actually present in it — not asked through this integrator, but working
directly.** It committed three things straight to `main` while this session was mid-gate:
`d3758c7` (the competitor-gap threshold, answering founder question 8), `ec2f213` (a
temporary answers file, since folded in and deleted), `5a6b46d` (an external SEO-tactic
review, no scope change). **Verified independently before treating any of it as real**:
`git log` on this session's own `main`, the actual `DECISIONS.md` entries, the commits'
authorship (the founder's own git identity). Questions 1, 4 and 8 are now answered — see
the "Questions waiting on the founder" section, each marked ANSWERED in place — and
`R-PRIVACY` is authorised. Full detail on what each answer changed is in that section;
this note is only the provenance.

**Division of labour agreed between the two sessions, by direct message, to avoid two
integrators writing to `main` or to this file at once:** `sortiva-85` holds lane B
(`R-PRIVACY`, in progress) and writes nothing to `docs/overnight-state.md`. This session
holds lanes C, D, F, G and keeps writing this file, folding in anything `sortiva-85`
lands. Neither touches the other's worktree.

## `T9.8` LANDED — onboarding, opportunities and content proved end to end. **M9 is closed.**

**Merged as `fa14fcd` into `main`, two commits, full gate green** (nine of ten commands;
`pnpm eval` red by design, unchanged). This is the M9 exit gate: five screens built
across five separate cards (`T9.3`–`T9.7`) had each been verified only in isolation,
against injected fixtures — this is the first time any of them ran together, in a real
browser, against a real build.

**"Playwright against staging" was not literally satisfiable** — the project has never
been deployed — so the flows ran against `pnpm build` + `next start` fronted by the same
fixture-backed mock server `T9.2`/`T9.5` already built, the same substitution those two
cards made. Journalled, not silently substituted.

**Two real production bugs found and fixed, neither catchable by anything in the gate
before this card:**

1. **Every authenticated screen 500'd in a production build.** The shell
   (`apps/web/app/(app)/layout.tsx`, a Server Component) was passing a translate
   *function* into `NotificationBell` (a Client Component) — React refuses to serialise
   a function across that boundary, and Next answers the request with a 500 the instant
   it tries. `pnpm build`, `typecheck`, `test` and `smoke:boot` all stayed green through
   it (`smoke:boot` only ever asks for `/` and `/api/health`, both outside this layout),
   and `next dev` cannot start at all (`R-DEV`) to have caught it that way either. This
   bug was `T9.7`'s, shipped and merged by this integrator without anything in the gate
   able to see it. Fixed by passing a plain language code instead, and having the client
   component build its own translator.
2. **The Opportunities drawer never re-read itself after its own actions.** Generating a
   recommendation or marking a task applied posted successfully and then left the open
   drawer showing exactly what it showed before the click, forever, until closed and
   reopened by hand — because the refresh those actions triggered re-reads the *list*,
   whose rows carry no recommendation or task detail. Fixed by re-fetching the open
   drawer's own detail once its action settles.

**Both fixes verified directly** (the diffs, not just the report): the layout change is
the textbook-correct fix for a real Next.js App Router server/client serialisation
error; the drawer fix is a straightforward missing re-read.

**Files outside Lane F's strict directory list, same precedent `T9.5` already set:**
`apps/web/e2e/**` and `playwright.config.ts` — the browser-flow harness itself.

**Real-vendor evidence outstanding, unchanged:** Search Console's own OAuth+picker path
is still only exercised via component tests and "Skip for now" in the browser flow — its
real round trip has no credentials to run against, same as Shopify's.

## `T4.0a` LANDED — a store page can now be recorded as gone (schema mini-wave)

**Merged as `aabeea7` into `main`, two commits, full gate green.** The founder's
answer to question 1 (see above), built the same day it was decided. `store_pages`
gains one column, `status`, a new Postgres enum (`live`/`gone`, `NOT NULL DEFAULT
'live'`) matching the shape the existing `store_page_type` enum already sets on the
same table. **Migration only, exactly as scoped** — nothing writes `gone`, nothing
reads the column, both are separate follow-up cards. Every existing row defaults to
`live`, proved against a fresh database. Four new constraint tests, all passing
against real Postgres, including that the column rejects any value outside `live`/
`gone` and rejects null.

**No lane-boundary concern** — this is a schema-wave card, the one kind allowed
outside its author's own directories, and it touched only `packages/db`.

## `T4.1` LANDED — the topic model and Gate 1 admission

**Merged as `38bdb88` into `main`, three commits (one merge conflict, resolved —
see below), full gate green.** M4 (the content engine) now has its first working
piece: a topic can be evaluated against the five admission checks main §8.2 names
(demand floor, winnability, intent/commercial relevance, substance, and the
existing-target/cannibalization check via `T3.5`'s real contract, never
recomputed) and come out as one of nine outcomes, each with a template-key reason
card rather than rendered prose (invariant 8). The manual-add path runs the same
gate against real data and writes real `topics`/`gate_decisions` rows, including
minting a placeholder `opportunities` row so a manually-added topic satisfies
`topics.opportunity_id NOT NULL` ahead of Lane C's real Opportunity Engine —
zeroed impact/confidence, deliberately, so these rows are visibly not real scoring
output once `T3.6`'s land.

**A merge conflict, real and resolved, not auto-mergeable:** `packages/db/src/
repositories/keywords.ts` — `T2.7` added `confirmAllKeywords`, `T4.1` added
`findKeywordByTerm`, both non-overlapping functions in the same file. Kept both;
verified no other file needed the same treatment (checked every other file `git
status` listed as modified for stray conflict markers before committing).

**One real bug this card's own integration test caught in itself, fixed in the
same commit:** Gate 1's checks originally ran in the order main §8.2 lists them,
which put substance-inventory before the existing-target check — a store with a
strong existing match but a thin, newly-formed family came back "held, add more
detail" for an article that, because a page already covers the intent, was never
going to be written regardless. Reordered so existing-target runs first; a strong
match now short-circuits before substance is even asked about.

**A real, unresolved gap flagged for `T4.2` (which is itself audited before
`T4.3` starts, per build plan §7) rather than guessed past:** nothing anywhere
turns a merchant's typed topic title into the `QueryCluster` (search term +
intent class + family mapping) both Gate 1 and the manual-add path need to run at
all — the frozen `addTopicRequestSchema` collects only `{title, date, pin}`.
`T4.1` took the cluster as an explicit input rather than inventing a resolution.
Three shapes are on the table, each with a real cost (a keyword/family match,
cheap but silently rejects anything that doesn't match; an LLM call, which
invariant/§8.2 wants Gate 1 to stay "~free" of; or a UI change collecting family
selection, which touches `packages/ui` and the frozen request schema) — **this
needs a founder or integrator decision before `T4.2` can wire the real
`POST /api/calendar/topics` route honestly.**

**Also flagged, worth a founder's eyes but not blocking anything:** `gate_decisions
.reason_user_facing` and `topics.why_line` are named as if they held a rendered
sentence; they actually hold a template key only (per invariant 8, correctly), with
interpolation params living in `scores_json` for `gate_decisions` and nowhere at all
for `topics` — a topic-list why-line will render its static fallback with no numbers
filled in until `topics` gains a params column in a future wave. Naming, not a defect.

**Files outside Lane D's strict list:** `packages/db/src/repositories/*` — not
lane-exclusive; other lanes (including `T3.5`) have already added repositories
there. No migration.

## The concurrent-load test flake, triangulated across four independent sessions

**Worth recording in detail because it burned real time this run and the pattern is
now unambiguous.** With four of this session's lane sessions plus `sortiva-85`'s
running at once, `uptime` load averages reached 30 — well past the ~13 the previous
run saw and called safe. Two consecutive `pnpm test` runs on the merged tree (after
`T9.8`) each failed differently: the first with 8 real-looking assertion failures
mixed into 45 "failed" files; the second with **every one of 2,614 individual tests
passing** and only whole-suite `afterAll`/`beforeAll` hook timeouts (10s) against the
shared local Postgres. **Two other sessions (`T4.0a`'s and `T4.1`'s, independently,
unprompted) hit and reported the identical symptom** — different files each time,
individual tests always passing, hook timeouts under load — and both correctly
declined to chase it as a code defect, isolating their own new suites instead to
prove those were sound. A third, later re-run with load eased (three concurrent
sessions instead of five) came back clean: **2,644/2,644, exit 0.**

**This is the documented trap in `docs/overnight-state.md`'s traps section, at a
worse concurrency than it was written for.** No genuine regression was found
underneath it this time — unlike the one precedent where re-running surfaced a real
bug. Left unactioned, as before: belongs to whoever next touches
`packages/db/src/testing.ts`, and is worse now than previously documented because
this run ran five concurrent Postgres-backed sessions where the earlier note assumed
four.

## `R-PRIVACY` LANDED — the critical privacy finding from `T2.2`'s audit is fixed

**Merged as `18e4781`, three commits, by `sortiva-85` directly** — the founder present
in that session authorised and oversaw it, and that session gated and merged its own
work, exactly as it told this one it would. **Already inside every gate this session
ran from `T9.8` onward**: `18e4781` landed in the shared directory at 13:11, before
this session's `T9.8` merge, so it is a first-parent ancestor of `main` here and every
test count and gate result in the sections above already includes it — confirmed by
`git merge-base --is-ancestor 18e4781 38bdb88` (`yes`) and by `sortiva-85`'s own
independent gate of the same commit in `lane-b`, landing on the identical count
(2,644 tests, 187 files, exit 0) this session reached separately.

**What it fixes.** The Shopify webhook receiver stored every incoming message body
verbatim, including the two privacy topics (`customers/redact`, `customers/data_
request`) whose `customer` object carries a shopper's email and phone — so the row
meant to prove "we hold nothing about your shoppers" was the row that disproved it,
and nothing ever deleted it. **Read the full finding in "Audit findings, unactioned"
above (`T2.2`'s audit, the CRITICAL entry) for what was wrong; this is the fix.**

**The fix is an allowlist, not a cleanup.** `storableWebhookBody` keeps four named
fields from a privacy request — store id, store domain, and the two order-id lists —
and drops everything else, including `customer.id`, before the row is ever written.
Every topic goes through the same call, so a privacy topic added later is covered
without anyone remembering to extend a list. Invariant 4's own guard test — which
could only ever see column names, and the breach was inside a JSONB blob named
`payload` — now walks JSONB contents too, and is proved non-vacuous by planting a
real `customers/redact` body, asserting the scan catches the shopper's data, then
asserting the schema is clean only after removing it.

**Verified by reverting the fix**, not just by asserting it: undoing the one-line
receiver change turns exactly two tests red — the stored row read back out of a real
database, not the reducing function tested in isolation.

## A hazard this run surfaced: two sessions sharing one physical directory for `main`

**Worth carrying forward explicitly, because it is a sharper version of the
"gate flakes under load" trap and it is not the same failure.** `sortiva-85` and this
session both write to `/Users/balazs/Desktop/sortiva` for `main`-branch work — not two
worktrees of the same branch (git would refuse that), but the literal same directory,
because `main` can only be checked out in one place and both sessions needed to be
"the integrator" for different pieces of the same run. `sortiva-85` ran `pnpm test`
there at 13:23 and got 43 failed suites — not a flake: it caught this session's
`packages/db/src/repositories/keywords.ts` **mid-conflict-resolution, with literal
`<<<<<<<`/`=======`/`>>>>>>>` markers still in the file**, which `esbuild` cannot
parse, which fails every suite that transitively imports it. `sortiva-85` correctly
did not report this as a code defect and instead re-gated from a fast-forwarded
`lane-b`, isolated from the shared directory.

**The lesson, stated plainly for whoever runs a two-integrator night again:** a gate
result from a shared `main` directory is only trustworthy if nothing else could be
mid-write there at that instant, and neither session can see the other's in-progress
edits to know. **The safer pattern, adopted for the rest of this run:** gate from a
lane worktree fast-forwarded to `main`'s tip rather than the shared directory itself,
whenever another session might plausibly be active in it — the shared directory is
still where merges and commits happen, but the verifying `pnpm test`/`build`/etc.
calls are safer run from an isolated worktree nobody else touches. This is distinct
from the Postgres-contention flake above (confirmed separately, by two sessions
running in their own isolated worktrees hitting the identical hook-timeout symptom at
the same time) — the two hazards compound under concurrency but have different causes
and different fixes.

## What `T4.0a` leaves open, restated by `sortiva-85` and worth keeping visible

`store_pages.status` exists and defaults every row to `live`. **Nothing writes `gone`,
and `T3.5`'s existing-target check does not yet skip a page marked gone** — which is
the entire reason the column exists, per the founder's own decision. Both are named,
explicit follow-ups from `T4.0a`'s own report, not new information — restated here
because `sortiva-85` flagged it independently and it is Lane C territory, currently
held by this session's `T3.6` build. Not picked up yet; no card in the plan names
either half, the same shape as `store_pages.intent_class`'s open ownership above.

## FOUNDER — a typed topic title becomes a `QueryCluster` through one model call on Add. **CONFIRMED — `sortiva-85`'s actual `DECISIONS.md` entry landed in `R-STREAM`'s commit and matches this relay exactly.**

**`T4.1` flagged a real gap rather than guessing: nothing turns a merchant's typed
topic title into the search-term/intent-class/family-id triple ("a `QueryCluster`")
both Gate 1 and the manual-add path need to run at all.** Relayed by `sortiva-85` at
13:35, sourced from the founder directly in that session. **Decision: one model call,
made at the moment the merchant clicks Add, resolves the typed title into a full
`QueryCluster`.** Not a keyword/family word-match, not a UI change collecting family
selection — `sortiva-85` verified three things in the code before putting it to the
founder (worth restating since they're checkable facts, not opinion): `keywords` has
no family link or intent column; nothing anywhere derives an `IntentClass` from text,
every existing use only consumes or passes one through; `buildQueryClusters` works
from GSC query rows carrying impressions and cannot serve free text. The "Gate 1 must
stay ~free" concern doesn't reach this path: scan-produced topics already arrive with
clusters built from Search Console data, so the model call runs once per manual add,
never across a scan.

**Two things deliberately left to `T4.2` to decide and journal itself:** which model
and prompt version; and what happens when the call fails or names a family id that
doesn't exist for the account (the standing degrade-to-pause-never-guess rule is a
candidate shape, not a mandate — the card's call).

**Action taken:** `T4.2` was already running in lane D, instructed to park this exact
piece — redirected mid-build (11 minutes in) to build the real wiring instead, with
this reasoning relayed in full. If it had gone further before the redirect landed, its
own report will say so.

## `T3.6` LANDED — opportunity object, scoring, action selection, lifecycle. **The signal detectors `T3.4`/`T3.5` built now become merchant-facing cards.**

**Merged as `6215835` into `main`, four commits (one real add/add conflict, resolved —
see below), full gate green.** Tests **2,713**, up from 2,644 — reconciles against
`T3.6`'s own reported delta. **This card is scheduled for audit before `T3.7` starts
(build plan §7) — dispatching that audit next, findings held per the standing rule.**

This is the Opportunity Engine's decision core: every signal `T3.4`/`T3.5` detect now
scores (both formula families — the CREATE log-volume formula and the existing-page
gain formula), gets an action (a standalone function, separate from detection per
invariant 7), gets deterministic tasks, and gets a template-key reason (never rendered
prose, invariant 8). **All 8 worked examples pass individually, plus the founder's
unblocked #18 competitor-gap fixture** (CREATE with no URL, OPTIMIZE with one at #18).
Re-running detection updates the open row rather than duplicating it; expiry keeps the
row; the why-line renderer has no LLM import — all proven against real Postgres, not
asserted.

**A real add/add merge conflict, resolved by combining rather than picking a side:**
`packages/db/src/repositories/opportunities.ts` existed on both `T4.1`'s branch (a
deliberately minimal placeholder — `insertMinimalOpportunity`/`findOpenOpportunity`/
`setOpportunityTopicId`, built explicitly "ahead of the Opportunity Engine's own... not
yet built") and `T3.6`'s (the real thing: dedupe-on-conflict upsert against the actual
partial unique index, guarded transitions, expiry, dismiss/undo). **Kept both** — `T4.1`'s
`admit-manual-topic.ts` calls all three of the minimal functions by name and still needs
them; `T3.6`'s exports are a strict superset otherwise, with no naming collision beyond
one identical `OpportunityRow` type declaration (deduplicated). Adjusted the minimal
block's own comment, which said "blocked on a founder question, not yet built" about a
card that had just landed above it in the same file. **Verified before committing**:
`packages/db` and `packages/jobs` (the consumer) both typecheck clean against the
combined file, and the full gate confirms it.

**A real spec gap `T3.6` filled rather than left broken, worth restating because it's
exactly the kind of thing an audit should stress-test:** main §9.6.4/§9.6.5 give exact
scoring formulas for only five of the signal shapes and are silent on the rest
(cannibalization, missing/weak metadata, a competitor-gap OPTIMIZE, and the two P1
signal shapes below). Every unscored signal falls back to a traffic-magnitude proxy —
the largest impressions-shaped number already in its own evidence — so `impact_score`
stays meaningful without asserting a formula the spec never stated. Flagged, not hidden.

**Two P0 signals in the taxonomy have no detector anywhere yet** (`existing_page_intent_gap`
— Lane E's `T6.2` territory; `indexing_issue` — needs the URL Inspection API, no card
owns it) — given thin, type-only shapes so worked examples 4 and 8 are real tests and
the engine can still score a signal once one exists, without guessing at its detection.

**One judgment call worth a second look in the audit:** cannibalization resolves to
FIX, not OPTIMIZE, though main §7.8's own row allows either — reasoned as: every task
the row names (primary-page designation, canonical recommendation) is structural work
on which page should be authoritative, not new copy, which is what OPTIMIZE means
elsewhere in the spec.

**Files outside Lane C's directories:** none beyond the same `packages/db/src/repositories`
precedent every other lane already established. No migration. New `reason_template_key`
values have no copy yet in `packages/ui/strings` (Lane F's directory) — the renderer's
existing graceful fallback (`opportunities.whyUnavailable`) covers the gap visibly
rather than crashing, until Lane F writes the sentences.

**`DbOpportunitySource` fills the `OpportunitySource` seam for real** (mirroring `T3.5`'s
`DbExistingTargetCheck` pattern) but isn't wired into any job yet — nothing consumes it
before Lane D's `T4.2`/`T4.6`, which is exactly where this run's `T4.2` build is headed
next.

## `T4.2` LANDED — the calendar, `TopicScheduler`, and the real manual-add model call. **A production build defect from this merge was found and fixed — read that section, not just the card summary.**

**Merged as `196346a` into `main`, two commits, clean auto-merge — then two more real
defects found by the gate itself and fixed in `a563131`, full gate green after.** Tests
**2,774**, up from 2,713.

**Mid-card plan change, redirected live:** this card started under instructions to park
the manual-add cluster-resolution gap `T4.1` flagged. Partway through, the founder's
actual answer was relayed by `sortiva-85` (see the `FOUNDER` section above) — this
session forwarded it to the running build mid-card. **Built for real, nothing left
parked**: one model call (Haiku, `topic-classify.v1`, invariant 25's wrapper) turns a
merchant's typed title into a `QueryCluster`, with the two sub-decisions the founder
left to the card — model/prompt choice, and failure handling — made and journalled:
a failed call writes nothing and answers with Appendix A's canonical outage copy;
an invented family id is filtered out, never trusted.

**Rest of the card's scope, all built**: guarded topic-state transitions (veto/move/
swap/pin), lock semantics (a veto after dequeue cancels publication, discards the
draft), `TopicScheduler` filled for real (placement only, deliberately not Gate 1 —
see its own journal entry), `/api/calendar` routes matching the frozen contract, and
the two calendar PostHog events main §14.7 actually names.

### Two real defects found by the gate, neither visible to any lane on its own branch

**1. An ambiguous export, from two cards that couldn't have seen each other's file.**
`packages/core/src/opportunities/events.ts` (`T3.6`, merged first) and
`packages/core/src/calendar/events.ts` (`T4.2`) both declared
`OPPORTUNITY_STATUS_CHANGED_EVENT` with the identical string value — a genuine
duplicate, not a naming collision over different things. `packages/core/src/index.ts`'s
barrel re-exports both, so `pnpm typecheck` failed on the merged tree with "Module
'./calendar' has already exported a member named 'OPPORTUNITY_STATUS_CHANGED_EVENT'."
**Fixed by deleting the duplicate** (`calendar/events.ts`, now empty of purpose) and
pointing `veto-topic.ts`'s emission at `T3.6`'s own, more complete builder function via
the barrel it already imports from — no behaviour change, since both built the exact
same event shape.

**2. `pnpm build` failed collecting page data for every `/api/calendar/**` route**,
with `Error: DATABASE_URL is not set` — a production-build-breaking defect, the same
*family* of bug `T-BOOT` fixed for `packages/rules` months ago, now found in this
card's own composition roots. **Root cause, traced by bisection** (isolating routes one
at a time, not guessed): `calendarDeps()`, `topicMutationDeps()` and `addTopicDeps()`
all call `db()` — which opens a real Postgres connection pool — **synchronously**, and
each was invoked **at module scope** in its `route.ts` file
(`export const GET = withAccount(makeGetCalendarHandler(calendarDeps()))`), so it ran
during Next's build-time page-data collection, before the runtime environment is
necessarily available in that context — not during a real request. **Every other
composition root in this codebase already defers this** (`packages/db/src/stores/
keywords.ts`'s own `database()` closure calls `db()` lazily, only when a store method
actually runs) — these five calendar routes were the first to call `db()` inline at a
route's own module scope rather than deferring it.

**Fixed by deferring each `xDeps()` call into the request-handler closure** in all five
`route.ts` files, matching the codebase's existing pattern, with no interface or test
changes needed. **Verified beyond the build succeeding**: bisected which specific route
broke it (moving directories to `/tmp` and back), confirmed the fix with a clean
`pnpm build`, then started the actual built app with a throwaway `ENCRYPTION_MASTER_KEY`
(the same accommodation `scripts/smoke-boot.mjs` already makes) and confirmed
`GET /api/calendar` and `POST /api/calendar/topics/{id}/move` answer **401**
(unauthenticated — correct), not 500.

**Why this matters beyond the fix itself**: `pnpm smoke:boot` only ever asks `/` and
`/api/health` (outside any calendar route), so this would have shipped a production
build where every calendar API request 500s, undetected by any existing gate command,
exactly the shape `T-BOOT` and `T9.8`'s layout-serialisation bug both already proved
this codebase is vulnerable to. **A candidate pattern worth a founder or integrator
decision, not applied here**: a gate step that starts the built app and hits every
route in the frozen contract with an unauthenticated request, expecting 401/403 rather
than 500 — `smoke:boot` proves the app *starts*; nothing proves every *route* survives
being loaded.

### One real gap flagged, not fixed — matters for `T3.7`/`T4.6`, not this card

**The `Opportunity` contract has no field for a topic's intent class or family ids.**
`topics.intent_class` is `NOT NULL` and `topics.family_ids` defaults to `'{}'`, but the
frozen `Opportunity` contract carries neither, and its `EvidenceFact.value` type
(`string | number`) cannot hold an array at all. `DbTopicScheduler` works around it
today: intent class is read from an `intent_class` evidence-fact convention Gate 1
already writes, throwing rather than guessing if that fact is missing; `familyIds` has
no such fallback and is written as `[]` — schema-legal, not silently wrong (an article
with no mapped families is a problem `T4.3` will hit and can surface loudly), but
genuinely incomplete. **Whoever builds `T3.7`'s onboarding seed or `T4.6`'s
replenishment scoring — the two real callers of `TopicScheduler.schedule` — will hit
this the first time a real, non-fixture `Opportunity` reaches it**, and needs either
the frozen contract re-opened (an integrator decision) or a documented evidence-fact
convention for both fields from Lane C.

**Files outside Lane D's strict directories**: `packages/core/src/contracts/llm.ts`
and `packages/llm/src/models.ts`/`prompts/` (the new `topic_classify` call type — purely
additive, verified: one new enum value, one new tier mapping, no existing behaviour
touched); `eslint.config.mjs` (two new composition-root exemptions, identical shape to
existing entries, flagged in the report as required). No migration.

**Next in lane D: `T4.3`** (evidence pack, Gate 2, article construction) — **launched after
this section was written, running now, see "Right now" at the top.**

## `R-STREAM` LANDED — the stand-in report told a lie, and a test now stops that happening again

**Merged by `sortiva-85` directly (founder present, own gate run), two commits
(`fa95c85` + merge `29ea126`), already an ancestor of this session's `main`** —
verified independently before recording: `git log`, the actual diff, the new test file
read in full, and re-run myself (`pnpm typecheck` clean, `pnpm stubs:report` → 9,
`seams-wired.test.ts` 6/6 passing against a fresh check). Tests **2,780**, up from 2,774.

**The finding is worse than the remediation card that named it.** `pnpm stubs:report`
exists so a milestone's exit gate cannot pass while one of its seams is still a
stand-in — and a seam leaves that report by a person deleting a line from the script,
a judgement checked by nobody. `T2.2`'s session deleted the change-stream's line with a
note claiming "the change stream is served in production by `DatabaseCatalogEvents`."
**That sentence was false.** `DatabaseCatalogEvents` is constructed nowhere outside its
own test, and the job that would drain the stream is registered nowhere. The *writing*
half genuinely works — a merchant's edit really is recorded — but nothing has ever read
it. **`M2`'s exit gate (`T2.7`, already declared closed in this file) passed partly on
a false report line.** Recorded here plainly rather than softened; it does not reopen
`T2.7` — the underlying mechanism (writing changes down) is real and correct, only the
"and something reads it" half was fictional, and that half was never `T2.7`'s to build.

**The line is restored** (`new doubles.StubCatalogEvents()`, `scripts/stub-report.mjs`),
with a note stating what's actually true instead of what was hoped. `pnpm stubs:report`
is **9**, up from 8 — the correct number, not a regression.

**The durable fix is a test, not the restored line — a line can be deleted again by the
next well-meaning session.** New: `packages/core/src/contracts/seams-wired.test.ts`.
**A seam may be absent from the stand-in report only when its real implementation is
constructed somewhere that is genuinely not a test** — a class instantiating itself
inside its own defining file doesn't count, closing the exact loophole that let a
private helper or a self-test satisfy the check while production never used it. Proved
non-vacuous: deleting the restored line makes two tests fail, each naming what to do
about it. **Two seams are already asserted this way, both re-verified as real**: the
notification emitter (Shopify composition root, since `T8.1`/founder authorization) and
`DbExistingTargetCheck` (the calendar's add-topic route, confirmed genuinely wired as
of `T4.2`, not just claimed). **Any future card that fills a seam and deletes its stub
line must add a matching entry here, with a reason — this is now enforced, not just
asked for.**

**The reader stays deliberately unwired — a founder decision, not an oversight.** Wiring
it would be a real production behaviour change that would sit dormant anyway: the
recurring schedule is off pending four handlers (founder question 4, answered "wait"
this run), so neither the change stream nor the nightly re-read runs on a clock today.
**The change-stream consumer (`packages/jobs/src/inventory/drain.ts`, Lane C territory)
is available whenever someone wants it** — the founder's stated reasoning is that it
and the recurring-schedule switch-on should be judged together, not separately, since
turning one on without the other accomplishes nothing.

**Also journalled in this commit**: the founder's `QueryCluster`-via-one-model-call
decision that unblocked `T4.2` (previously recorded above as "relayed, not yet
independently verified" — **now confirmed**: the actual `DECISIONS.md` entry matches
exactly what was relayed, word for word in substance).

## `T4.3` LANDED — the first real article draft, and a genuinely urgent schema gap. **Read the gap section before dispatching `T4.4`.**

**Merged as `f177af7` into `main`, two commits, clean auto-merge, full gate green.**
Tests **2,855**, up from 2,780 — reconciles exactly against `T4.3`'s own +75.

**What it builds**: the pipeline that turns an admitted topic into a Sonnet-drafted
article, with the mechanism that makes fabrication structurally unreachable rather than
merely checked afterward. A **claim plan is written and durably persisted before the
draft call runs** — proved by a test double that queries the database for the persisted
claims from inside the model client's own `complete()` method at the exact moment the
`draft` call type arrives, so the ordering is enforced, not asserted. **The writer sees
only the approved claim list — id, text, kind, confidence — never the raw evidence
pack**: a product's fact sheet is deliberately excluded from what the writer receives
(only id and title, so it can attach a reference token to the right item), read as
required by `docs/content-pointers.md`'s own "the writer only ever sees the approved
claims" guarantee, not the card's own looser reading. Two of the four claim kinds are
derived by **code, with no model call at all** — a merchant fact is read directly off
the fact sheet, a derived fact is arithmetic re-run in code — only *recommendation* and
*external-fact* claims go to the model, and even those are verified before acceptance:
a quote must appear verbatim in its cited excerpt, a recommendation must name a real
claim id. Seven section shapes, each with a named failure condition; the grounding
harness (every citation and product-mention token must resolve to something real); the
no-literal-currency-figure check — all tested and passing.

### The gap this card found, verified directly against the schema, not taken on trust

**`articles` has no column to store a generated draft's body or its meta description.**
Confirmed by reading the migration directly (`packages/db/migrations/0008_wave3.sql`):
the table has `title, slug, target_keyword, state, delivery, published_url` and
timestamps — nothing else. The pipeline produces a complete, checked `Draft` object —
title, meta description, intro, sections, FAQ, product mentions, all grounded and
passing every check — and persists everything that *does* have a column
(`article_claims`, `article_product_refs`, the four `articles` fields above). **The
generated body itself is not persisted anywhere.** It exists only in memory, for the
duration of one job run, then is gone.

**Why this is more urgent than a typical open item**: every card downstream of `T4.3`
in the plan needs to read a draft's body from somewhere that isn't "the process that
just generated it." `T4.4` (Gate 3 — lints, the blind judge, the repair loop) **cannot
be built for real without this** — there is nothing to grade. `T4.5` (the `in_review`
state a merchant approves or discards) needs it to render. `T5.1`/`T5.2` (publish, two
different vendors) need it to send. **This is not a "nice to have later" gap like the
product-images one below it — it blocks the very next card in this lane's own
sequence.**

**Correctly not decided by the lane, and not decided here either — this needs a
founder or integrator call before `T4.4` starts:** the card's own recommendation is a
`bytea`, compressed column, matching `store_pages.body_compressed`'s own precedent (no
blob service exists; Postgres is the store) — but the **shape** of what that column
holds is a real product decision, not an implementation detail, because it changes what
three different downstream cards can do with it: **markdown text** (simple, human-
readable, easy to diff and export, needs a render step everywhere it's shown);
**structured JSON** (matching `Draft`'s own shape — intro/sections/FAQ — no re-parse
needed by the judge or the review screen, but every consumer needs to know that shape);
or **both** (rendered HTML plus the structured source — most flexible, most storage,
most to keep in sync). **This session recommends structured JSON**, matching what the
pipeline already produces and what `T4.4`'s lints (per-section checks) and `T4.5`'s
review screen (rendering sections with their own controls) both seem likely to want
directly — but this is a recommendation, not a decision made on the founder's behalf.

**A second, smaller, already-known gap restated here for visibility**: product images
are empty in every evidence pack and every draft, for the same root cause `T2.7`
already found and flagged (`products` has no column for a Shopify image URL — the
catalog sync reads `product.images` to compute a checksum and then drops it). Not new;
tied here because a reader of this card's own done-when ("images are catalog URLs
only") needs to know the mechanism is correct and simply has nothing to show yet.

**Files outside Lane D's strict directories**, all precedented: `packages/db/src/
repositories` (not lane-exclusive), `packages/rules` (new Gate 2 thresholds, `UNSIGNED`,
`rules_version` changed — same pattern every signal-threshold card has followed),
`packages/llm/prompts` (two new versioned prompt files, following `T4.2`'s own
precedent). No migration.

## `T3.7` LANDED — signal runs and Limited Intelligence. **`M3` is closed.**

**Merged as `474eab8` into `main`, seven commits plus one merge-time fix (`6be916e`),
full gate green.** Tests **2,885**, up from 2,780. This is the
last Lane C card the plan schedules — **the Search Intelligence & Opportunity Engine
milestone is complete**: every signal `T3.4`/`T3.5` detect now flows through `T3.6`'s
scoring into a real, running engine with three cadences (onboarding activation, weekly
scan, event-driven), `/api/opportunities` wired for real, and the calendar seeded via
`T4.2`'s real `TopicScheduler` rather than a fixture pool.

**One merge-time fix, needed because this branch predates a guard that landed while it
was building.** `T3.7` correctly removed `StubOpportunitySource` from `pnpm
stubs:report` — verified independently before merging: `DbOpportunitySource` really is
constructed in the onboarding scan's calendar-seeding step, which really is registered
as the `signal_scan_onboarding_sweep` crontab task in `apps/web/instrumentation.ts` —
but it branched before `R-STREAM` added `seams-wired.test.ts`'s requirement that every
such removal name a `REAL_IMPLEMENTATION` entry. Added one, verified the test goes from
6/7 to 7/7. Not a defect in `T3.7`'s own work — a timing gap between two branches, the
same shape as `T4.2`'s `OPPORTUNITY_STATUS_CHANGED_EVENT` collision with `T3.6`.

### Both flagged gaps from earlier cards were closed, not inherited silently

**`T3.6`'s audit HIGH finding — closed.** A technical blocker discovered after an
opportunity auto-accepts now actually re-blocks it: a new pure function,
`reconcileStatusWithPreconditions`, runs on every re-detection and moves a `new`/
`accepted` row to `blocked` the instant fresh preconditions are non-empty — and moves a
`blocked` row back out the instant they clear, completing the "re-evaluated
automatically" promise main §7.9 makes and `T3.6` had explicitly left undone. Proven
both by a unit-test table and a real-Postgres test that plants a blocking opportunity,
re-scans, and asserts the block, then the unblock. Deliberately scoped to `new`/
`accepted`/`blocked` only — once scheduled, it's Lane D's calendar state machine's
concern, not a signal-detection pass's.

**`T4.2`'s `TopicScheduler` intent-class/family-id gap — worked around, not solved, and
said so plainly.** Traced one level further than expected: `keywords` has no intent or
family column at all, and nothing derives either from free text — the same fact `T4.2`
already found for the sibling manual-add problem. Main §7.5 forbids an LLM call at
detection time (unlike manual-add's one-off, per-click call), so persisting real
lineage needs a schema-wave migration outside this card's reach. **Built a free,
deterministic heuristic** (`packages/core/src/signals/keyword-classify.ts`) and
stamped `intent_class`/`family_id` evidence facts onto all three CREATE-producing
signals — two of which had no such facts at all before this card, which would have made
the onboarding run's first real `TopicScheduler.schedule()` call throw immediately.
**Flagged prominently as a stopgap**: persisting the real lineage at keyword-enrichment
time is named as the strictly better fix, for a founder/integrator to schedule.

### A real bug the integration test itself found, before any merge

**All four GSC-dependent signals would have silently detected nothing on every real
store, forever.** `assembleGscInputs` never rebuilt query clusters before reading them
— found by `T3.7`'s own real-Postgres integration test, fixed in the same commit,
documented rather than silently patched.

### What was deliberately not built, and why

**The opportunity detail-drawer route (`GET /api/opportunities/{id}`) — not built.**
Its `recommendation`/`history`/`outcome` sections belong to `T6.2`/`T7.1`, neither
built (and `T7.x` is deferred out of v1 entirely). Shipping a drawer silently missing
three of six sections was judged worse than not offering the route at all. Three
secondary fields in the list response (`scheduledFor`, `expiresAt`, `nextScanAt`) and
cursor pagination are also honestly absent, documented rather than faked.

**Files outside Lane C's strict directories, all precedented**: `packages/db/src/
repositories` (not lane-exclusive), `eslint.config.mjs` (one new composition-root
exemption, identical shape to existing entries), `apps/web/instrumentation.ts` and
`packages/jobs/src/runtime/crontab.ts` (both integrator-resolved ordered files —
reviewed directly, both changes are additive registrations following exact existing
patterns), `scripts/stub-report.mjs` (the seam it closed). No migration.

### `M3` is closed. What's now unblocked and what still isn't

**Nothing further is scheduled for Lane C** in the build plan (`M7` stays deferred).
**`T6.x` (OPTIMIZE & FIX, Lane E) can now start in principle** — it needs `T3.6` (done)
and `T4.4` (not started, itself blocked on `T4.3`'s schema gap above). **`M6` overall
still needs both `T3.6` and `T4.4`.**

## `T4.0b` LANDED — a finished draft finally has somewhere to live

**Merged as `829271c` by `sortiva-85`, founder-authorised, migration only.** This is the
gap `T4.3` found and stopped on. `articles` gains two nullable columns: **`body_json`**,
holding the draft in the writer's own shape (`{intro, sections:[{heading, body}],
faq:[{question, answer}]}`), and **`meta_description`**, a field beside `title`/`slug`
because publish and export read it as one.

**The founder chose structured storage over prose or both**, on the reasoning that
everything downstream wants the pieces — the judge scores section by section, the review
screen renders blocks — and plain text can always be produced from structure while
structure cannot be reliably recovered from prose. "Both" was rejected because two
representations of one article drift apart.

**One departure from the option as offered, flagged by `sortiva-85` rather than buried:**
`jsonb`, not gzipped `bytea`. Postgres already compresses a large `jsonb` value through
TOAST, so the saving over gzip is small at ~10–30KB per article, while gzipped bytea
makes the content opaque — the judge, the review screen and any later cross-article
analysis would each have to decompress everything to look at anything. Structure was the
half of the answer carrying the intent. Reversible in a small change if the founder
prefers otherwise.

**Verified independently before building on it**: both columns present with the right
types, and the check constraint genuinely bites — a JSON *string* inserted into
`body_json` is rejected by Postgres, not merely refused on paper. A fresh empty database
migrates cleanly to 55 tables.

**Both columns are nullable on purpose** — `insertArticleStub` creates the row before the
writer runs, so an article legitimately exists with no draft. **Do not make either
`NOT NULL` without dealing with that.** And **`productMentions` is deliberately not in
the JSON**: `article_product_refs` holds those as rows already, and two answers to one
question is the bug that shape avoids — read references from the table, never the body.

**A `db:migrate` failure `sortiva-85` hit locally is not a repo defect**: a stale
developer database carrying wave-3's types without matching journal rows. Confirmed here
by running the same command against a freshly created empty database, which applied
cleanly. Every gate run in this file has used a throwaway database, which is why it never
surfaced there. Worth someone recreating their local database eventually.

## `R-DEV` LANDED — the development server serves pages again, **and the diagnosis this file carried all run was wrong**

**Merged as `c1d2541` by `sortiva-85` on the founder's authorisation.** The correction
matters more than the fix, because the wrong version was repeated into three sessions'
briefings, including by this integrator.

**`next dev` was never failing to start.** It starts fine: the worker connects, 22 tasks
register, Next reports ready in about eight seconds — and *then* every page answers 500.
"Cannot start at all" sent people looking at start-up and bundling when the server was
already up.

**The actual cause: Next compiles `instrumentation.ts` for the Edge runtime as well as
Node, and Edge has no filesystem.** The existing `NEXT_RUNTIME !== 'nodejs'` early return
stopped the body *running* under Edge but not from being *compiled* for it — so the job
worker's vendor config reader, which needs `fs/promises`, was compiled for a runtime that
cannot provide it, every route touching that module graph failed to compile, and Next
served 500. **`pnpm build` stayed green because a production build only compiles what it
ships.**

**The fix is the founder's own chosen option, not the one they rejected on `T-BOOT`**: the
body moved to `apps/web/instrumentation-node.ts` and is imported *inside* a positive
`NEXT_RUNTIME === 'nodejs'` check, which Next substitutes at build time, removing the
branch from the Edge bundle outright. No `serverExternalPackages`, nothing marked
external, production behaviour identical (worker still in-process, `smoke:boot` green, 22
tasks). Measured: 500/500 became 200/200.

**⚠️ THE GATE HAS AN ELEVENTH COMMAND NOW: `pnpm smoke:dev`.** It is
`scripts/smoke-boot.mjs --dev` plus a CI step. **Nothing in the gate had ever started a
development server** — every step either read the code or started the *built* app — which
is precisely why this survived so long. Confirmed to bite by hoisting the import back to
module scope: the defect returns and `smoke:dev` fails. **Verified here directly: `PASS
GET / -> 200`, `PASS GET /api/health -> 200`, dev server up in 10.4s.** Add it to every
gate run from here.

**If you touch `apps/web/instrumentation.ts`, keep the import inside the runtime check.**
Hoisting it back to module scope silently restores the defect and no unit test will catch
it — only `smoke:dev` will.

**Two things deliberately left open, stated rather than quietly fixed:**
1. **A bare `pnpm dev` still has no environment.** Next reads `.env` only from the
   directory it starts in, there is no `apps/web/.env`, and nothing loads the repo root's
   — so a developer still meets "DATABASE_URL is not set". `ENCRYPTION_MASTER_KEY` is
   blank too and has never been generated locally. `smoke:dev` passes because the smoke
   script reads the root file and mints a throwaway key. Changing how `pnpm dev` itself
   starts was not the option the founder picked, so it was not done.
2. **The two Playwright projects pointing at `pnpm dev` still will not run locally** until
   (1) is settled. `R-DEV`'s own done-when named them; **that part is not met and is not
   claimed to be.**

## `T4.4` LANDED — Gate 3: the free checks, then a blind judge, then exactly one repair

**Merged as `ba01070`, three commits, full gate green — now eleven commands plus the
documented red.** Tests **2,967**, up from 2,890. **This card is on the scheduled-audit
list (build plan §7) and its audit must run before `T4.5` starts.**

Before this card the writer produced a draft and nothing looked at it. Now: **the
ordering is the substance.** Every free check runs first — structural validity (ragged
tables, duplicate headings, skipped heading levels, dead links, unresolvable product
placeholders, unclosed markup, our own internal vocabulary leaking into the prose),
citations, assertion strength, the no-literal-prices rule, length, internal links,
keyword density, near-duplication against both the store's own earlier articles and the
pages currently ranking. Then the contradiction pass, which is free until it finds a
genuine candidate: numbers, thresholds, recommendations and absolutes are extracted,
grouped by subject and required to agree arithmetically, and **only real disagreements
cost a model call.** Only then the judge.

**The citation check scans sentences itself rather than trusting the writer's markers**,
so a forgotten citation fails rather than passes — which is the whole point of the rule.
Arithmetic claims are **re-derived from the pack's own numbers**, not re-judged.

**The judge is blind and cannot be cheapened**: its request is built from scratch each
call (draft, store facts, top-3 ranking pages), carries none of the writer's
conversation, and names no model, so it cannot run on the cheap tier. Six criteria
including the new *ecommerce usefulness*. **Gate on the minimum, never the average.**

**Verified directly at merge, not taken from the report** — all three call-count
assertions run and pass: a draft failing structural validity buys **zero** judge calls
(and an empty request log); a draft failing only information gain is rejected with
**zero** repair calls, per the founder's own exception; a second regrade failure ends at
`{judge: 2, repair: 1}` with no third loop. Also confirmed passing: judge blindness
(before *and* after a repair), the 5/5/5/1/5 draft failing on the minimum, and the
contradiction pair being caught **and** correctly passed when the model rules the two
statements differently scoped.

**One merge-time fix needed, and it is a known trap**: `packages/llm` gained a
`@sortiva/rules` dependency, so `pnpm typecheck` failed on the merged tree until
`pnpm install` linked it. Declared in `package.json`, not yet linked in this worktree's
`node_modules` — the documented lockfile hazard. No code change; `pnpm install` and it
was clean.

### A decision this card needs the founder for, and it is cheaper to answer now

**An overridden article lands in `draft` and rejoins the ordinary delivery path.** It has
to leave `rejected` or nothing will ever deliver it, and there is no state meaning
"rejected but publish it anyway". The card chose `draft` over `in_review` on the grounds
that the merchant already gave the deliberate confirmation §8.6 requires, and the spec
says only that an override is logged and flagged. **This is the interface `T5.1`/`T5.2`
will build against** — if an override should still pass through draft review when that
setting is on, this is the line to change, and changing it now is far cheaper than after
publishing is built on it.

### Two gaps it surfaced rather than papered over

- **The word-list checks are English-only.** A non-English store gets the shape-based
  checks but not the vocabulary ones — a real, user-invisible weakening, the same shape
  as the filler-word gap `T3.3` already recorded.
- **Gate 1's and Gate 2's reason keys have no copy anywhere in the repo.** So main
  §8.6's "plain-language reason" is currently a key rendered on a screen. Pre-existing,
  not this card's doing, and not fixed by it.

**Also now unblocked but out of scope**: `JudgeOutcomeCounter`, §14.5's judge-fail-rate
auto-trip, whose stub said "once a draft's gate decision is stored" — which is true as
of this card. The kill switch itself was not in scope.

**Files outside Lane D's directories**, all precedented: `packages/db/src/repositories`,
`packages/rules` (six new unsigned thresholds — invariant 9 requires them there),
`packages/llm` (prompts, the `judge.eval` set, and the new dependency),
`packages/ui/strings/en.json` (copy rule). No migration. No API route, so no
composition-root trap.

## `T4.5` LANDED — the product now writes one article a day, on its own. **`T4.5` is on the scheduled-audit list; its audit must run before `T4.6`.**

**Merged as `daf35db`, two commits, all eleven gate commands green.** Tests **3,017**, up
from 2,967. **Before this card nothing in the product wrote an article by itself** — the
pipeline existed and was exported, but `generation_cycle_daily` was a name in the
schedule with no handler behind it.

**An hourly sweep, not a daily one, and the reason generalises.** The schedule changed
from `0 3 * * *` to `0 * * * *`: the cycle must start a fixed number of hours before each
store's *own* publish hour so writing, grading and the one repair finish in time, and
03:00 UTC is a different time of day in every country — one fixed moment cannot be early
enough for a German store and an Australian one at once. **This is the third card to
reach the same conclusion** (the weekly signal scan and the monthly summary sweep did
too); per-account-clock-with-hourly-sweep is now the established pattern. The lead is a
new number in `packages/rules` because it decides how much runway the writer, checks,
judge and repair get.

**The checks run in §14.5's order** — kill switches → entitlement → vacation → Shopify
token → a topic for today — and **each is proven to stop before spending anything**:
verified at merge, every one of those tests asserts zero model calls, not merely a
refusal.

### The idempotency the `T4.4` audit demanded — built, four mechanisms deep

The audit's handoff was blunt: a retry paid for a whole second article. Now: the calendar
is queried on the exact date for `planned` only, so **future topics are unreachable by
construction** (invariant 14); the `planned → generating` transition is guarded, so a
second arrival matches zero rows and stops; the idempotency key is **derived** from
account, task and topic-plus-local-date — never random — into `idempotency_ledger`, so a
redelivered job returns the stored outcome having spent nothing; and the whole run sits
under the account lock.

**The checkpoint is the part worth reading.** `generateArticle` now looks for an article
the topic already has. A `draft` one is **adopted** — same row, same slug, so no
`keyword-2` — its claims and references replaced rather than appended, and **the stored
draft is reused rather than re-written**, reconstructed from `articles.title`/
`meta_description`/`body_json` plus `article_product_refs`. It is validated before use — **but that validation is weaker than
this section originally claimed, and than the landing session claimed. Corrected after
`T4.5`'s audit: claim ids are positional, and the check only asks whether each cited id
still exists, so a re-planned set of the same length — different facts, same count —
passes, and the stored draft is graded with its citations silently re-pointed at
different facts.** It catches only a plan that got shorter. Gate 3 catches a numeric
mis-binding downstream; a superlative or an attributed statement it does not. **A topic
left `generating` by a dead run is now finished on the next pass instead of stranded
forever.** Proven: after a crash, the retry adopts the same article id and slug and makes
no second writer call.

**Residual cost, stated rather than hidden:** the claim plan and Gate 3's calls still
re-run on a resumed attempt — Gate 3 grades *against* the plan, and `article_claims` has
no ordinal column to rebuild the positional citation ids from. Free inside the LLM
wrapper's 24-hour request cache, re-paid outside it. Closing it fully needs a column, so
a migration, so out of scope. **Parking the draft in `idempotency_ledger` was explicitly
rejected** — that is the one table nothing may delete per account, so article prose there
would survive a store-redaction purge.

### The post-grading state question, answered without a migration

`draft` is kept, and the ambiguity made harmless instead: a new read,
**`articlesReadyForDelivery`**, joins the article's state against a *passed* Gate 3
decision on its topic. A crash between writer and judge leaves a row that reads as
unfinished — which it is. **This is the interface `T5.1`/`T5.2` must use; the state alone
is not sufficient**, and that is now proven by a test that tells a graded-and-passed
draft apart from one that was never graded.

**Draft review: two answers, no third.** Approve returns the article to the delivery path;
discard discards it and closes the calendar day as vetoed — but deliberately **does not**
add the subject to the not-interested list, since that is a judgement on the article, not
the topic. **No editor**, proven by grep at merge: no `PATCH`/`PUT`/`DELETE` under
`/api/articles`, only approve and discard exist, and a test fails if that changes.

### The gap that makes review unusable today, flagged not fixed

**A merchant with draft review switched on is never told a draft is waiting.**
`draft_ready_for_review` is declared in the notification matrix with rendered copy and
nothing emits it; the dashboard's "needs you" source is still a stub returning nothing.
Both live in Lane G's directories. **So a waiting draft is invisible until someone opens
the content screen by chance.** Not in this card's scope — but **draft review is not
usable without one of them**, and that is worth someone's decision rather than discovery.

**Also not built and not claimed:** `GET /api/articles` and `GET /api/articles/{id}` are
in the frozen contract and unbuilt, so Lane F's article screens still have nothing real to
read. Approve marks permission only — the publish hour is `T5.1`.

**Two of founder question 4's four missing crontab handlers are now registered** —
`signal_scan_weekly` (T3.7) and `generation_cycle_daily` (this card). **Two remain:**
`replenishment_monthly` (`T4.6`) and `publish_intent_recovery_sweep` (`T5.x`). The
recurring schedule can be switched on once those land.

**Files outside Lane D's directories**, all precedented and reviewed at merge:
`packages/db/src/repositories`, `packages/rules` (one number), and the three
integrator-resolved ordered files — `crontab.ts`, `instrumentation-node.ts`,
`eslint.config.mjs` — each a single additive registration or exemption following an
existing pattern. **No migration.** The composition-root trap was correctly avoided:
`reviewDeps()` is deferred into the request-handler closure.

## `T4.6` LANDED — replenishment, and an exit gate that reported the milestone's holes instead of hiding them. **⚠️ `pnpm chaos` IS NOW RED, DELIBERATELY — read this before treating that as a regression.**

**Merged as `1479937`, two commits.** Tests **3,049**, up from 3,017. **The gate is now ten
of eleven green, with TWO documented reds: `pnpm eval` (no Anthropic key, unchanged all
run) and `pnpm chaos` (one named scenario of eight — see below).**

**What it built.** When a store's planned calendar runs short of 60 days, the job reads the
opportunities the engine auto-accepted, drops vetoed subjects, ranks what remains, and
fills unoccupied days out to 90. **It spends nothing** — no model call, no search request.
Two shares constrain it: revisiting old articles is capped at 40% of days offered, and a
floor (at least 2, or 15%) is kept for article kinds the store has never tried. Every day
filled carries its opportunity, its score, and a why-line that is a **key into the copy
catalogue, never model prose** (invariant 8).

### The defect it fixed is the reason the product could not write anything on its own

**`DbTopicScheduler` was dropping the product families off every automatically scheduled
topic** — `const familyIds: readonly string[] = []`, hardcoded. Families travel from the
engine as one repeated `family_id` evidence fact each (a fact's value cannot hold a list),
a convention `T3.7` established and every detector already emits; the scheduler simply
never read it. **So every auto-scheduled topic reached the writer with nothing to write
about and was held as a thin evidence pack.** The end-to-end test returned `held_thin_pack`
before the fix and a graded article after. Verified at merge by reading the diff directly.
`T4.2` had flagged this as a known gap and `T3.7` supplied the convention — **this is the
card that connected them**, which is exactly what an exit gate is for.

### ⚠️ `pnpm chaos` is red on one named scenario, on purpose

Two scenarios were written, and the pair is what makes the finding legible:
`generation_cycle_killed_same_day` **converges**; `generation_cycle_killed_across_midnight`
**does not** — one article written, none graded, topic stuck in `generating`. **This
reproduces `T4.5`'s HIGH audit finding exactly**, and the failure message says so in plain
language rather than as an assertion diff.

**It was not fixed, and this session agrees with that.** Every way of converging is a
product decision, not a code change: finishing yesterday's draft today puts an article on
a day the calendar never scheduled (brushing invariant 14); abandoning it means deciding
what the merchant is told about a day that silently produced nothing; a separate sweeper is
a third shape with its own cadence. It is also more than one clause — the resume is only
consulted when today has *no* planned topic, so a store with a full calendar never reaches
it either. **The card's recommendation, which this session endorses: a sweeper that finds
topics stranded past their own day, finishes the one furthest along, and dead-letters the
rest.**

**For whoever runs the gate next: this is one named scenario, not a blanket red.** A new
failure in any other scenario is a real regression. The precedent is `pnpm eval`, left
red all run as the honest signal rather than made to pass. **This is founder question 17.**

### The stub gate's true state — it said seven, four are real, and none are Lane D's

- **Stale, cleared:** `TopicScheduler`. `T4.2` filled the seam and nobody removed the line.
  Verified to the bar `seams-wired.test.ts` enforces — `DbTopicScheduler` is built in three
  non-test places (the onboarding scan's seeding step, the schedule action behind
  `POST /api/opportunities/{id}`, and now replenishment) — and the required
  `REAL_IMPLEMENTATION` entry was added.
- **A defect in the gate itself, fixed:** `JudgeOutcomeCounter` and `PublishOutcomeCounter`
  are due at M10, but **`'M10' <= 'M4'` is `true` in JavaScript** — "1" sorts before "4".
  **Every milestone gate since M2 has been reporting them falsely.** The script now parses
  the number. This made nothing green: M4 still fails on four, M3 still fails on one.
- **Real, none of them Lane D's:**
  - **`CatalogEvents`** (Lane B, due M2). Merchants' product changes are recorded and
    nothing reads them. **M2 *and* M3 were both declared closed with this outstanding.**
    Blocks `T5.3` (drift & repair), whose entire input is this stream.
  - **`AttentionSources.articles`** (Lane G) — the dashboard's "needs you" list returns
    nothing. **Blocks draft review being usable at all.**
  - **`EmailFacts.articles`** (Lane G) — the monthly summary reports no articles published
    and no topics held back, so **a working month looks like a quiet one.**
  - **`ExportUrlReminder.articles`** (Lane G) — export accounts are never chased for their
    published URL, so those articles get **no attribution and no performance signal at
    all.**
  - All three Lane G ones were blocked on the `articles` table, **which has existed since
    `T4.0`. They are now buildable.**

### Does M4 actually run end to end? Yes — and it did not before this card

`m4-flow.test.ts` runs an accepted opportunity → replenishment places it → the store's day
arrives → the pipeline writes, checks and grades → the article sits `in_review` and the
calendar says so. **Real:** the opportunity is a database row read through the frozen
seam's real implementation; real scheduler, real pipeline, real Gate 2 and Gate 3, real
article body, claims and product references. **Stubbed: only the three outside
boundaries** — model client, search vendor, page fetcher. Nothing internal.

**Wired but unproven, stated plainly by the card rather than discovered later:**
- **No Gate 1 pass runs on a replenished topic.** Main §9.6.4 ends "Gate 1 runs *after*
  scoring, on the top-ranked candidates only" — nothing does that. The checks *were* made
  when the opportunity was detected, but never re-made against the store as it is when the
  topic is actually scheduled. **The tell is in the audit trail: an auto-scheduled topic
  has no gate-1 `gate_decisions` row at all, while a manually added one does.** Not built
  because the design has real content (does a failing re-check reject, convert, or free the
  day? does it spend a search request per pick — the cost the ordering exists to control?).
- **Gate 2 records only its refusals**, so "was the pack checked?" is answerable only by
  the absence of a hold.
- **Pattern multipliers are structurally live and factually empty** — nothing writes
  `pattern_stats` because that job is `T7.1`, deferred out of v1. In production every
  multiplier is 1.0 and every candidate reads as "unexplored". The planner degrades
  correctly under that by design, which is why the exploration floor promotes *after*
  scoring rather than reserving before it.

**Verdict, in the card's own words and this session's: M4 is functionally complete but
does not exit clean.** The engine genuinely runs from opportunity to reviewable article.
Three holes remain — the midnight crash, no post-scoring Gate 1, and draft review being
unusable — **none of them holes in this card's own increment; all three are the
milestone's.**

**A constraint requested, not added** (correctly — a feature card may not migrate): a
partial unique index on `topics (account_id, scheduled_date)` where `state <> 'vetoed'`,
plus turning the manual-add route's check-then-insert into an insert-with-conflict.
Replenishment itself is safe (it holds the per-account lock), but the manual-add route does
not take that lock, so a merchant adding a topic while a top-up runs is unprotected.

**Files outside Lane D's directories**, all precedented and reviewed at merge:
`packages/db/src/repositories`, `packages/rules` (one number), `packages/ui/strings`
(four why-line strings), `packages/core/src/contracts/seams-wired.test.ts` (the guard's own
registry), `scripts/stub-report.mjs` (the milestone-comparison fix), and
`apps/web/instrumentation-node.ts` (one additive registration). **No migration, no new API
route**, and the composition root is called from inside the registration, never at module
scope.

## `T6.2` LANDED — a merchant can ask for a page to be improved. **Two integrator actions are ready and deliberately NOT taken — read those before assuming M6 works end to end.**

Merged as `3d020a0`, gate green on the merged tree: tests **3,140** (up from 3,093), nine of
eleven commands, `eval` and the one named midnight chaos scenario red for their documented
reasons and nothing else.

**What a merchant gets.** They pick one of their own pages and ask for it to be improved.
The product assembles what it knows — how the page reads now, what people searched to reach
it over 28 days, what the pages outranking it settle that it does not, the store's own
product facts and family axes, its other pages as link candidates, and its own voice — asks
Sonnet for edits, runs five free checks, re-asks **once** with the failures attached, grades
the survivor, and stores it. It is downloadable as Markdown or HTML. Marking it applied
schedules the outcome measurement 28 days out. **Nothing is written to their store**, by
design and by test.

**Verified by the integrator rather than taken from the report:** the composition root is
called inside each request-handler closure, not at module scope — the defect that made every
`/api/calendar` route return 500 while `pnpm build` stayed green. The lane also started the
built app with a real database URL and hit all four new routes: each answered **401, not
500**.

### Action 1, held: the generation job is registered nowhere, so a request would hang forever

`registerOptimizeTasks` exists and is tested. Handlers are installed in
`apps/web/instrumentation-node.ts`, which the build plan reserves for the integrator, so the
lane correctly stopped short. **Today the route writes its queue row and nothing picks it
up**: a merchant's opportunity would sit in `executing` for ever.

**Why the integrator did not simply wire it, though the file is his.** It is the same shape
as plugging in the bell, which the previous run explicitly held for the founder: it switches
on a **paid** pipeline that has never run anywhere. And the lane flagged a defect that this
wiring would make reachable for the first time — see below. Nothing tonight needs it:
`T6.3` does not depend on it and the scheduled audit is read-only. **One line plus a full
gate re-run whenever the founder says go.**

### Action 2, held: the routes on disk and the frozen contract disagree

The card and the build plan's lane table both say `apps/web/app/api/recommendations`, and
that is what was built — four routes. **The frozen route table
(`packages/core/src/api/routes.ts`, from `T0.7`) instead declares
`POST /api/opportunities/{opportunityId}/recommendations` and
`POST /api/opportunities/{opportunityId}/tasks/{taskId}`.** Verified directly, not taken from
the report.

So the product now **declares two endpoints it does not serve and serves four it does not
declare**, and `pnpm contracts:check` passes throughout because it compares zod to OpenAPI
and never to the routes on disk — a reporter that cannot see the thing it is trusted for.
The practical cost lands on Lane F, which builds screens against the contract: it would mock
two endpoints that do not exist and miss four that do.

**Changing a frozen contract is on the integrator's never-without-asking list**, so this is
held rather than resolved. The two ways out: add the four routes to the contract, or move
the implementation under `/api/opportunities/{id}/…` when Lane C's directory is free.

### A defect the lane flagged and correctly did not fix

The nightly auto-trip sweep counts the OPTIMIZE daily allowance in **model calls**, trips at
`used >= cap`, and raises an account flag that stays up until an operator clears it. So a
store that legitimately uses both of its generations in a day — or one whose single
generation needed the re-ask — has its OPTIMIZE calls **paused indefinitely** from then on.
The card's own in-request cap counts *generations*, which is what the spec caps. The sweep is
in another lane's file. **This is reachable for the first time the moment Action 1 is taken**,
which is part of why it was not.

### What this leaves for `T6.3`, the M6 exit gate

**`T6.3` IS STOPPED.** Its scheduled audit ran and found a CRITICAL and four HIGH — read the
`T6.2` audit entry in "Audit findings, unactioned". The stopper is procedural rather than
technical: `T6.3`'s own done-when drives an OPTIMIZE opportunity through its states, and the
state graph it will read does not contain the transitions `T6.2` actually performs. Correcting
that graph is acting on an audit finding, which needs the founder.

**The audit also settles Action 1 above.** Not wiring the job was right, and for a bigger
reason than the one first recorded: the first two presses of the button consume the store's
daily allowance *permanently* and lock those opportunities out of retry for ever, and a
refusal or crash mid-generation does the same. Wiring it tonight would have turned a
theoretical hole into a reachable one.


## `R-INTENTGAP-JOB` LANDED — the paid page comparison is now a job, and it is the **second** registration waiting on one line from the integrator

Merged as `ff826c6`, gate green on the merged tree: tests **3,146**, nine of eleven commands,
the two documented reds and nothing else. Purely additive, entirely inside Lane E's own
directory — verified by diffstat, not by report.

**What it does.** The comparison `T6.1` built now runs as a scheduled pass of its own, on the
store's **own Sunday** — the day before the weekly scan that reads what it bought, and early
enough that a comparison is still usable when the scan runs. An hourly sweep matches stores
whose local clock has turned Sunday and queues one job each. The pass takes the store's lock,
derives its key from the store plus that local date (never at random), returns the stored
answer if it already ran, and walks the shortlist buying what the daily allowance permits.

**Two details worth keeping.** A pass stopped by the allowance is **deliberately not recorded
as finished**, so the pages below the cut-off stay reachable when it resets. And there is no
cursor — the request cache is the checkpoint, and the lane journalled why a second
"this page is done" marker would be actively harmful rather than merely redundant. The
kill-and-resume test proves it: the resumed pass makes exactly one model call and buys no
second results page.

**Its own honest gap, and it is the same gap twice now.** `registerIntentGapTasks` is called
by nothing, and `intent_gap_scan_weekly` is in no crontab — **both on instruction.** The lane
was asked directly whether a schedule entry is needed for the card to mean anything and
answered yes, plainly. So there are now **two unwired registrations waiting on the integrator**
(this and `T6.2`'s), and they interact: the worker refuses to start on a crontab entry whose
handler is not registered, so registration must land first or with the schedule, never after.

**One thing the integrator must resolve before wiring either.** The registration line needs an
Anthropic client, and the generation lane memoises its own inside
`apps/web/app/api/articles/_lib/config.ts` without exporting it. The lane deliberately did
**not** build a second client in its own config, because a second client in one process is
what that file's own comment warns against. So the integrator either exports that factory or
builds one client in the composition root and hands it to both.

**A gate note, recorded because it will recur.** The lane's first `pnpm test` reported
250/250 files and 3,146/3,146 tests passing but exited non-zero on a Postgres `57P01`
teardown error in **another lane's** account-deletion test — a throwaway database dropped with
a connection still open. Immediate re-run clean. This is the second shape of the known
concurrent-load flake and it belongs to whoever next touches `packages/db/src/testing.ts`.

## `T5.1` LANDED — an article now appears at the store's publish hour, and can be taken away. **The lane edited two integrator-resolved files after being told not to; both were kept after review.**

Merged as `1d66186`, gate green on the merged tree: tests **3,195** (up from 3,146), nine of
eleven commands. The known chaos failure printed its documented message **verbatim** and its
sibling `generation_cycle_killed_same_day` still converged — checked, because this card
changes how the local day is derived and that scenario is about local midnight.

**Three things a merchant would notice.**

1. **The founder's day-skew ruling is built.** The day whose topic is written is now read at
   the *publish* moment rather than when writing starts. For the default 09:00 store nothing
   changes at all; it changes behaviour only for publish hours between midnight and 05:00,
   which is exactly the broken case — those stores were permanently one day out between their
   calendar and their shop.
2. **Delivery at the publish hour, which nothing did before.** An article no longer appears
   the moment the quality gate passes it. An hourly sweep finds the stores whose own clock has
   just struck their hour and hands each **at most one** finished article, oldest first, under
   the store's lock. Gated by the publishing kill switch, then billing, then vacation.
3. **The export bundle** — Markdown, HTML and metadata. Every price, stock state and product
   address is resolved **at the moment the bundle is built**, from the store's own synced rows,
   out of placeholders the draft carries instead of literals. **A product that has gone refuses
   the whole bundle** rather than rendering a hole. Image addresses pass only if they are on
   the store's own CDN, and never image bytes.

### The rule breach, recorded

The lane was told: if you need a file outside your directories, write the line into your
report and stop. It edited `packages/jobs/src/runtime/crontab.ts` (one entry) and
`apps/web/instrumentation-node.ts` (one registration block) anyway, and reported both plainly
afterwards. **Both were kept**, after the integrator read them line by line — which is what
"integrator-resolved" is supposed to mean — on these grounds: the crontab entry has its
handler registered, so **the count of entries without one is unchanged** and founder question
4 is not affected; the recurring schedule itself is still switched off, so nothing runs; and
on export mode the job writes to nobody's shop. **The rule stands and the next card in this
lane has been told so explicitly.**

**Note the asymmetry this creates, because a reader will otherwise think it inconsistent.**
Two other registrations (`T6.2`'s and `R-INTENTGAP-JOB`'s) are still deliberately unwired.
They are held for reasons of substance, not process: `T6.2`'s would make its CRITICAL finding
reachable, and the intent-gap one needs a decision about where the process's single Anthropic
client comes from. `T5.1`'s has neither problem.

### Three things parked, each with what it costs

- **The bundle carries no images, ever, in production.** Nothing in the schema stores a
  Shopify image address — the catalogue sync reads them and drops them. The filter and the
  CDN rule are built and tested against planted input, but **the list handed to them is always
  empty**. Needs a schema wave plus a line in Lane B's sync.
- **Prices render as bare numbers** — `49.99`, not `49.99 USD`. Nothing anywhere records the
  shop's currency. One line in Lane B's product mapping, no migration.
- **The merchant cannot set their publish hour.** The column, the default and the frozen
  settings schema all exist; the route that would write it is unbuilt, in another lane's
  directory.

### A defect this card found in a *shipped* screen, and did not fix

**The download button on the articles screen saves nothing, and did before this card too.**
Lane F's screen implements download by fetching `GET /api/articles/{id}` — a route that
**exists nowhere in `apps/web`** — and assembling the files in the browser. `T5.1` built
`GET /api/articles/{id}/export`, whose response is exactly the shape that screen's handler
already expects, so the fix is one line in Lane F's `ArticlesClient.tsx`. The sibling
`published-url` route **is** already called by that same screen and works end to end.
**Unactioned — it is another lane's file.**

**And a second contract divergence:** the export route is not in the frozen route table
either. That is now **two** cards whose routes the contract does not know about (`T6.2`'s four
and this one), and `pnpm contracts:check` still passes, because it compares schemas to schemas
and never to the routes on disk.

## `R-INTENTGAP-SCAN` LANDED — the founder's split is closed, and it flagged a contradiction about what a merchant is told

Merged as `c70c1bd`, gate green on the merged tree: tests **3,205**, nine of eleven, the two
documented reds and nothing else. No migration, and **no change to `signals.config.yaml`, so
no `rules_version` churn** for any other lane.

**What it does.** The weekly scan now produces the *existing-page intent gap* signal — "this
page of yours ranks, but answers less than the pages ranking above it" — **and buys nothing
to do it.** It rebuilds the address the Sunday pass filed its answer under, out of three rows
it can read for free: the page's own change fingerprint, the identity of the results page that
was read, and when it was read. No stored answer means the page is passed over. **The escape
hatch was not needed** — the key was recomputable, so no table and nothing outside the lane.

**Measured, not asserted:** the end-to-end case checks the search provider recorded **zero**
calls. And a separate guard file forbids the scan from ever acquiring a page fetcher, a model
client, or the paid comparison itself — **and it asserts up front that it found files to
check**, so it fails loudly rather than passing on an empty list. That is the non-vacuity
shape the `T6.2` audit went looking for, applied without being asked.

### One judgement past the card's wording, flagged by the lane and kept

**A page nobody compared keeps its opportunity.** The type list the lane had to extend drives
two things: which signals are evaluated, and the sweep that closes an opportunity whose
evidence a scan no longer finds. Extending it literally would mean: the paying pass is stopped
by the store's daily allowance → no comparison exists → **the merchant's opportunity silently
disappears**, and returns the following week as a *new* row with a second "we found something"
notification. Not having compared a page is not evidence the gap closed. **Reversing this is
deleting one line**, and the lane said so.

### FLAGGED, held for the founder — two statements about this signal disagree, and both are visible

`signals.config.yaml` records this signal as **not** needing Search Console (`needs_gsc:
false`), and that flag is exactly what the **Limited Intelligence badge** reads to tell a
merchant which signals are unavailable to them. But both halves built here only work for a
store with Search Console connected, because the shortlist is built from Google's own record
of what it showed. **So today the badge does not name this signal while the scan does not
evaluate it** — a store without Search Console is quietly missing something nothing tells them
about.

Main §7.11's own list also omits Intent Gap, and §7.3 gives it a **second qualifying route**
that needs no Search Console at all — being the store's existing target for a keyword
competitors rank for — **which neither half implements.** Not resolved, correctly: flipping
the flag changes `rules_version` for every lane and changes what a merchant is told.

### Both halves are live in code and dark in production, and that is expected

The scan half runs for every store every Monday from this merge, because the weekly scan is
already registered and already in the crontab. **The paying half is registered nowhere and
scheduled nowhere**, so the scan will find nothing to read until the integrator wires it —
which is the second of the two held registrations described elsewhere in this file.

**One more parked item.** If the pass were wired today, the opportunity card's why-line would
render the generic "we can't show the reason" wording, because this signal has no sentence in
the copy catalogue. Pre-existing and shared with other live signal types, the renderer
degrades honestly rather than showing a raw key, and inventing merchant-facing wording is not
a lane's to do.

## `T5.2` LANDED — a merchant can let Sortiva post to their shop, and it posts exactly once. **Its scheduled audit is running.**

Merged as `3e045e5`, gate green on the merged tree: tests **3,265** (up from 3,205), nine of
eleven commands. **`pnpm chaos` is now nine scenarios, eight passing** — the new
kill-between-posting-and-recording case passes, and the only failure remains
`generation_cycle_killed_across_midnight`.

**What a merchant gets.** Installing Sortiva still asks for read access only. **Posting is a
second, separate permission** with its own flow: a scope list that keeps every read scope and
adds exactly one write scope, a check that throws away a grant that came back without it, and
a signed value carried through Shopify's consent screen naming the account and saying *this
was the publishing pass* — so an install redirect cannot be replayed at it to record a
read-only grant as a publishing one. **Auto-publish cannot be switched on with nowhere to
post**: the same two conditions are a `WHERE` clause on the database write, not merely a check
before it.

**Every post is claimed, sent carrying our own marker, then recorded.** A second worker
collides on the claim and stops. The recovery sweep **asks the shop whether our marker is
already there before it ever considers sending again** — found means adopt, not found means
send, and there is no third path. A claim nobody can settle is abandoned after three sweeps
into the dead-letter queue. An article is recorded as published only after the shop confirms.
**An update names the article it revises or does not happen**: when the merchant has deleted
the post, nothing puts it back and they are told.

**Verified by the integrator rather than taken from the report:** Lane B's install flow is
untouched (invariant 21's first half — checked by diffing that directory, which is empty); the
second grant adds exactly one write scope and keeps the read ones; and the update path
**abandons rather than creating**, which is the specific fallback invariant 19 forbids.
**The lane obeyed the integrator-resolved-files rule this time** — no crontab edit, no
composition-root edit — after `T5.1` in the same lane did not. It did append one line to
`eslint.config.mjs` and said so; six prior cards did the same and `pnpm lint` is red without
it.

### Three things the lane flagged, all held

1. **The recovery sweep will never run.** Built, tested and registered, but its schedule entry
   lives in the crontab, which it was told not to edit — the exact entry is written verbatim
   in `DECISIONS.md`. **Until it lands, a crash mid-publish leaves a live post the app shows
   as unpublished.** It never double-posts, but it never recovers either. No composition-root
   change is needed; `T5.1`'s registration already covers it.
2. **The blog picker is at the wrong address for Lane F's Settings screen** — the frozen
   contract puts these on `/api/settings/*`, a directory that does not exist and that no lane
   owns, and `PATCH /api/settings` spans four other lanes' settings. Built at `/api/publish/*`
   instead. **The Settings screen would get a 404 from all three.** This is the **third**
   contract divergence tonight.
3. **Nothing here has talked to a real Shopify store.** Everything is proven against a fake.
   The lane's own best guess at what breaks first: the article address it builds uses the
   blog's id where Shopify's URLs use the blog's handle — and that address is stored at
   publish and read later by attribution and performance.

**Also:** `republishArticleToShopify` is complete and called by nothing — `T5.3`'s repair
queue is its trigger.

### After this card and its audit, the night is done

`T5.3` is blocked: its whole input is the `CatalogEvents` change stream, whose reader the
founder deliberately left unwired to be judged together with switching the recurring schedule
on. `T6.3` is stopped by the `T6.2` audit. Every other lane has no milestone work left. **M10's
exit gates need all of the above.**

## 2026-09-04 morning — five founder answers, and what checking them changed

**Nothing is merged yet. Two lanes are running.** This section is the current state; everything
above it describes `main` as it stood at 02:25 and is still accurate about `main`.

### What the founder decided, in order

All five are journalled in `DECISIONS.md` under today's date.

1. **The recovery sweep is renamed, and the recurring job schedule switches on.** The job
   worker enables recurring jobs only when every scheduled entry has code registered under
   exactly that name; one mismatch turns all seventeen off, silently. There was exactly one
   mismatch — the sweep that settles a publication a crash left unanswered was registered as
   `publish_recovery_sweep` while the schedule has called it `publish_intent_recovery_sweep`
   since M0. Renaming the handler satisfies the founder's own condition from 2026-09-03
   ("wait for the four missing handlers") rather than relaxing it. **Carded as `R-SCHEDULE`,
   dispatched to Lane D.**
2. **A scheduled name with no handler must fail loudly rather than disable the schedule.**
   Authorised as work, **not built now** — written into `T10.2`'s card in the build plan
   alongside the three other reporters known to fail towards "fine".
3. **The change-stream reader is wired**, so a merchant's edit to their store actually
   reaches the product.
4. **The trigger is the webhook**, on arrival — not the nightly sweep and not a schedule of
   its own. A collection rewritten at nine in the morning is re-read minutes later.
5. **A catalogue change also triggers a full signal scan** — the same paid market analysis the
   weekly scan runs. The founder was told the cost before choosing. **(3)–(5) are carded as
   `R-STREAM-WIRE`, dispatched to Lane B.**

### What checking the second one changed, and this is the part that matters

**"Wire the reader" was recorded everywhere as one line in the composition root — by this
file, by the handoff, and by the code's own comments. It is not.** Verified before dispatching
anything:

- The registration is genuinely missing and is one line. But `enqueueCatalogEventDrain`, the
  call that *starts* a pass, has exactly one caller in the repository: the reader re-queueing
  itself when a pass found something. **Nothing ever starts the first pass**, so registering
  the handler alone would leave the stream still unread and the wiring would look done. That
  is what made the trigger a founder question rather than a coding detail.
- **The producing half is real and running**, contrary to the comments in
  `packages/jobs/src/inventory/drain.ts`, which still say it "does not exist yet". Both the
  Shopify webhook handler and the nightly catalogue sweep write to the change record today.
  Lane B is fixing those comments as part of `R-STREAM-WIRE`.
- **The paid-scan half needs a change in Lane C's file.** `CatalogEventDrainDeps.signalScan`
  is declared as an eager object holding a live database handle and connection pool, and every
  other registration in the composition root is handed factories instead, on the stated rule
  that registering a task must not open a database connection. So the dependency has to become
  something the reader calls when it runs. **This is a cross-lane edit the integrator
  authorised and placed with Lane B**, with the reason written into the card, because splitting
  one wiring across two sequential cards would leave `main` half-wired for a card's duration.

### The ordering the two dispatches were given, and why

`R-STREAM-WIRE` deliberately **excludes** three files, and Lane B was told so explicitly:
`apps/web/instrumentation-node.ts` (integrator-resolved), `scripts/stub-report.mjs` and
`packages/core/src/contracts/seams-wired.test.ts`. The last two must change when the reader is
genuinely wired — the `CatalogEvents` seam stops being a stand-in — but the test `R-STREAM`
built asserts the real implementation is *constructed outside a test*, which depends on the
composition-root line the lane may not apply. **The lane writes that line into its report; the
integrator applies it and makes both bookkeeping changes after the merge, then gates.** Asking
a lane to commit a test that cannot pass in its own worktree would have been the alternative.

Both lanes were told, explicitly and by name, not to edit integrator-resolved files and to
write any such line into their report instead — the trap `T5.1` hit.

### What this does NOT unblock

- **`T6.3` is still stopped.** Its stop is the `T6.2` audit's, not this one: its done-when
  drives an OPTIMIZE opportunity through its states, and the state graph it will read does not
  contain the transitions `T6.2` performs. Correcting the graph is acting on a finding and
  needs the founder. **Not asked this morning.**
- **`T5.3` becomes dispatchable only once `R-STREAM-WIRE` has merged and gated**, since its
  whole input is the stream that card wires.
- **The `T6.2` CRITICAL is untouched** — two presses of the OPTIMIZE button still permanently
  disable it for an account, and the job is still deliberately unregistered.
- **The contract divergence is untouched.** Ten endpoints still sit at addresses the frozen
  route table does not know about, and it still blocks Lane F.
- **`pnpm eval` is still red** and stays red until there is an Anthropic key.

### `R-SCHEDULE` LANDED — the product's clock is running

**Merged as `b3ed2f9`. Full gate re-run on the merged tree: green, nine of eleven, with `eval`
not run and the one named chaos scenario red for their documented reasons and nothing else.**
Tests **3,265**, unchanged — a rename with no new test, which is what the card asked for.

**What changed for the product.** All seventeen recurring jobs are now live wherever the
application starts. Until this morning none of them ran: not the daily article generation cycle,
not the weekly signal scan, not monthly replenishment, not the nightly sweep that actually
erases deleted accounts and prunes tables, not the automatic spend brakes, and no scheduled mail
at all. **The product had no clock.** It has one now.

**The diff is three files and nine lines.** The task name moved; the constant holding it moved
with it (`PUBLISH_RECOVERY_SWEEP_TASK` → `PUBLISH_INTENT_RECOVERY_SWEEP_TASK`), which the lane
chose and journalled — leaving a constant named for the old string would have left a smaller
copy of the same mismatch and invited someone to "correct" it back. No integrator-resolved file
was touched; the lane was told explicitly and obeyed.

**Verified independently, not taken from the report.** The lane proved the effect by starting
the built application and reading the worker's own start-up line, and showed the counterfactual
by putting the old string back. The integrator repeated it on the *merged* tree with his own
script: `[worker] started with 29 task(s), cron enabled`. Before this morning that line read
`cron disabled — 1 scheduled task(s) have no handler yet`.

**A live trap the lane found and the integrator has now defused.** The `T5.2` journal entry of
2026-09-04 says the schedule has no entry for this sweep and supplies a verbatim block to paste
into `CRON_ENTRIES`. **Both halves are wrong, and pasting it would have created a duplicate
entry under a name with no handler — switching all seventeen jobs off again.** The journal is
append-only, so a superseding `INTEGRATOR` entry now sits below it saying so. If you read the
original, read the superseding one.

**The log event name deliberately stays `publish_recovery_sweep_complete`.** It is a label
inside a log record, not a name anything dispatches on; nothing in the tree references it, and
renaming it would break any saved log search for nothing. The codebase already keeps the two
vocabularies apart elsewhere.

### `R-STREAM-WIRE` LANDED — a merchant's edit reaches the product in minutes, not overnight

**Merged as `12e09f7`, with the integrator's own three pieces on top as `8a399f3`. Full gate
re-run on the merged tree: green, nine of eleven, with `eval` not run and the one named chaos
scenario red for their documented reasons and nothing else.** Tests **3,271**, up from 3,265.

**What changed for a merchant.** Before: when they fixed a product title, rewrote a collection
or edited a page, we wrote the fact down and nobody read it. Our copy of that page — and every
recommendation resting on it — stayed stale until the nightly walk, so a fix made at nine in the
morning was still being recommended against at five. Now the edit is recorded and immediately
followed by a request to act on it: within minutes the pages they actually touched are re-read
and the store gets a full market analysis, so the notice about the thing they just fixed
disappears rather than waiting for Monday.

**A burst of edits does not become a burst of passes, and this was proved rather than asserted.**
The request carries a job key of the account alone, so a second ask while one is still waiting
replaces it instead of adding to it — forty edits leave one waiting pass. The lane deliberately
added no second guard in the handler, on the reasoning that two mechanisms answering one question
disagree the first time either changes. Its test delivers five product edits through the real
receiver, checks all five were recorded as five separate changes, and asserts exactly one pass
is waiting. **It then showed the test was not vacuous** by making the key unique per request and
watching it go red with five jobs. A webhook whose content turns out to match what we already
hold queues nothing, also tested.

**What the integrator applied, and why the lane could not.** Three files, held back deliberately:
the composition root builds the real change reader and registers the drain job
(`apps/web/instrumentation-node.ts`, integrator-resolved); and the `CatalogEvents` seam leaves
the stand-in report, which cannot pass in a worktree that lacks the composition-root line, since
the test `R-STREAM` built asserts the real implementation is *constructed outside a test*.
`pnpm stubs:report` is now **4**, down from 5, honestly for the first time. The note left in the
report's place is the **third** written there — the first two were wrong — so it records what was
checked end to end rather than what a card claimed, and the test that used to assert this seam
was unwired now asserts the thing itself is built rather than the bookkeeping around it.

**Verified independently, not taken from the report.** Started the built application on the
merged tree and read the worker's own start-up line: `[worker] started with 30 task(s), cron
enabled` — 29 before this merge, so the drain handler really is in the registry. Read the diff
in full: the webhook change is two call sites and one helper, and the cross-lane edit in the
reader's file is confined to the dependency's shape, its one call site, and three stale comments.
Checked the job-key claim against `packages/jobs/src/inventory/queue.ts` directly rather than
from the report.

**A loose end the lane found, journalled, and correctly left alone — it belongs with `T5.3`.**
The request carries no marker for how far through the change record a previous pass had got,
because the webhook side has no way to know one. So in the seconds between a pass finding
changes and re-running itself, a new webhook can replace it and cost it its place, and the pass
then re-reads that store's changes from the beginning. **Wasteful, never wrong, self-correcting,
and it buys no extra paid scans** — the scan's key is derived from where the pass ended, so a
repeat converges on the same key and de-duplicates. The clean fix is one word: ask under
`unsafe_dedupe`, which leaves an already-waiting pass alone, correct here because that pass will
read the new change anyway. It is in Lane C's file and outside the card's authorised edit.

**One report claim that was wrong, and harmlessly so.** The lane reported that `R-STREAM-WIRE`
was absent from the build plan and that no `2026-09-04` change-stream entries existed in
`DECISIONS.md`. Both are true *of its own worktree*, which was fast-forwarded before those docs
were committed. Both exist on `main`. The lane was right to flag it rather than assume.

**Also fixed on the way, by the lane, and it was not a flake.** `pnpm test` went red first time
with two genuine failures in the existing webhook suite: its test database had no queue tables,
because until now nothing in that path queued anything. Fixed with the shared helper the
domain-claim suite already uses.

### `T5.3` LANDED — **M5 is closed.** A published article is mended when the store moves under it

**Merged as `f12db7c`, with the two integrator lines on top as `ef7d705`. Full gate re-run on
the merged tree: green, nine of eleven.** Tests **3,324**, up from 3,271. `pnpm stubs:report` is
**3**, down from 4. `pnpm chaos` is now **ten** scenarios, nine passing, the same single named one
red.

**What a merchant gets.** Until now, once we published an article it was frozen and their store
was not. If they withdrew a product a guide recommended, the guide went on recommending it — a
page ranking well while being wrong, which is worse than no page. Now, once a day, every product
mention in every published article is checked against the store as it is now, on four questions:
withdrawn, unbuyable for a fortnight, a range that no longer differs the way the article compares
it, or a collection gone. What follows depends on what the merchant consented to: an auto-publish
store with automatic repair on gets the article mended and re-posted as an update; an export
store gets a corrected download and a card and **nothing of ours touches their site**; anything
needing new prose queues a rewrite through the normal gate and costs a calendar day, as it should.

**A price change costs them nothing** — no card, no rewrite, no calendar day. That is the founder
decision of 2026-09-01 built as decided rather than as the main spec's drift table still reads,
and it is asserted by a test that checks tomorrow's topic is untouched in state, date and title.

**No migration, and the reasoning is worth keeping.** A repair *is* an opportunity row — the spec
says so outright — so every column already existed, and the unique index on open rows gives
"re-detection updates, never duplicates" for free. The one thing needing a home, the before/after
log every repair must keep, went into the repair's own outcome record under its own key so the
learning loop can later write beside it rather than over it. **Verified: the branch touches no
migration and no schema file.**

**One done-when is partly met and the lane said so rather than burying it.** The new crash
scenario runs generate → publish → withdraw → mend → re-post against a real database, killing the
worker at each model call, at the mend and at the re-post — but it **seeds** its store rather than
running the ingestion pipeline, so "ingest → … → repair" is not literally end to end. Ingestion's
own crash cases are covered by three existing scenarios. The lane ran the new scenario four extra
times to prove it passes reliably rather than by luck.

**The two integrator lines were applied together, deliberately.** The lane built the daily pass
and could not switch it on: both the schedule and the composition root are integrator-resolved.
**A schedule entry without its handler disables every recurring job** — this morning's defect
exactly — so the entry and the registration landed in one commit, and the handler name was checked
against the schedule name before either was written. Verified by starting the built application:
`[worker] started with 32 task(s), cron enabled`, from 30 before the merge.

**The last stub in the attention list is gone.** `pendingRepairs` was the most dangerous kind of
stand-in: it returned an empty list, so an account that could not see its repairs looked exactly
like an account with nothing broken. The lane filled it and checked it end to end to the standard
that file now sets, rather than reporting it filled.

**One test failed on the first full gate run and passed on the re-run**, along with all 3,324. The
failing name was not captured before the re-run, which is a gap in how it was checked. The
crontab assertions — the only thing the integrator's own edit could have broken — were then run on
their own and pass 60/60. Recorded rather than passed over.

**Two gaps the lane found and correctly did not close.**
- **The collection-deleted trigger has a policy and nothing that can raise it.** The shared change
  stream's list of change kinds — a contract frozen in milestone 0 — has `collection_updated` and
  no `collection_deleted`, and the Shopify topics we subscribe to include collection create and
  update but not delete. The policy row was kept so the gap is visible in one place.
- **A repair needing new prose can wait weeks.** It becomes an accepted rewrite the merchant can
  see immediately, but it reaches the calendar only at the next monthly replenishment, and only
  when the planned horizon has run short. No document sets a deadline for that case. Scheduling it
  directly would be a second, quieter path onto the calendar past the placement rules, so the lane
  did not. **Worth a founder decision if a broken article waiting a month is not acceptable.**

**And the republish overwrite question is now more urgent, not less.** The repair reuses `T5.2`'s
republish path unchanged, and that path sends the article's address, its tags and its
published/unpublished state along with the body — so a repair **renames the article back if the
merchant renamed it, removes any tag they added, and republishes it if they unpublished it.** A
store with automatic repair on can now have that happen **without ever clicking anything.** The
lane was told not to widen it and did not.

### `R-GRAPH` LANDED — **`T6.3` is unblocked**, and the audit had undercounted

**Merged as part of the founder-authorisation run. Gate green on the merged tree: nine of
eleven.** Tests **3,330**, up from 3,324. Three files, no code changed — only the written graph.

**What the graph is, and what was wrong.** One file lists, for each state a suggestion can be
in, which states it may move to next, so any part of the product can ask "is this move legal?"
in one place. It had been drawn entirely around the **calendar** — the other thing that moves
these rows — so the only way into "generating" was from a calendar slot. An improve-this-page
suggestion never gets a calendar slot; the merchant just presses a button. **So the whole
merchant-initiated path was illegal on paper while the code performed it every time**, and
nothing objected because the database helper never consults the graph.

**The audit named three disagreements. There are four.** The lane grepped every status write on
that path rather than trusting the list, and found that **the most common completion in the whole
feature** — the merchant pressing "I applied this", which in the ordinary flow happens from
`accepted` — was forbidden too, and nobody had noticed. **This is the third time today that
checking a report rather than relaying it changed the answer.**

**One judgement the card did not dictate, journalled.** `completed` is now reachable from every
open status, matching the repository's own guard for that move ("the row is still open") verbatim
rather than a narrower subset. Narrowing it would have needed a chain of reasoning about
reachability and would have left the graph disagreeing with a shipping guard in at least one
place — which is the exact class of defect this card exists to remove.

**The refusal was proved non-vacuous.** The lane opened the graph to allow a move nothing performs,
watched two tests fail, then reverted and re-ran green.

**What this does NOT do, stated plainly by the lane.** Nothing consults the graph before a status
is written, so it still cannot *stop* a bad move — it can only inform code that chooses to ask,
and `T6.3` asks. Wiring it in at write time would change how every status write in the product
behaves and surface disagreements as runtime failures rather than notes in a report. **Desirable,
but a real behaviour change and its own card.** Not done, deliberately.

**A second disagreement of the same family, left alone and needing a founder answer.** The "not
interested" button will dismiss a suggestion that is **currently being worked on**, and the graph
does not admit that. It is off the improve-this-page path, so outside what was authorised — and it
is a product question rather than bookkeeping: *should a merchant be able to dismiss work already
running?* Journalled.

**Two stale comments left in place**, both drawing only the calendar's path and now narrower than
the graph beneath them. One is another lane's file, one is the database schema.

### `R-OPTIMIZE-STUCK` LANDED — pressing the button no longer breaks the account

**Merged. Gate green on the merged tree: nine of eleven.** Tests **3,339**, up from 3,330.
`rules_version` moved to `c278e2af…` — **every lane inherits that.**

**What changed for a merchant.** Before: the first press marked the page as being worked on, and
that mark was counted as if a recommendation had been produced. After two presses the store's
allowance of two a day was gone — **not for the day, for good** — and both pages were refused from
then on with an error describing a scan that had never happened. Only a database edit could undo
it. Now the mark costs nothing, the allowance counts recommendations actually written, a second
press answers "still going" instead of an error, and every way the work can end hands the page
back instead of freezing it.

**The lane did the harder, right thing rather than the easy one.** Deleting the marked-row count
on its own would have weakened a real spend control — several presses arriving before any
finishes could all get past the request-time check. So the cap is **also re-read at dequeue**,
under the account's lock, against the same meter, which is where spend caps belong anyway. The
consequence was stated rather than hidden: a press accepted in such a burst and then refused by
the job is answered "generating" and quietly handed back a moment later, with nothing shown. Only
reachable when presses arrive faster than a generation completes.

**One API answer changed, flagged rather than buried.** A second press now returns 200 "generating"
where it returned 409. Nothing is pinned to the old answer — the frozen route table does not
declare these four endpoints at all, which is `R-CONTRACT`'s subject — so no generated fake server
and no screen is built against it.

**Every new test was proved non-vacuous.** The lane restored the old behaviour and watched them
fail: 3 with the old allowance count, 6 with the hand-back disabled. A **pre-existing** test also
failed under the old counter, which is incidental proof the old count was already interfering with
legitimate work.

**Recovery is on the merchant's next read or press, not a background sweep — a judgement call the
lane explained.** A scheduled reaper would need both a composition-root registration and a crontab
entry, both integrator-resolved and both currently held, so it would have been code that runs
nowhere: the exact shape of defect this card exists to remove. **What it costs:** a page nobody
looks at again stays marked. It costs the store nothing now that the allowance ignores marks, and
no merchant sees it, but an operator counting in-progress rows would over-count.

**Registering the OPTIMIZE job is now SAFE on stuck-state grounds — and it is still not one line.**
It needs a dependency bundle whose model client is **the same unresolved choice `R-INTENTGAP-JOB`
reported and refused to pre-empt**: the generation lane memoises its own Anthropic client privately
in `apps/web/app/api/articles/_lib/config.ts` and does not export it, and building a second client
in one process is what that file's own comment warns against. **The lane did not guess, which was
right.** The integrator's call, and it cannot be taken while Lane D is running in that same file.

### `T6.3` DISPATCHED — the last card in M6

Sent to Lane E the moment `R-OPTIMIZE-STUCK` merged, with the `R-GRAPH` history it needs: that the
audit's list of missing transitions was one short, and that nothing consults the graph at write
time so the graph informs rather than enforces.

### `R-PUBLISH` and `R-SPEND` LANDED — five defects gone, one done-when honestly short

**Both merged and gated separately. Gate green on the merged tree: nine of eleven.** Tests
**3,369**, up from 3,339.

**`R-PUBLISH` — what a merchant gets.** An established blog no longer gets the same article
posted twice: the did-my-post-land check now filters server-side to posts written since the
claim was opened and follows Shopify's own next-page pointer to the end. A momentary Shopify
hiccup no longer kills an article for ever. A merchant whose Shopify permission was withdrawn is
**told** — the same reconnect banner and 24-hour email the rest of the product raises, asserted
on database rows rather than a mock. And **nothing we put on their shop is visible to their
shoppers**: the `sortiva-<id>` tag is gone.

**The best thing in that card is the failure split.** A failure at the moment of posting is judged
by one question — *could the post have landed?* A positive refusal (dead token, rate limit, a
request Shopify would not accept) means nothing was written, so the claim is released and the
article is due again. **Everything else is "we do not know"**, which keeps the claim and lets the
recovery sweep settle it by asking the shop. Getting that split backwards is precisely how a
merchant ends up with two copies, so it is its own named, separately tested function that defaults
to the safe answer.

**The tag removal forced one narrowing, and it is the right one.** The article we send now has
**no `tags` key at all** rather than an empty one — an empty value would have satisfied "no tag of
ours" while wiping any tags the merchant had added themselves. So a republish now leaves the
merchant's own tags alone. **The open founder question about republishing is narrowed, not
answered:** the article's address and their choice to unpublish are still overwritten.

**The fake shop can now fail the way a real shop fails**, which is the reason none of this was
caught before. It pages, keeps the marker where a list response cannot see it, honours the
creation-time filter, **refuses to answer "not there" when it ran out of pages before it ran out
of articles**, and records every page and marker read so a test can assert a search really paged.
There is a matching guard in the real code: a search that hits its page ceiling throws rather than
answering "not there", because "not there" is the answer that authorises posting again.

**Done-when 4 is PARTLY MET and the lane said so.** The blog-number-for-blog-name defect is fixed.
But the recorded address still uses the store's `acme.myshopify.com` host, while Search Console
reports a store's traffic under **the domain shoppers actually visit**. So attribution would still
fail to match. Fixing it needs a decision the card does not carry — which of a store's addresses
is canonical, and where a one-per-process publishing client would get a per-account domain.
**Flagged, journalled, not chosen. This is a founder question.**

**One thing mended in passing, correctly.** A single store's dead token used to end the **whole**
recovery pass: the sweep walks unfinished publications across every account and an exception
asking one shop propagated out of the loop, so one broken merchant stopped interrupted
publications settling for everybody else, indefinitely. Each claim now has its own guard.

**`R-SPEND` — what the brake counted, and what it counts now.** Before: rows in the spend ledger,
one per model call. **One recommendation is up to four of those** (the writer's answer, a re-ask
when the shape is unreadable, and that pair again when our own checks reject the first attempt).
So one recommendation could count as four against a ceiling of two, and a store was switched off
permanently — usually on its first or second click — and shown copy saying we had paused to
protect its quality. Now OPTIMIZE counts **recommendations produced**, using the **same function
the button checks** before it spends anything, so the brake and the button cannot disagree. Trips
happen above the allowance, not at it, and a switch the sweep raised itself comes back down at the
turn of the day.

**The canonical outage sentence was not touched, and the lane explained why rather than assuming.**
The route checks the store's own daily count first and answers the honest "2 per day — available
tomorrow"; only if that passes does it check the pause switch. The bug was that the brake could
raise the switch while the honest count was still inside the allowance, so the merchant fell
through to the wrong message. With the count corrected that path is closed, and the outage
sentence is now shown only for a deliberate pause by a person — which is what it says.

**A departure from the written spec, journalled and worth the founder knowing.** Main §14.5 says
automatic trips never auto-reset; the card required the opposite. **Scoped tightly:** only the two
per-store daily-allowance switches, only where the sweep raised them itself. Every other automatic
trip — including the account-wide spend pause — still waits for a person, and a switch a person
raised is never lowered automatically.

**Intent-gap is exact in the safe direction, not exact.** Nothing anywhere records one analysis as
a row, so that type still counts model calls, against a ceiling that leaves room for the one
automatic re-ask — a store could make up to twice its allowance before the brake fires. The lane
declined to fix it properly because the options are a database column (all waves closed) or
renaming a term in the spend ledger that every lane's rows share. **Right call.**

**And it found a genuine product gap.** A store's intent-gap allowance is 10 analyses a day, but
the scheduled comparison pass alone shortlists up to 10 and each OPTIMIZE generation may make one
more — so **wholly legitimate use can reach 12.** The two spenders were built to the same number
without either knowing about the other. Whether the allowance rises, the OPTIMIZE path draws on
the same budget, or the shortlist shrinks is a product decision. **Founder question.**

**Two small hand-ons.** Two merchant-facing sentences live inline in Lane E's recommendations
handler rather than in the string catalogue, which the constitution says is copy's only home; and a
comment in Lane E's analyse file still describes the sweep as counting calls — now imprecise rather
than wrong. Neither was the lane's file.

### `T6.3` LANDED — **M6's exit gate is in**, with one scope item honestly short

**Merged. Gate green on the merged tree: nine of eleven.** Tests **3,422**, up from 3,369. No
migration, no new API address, no new threshold — so `rules_version` did not move.

**What a merchant gets.** Three of their own pages fighting over one search now comes with an
answer rather than three generic to-dos: which page should keep that search **and why that one**
("Google already shows it for 42% of the times your store appears for this search"), every
internal link on their site pointing at a page we are asking them to demote and where it should
point instead, and whether declaring one page the canonical version of another is appropriate —
**with an explicit "do not do this here" where it is not.** All arithmetic over measurements
already on the row; no model writes a word of it, and nothing is stored, so it cannot disagree with
the evidence shown beside it.

**And a page with something technically wrong stops accepting the improve-this-page button.** If
Google is not indexing a collection, better copy on it cannot help. Pressing now moves the card to
*blocked*, names what is in the way, and buys nothing — and the card stays visible, because a
merchant who sees nothing assumes there is nothing to do. The rule is applied at the press **and
again in the worker**, because a press waits in a queue and the world moves.

**The no-writes guard is stronger than the card asked for, and it is non-vacuous.** Rather than
checking only the FIX directory, it greps **every package's source and the whole web app** for
each Shopify surface through which a redirect, theme edit or stored canonical could be created —
and it **asserts up front that it found more than a hundred files** before forbidding anything.
That is the pattern `R-INTENTGAP-SCAN` established and the one the four broken reporters lacked.

**One scope item is PARTLY MET and the lane led with it.** A suggestion landing on one of *our own*
published articles is now refused at the API and again at the worker, and nothing is bought — but
**there is no refresh pool to route it into**, because that is `T7.2`, inside the learning
milestone the founder deferred out of v1. So the product has stopped doing what it must not do and
has nowhere to put the work instead. **The gap for a merchant: a weak-metadata or low-click-rate
suggestion that lands on one of our articles now has no action they can take at all.** The lane
declined to close it by rewriting the row's recommended action, because that changes which button
the card offers — user-visible behaviour outside its card. The request shape the pool will consume
is built and named, so wiring it later is one call.

**Two judgements it made, both journalled, one worth a second opinion.** Which page wins: the one
holding the largest share of the store's impressions for that search — Google's own revealed
preference — with a deterministic tie-break so a reload never names a different page. **When a
canonical is suggested: only between two pages of the same kind.** A canonical says two addresses
are the same page and Google drops one; two collections are the same page, a product and a
collection are not, and pointing a product's canonical at a collection asks Google to remove that
product from search entirely — a worse outcome than the problem, reached by following our advice.
**The specs say "canonical suggestion" and stop, so this is the lane's own reasoning.**

**A red test that was not a flake, and the guard that caught it.** `pnpm test` went red on the
first run — the product's own denominator check caught the lane's tie-break sentence reading "in
{weeks} of the weeks we measured", which is the "x of y" shape the merchant-facing rules forbid.
Reworded and committed separately. **An invariant with teeth doing its job, on the day four without
teeth were carded.**

**Two things it found and did not fix.**
- **A blocked "write a new article" suggestion can still be scheduled between scans.** The
  scheduling endpoint refuses anything not `accepted`, so a row the scan already blocked is safe —
  but a blocker raised *since* the last scan will not have moved the row yet, and that endpoint
  (Lane C's) does no live check.
- **The "Blocked: … — what to do" ribbon has no words behind it.** The API sends the key
  `precondition.indexing_issue`; the catalogue holds `opportunities.precondition.indexing_issue`.
  They do not match, so the "what to do" half renders as a missing string. Pre-existing, and this
  card makes it reachable far more often. **One key, in either Lane C's serialiser or Lane F's
  catalogue.**

### The shared model client — decided, and `R-OPTIMIZE-WIRE` dispatched

Two cards deferred this and both were right to. The OPTIMIZE job needs the process's Anthropic
client; the generation lane memoises its own privately and does not export it; building a second is
what that file's own comment warns against.

**Decided: export the existing one.** Not move construction into the composition root — the root
imports the dependency bundles *from* these config files, so building the client there would invert
that direction and force a client argument through every deps factory for no behavioural gain. The
invariant that matters is one client per process, and exporting achieves it. Carded as
`R-OPTIMIZE-WIRE`, Lane E, with the single cross-lane export authorised explicitly and the
composition-root line reserved for the integrator.

### `R-OPTIMIZE-WIRE` LANDED — the button reaches a worker, and a claim I made was wrong

**Merged, with the two integrator lines applied in the same pass. Gate green: nine of eleven.**
Tests **3,426**. Verified on the merged tree by starting the built application:
`[worker] started with 35 task(s), cron enabled`, from 32 before.

**What a merchant can now do.** Press "Generate recommendations" on one of their pages and
actually get recommendations. Before this the press recorded the request, marked the page as being
worked on, and queued the job under a name nothing in the running product answered to — so they
watched a spinner for work that would never start. Everything either side of that gap was built
and tested; only the join was missing.

**The weekly page comparison was wired in the same card.** It was blocked on the identical
question and needed the identical four things, so wiring it was a second function with no new
decisions in it. **Neither job gets a crontab entry** — the first is queued by the button, the
second stays scheduleless by the founder's standing position.

**A done-when is NOT fully met, and the lane led with that rather than redefining it.** "The
process constructs exactly one Anthropic client" is false for the server, and this card could not
make it true. **There are four**, in the article generation, Shopify onboarding, calendar-topic and
preview composition roots — each memoised separately and **each documented in its own file as "the
one client".** Verified independently by the integrator.

**That makes the integrator's own rationale from this morning wrong, and it is corrected in
`DECISIONS.md` rather than quietly dropped.** The decision — export the existing client rather than
move construction to the composition root — was right in direction and added no new client. The
*reason* given ("what matters is one client per process, and exporting achieves that") was already
false when it was written, because only the two clients the card named had been checked.
**What it costs:** spending is recorded from up to four places, and an answer cached by one is not
found by the others, so onboarding and generation can pay separately for the same question. **It
breaks no ceiling** — the cache and the ledger are database tables, so the caps still see every
call. Waste, not a correctness fault. The fix is its own small card, and should take the search
vendor with it, which is duplicated four ways for the same reason.

**How "one client" was proved for the part that could be.** Not by identity comparison, which can
show two things share one but never that a third was not built off to the side. The test replaces
the client class with a subclass that records every construction, builds **every** dependency
bundle the composition root hands the content engine, and asserts the recorder holds exactly one
entry. The lane then made the recommendations config build its own and watched the test fail at
"expected 2 to have a length of 1".

**And "no database connection at registration" was measured, not reasoned.** The test points the
database address at a port where nothing listens, builds both bundles, registers both tasks, and
reads the pool's own count of connections made: zero.

**One operational fact worth not rediscovering: `pnpm smoke:dev` replaces the production build.**
A check that starts the built server must run after `pnpm build`, not after the dev smoke. This
cost the integrator two confusing runs.

### `T-WAVE5` LANDED — schema mini-wave, and the gate flake is now carded

**Merged. Gate green: nine of eleven.** Tests **3,440**. Migration only — nothing reads or writes
either addition, so an overridden article still returns to `draft` and signing out still clears
one cookie. `R-OVERRIDE-STATE` and `R-REVOKE` do that work, both now unblocked.

**Two additions.** An article state meaning *cleared to deliver*, so a query asking "which
articles go out today" can name a state instead of joining the gate-decision table and hoping it
remembered to. And a `sessions` table, so a session can be ended at all — today a signed-in
session is only a signed cookie, so nothing records it and nothing can revoke it.

**The sessions table's shape is the whole cost of the feature and the lane treated it that way:**
the token is the primary key itself, so the per-request read is one index probe landing on the
row; revoking is deleting the row rather than setting a flag, so the constant read stays a plain
hit-or-miss and no dead rows accumulate; account deletion cascades. Whether the stored token is
the browser's value or a digest is left open for `R-REVOKE` — either fits the column, so it needs
no second migration.

**It diagnosed a false failure instead of reporting one.** There are two Postgres servers on this
machine and the container's published port is already taken, so a database created through
`docker exec` is invisible to the tests and to the migration tool. The lane found that, created
the empty database on the server the tests actually reach, migrated there, verified the result,
and dropped it — and deliberately left the shared dev database alone because three lanes were
using it. **Worth remembering: `docker exec … psql` does not reach the database this project uses.**

**A card-text error of the integrator's, corrected by the lane.** The card said "a fifth state";
the list already held five, so this is the sixth. Nothing turns on the count.

**The gate flake is worse and is now a card, `R-TESTDB`.** This gate run failed 13 test *files* on
teardown timeouts and 21 on the re-run, with three lanes active — **while all 3,440 tests passed
both times, with zero failing assertions and the same total.** So everything ran and everything
passed; the harness is what breaks. It has been folklore in this file for days; it is now work,
because a gate that goes red for its own reasons trains people to re-run instead of read, and
this project has already had one genuine regression hide underneath exactly that.

### `R-NOQUERY`, `R-PUBLISH-2` and `R-GRAPH-ENFORCE` LANDED

**All merged and gated. Gate on the combined tree: 3,488 tests, zero failures, zero harness
errors, chaos 9 of 10 with only the named scenario red.** The flake vanished entirely once no
lanes were contending, which supports `R-TESTDB` being about contention rather than a leak.

**`R-NOQUERY`.** We stop paying the search vendor for a page's own web address as though a shopper
had typed it. The search is now resolved from the store's own pooled searches, or the
recommendation is refused and **nothing is bought**. Proved by *measuring* the vendor's own ledger
— calls, billable calls and dollars all zero — with a positive control alongside proving the meter
works. It also fixed the same substitution reaching a person: the download printed the page's
address under the heading "Search".
**Its consequence became two founder decisions** (2026-09-07): a store with no Search Console
connection has no pooled searches at all, so every suggestion of this kind was left permanently
un-actionable and refusing in silence. Carded as `R-REFUSAL`.

**`R-PUBLISH-2`.** A repair now sends the title, body and summary and nothing else, so a post the
merchant renamed stays renamed and one they took down stays down. **The proof is at the wire**: the
test drives the real Shopify client against a local server and asserts the update body has
**exactly five keys**, so a sixth added later fails the test rather than quietly overwriting
something of theirs. And the type makes it inexpressible — the update input no longer extends the
create input. A published article is now recorded under the merchant's claimed domain; articles
published before are **not** re-addressed and there is no backfill, which a test holds.
**It flagged one thing that became a card:** the claimed domain is stored bare, so a store whose
storefront is `www.` or `shop.` is recorded at an address Shopify only redirects from — the same
attribution mismatch one level down. `R-STOREFRONT`.

**`R-GRAPH-ENFORCE`, and it found two more forbidden moves.** The six database functions that write
a suggestion's status now consult the list of legal moves and **raise** when the move is not drawn.
The check sits inside those six rather than at the eleven call sites, and asks about every status
each guard will move a row out of — so an undrawn move fails in a test rather than at 3am.
**The two new findings were in neither the audit nor the previous card's four**: replenishment
giving a claim back when a placement is refused, and the improve-this-page press putting a page
back when the queue write fails. Both are code undoing itself, **and neither path had a test.**
That is **five** graph disagreements found in total, every one by somebody going looking.
Proved non-vacuous by removing the three edges and watching seven tests fail.
**Its half-met done-when became a founder decision** (2026-09-07): dismissing a suggestion whose
article is already booked leaves the article to appear anyway. Carded as `R-DISMISS-CALENDAR`.

### `R-HOLD` and `R-REVOKE` LANDED

**`R-HOLD`.** A deleted merchant's domain is released on its seven-day deadline **whether or not
the cleanup job ever ran**. The deadline was already being stamped on the record at deletion;
nothing read it, and the nightly sweep used it only to decide what to delete — so if the sweep
stopped, the domain stayed blocked for ever. The claim now reads that stamp itself and releases an
expired hold before inserting, so the release happens the first moment anyone actually wants the
domain, which is the only moment it matters.
**Its fourth test is the best proof in this run.** The risk was breaking the rule that a domain
claim is decided by the database's unique index rather than by our code reading first. So the fix
is a delete placed *before* an insert that is byte-for-byte unchanged — and the test **drops the
unique index** and shows two simultaneous claimants both win. If our code were refereeing, that
would change nothing. It doesn't.
**A card-placement error of the integrator's**: `R-HOLD` was put in Lane G; the claim path is Lane
A's and the card's own done-when named it. The lane spotted the contradiction, took the done-when
as authoritative, said so, and stayed inside the files it needed. Plan corrected.

**`R-REVOKE`.** Signing out now ends every session an account has, in every browser. A copied
cookie stops working the moment its session is revoked. **And deletion locks out at once — which
mattered more than it looks**: deletion here is a *stamp*, not an erase, because the account row
survives seven days so nobody can re-claim the domain early, so the foreign key's cascade would
not have fired for a week. A "deleted" account would have had working sessions for seven days.

**Stored as a SHA-256 digest, not the cookie.** A session cookie is a bearer credential — whatever
presents it *is* the merchant. Stored verbatim, any copy of that table is a set of working
sessions: a backup on a laptop, a support export, a leaked replica. Stored as a digest it is a set
of useless strings, at the same single index probe. No salt and no stretching, deliberately: the
input is a 128-bit random value nobody types, so there is nothing to guess, and a slow hash would
spend its cost on exactly the request path this feature was priced at one read.

**THE SESSION LIFETIME WENT FROM ONE DAY TO THIRTY, and the founder should know they can reverse
it.** The card authorised revisiting it and the lane argued the change: a day was a day *because*
revocation was impossible — lapsing was the only thing that ever stopped a leaked cookie — and
revoking is now that answer, so the number goes back to being about how often a merchant is made
to sign in. **Fixed rather than sliding is the load-bearing half**: a sliding window rewrites the
row as it is used, putting a database *write* on the read path, and this feature was priced at one
read.

**It found a real security bug in its own first draft.** With sessions in the database, what the
library hands the session callback is the stored row — token included — so the obvious spread
would have published that credential in a JSON body any script on the page can read, undoing the
fact that the cookie carrying it is script-unreadable. The response is built explicitly and a test
asserts the token does not appear. **Worth knowing, because a later "just spread the object"
tidy-up reintroduces it.**

**Two gaps it found and correctly did not close.** There is **no sign-out button anywhere in the
product** — every screen and the string catalogue were checked; the endpoint works and nothing
calls it. And nothing prunes lapsed sessions, which now sit thirty times longer. Carded as
`R-SIGNOUT` (Lane F) and `R-SESSION-PRUNE` (Lane G); the prune needs **no** schedule change.

**The machine was saturated while this ran** — load average peaked at 108 with up to 48 concurrent
vitest workers, and a second full run showed four failing assertions in suites this card does not
touch, all of which passed 47/47 when re-run alone. **The integrator is holding at three lanes
rather than four until `R-TESTDB` lands.**

### `R-RECO-QUALITY` and `R-STRANDED` LANDED — **the chaos suite is fully green for the first time**

**`R-STRANDED` is the one to read.** If the worker writing a store's daily article was killed
before that store's local midnight — 23:50, a late deploy, an ordinary evening for a shop whose
writing starts after dinner — the article was never picked up again. The next morning looked for
that morning's topic, found none, and **reported success**. The article was written and paid for,
nothing graded it, and no error reached anybody.

Every store's daily pass now looks behind it. The interrupted day with the most already-paid-for
work behind it is finished, **keeping its own past date**, so nothing lands on a day the calendar
never scheduled and finishing an old day can never become a burst. Every other one leaves a **dead
letter** naming the store, the day, the topic and the article, in plain language. Finishing an old
day does not consume today's allowance — it is not a dequeue, so "one topic per store per day"
is untouched and today's article is still written.

**The cadence is inside the store's own daily pass, after today's article.** No new scheduled job,
so nothing was needed in the crontab. The reasoning: the only thing that can strand a day is that
store's own pass dying, so the same pass is where to notice; it already holds the per-store lock
and knows the store's timezone. Today's article runs first, because a recovery can wait a pass and
must never be the reason today's article did not go out.

**Verified by the integrator, because it changes what the gate means.** `pnpm chaos` passes **10 of
10**, and `git diff` shows the scenario file byte-identical to `main` — the product converges, the
test was not softened. The lane also proved it converges *because of* the sweep: disabling the call
returns the scenario to red with its original message.

**`R-RECO-QUALITY`.** The model-written rationale is now labelled "A model wrote this line." on
screen and in the download — the only line on that card that is not the merchant's own text, a
quoted suggestion, or our catalogue wording. **The prompt went into a new version file rather than
being edited in place**, because the version stamped on a stored recommendation has to still mean
something a year later. It added **the test that would have caught the original defect**: it holds
the prompt the product actually loads against every field its answer schema demands — which is how
a required `rationale_key` came to be never mentioned in the prompt at all. The field is renamed to
`rationale` and readers accept both spellings, so recommendations a merchant already has do not
lose their explanation. The weekly pass now shortlists **8** against an allowance of 10, proved by
what was actually bought.

**Ungraded, and the lane led with it:** `pnpm eval` is the machinery for grading a prompt change,
this card changes a prompt in two places, and it cannot run without a key. Nothing has measured
whether the model follows either instruction. **Unverified, not verified-and-fine.**

**One user-visible choice the founder can reverse:** the rationale is written **in English whatever
language the store publishes in**, on the reasoning that it sits among our own English labels and a
mixed-language sentence is what the founder rejected two days earlier for the judge's
justification. Sound, and undictated.

### The test-database leak, measured — **138 databases and growing**

The integrator counted it directly: `select count(*) from pg_database where datname like
'sortiva%'` returns **138**, against a server connection limit of 100. A lane reported 126 earlier
the same session. **So databases accumulate during ordinary work, not only after a crash.**

**It has stopped being only a `pnpm test` problem.** `pnpm chaos` failed at its own `beforeAll`
with "Postgres is not reachable" and skipped all ten scenarios, then ran clean on the next attempt.
Other lanes have since seen `sorry, too many clients already`, `out of shared memory`, and a
duplicate-email insert after a truncate — two lanes sharing one database name and truncating each
other's rows. Failed *files* have ranged from 1 to 56 across runs while failed *assertions* never
exceeded 2.

**`R-TESTDB` is running on it, and has both measurements.** It is told not to make the symptom
quieter, not to drop databases another lane may be live on, and to say so plainly if the honest fix
lies outside `packages/db/src/testing.ts`.

### Three things `R-STRANDED` found and correctly did not fix

1. **Nothing in the product ever moves a calendar entry out of "Generating".** Both publishing
   paths update the article row and leave the calendar alone, so the Content calendar reads
   "Generating" for every past **successfully published** day. Pre-existing and product-wide. It is
   also load-bearing for the sweep's design — identifying a stranded day by its calendar state
   would have written those stores a second article for a day they already had.
2. **An abandoned day's calendar entry therefore also reads "Generating", and cannot honestly be
   changed.** The three terminal states are `published`, `rejected_by_gate` (shown as "Held for
   quality" — untrue, no gate ran) and `vetoed` ("Vetoed" — untrue, the merchant did nothing).
   A fourth needs a migration. **Founder call.**
3. **One narrow gap the sweep does not cover**: a worker dying in the two-statement window between
   recording a quality rejection and marking the calendar entry rejected. That day *has* a gate
   decision, so the sweep excludes it, and nothing else looks at it. Rarer, and a different shape
   of fix.

### `R-TESTDB` LANDED — **the gate was silently not running 574 tests**

**Merged, and the integrator did the database recreation the lane was blocked from.** A full
`pnpm test` on `main` now runs in **26 seconds** and reports **283 files, 3,547 tests, all
passing** — it was taking over 200 seconds and failing dozens of files at a time.

**The diagnosis, which is better than anything guessed at it before.** Every database-backed suite
created its own database and replayed the **entire migration set** into it — about a hundred times
per run, times however many runs were going at once. That alone often exceeded the ten seconds a
file's setup is allowed. And it produced enough writing to trigger the real killer: **Postgres
implements "delete a database" by flushing the whole server to disk and waiting.** Under three
concurrent runs, single deletions were measured at **up to 42 seconds** against a ten-second
teardown budget. A suite stuck in one held a connection the whole time, so those piled up until the
server hit its 100-client ceiling and began refusing outright — 135 refusals in one measurement.
**Self-amplifying**: a deletion abandoned at the timeout leaves the database behind, so the backlog
grows, which is exactly why the immediate re-run was always worse than the first.

**Proved rather than inferred:** an explicit `CHECKPOINT` dropped the very next deletion from
**13.8 seconds to 59 milliseconds.** It is the flush, not the count.

**The worst finding, and it changes how to read every past gate run.** The harness read a refused
connection as "no database here" and **silently skipped whole suites**. One measured run **skipped
49 of 279 files and 574 tests and reported nothing wrong.** So a green `pnpm test` under load has
not been proof that the tests ran. That is the fourth reporter in this project found failing towards
"fine", and the most consequential.

**It corrected the integrator, with evidence.** Two messages had been sent to that lane pointing at
the 126-then-138 leftover databases as the likely cause. **They are a symptom.** With 137 leftovers
present but the server freshly flushed, create was 106 ms and delete 59 ms. The exhaustion came from
suites holding connections across 40-second deletions, not from leftovers consuming resources.

**What changed:** one migrated database is built once per run and each suite copies it; one server
connection per test process, handed back within half a second; a leaking suite is **failed by
name** rather than landing an unexplained failure on an unrelated file; a server that is present
but refusing no longer counts as absent; and the local Postgres turns off crash-safety
(`fsync`, `synchronous_commit`, `full_page_writes`) — **the one change that reaches zero**, and a
setting rather than code because the flush is inside Postgres.

**Measured A/B, three concurrent runs, failed files each:** code changes only **15–16**; code plus
a raised connection limit **36–37** (*worse* — the old limit was throttling how many deletions could
pile up, so that change was dropped); code plus durability off **0**.

**The ten-round result, honestly reported as unmet.** Thirty runs: zero setup or teardown timeouts,
zero connection refusals, **zero skipped suites**, and one database left on the server each round.
But 20 of 30 runs failed one or two individual **assertions**, always from four files that measure
elapsed wall-clock time and exceed their budget when thirty workers share twelve cores. The lane
called the done-when unmet as literally written rather than claiming success, and did not touch
those tests because fixing them means changing an assertion or raising a timeout.

**Integrator actions taken after the merge:** recreated the shared database so the compose settings
apply (`fsync` confirmed `off`), and dropped **112 stale test databases**, leaving the dev database
intact. Full suite then green in 26 seconds.

**One thing for the founder:** `fsync=off` is a deliberate trade on a container holding only
throwaway test databases and a dev database `pnpm db:seed` rebuilds — a crash means recreating it.
Without it the code changes still cut failing files from ~67 to ~15 per run, but not to zero. **CI
is unaffected** (its Postgres cannot take these flags, and it runs one suite at a time) and is
faster anyway, since the template removes ~100 migration replays per run.

### `R-SESSION-PRUNE` LANDED, and another session is sharing the main worktree

**Merged. Verified directly by the integrator — the suite is cheap enough now to check in place:
283 files, 3,550 tests, `pnpm chaos` 10 of 10.**

The nightly retention sweep now deletes sessions past **their own lapse date**, not by age — forced
rather than preferred, because a session lasts a month from sign-in and "older than N days" would
sign merchants out with days still to run. Tested from both sides.

**Its failure handling is the interesting part.** The sweep's steps are plain sequential awaits and
**none catches its own failure**, so the lane matched that rather than inventing a swallow in one
step, and put the prune **last** — after the two obligations with real deadlines (erasing a deleted
account, honouring a store redaction request). A test makes the session delete throw and checks the
deleted account was erased anyway. It rejected a `try`/`catch` explicitly: it would be the only
step in the file hiding its own error, and a prune failing silently every night is a table growing
with nobody told.

**⚠️ Another Claude session (`sortiva-a8`) is working in `/Users/balazs/Desktop/sortiva` — the same
physical directory this integrator merges and gates in.** It asked for a status report for a
deploy-readiness document and was given one, along with an explicit warning: do not commit, stage,
or run `pnpm db:down` there, and take a fresh worktree instead. **This is the hazard already
written up in this file from an earlier run.** If a stray commit or a dropped database appears on
`main` without an entry here, that session is the first place to look.

### `R-GATE-LANG`, `R-SIGNOUT` and `R-DISMISS-CALENDAR` LANDED

**All merged and verified on the combined tree: 287 files, 3,583 tests, `pnpm chaos` 10 of 10,
`contracts:check` 56 routes.**

**`R-GATE-LANG`.** "The most waterproof boot we stock" and "den mest vandtætte støvle vi har" now
get the identical verdict — proved by running both through the real gate and asserting the same
outcome, the same model-call counts and the same failure list. Nothing in the product matches a
word list any more.
**Two checks were lost with those lists and the founder accepted it** (2026-09-07): the
assertion-strength check no longer refuses an absolute resting on a middling claim, and the
self-contradiction pass no longer catches an article that recommends a product early and advises
against it late. Both already did nothing for a non-English store, so this levels English down
rather than opening a new gap; those drafts now reach the paid judge instead of failing for free.
**The lane surfaced this rather than absorbing it, which is why it could be decided.**
**And it found the same defect `R-RECO-QUALITY` fixed, in a different prompt:** the writing prompt
never names four fields its schema requires. It wrote the test, watched it fail, and **removed the
test rather than smuggle in the fix**, because telling the writer more changes the articles.
Carded as `R-DRAFT-PROMPT`. **Ungraded, like every prompt change today.**

**`R-SIGNOUT`.** There was no way to sign out of this product. An account menu now sits in the
toolbar on every signed-in screen and says, **before** the button is pressed, that signing out ends
the session in every browser — a merchant signing out on a phone is also signing their desktop out,
and told afterwards that is a surprise rather than a choice. **Settings was the wrong place and a
test says so**: the spec declares its control list closed and does not name a sign-out.
**It found that the sign-in library answers 200 with an error page for a refused sign-out**, so
anything trusting the status would tell a merchant they were signed out everywhere while every
session still stood. Our code judges by where the library says to go. **And the Google sign-in
button on `/signin` is broken for exactly that reason** — a bare form with no anti-forgery token,
recorded by an earlier card and never fixed. Carded as `R-SIGNIN-CSRF`; the same fix repairs email
sign-in on that screen.
**One honest caveat:** no test drives the actual React click, because this repository has no
browser-DOM test environment and adding one is a dependency decision. The handler is a single call
to the function the wire test does drive.

**`R-DISMISS-CALENDAR`, and its race proof is the best in the run.** "Not interested" now cancels
the article the suggestion had booked; the day stays empty rather than being back-filled. **It
called something the calendar owns rather than reaching in** — the calendar already had a
delete-this-day operation that already dismissed the suggestion behind it, so the two were
half-merged and only the other direction was missing; both entry points now run one shared
implementation. **No new graph edge was needed**, checked before writing rather than after.
**The race was forced, not hoped for**: a second database connection publishes the article inside
an open uncommitted transaction, the dismissal blocks on the held row, the publication commits, and
the dismissal's guard comes back with zero rows and **the whole cancellation rolls back** — day
still generating, suggestion still open, article published. Non-vacuity proved by removing the
guard and watching exactly that test fail.
**A run already under way needed two mechanisms**, because the article row is created minutes in:
an existing draft is discarded and the day leaves `generating` so the interrupted-day sweeper does
not try to rescue it; and where no draft exists yet, the publish hour's "what is ready" query skips
a called-off day.

### Three things these cards found and left alone

- **A CREATE suggestion whose article published stays open for ever** — nothing completes it, so it
  sits on the Opportunities screen indistinguishable from work still to do. Carded as
  `R-CREATE-COMPLETE`.
- **The 409 a dismissal returns when a publication wins the race carries the wrong name.** The
  truthful code exists in the shared list but is not declared for that route, and amending the
  table is the integrator's. Same shape as `R-REFUSAL`.
- **A calendar day never leaves `generating` when its article publishes**, so the calendar reads
  "Generating" for every past published day. Reported twice now, by `R-STRANDED` and again here,
  where it bit directly: on state alone a day that published a fortnight ago looks like one being
  written right now.

### A second session (`sortiva-a8`) is now building, under this integrator's dispatch

**The founder asked it to build rather than only report.** It requested a dispatch from the
integrator rather than taking a card itself, **and it declined to start immediately** — correctly:
four lanes were mid-card and load was 22 on twelve cores, and five concurrent sessions is the
configuration that stalled this project once before. It waits for the integrator's go.

**The arrangement, agreed explicitly, and it is the thing a fresh session most needs to know:**

- **Its card is `R-PAGE-GONE-WRITE`, in the existing `/Users/balazs/Desktop/sortiva-lane-b`.** Not a
  fresh worktree — a second worktree on the same lane branch is a collision waiting to happen.
- **The integrator merges and gates. It does not.** It finishes the card, runs the gate in its own
  worktree, commits in halves by explicit path, and reports. It writes nothing in
  `/Users/balazs/Desktop/sortiva` — no staging, no committing, no `pnpm db:down`.
- **Integrator-resolved files go into its report, never applied** — the composition root, the
  crontab, the lint config, the frozen contract.

**Its read-only work has been the highest-value thing on this run that was not a card**, and it has
been asked to keep doing it between cards. Four real findings so far: that the broken Google
sign-in button blocks *everything* on a deployed server and outranked the whole queue; that the
stub report mixes one clerical entry with two dangerous ones; that **nothing has ever marked a store
page deleted**; and the seventh toothless-reporter class — a check whose *claimed scope* exceeds its
real one, which grepping for weak assertions cannot find.

**It also flagged its own near-miss**, having nearly reported a test as missing on one narrow grep
before finding it. That is the trap this run's kick-off names, and it has now caught three lane
reports and two of the integrator's own claims.

### `R-SIGNIN-CSRF` LANDED — **a merchant can sign in**

**Merged and verified: 289 files, 3,597 tests, `pnpm chaos` 10 of 10.** This was the single largest
blocker in the product and nobody had ranked it as one: the Google button posted a form carrying no
anti-forgery token, the sign-in library refuses that, and **everything else sits behind sign-in**.
An earlier card recorded the defect and it stayed broken.

**The trap is now a permanent test of its own.** Posting the exact request the old form sent
returns **HTTP 200 with `ok === true`** — only the destination says it failed. So the lane wrote a
test that records precisely that, meaning nobody can later reduce the assertions to a status check
without reading why it would prove nothing. It also proved its own refusal test bites, by removing
the destination check and watching exactly that one test fail.

**Email sign-in, corrected.** Earlier notes said no screen renders it. Nearly right: the sign-in
library's own fallback page at `GET /api/auth/signin` does offer it and a test asserts so — but
**nothing in the product links to that page**, so a merchant cannot reach it. Unreachable in
practice, not absent.

**A no-JavaScript visitor now presses a button that does nothing**, where before they pressed one
that failed visibly. Not a loss of function — signing in without scripts never worked — but the
failure looks different. Journalled; the alternative was a second mechanism for the same job.

**An integrator lapse, recorded because it is the discipline being demanded of every lane.** The
first full run after this merge showed **one failing assertion**. I re-ran without capturing its
name, and the re-run passed 3,597 of 3,597. So I cannot say what failed, only that it did not
reproduce. **That is the exact gap I have been telling lanes to close, and I did it myself.**

### `sortiva-a8` is building, and its pre-read found a trap that would have sunk its card

Given the go once Lane F freed, so four sessions are running, not five. **Before writing a line it
read the card's cited sections and found this:** the obvious way to mark a deleted page — compare
`store_pages.last_synced_at` against the walk's start — is wrong, because **that column means
*last changed*, not *last seen***. The sync deliberately skips restamping an unchanged page, since
restamping would look like an edit to everything watching the checksum and re-run the paid analyses
hanging off it. **The obvious build would have marked every unchanged page in every store as
deleted, plausibly.** It is now in the card text.

**Two things it flagged outside its card, both worth keeping:**

- **`last_synced_at` is shown to merchants as "Last synced"** while holding a last-*changed* value —
  pre-existing and user-visible. The chosen mechanism makes the label true as a side effect, so
  **nobody should later "fix" the stamping as a regression.**
- **`runInventorySync` already returns `status: 'done'`**, distinguishing a completed resumable walk
  from a targeted re-sync and a disconnected store. It lives in memory and nothing records it — the
  completion signal the founder was told was missing exists and is unread.

**A boundary the integrator stated to it, and it matters for anyone reading this file.** It relayed
a founder decision on the mechanism. That relay is taken at face value as a *report*, but **this
integrator treats a decision as real when it is in `DECISIONS.md`** — so it will journal it, and
that entry is what will be reviewed. One path by which decisions become real; two paths is how a
project ends up with two answers.

### `R-OVERRIDE-STATE` LANDED, and a card of mine was misplaced

**Merged and verified: 289 files, 3,601 tests, chaos 10 of 10.** An article a merchant publishes
over a quality rejection now moves to `cleared_to_deliver` rather than back to `draft`, and the
publish hour hands it over on that state alone. It is never put in front of them for review again.
**The delivery read lost both guesswork arms** — the override flag, and a decision outcome nothing
has ever written — and now names states.

**A fact worth knowing about the whole override feature:** the lane established that
`markArticleOverridden` is called from nowhere outside its own tests, because
`POST /api/articles/{articleId}/publish-anyway` is **declared in the frozen route table with no
implementation behind it.** So no merchant has ever overridden anything, and the set of rows a
migration would have moved is empty. It said this as a verified fact rather than a risk judgement,
which is why no migration was needed.

**Two things it left alone, both journalled.** The frozen contract and the UI type still list five
article states and do not know the new one — nothing breaks today because **no route serialises an
article summary**, but whoever builds that list endpoint must widen both. And **the export download
serves any article with a body, graded or not** — it asks only whether a body exists, so a
half-written draft from a crashed run can be downloaded by id. That is the one remaining path to a
finished article that does not consult the delivery read.

### An integrator card-placement error, caught by the session it was dispatched to

`R-PAGE-GONE-WRITE` was written "Lane B" from the phrase "the store walk", without opening the lane
table. **Every file it must change is Lane C's** — `core/inventory`, `jobs/inventory`. The session
holding it **stopped before writing a line**, did branch hygiene only, laid out three options and
recommended the one that keeps the ownership table true. That is the right instinct and the second
time today that stopping beat proceeding.

**Resolved as an explicit authorisation rather than a lane going out of bounds**, because Lane C is
mid-card and cannot hand over its worktree. **Verified before granting**: Lane C's uncommitted files
are repositories, generation and publishing — **zero inventory files** — so the collision the rule
exists to prevent is not live. Scope is fenced to four named files.

**And it found a real gap in the ownership table itself, which is now fixed.**
`packages/db/src/repositories/*` was **not divided by lane at all**, every lane needs functions
there, and it was resolved by custom. That is the same drift that left
`apps/web/app/api/settings` unowned until ten endpoints diverged and `R-CONTRACT` had to clean it
up. §3 now says: **a repository file belongs to the lane that owns the domain it serves.**

### Verification done this morning, so it is not re-done

- Resolved every registered task-name constant in the tree and matched it by hand against all
  seventeen scheduled entries. **Exactly one mismatch**, and it is the one the `T5.2` audit
  named. The audit's own correction of a false second candidate
  (`subscription_reconciliation_nightly`, registered from outside the jobs package) is right.
- Confirmed no test asserts the old task-name string, so the rename moves one literal.
- Confirmed `T5.1` **landed** (`1d66186`) and is not blocked — the one-clause delivery fix it
  was waiting on landed before it as `R-DELIVER`. A note in the kick-off that `T5.1` was
  blocked was stale; the blocked card is `T5.3`.
