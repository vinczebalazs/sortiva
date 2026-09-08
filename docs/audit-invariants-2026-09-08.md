# Invariant sweep — 2026-09-08

The audit half of `T10.2`. Read-only: this file is the only thing it changed.

The question asked of each of the 26 numbered invariants in `CLAUDE.md` is not "is
the rule written down" but **"what would actually stop somebody breaking it, and
does that thing work?"** A rule with a test beside it that would pass on broken
code is worse than a rule with nothing, because it buys confidence it has not
earned. The card calls that an *invariant without teeth*, and finding them is the
point of the exercise.

Nothing here has been fixed. Every finding is written so a card can be raised from
it without repeating the investigation.

---

## How this was done, and how much to trust each verdict

Three kinds of evidence, and they are not equal. Each invariant below says which
one it rests on.

**Mutation-checked (strongest).** I broke the guarded thing and watched the guard
fail. Eight of these, listed here so the claim is checkable:

| What I broke | What caught it |
|---|---|
| Named the quarantined product HTML from the persona module | `quarantine.test.ts` — 2 assertions red |
| Read the preview cache from the persona module | `disposable.test.ts` — 1 assertion red |
| Removed the duplicate-suppression clause from the opportunity write | `opportunities.test.ts` — all 12 red |
| Skipped the "record the vendor's answer before using it" write | `client.test.ts` (`packages/llm`) — 3 red |
| Made unpaid accounts lose read access | `entitlement.test.ts` — 2 red |
| Let the scheduler take tomorrow's topic today | `daily-cycle.test.ts` — 2 red |
| Ran the repo's own planted-violation harness (`pnpm lint:prove`) | 11 planted rule violations, all rejected |
| Ran the repo's own drop-the-index test for the domain claim | 16 pass, including its self-mutation case |

I also probed the denominator rule's pattern directly with the strings it is meant
to reject (below, invariant 23) — that is a mutation of the *input* rather than the
code, and it failed to catch three of five.

**Read the code and the prose beside it (strong for absence).** Where I say "no
mechanism exists", I mean I searched for producers and consumers and found the
thing has no caller, no writer or no assertion — not that I failed to find one. The
card warned that a comment can claim more than its test delivers, and the only way
to find that class is to read the sentence, not the assertion. Twelve such
over-claiming comments are listed at the end.

**Taken from a mapping pass (weakest, and marked).** A few mechanisms I located but
did not exercise. They are marked *unverified* where that matters.

**Scope note.** Three other lanes were working in
`apps/web/app/api/gsc`, `apps/web/app/(app)/_lib/route-answers.test.ts`,
`packages/ui`, parts of `packages/core`, `packages/jobs/src/generation` and
`apps/web/app/api/calendar` while this ran. I read those freely and mutated nothing
in them, so a few mutation checks that would naturally have gone there were done by
reading instead. Each is marked.

---

## The seven reporters the card named

The founder named seven checks known to "fail towards fine". Their state today:

| # | The reporter | State |
|---|---|---|
| 1 | A scheduled job with no handler turns the whole schedule off instead of failing | **Still live.** Worse than described — see Finding 1 |
| 2 | `contracts:check` never compares the contract to the routes on disk | **Still true of the script**; now covered by two tests instead — see Finding 9 |
| 3 | The stub report only sees class-shaped stand-ins | **Still live** — see Finding 6 |
| 4 | The chaos suite discards `result.kills` | **Still live**, narrower than described — see Finding 5 |
| 5 | The stub report mixes one stale entry with two real ones | **Still live**, and the two real ones are a live defect — see Finding 2 |
| 6 | A refused sign-in answers 200, so status-code checks pass on a broken sign-in | **Fixed.** `signin-wire.test.ts` asserts only on destinations and carries a test whose whole job is to record that a refusal answers 200 |
| 7 | A comment claiming a test proves something it structurally cannot | **Still live, and the thing it denies has happened** — see Finding 3 |

---

## The 26 invariants

### 1. One domain per account, one account per domain

*What it protects:* two businesses cannot both claim `example.com`, and one
merchant cannot quietly hold two. A duplicate claim would mean two accounts being
sold advice about the same shop.

*Mechanism:* a unique index `domains_domain_normalized_key`
(`packages/db/migrations/0000_wave1.sql:197`), a second on `account_id` (`:196`),
and a claim written as insert-with-conflict in
`claimWithIngestionRun` (`apps/web/app/api/domain/_lib/store.ts`). Address folding
is `normaliseClaimDomain` (`packages/core/src/domain/normalise.ts`).

*Verdict:* **enforced**, and the best-guarded invariant in the set. Its test file
already contains a mutation check of its own — `it('would let both claims through
if the unique index were gone')` in
`apps/web/app/api/domain/_lib/domain.test.ts` drops the index, watches two
concurrent claims both succeed, restores it, and watches one lose again. I ran the
suite: 16 pass.

*One wrinkle worth tidying:* `packages/db/src/repositories/domains.ts:9-14`
describes the claim as insert-with-conflict, and the very next comment block
(`:16-27`) says the function it is attached to is a test-only writer that product
code must never call. Two adjacent comments about the same function, one of which
is about a different function.

---

### 2. Nothing from the free preview is ever read by the real product

*What it protects:* the landing-page preview writes a throwaway summary of a
stranger's shop. If any of that leaked into a real account's persona or advice, a
merchant would be advised from a guess made before they ever signed up.

*Mechanism:* `packages/core/src/preview/disposable.test.ts` — four assertions
scanning every TypeScript file under `packages/` and `apps/` for imports of the
preview module and for the names `previewCache`, `readPreviewCache`,
`preview_cache`, plus two anti-vacuity assertions proving the scan actually found
files and would catch a planted import.

*Verdict:* **enforced.** Mutation-checked: I added a preview-cache read to the
persona module and the scan went red.

*Limit, stated because it is the shape of the hole:* the check is over **names**,
not over what the code reaches. `packages/db/src` is skipped wholesale, so a second
reader added there under a name that does not say "preview" — and called from
`packages/core` — would pass all four assertions. The file's own header claims
"nothing from `preview_cache` is ever read by ingestion, persona, topics or
evidence", which is a reachability claim the assertions cannot make.

---

### 3. Raw product descriptions are quarantined

*What it protects:* merchants' product pages are full of marketing prose. Feeding
it downstream poisons the writing twice — the keywords come out of adjectives and
the articles inherit the register. Only the distilled fact sheet is allowed
through.

*Mechanism:* `packages/core/src/distill/quarantine.test.ts` — a token scan (not a
text scan; comments are deliberately excluded) over all of `packages/` and `apps/`
failing any file that names `rawBodyHtml` or `raw_body_html` outside a nine-entry
allowlist, each entry carrying a written reason. Plus three anti-vacuity
assertions.

*Verdict:* **partially enforced.** Mutation-checked both ways, and this is the most
valuable single result in the sweep:

- I added `rawBodyHtml` to a persona file. Two assertions went red. The name rule
  works.
- I then had the same persona file call `readProductBody(row)` — the one
  decompressor, which is exported from `packages/db` — passing a row variable, so
  the column's name appears nowhere. **All six assertions passed.**

So the quarantine stops somebody *mentioning* the column and does not stop somebody
*reading* it. The header comment at `quarantine.test.ts:20-23` says "the column has
exactly one reader in the whole repository … any other module that so much as names
the column fails the build". The second half is what the test does. The first half
is not asserted anywhere, and nothing asserts `readProductBody` has a single caller.

---

### 4. Order ingestion never stores a customer field

*What it protects:* we read merchants' orders to learn which pages earn money. We
must never end up holding shoppers' names, emails or addresses — both because we
promised not to and because a GDPR request must be answerable with "we hold none".

*Mechanism:* four, all real.
- `stripOrder` (`packages/core/src/catalog/orders.ts`) builds an allowlist, not a
  denylist. `orders.test.ts` serialises its whole output and asserts none of a set
  of realistic shopper values appears anywhere in it, plus an anti-vacuity case
  proving those values *were* in what Shopify sent.
- `packages/db/src/no-customer-data.test.ts` queries the live migrated database's
  column list and word-matches every column against an 18-word shopper vocabulary.
- `packages/db/src/no-customer-table.test.ts` does the same for table names.
- `apps/web/app/api/webhooks/shopify/[topic]/_lib/gdpr.test.ts` drives the real
  receiver with a real redact request, reads the stored row back out of Postgres,
  and asserts no shopper value and no `customer` key survived.

*Verdict:* **enforced.** Not mutation-checked by me — the anti-vacuity cases in
each file are themselves planted-violation checks, which is the same evidence.

*One misleading test title:*
`it('catches a shopper hiding inside a JSONB blob, then confirms none is there')`.
The first half is real. The second half runs against a freshly created empty test
database, so it confirms the planted row was deleted and says nothing about any
real database.

---

### 5. At most five competitors, and SERP domains never enter that list

*What it protects:* two separate promises. The cap keeps the merchant's competitor
list something they curate rather than a dump. The second half is a trust promise:
domains we saw ranking in Google search results may be *suggested* to a merchant,
never silently added to their list as though they had chosen them.

*Mechanism, the cap:* a database trigger `enforce_competitor_cap`
(`packages/db/migrations/0003_wave2_guards.sql:20-45`) that locks the account row
and refuses the sixth, plus `BUSINESS_COMPETITOR_CAP = 5` in
`packages/db/src/repositories/keywords.ts:37`. Tested on both sides *and* against
each other: `packages/db/src/keywords.test.ts` fills to the constant through the
repository and then bypasses application code with raw SQL to prove the database
refuses at the same number. Raise the constant without touching the trigger and it
goes red.

*Verdict on the cap:* **enforced**, and unusually well.

*Verdict on "never auto-added":* **the code does the opposite, and nothing checks
either reading.** `proposeCompetitors`
(`packages/jobs/src/ingestion/keywords.ts:443`), called from the onboarding
keywords step, takes domains that ranked in the store's SERP snapshots and writes
them into `competitors` with `source: 'auto'`, up to the cap, before the merchant
has looked. Its comment calls this "a draft the merchant removes from, badged as
ours rather than theirs" — but a row in `competitors` is not a draft in any
structural sense; nothing distinguishes it from a merchant-typed row except a
column.

This is **not hidden**: `DECISIONS.md` 2026-09-03 `T2.6` records it, says
"`CLAUDE.md` invariant 5 reads more broadly than that", and flags it for the
integrator. What has not happened is the reconciliation. Meanwhile no test, lint
rule or constraint enforces either the invariant's wording or the narrower rule the
journal proposes ("nothing reads a snapshot row into `competitors` except through
`addCompetitor`"). See Finding 4.

---

### 6. No new page proposed without first checking we do not already have one

*What it protects:* the single most expensive mistake this product could make is
writing a second page that competes with the merchant's existing one for the same
search. The check that prevents it must be the same function everywhere.

*Mechanism:* three, of unequal strength.
- **Real and load-bearing:** `detectUncoveredCommercialQueries`
  (`packages/core/src/signals/uncovered-query.ts:77`) throws
  `UncheckedCandidateError` if a candidate keyword has no coverage answer at all,
  and skips one where an existing page is a strong match. Asserted by
  `it('refuses to answer for a search nobody ran the check on')` in
  `packages/core/src/signals/catalog-signals.test.ts`.
- **Weaker than advertised:** `runGate1` (`packages/core/src/gates/gate1.ts`)
  converts a strong match to OPTIMIZE/REFRESH and admits nothing. Its tests pass a
  hand-built outcome object; nothing asserts that outcome came from the real check.
  The file's own comment (`:14-20`) says "It is the same function everywhere it
  runs (invariant 6)". That is true of the real callers and is not asserted.
- **Declared and dead:** `CreateClearance` /`assertClearedToCreate`
  (`packages/core/src/opportunities/clearance.ts`) is a permission token designed
  so that "any function that proposes a new page takes one as an argument. A caller
  that skipped the check has nothing to pass." **No production code calls
  `assertClearedToCreate`.** `buildOpportunityDraft` takes no clearance. The
  mechanism exists, is tested against itself, and guards nothing.

*Verdict:* **partially enforced**, with a real coverage gap: two of the four
branches that can produce a CREATE — `competitor_coverage_gap` and
`product_family_coverage_gap` in
`packages/core/src/opportunities/action-selection.ts:137,150` — reach it through
their own detectors' logic rather than through the existing-target check, and
nothing asserts they ran it.

*Not mutation-checked:* `packages/core/src/{gates,signals,opportunities}` were held
by other lanes. Established by resolving callers.

---

### 7. Signal and action are never wired one-to-one, and every opportunity explains itself

*What it protects:* "we saw X, therefore do Y" is how an advice product becomes a
lookup table. Choosing what to do has to be a separate judgement over the whole
evidence. And every card a merchant sees must carry the evidence, the confidence
and the version of the rules that produced it, or nothing can be audited later.

*Mechanism:*
- `packages/core/src/signals/no-action-mapping.test.ts` asserts no file in the
  detection directory contains the words CREATE/OPTIMIZE/REFRESH/FIX/HOLD, and that
  the module exports no function whose name suggests choosing. Case-**sensitive**
  and non-recursive, so a detector writing `'optimize'` in lower case passes.
- Separation is real: `selectAction` takes the signal *and* a context, and
  `it('selects REFRESH when the same signal lands on one of our own articles')`
  proves the same signal yields different actions.
- Row completeness is nine `NOT NULL` columns in
  `packages/db/migrations/0002_wave2.sql:193-217`, of which
  `constraints-wave2.test.ts` tests two.

*Verdict:* **partially enforced.** The "source **and window** per fact" clause is
not enforced at all — `EvidenceFact.window` is optional
(`packages/core/src/contracts/opportunities.ts:53`) and the nearest test asserts
source and fetch time on every fact but `window` on exactly one.

---

### 8. Every user-facing "why" comes from a template, never from a language model

*What it protects:* the sentence explaining why a merchant should do something must
be reconstructible from the numbers we measured. A model-written explanation can be
plausible and wrong, and there would be no way to tell afterwards.

*Mechanism:* the producer side is clean — `reasonFor`
(`packages/core/src/opportunities/reasons.ts`) returns a template key and
parameters and nothing else; the calendar equivalent is `topicWhyLine`. Catalogue
coverage is well tested (`reason-copy.test.ts` asserts every gate outcome has a
sentence; `rendering.test.ts` asserts no placeholder is left showing).

*Verdict:* **partially enforced.** The claim that no model text can reach the slot
rests on one substring assertion for one fixture
(`packages/ui/src/opportunities/opportunities.test.ts`,
`it('renders the why-line from the catalogue, not from a model')`). There is no
structural test banning `@sortiva/llm` from `packages/ui` — the analogue of
`boundaries.test.ts`, which covers `packages/core` only. The comment at
`packages/ui/src/opportunities/why.ts:5-13` says "Nothing a language model wrote is
ever shown here", which nothing enforces.

*Worth knowing:* model-written prose **does** reach the OPTIMIZE recommendation
drawer, deliberately and labelled as model-written
(`drawer.test.ts`, `it("marks the model's own sentence as model-written")`). So the
invariant is about the why-line specifically, and the code is consistent with that.

---

### 9. No threshold number lives outside `packages/rules`

*What it protects:* one place to change what the system believes, and one hash
stamped on every result saying which numbers produced it. A number that reappears
as a comparison somewhere else silently forks the product's judgement.

*Mechanism:* the lint rule
`tools/eslint-plugin-sortiva/rules/no-threshold-literals.js`, enabled repo-wide and
switched off only inside `packages/rules` and in tests and fixtures.

*Verdict:* **enforced for the pattern it recognises**, and the enforcement itself is
proved rather than assumed. `pnpm lint:prove` (`scripts/prove-lint.mjs`) plants a
real violation on disk, runs the real lint, and fails unless the expected rule
fires. I ran it: 11 planted violations, all rejected. **This harness is the single
best thing in the repository's checking machinery** and is the pattern the rest of
this report keeps wishing for.

*The rule's actual reach, so nobody over-reads it:* it fires only on a comparison
whose other side is a numeric literal, against an identifier whose last word is one
of `volume, position, impression(s), click(s), ctr`. So `if (position < 15)` is
caught; `const MIN = 15; if (position < MIN)` is not, and `clickThroughRate < 0.02`
is not.

*`rules_version` stamping:* enforced for opportunities (a `NOT NULL` column, tested
by a not-null violation). **Not enforced for gate decisions:** `gate_decisions`
(`packages/db/migrations/0008_wave3.sql:110-122`) has no `rules_version` column at
all — it is stamped only as a free-form key inside `scores_json`, asserted for
gates 1 and 2 and not for gate 3. See Finding 11.

---

### 10. An open opportunity is updated, never duplicated, and expiry never deletes

*What it protects:* a merchant's board must not fill with three copies of the same
advice each week, and their history must survive — an expired card is still
evidence of what we told them.

*Mechanism:* a partial unique index
`opportunities_open_signal_entity_key` over `(account_id, signal_type, entity_ref)`
restricted to the five open statuses
(`packages/db/migrations/0002_wave2.sql:334`), matched by an `ON CONFLICT DO
UPDATE` whose predicate is written the same way
(`packages/db/src/repositories/opportunities.ts:83-90`). Expiry is an `UPDATE …
SET status='expired'`, and `it('expiry keeps the row')` asserts the row is still
countable afterwards.

*Verdict:* **enforced.** Mutation-checked: removing the conflict predicate from the
write turned all 12 tests in `packages/db/src/opportunities.test.ts` red
immediately — Postgres will not apply `ON CONFLICT` against a partial index whose
predicate the statement does not restate, so this one cannot rot quietly.

---

### 11. Gate on the minimum, one repair, a blind judge, never a cheaper model

*What it protects:* the quality bar. Averaging would let a draft with one terrible
score through on four good ones. A judge that could see the writer's reasoning
would agree with it. A judge on a cheaper model would be a cheaper bar.

*Mechanism and verdict, clause by clause:*
- **Minimum not average — enforced.** `evaluateFloors`
  (`packages/core/src/gates/gate3/judge.ts:155`) computes no mean, and
  `it('fails a 5/5/5/1/5 draft even though its average is 4.2')` pins it.
- **Judge blind to the writer — enforced.** `buildJudgeRequest` builds from scratch;
  `it('carries none of the writer conversation')` asserts the judge's text contains
  none of the writer's prompt markers, and a second case repeats it after a repair.
- **Never a smaller model — enforced, on both routes.** `PINNED_CALL_TYPES` in
  `packages/llm/src/models.ts:110` excludes the judge from the environment override,
  and `modelFor` (`packages/llm/src/client.ts:158`) throws on a per-call override.
  Both asserted, including end to end with a downgrade environment variable set.
- **One repair loop — enforced by the code's shape, not by the number.** There is no
  loop; call-count assertions pin `{ judge: 2, repair: 1 }`. But `repair_loops_max`
  is read only as `< 1`, i.e. as an on/off switch. Setting it to 5 changes nothing,
  so that threshold is in `packages/rules` in name only.

*Gap:* nothing asserts the *relation* "the judge's tier is at least the writer's".
Both are pinned to literal model ids in separate tests, so raising the writer above
the judge would go unnoticed.

*Not mutation-checked:* `packages/core/src/gates` was held by another lane.

---

### 12. Articles published against our recommendation are quarantined from learning

*What it protects:* a merchant can override the quality gate and publish anyway.
That article must not then teach the system that its own bar was wrong, and must
not be counted in any claim about how well our articles do.

*Mechanism:* the flag is written by `markArticleOverridden`
(`packages/db/src/repositories/articles.ts:140`).
- **Calibration — enforced.** `gateDecisionsForCalibration`
  (`packages/db/src/repositories/gate-decisions.ts:214`) excludes them in SQL, and
  `packages/db/src/gate3-override.test.ts` asserts the decision is visible before
  the override and gone after.
- **Shown segmented — enforced.** `splitResults` plus a rendered-HTML assertion that
  the overridden row appears only inside a folded section that says why.
- **Pattern learning — vacuously true.** `pattern_stats` has no writer anywhere in
  the repository (verified by grep). There is nothing to exclude from.
- **Headline performance claims — no mechanism.** There is no aggregate claim about
  article performance in the product today.

*Verdict:* **enforced where it can be**, and the module comment on
`packages/core/src/gates/gate3/override.ts` states all four clauses as fact when
only one has an enforcing query.

---

### 13. No verdict before 28 days, and labels are relative to the store's own median

*What it protects:* telling a merchant an article failed after ten days is noise
dressed as judgement, and telling them it failed against an absolute number
punishes small shops for being small.

*Mechanism:* essentially none, because the thing it constrains does not exist yet.
- The one real piece: marking an OPTIMIZE recommendation applied schedules its
  measurement 28 days out
  (`apps/web/app/api/recommendations/_lib/handlers.ts:678-681`), asserted against a
  frozen clock and against the queued row. **Nothing runs that job** — the handler
  is deferred out of v1 and the file says so.
- For articles there is no maturity guard at all: `packages/core/src/search/performance.ts:302`
  hardcodes "no verdict" for every row regardless of age.
- The six `learning.labels.*` numbers in `signals.config.yaml` have **no consumer**
  anywhere (verified by grep — they appear only in the type file and in a
  key-exists test). `article_labels` has **no writer**.
- The only assertion in the area checks that a *sentence* saying "measured against
  your own store's median" is on the Performance screen.

*Verdict:* **not enforced — and not currently violable either.** Worth flagging
because `packages/rules/src/rules.test.ts` asserts these six keys exist, which reads
like coverage and is not: it proves the config file has the numbers, not that
anything obeys them. When the learning loop is built, this invariant starts from
zero. See Finding 26.

---

### 14. One topic a day, and only today's — gaps stay gaps

*What it protects:* the merchant was promised at most one article a day. Pulling
tomorrow's topic forward on a quiet day, or back-filling three missed days as a
burst, would both break the promise and look like spam to Google.

*Mechanism:* `findPlannedTopicOnDate`
(`packages/db/src/repositories/topics.ts:172`) matches the scheduled date with
equality — never `>=` — and only the `planned` state. The claim is a guarded update
(`UPDATE … WHERE state = 'planned'`) that returns nothing if it lost.

*Verdict:* **enforced.** Mutation-checked: I changed the date match from equality to
"on or after" and two tests in
`packages/jobs/src/generation/daily-cycle.test.ts` went red, including
`it('writes nothing on a day with nothing planned, and leaves tomorrow alone')`,
which checks four separate things — the skip reason, that no model call was made,
that tomorrow's topic is untouched, and that no article row was written.

*Gap:* there is no database constraint. `topics_account_scheduled_idx` is a plain
index, not unique, so "one topic per day" is enforced only in the API's
`calendar_day_occupied` check. Two concurrent adds on the same day are not stopped
by the database.

*Caveat, on the honest reading:* the stranded-day recovery sweep can finish
yesterday's article on the same wall-clock day as today's, so two articles can be
*produced* in one day. The invariant is about dequeues, and delivery is separately
capped to one per pass, so the promise holds — but the comment in
`daily-cycle.ts` saying "the whole of the plan's 'up to one article per day' lives
in this file" is not true.

---

### 15. Veto works until the moment of dequeue; every transition is a guarded update

*What it protects:* a merchant must be able to say no right up to the last second,
and two workers racing must never both win. When one loses, the answer has to be a
409 with a code the screen can act on, not a silent no-op.

*Mechanism:* every state change in `packages/db/src/repositories/topics.ts` is
`UPDATE … WHERE account_id AND id AND state = expected … RETURNING *`, returning
undefined on zero rows. The race that matters is asserted directly:
`it('a concurrent veto and dequeue on the same planned topic yields exactly one
winner')` runs both under `Promise.all` and asserts exactly one wins. The 409 and
its code come from a closed enum (`packages/core/src/api/errors.ts`) and are
asserted at the route.

*Verdict:* **enforced per transition; the universal is not.** There is no lint rule
or structural test that scans repositories for an unguarded `UPDATE … SET state`.
The convention is carried by a `…Guarded` naming habit. Invariants 2, 3 and 21 all
have structural scans; this one, which is about *every* transition, does not.

---

### 16. Entitlement is local, read access is never revoked, and we never render a card form

*What it protects:* a Stripe outage must not stop the product, an unpaid merchant
must still be able to read everything we ever wrote for them, and we must never be
in the business of handling card details.

*Mechanism:*
- **Read access never revoked — enforced twice over.** `readAllowed` is typed as the
  literal `true` (`packages/core/src/billing/entitlement.ts:74`), so the compiler
  refuses to make it false, and `it('keeps read access open in every billing
  state')` asserts it for all five states. Mutation-checked: widening the type and
  making read access depend on payment turned two tests red.
- **Single writer of `subscriptions.status` — enforced.**
  `packages/core/src/billing/singleWriter.test.ts` scans for six SQL/ORM write
  shapes against a four-file allowlist and includes a self-test proving its own
  patterns match a write when they see one. The strongest mechanism in the money
  set.
- **No card form — enforced.** `packages/ui/src/public/no-card-form.test.ts` reads
  every tracked file against seven card-form markers including `js.stripe.com`.
- **The cap line — enforced**, held by an inline snapshot in
  `packages/core/src/billing/plan.test.ts` and by the canonical-copy suite.

*Verdict on "no Stripe call in a request path": **partially enforced**, and the
comment claims more than the check can give.* `stripeCallSites.test.ts` is a
one-level text scan for four method names — `.createCheckoutSession(`,
`.createPortalSession(`, `.constructEvent(`, `.fetchSubscription(` — outside a
five-file allowlist. It never renders or drives a route. A wrapper function calling
Stripe (`startCheckout(...)`, which is how
`apps/web/app/api/billing/_lib/handlers.ts:78` actually reaches Stripe from a live
request path) does not match the pattern, so transitive reach is invisible. The
file's header calls itself "the executable form of invariant 16's hardest sentence:
no Stripe API call ever sits in a request path or at scheduler dequeue". It cannot
say that.

---

### 17. Spend caps are ours; PostHog is telemetry, never the control plane

*What it protects:* a runaway vendor bill is the one failure with no upper bound.
The brakes must live in our own database, and an analytics outage must never be
able to decide whether work runs.

*Mechanism:* real and well tested for the first half. `evaluateSpendCaps` reads
`spend_events` rows and raises `ops_flags`, asserted end to end against a real
Postgres. Every registered task is wrapped in a kill-switch check by
`registerTask` itself (`packages/jobs/src/runtime/tasks.ts:25-31`), and the check
fails closed — unreadable switches mean "do not run", asserted by
`it('refuses when the switches cannot be read at all')`.

*Verdict:* **first half enforced; second half has no mechanism.** "PostHog is never
the control plane" rests on the analytics port having only write methods — a type,
with no test asserting the absence of a read method and no lint rule banning a read.
The comment above the spend-ledger tests says these "cover the port's own rules"
including that analytics is "never the control plane"; the four tests below it cover
attribution shape, a negative cost, ledger summing and a logger that must not throw.

---

### 18. Every worker is effectively-once

*What it protects:* the queue delivers at least once, so a merchant's catalogue sync
or article generation can run twice. Doing the work twice means paying twice and,
worse, publishing twice.

*Mechanism:*
- **Keys derived, never random — enforced, and strongly.**
  `packages/jobs/src/runtime/idempotency.test.ts` spawns a *separate process*
  to recompute the key and pins three literal sha256 digests. A module-level random
  would fail.
- **Completed keys are write-once — enforced in the database.** A trigger
  `idempotency_ledger_write_once_trg`
  (`packages/db/migrations/0005_wave2b_guards.sql:21-32`) refuses any update, and a
  separate test asserts no production path deletes from the ledger.
- **Per-account serialisation — the behaviour is well tested** (eight cases: two
  workers on one account serialise, different accounts run in parallel, the lock is
  released when the body throws, a stuck holder fails loudly rather than waiting
  forever, and so on).

*Verdict:* **partially enforced, with two named gaps and one wording mismatch.**
- **The invariant names a function the code deliberately does not use.**
  `pg_advisory_xact_lock` appears nowhere except in two comments explaining why it
  is not used; every call site is the session-scoped `pg_advisory_lock`. This is
  journalled (`DECISIONS.md` T0.4) and was already flagged for reconciliation in
  `docs/audits/T0.4.md`. It is still unreconciled. See Finding 24.
- **"Every worker takes the lock" has no mechanism.** `registerTask` wraps handlers
  in the kill-switch check and *not* in a lock. Six task files take it by hand and
  could simply forget. Nothing enumerates the registered tasks and asserts each one
  acquires it — which is exactly the reasoning the same file applies to kill
  switches ("a switch that half the code paths consult is not a switch").
- **"Any step over 60 seconds checkpoints" has no mechanism.** Checkpointing works
  and is tested; nothing measures a step's duration or asserts a long one
  checkpoints.

---

### 19. External writes go through a two-phase intent, and an update never becomes a create

*What it protects:* the worst possible outcome of a crash mid-publish is two copies
of an article on the merchant's blog, or a replacement post appearing where they
deliberately deleted ours.

*Mechanism:* a globally unique index on `publish_intents.article_external_id`
(`packages/db/migrations/0008_wave3.sql:216`); a marker derived from the article, so
a retry computes the same one; a recovery sweeper that asks the shop whether our
marker is already there before re-sending. The "never falls back to create" case is
asserted directly — `it('creates nothing when the merchant deleted the post, and
says so')` checks the failure reason, that the shop still holds no article, that the
create-call count did not move, and that the intent was abandoned. Reinforced under
kills by the drift-repair chaos scenario.

*Verdict:* **enforced.** Not mutation-checked (the publish path was adjacent to
another lane's work); established by reading the assertions, which count the create
calls rather than merely inspecting the result.

---

### 20. Every billable answer is written down before it is used

*What it protects:* a crash after a vendor has answered must not make us pay for the
same answer twice.

*Mechanism:* the write sits before the parse inside a `try` in
`packages/llm/src/client.ts:257-272`, with the cost record in a `finally` so a
database hiccup cannot lose a cost already incurred. The same shape for search data
in `packages/providers/src/seo/index.ts:207-215`.

*Verdict:* **enforced.** Mutation-checked: removing the cache write turned three
tests red. The ordering assertion is genuinely clever and worth copying — it feeds
the model two completions that fail validation and asserts *two cache writes
happened anyway*, so the write must have preceded the processing that rejected
them. Replay is separately proved: a second client with a fresh ledger gets the same
answer with the vendor called once.

*One misleading comment.* `packages/db/src/cache.test.ts:5-9` says "the whole
guarantee is that the row is committed before processing, and only the database can
prove that". The four tests in that file are round-trip, expiry, overwrite and
missing-key — none involves a vendor call, so none can observe ordering. It
disparages the very tests that do prove it.

---

### 21. Reading and writing to a merchant's shop are separate consents

*What it protects:* installing this product must not grant it the ability to post to
the store. Posting permission is a second, deliberate act. And nothing may ever
touch theme code or redirects.

*Mechanism:* the read scope list and the publish scope list are separate constants,
each asserted, and both grants verify what came back
(`assertReadOnlyGrant` throws on any `write_*`; `assertPublishGrant` throws if
`write_content` is missing). A replayed install redirect is refused at the
publishing callback by a `purpose` field. Auto-publish cannot be switched on without
both a resolved blog and the grant — the check is inside the SQL of
`setDeliveryMode`. Two structural scans assert that nothing in the OPTIMIZE or FIX
code names a Shopify client, a write scope, the publish protocol, a GraphQL
mutation, a URL-redirect resource or a theme/asset resource.

*Verdict:* **largely enforced**, with two things to know.
- The invariant's "the second grant is made **only from Settings or a first publish
  attempt**" has no mechanism. Nothing constrains where the grant flow can be
  started from.
- `packages/db/src/repositories/publishing.ts:130` says turning auto-publish on is
  "guarded in the database as well as in the API … the guard is what makes that a
  property of the data rather than of one code path". There is no constraint or
  trigger; the guard is a `WHERE` clause in one statement. Any other update of that
  column bypasses it. It is exactly one code path, written in SQL.

---

### 22. Degrade to a pause, never to lower quality

*What it protects:* when something breaks, the product stops and says so. It never
quietly finishes the job with a cheaper model or week-old search data, because the
merchant cannot tell the difference and we can.

*Mechanism:* stale search data cannot be returned — the expiry is inside the query
(`findFreshSerpSnapshot`). Publishing without a grade, with the switch down, or with
a failed payment are each refused and asserted. The pause sentence is a canonical
string held by snapshot.

*Verdict:* **partially enforced, and the blanket clause is not.** "No model
substitution" is enforced for the judge only. A per-call `model:` override and the
`ANTHROPIC_MODEL_*` environment variables **do** substitute models for every other
call type, and that behaviour is tested as working. So the invariant as written —
no model substitution — describes something the product does not do.

*Over-claiming comment:* `packages/core/src/ops/kill-switches.ts:18-20` — "A switch
pauses; it never lowers the bar. There is no flag here that makes the product carry
on with a cheaper model, staler data or a skipped check." No test enforces that. A
new flag named `global.use_cheap_model` would pass every test in that file.

---

### 23. No denominators in anything a merchant reads

*What it protects:* "3 of 30 articles" invites a merchant to read the 30 as owed.
The daily cap is a ceiling, never a promise, and the whole product's honesty rests
on not implying otherwise.

*Mechanism:* four separate corpora, none complete.
1. The string catalogue (`strings.test.ts`), one regex over every value.
2. Rendered markup — but only for the Dashboard (thorough, five patterns, tag
   stripped) and, much more weakly, four other screens with a single `\d+ of \d+`
   check. **Opportunities, Performance, Settings, Products and the drawer have no
   rendered-output check at all.**
3. Emails — the strongest, because `assertNoDenominator` runs inside the monthly
   summary's own render rather than only in a test.
4. The generated API document, substring-scanned for `outOf`, `target`, `quota`,
   `remaining`.

*Verdict:* **partially enforced, and the catalogue check has a hole I proved.** Its
pattern is `/\{\w+\}\s*(of|\/)\s*\{?\w+\}?/i` — it **requires a `{placeholder}` on
the left**. Running it against five candidate strings:

```
MISSED  "3 of 30 articles"
CAUGHT  "{count} of {cap}"
MISSED  "22/30 published"
MISSED  "You have used 12 of your 30"
CAUGHT  "{count} of 30"
```

So a denominator written with literal numbers passes the catalogue check outright.
On the Dashboard the rendered check would still catch it. On five screens nothing
would.

---

### 24. The canonical sentences are used word for word

*What it protects:* a small number of sentences were written carefully because
they carry a promise — the teaser, the cap line, the read-only trust copy, the
outage line. Paraphrasing one changes what was promised.

*Mechanism:* `strings.test.ts` generates one assertion per entry of a 14-entry map,
each pinning the literal, **plus a closure check** asserting the set of
`appendixA.*` keys in the catalogue equals the map's keys — so a new canonical
string cannot be added without a pinned literal. Copy is kept in the catalogue by
the `no-literal-jsx-text` lint rule, which `pnpm lint:prove` proves fires.

*Verdict:* **enforced for the catalogue.** One gap: the lint rule only sees JSX, and
`apps/web/app/api/recommendations/_lib/handlers.ts:370` hard-codes a second copy of
the canonical outage sentence in a route handler. Nothing scans non-JSX source, so
those two copies can drift apart silently — which is exactly the failure the test
file's own comment warns about for the billing copy.

---

### 25. One instrumented wrapper per vendor

*What it protects:* every model call, every paid search read and every email must
pass through one place, or there is no cost accounting, no cache and no way to
know what we spent.

*Mechanism:* the lint rule `no-direct-provider-sdk`, repo-wide with no exemptions,
covering seven modules: `@anthropic-ai/sdk` → `packages/llm/`, `resend`, `stripe`,
`posthog-node`, `posthog-js`, `@shopify/shopify-api`, `googleapis`, each pinned to
one directory. It checks static imports, dynamic `import()`, `import =` and
`require()`. A companion rule bans the two vendor host strings for the vendor with
no SDK. `packages/core/src/boundaries.test.ts` separately proves `packages/core`
imports none of them.

*Verdict:* **enforced.** Mutation-checked via `pnpm lint:prove`.

*Two gaps:*
- Only three of the seven banned modules have a planted proof
  (`@anthropic-ai/sdk`, `posthog-js`, and the DataForSEO host). A typo in one of the
  other five entries' module strings would go unnoticed.
- Model and prompt stamping is `NOT NULL` on three artefact tables but **nullable on
  `gate_decisions`** (`0008_wave3.sql:118-119`), so a gate decision — which is an
  LLM artefact — can be stored with neither stamp.

---

### 26. Events: notifications dedupe, attention is a live query, analytics carries no product content

*What it protects:* a merchant must not get the same alert twice, and no article
text, prompt or token may ever reach the analytics vendor.

*Mechanism:*
- **Dedupe — enforced.** Unique indexes on `(account_id, type, dedupe_key)` for both
  `notifications` and `email_sends` (`0000_wave1.sql:216` and `:212`), with both key
  columns `NOT NULL` so the index cannot silently disable on nulls. Dedupe keys are
  proved derived, not random, and the vendor is handed the same triple as its own
  idempotency key.
- **Analytics, browser side — enforced.** Events are declared in a fixed table, every
  declared property must be one of four non-text kinds, undeclared properties are
  dropped at the wrapper on every capture, and `posthog-js` is lint-banned outside
  the wrapper. Session replay is proved off on every view that renders store data.
- **Tokens — enforced.** Envelope encryption with a fresh data key per row, tampered
  ciphertext rejected, and both the master key and every decrypted token registered
  with the log scrubber.

*Verdict:* **partially enforced, with one real hole and one absent rule.**
- **The server side has no product-content guard.** `PosthogServerCapture.capture`
  takes an open `Record<string, unknown>` and applies only a secret scrubber, which
  redacts credential shapes and not prose. No test scans server call sites.
  `DECISIONS.md` states this openly — "the scrubber redacts credentials, not product
  text, so today the rule is upheld by review alone" — and an earlier audit finding
  already records it. It is still open.
- **"Append-only" is a comment, not a mechanism.** No revoke, no trigger, no test
  asserts nothing updates or deletes `notifications`.

---

## Findings, ranked

Live defects first. Each is written to be turned into a card without redoing the
work.

### 1. One mistyped job name switches the product's entire clock off, quietly

**Severity: highest. This is a live defect and it is the founder's reporter 1,
unfixed.**

`bootstrapWorker` (`packages/jobs/src/runtime/bootstrap.ts`) decides whether the
recurring schedule runs at all:

```
const missing = CRON_ENTRIES.map((e) => e.task).filter((task) => !registered.has(task))
const enableCron = registered.size > 0 && missing.length === 0
if (!enableCron) { logger.log(`[worker] cron disabled — …`) }
```

So one scheduled entry whose handler was never registered turns off **all**
recurring jobs — the daily article, the nightly reconciliation, the Search Console
sync, the publish-intent recovery sweep, everything — and says so in a single
`logger.log`, not even an error.

The loud guard exists. `assertCrontabTasksExist`
(`packages/jobs/src/runtime/crontab.ts:192`) throws with the missing names. But
`startWorker` only calls it `if (useCron)` — and `useCron` is exactly the flag that
was just set to false because a name was missing. **The guard is unreachable in
production by construction.**

The two tests that cover it both bypass the only path production takes:
`runtime.test.ts:185` calls `assertCrontabTasksExist` directly, and `:1158` calls
`startWorker({ enableCron: true })` directly. `bootstrapWorker` — the function
`apps/web/instrumentation-node.ts:314` actually calls — has tests for health
marking and analytics flushing, and none for its cron decision.

*Established by reading, not mutation:* the deduction is four lines long and
unambiguous, and reproducing it at runtime needs a booted server plus a real
database. Worth a mutation check when the card is taken.

*What a fix looks like:* refuse to start, the way the missing kill-switch reader
already does two blocks above in the same function — that path calls
`markWorkerStopped` and throws, which is exactly the right shape. Plus a test that
drives `bootstrapWorker` with one unregistered name.

### 2. Two of the four automatic brakes cannot fire in production

**Severity: highest. Live defect. The second half of the founder's reporter 5.**

The automatic trips are meant to stop the product when the quality judge starts
rejecting most drafts, or when publishing starts failing. Neither can happen.

`evaluateAutoTrips` (`packages/jobs/src/sweeps/auto-trips.ts:149,166`) falls back to
`UnrecordedJudgeOutcomes` and `UnrecordedPublishOutcomes` when its dependencies do
not supply real counters. Those stand-ins report "not measurable", which routes both
conditions into an `unmeasurable` list and skips the arithmetic entirely.

The composition root passes neither: `apps/web/instrumentation-node.ts` calls
`registerOpsTasks(db, { analytics })`, and `registerOpsTasks`
(`packages/jobs/src/sweeps/spend-caps.ts:185`) hands that same object straight
through as `AutoTripDeps`.

So the arithmetic is real, tested, and fed nothing. `pnpm stubs:report` says so
today, in two of its three lines — and see the next finding for why nobody reads
them.

### 3. Email sign-in is configured on the server, absent from the screen, and a comment says a test prevents exactly that

**Severity: high. Live product gap, and the exact class the card asked for.**

`apps/web/app/api/auth/_lib/config.ts:65-68`:

> "Omitted only by tests that drive the callbacks directly. The single production
> instantiation always supplies it, and `authWiring.test.ts` asserts that, **so
> email sign-in cannot quietly fall off the sign-in screen.**"

`authWiring.test.ts` repeats the claim in its own header: "removing it takes the
sign-in route off the screen *and* turns this red."

What the test actually does: `buildAuthConfig(authDeps()).providers` contains an
entry with `id === 'email'`. It inspects a configuration object. It cannot see a
screen.

And the screen has no email sign-in. `packages/ui/src/public/SignIn.tsx` renders one
Google button, and its own comment says: *"Only Google is offered today. Email
sign-in is specified and unbuilt."*

So the thing the comment says cannot happen has happened, the test is green, and two
files carry the false assurance. Note also that the component's stated reason for
the gap — no store for the single-use token — looks stale: `VerificationTokenStore`
exists and has its own tests. Worth checking before the card is scoped.

*Only reading the prose finds this.* The assertion inside the test is correct about
what it asserts.

### 4. Onboarding auto-adds competitor domains that invariant 5 says must never be auto-added

**Severity: high. A trust promise, and the constitution and the code disagree.**

`proposeCompetitors` (`packages/jobs/src/ingestion/keywords.ts:443`, called at
`:198` from the onboarding keywords step) takes domains that ranked in the store's
own SERP snapshots and writes them into `competitors` with `source: 'auto'`, up to
the cap, before the merchant has seen anything.

Invariant 5 says SERP ranking domains "may be *suggested* to the merchant, never
auto-added".

This was noticed at the time. `DECISIONS.md` 2026-09-03 `T2.6` records the
departure, argues from main §7.2.1 that the invariant compresses a narrower rule,
and explicitly flags it for the integrator. Nothing has since reconciled the two.

**What has no mechanism at all is either reading.** No test, lint rule or constraint
asserts "no row with `source = 'auto'` without a merchant action", and none asserts
the narrower rule the journal proposes — that nothing reaches `competitors` except
through `addCompetitor`. Contrast invariants 2 and 3, which both have structural
scans; this one has prose in two repository files.

*Card shape:* a founder decision on which rule is true, then one structural test for
whichever it is, then an edit to `CLAUDE.md` if the code stays.

### 5. The chaos suite still cannot tell a scenario that survived three kills from one that was never interrupted

**Severity: high. The founder's reporter 4, still live, though narrower than
described.**

`packages/jobs/src/chaos/suite.chaos.spec.ts:43-45` runs each scenario with
`kills: 3` and then asserts one thing: `expect(result.scenario).toBe(scenario.name)`.
It discards `result.kills` and `result.checkpointsReached`.

The harness has since been hardened, which narrows the hole: if a pass survives with
budget unspent it tightens its kill-point ceiling and retries, and it throws if it
never converges. So the residual case is a scenario whose driver reaches **no
checkpoint at all** — `seen.length === 0`. That returns `kills: 0`, breaks out, runs
the universal "every step settled" assertion against a run nothing interrupted, and
passes green.

That is not hypothetical: a refactor that removes or renames a scenario's
`ctx.checkpoint(...)` calls produces exactly that state, and the nightly chaos run
would report success.

The harness itself already knows this matters — `ChaosResult.kills` is documented as
existing precisely so this can be checked, and `harness.test.ts:68` asserts
`result.kills === 3` for the harness's own self-test scenario. The seven real
scenarios get no such assertion.

*Card shape:* assert `result.kills` equals the requested budget and
`result.checkpointsReached` is non-empty, in the suite spec, per scenario.

### 6. The stub report can only see one shape of stand-in, and one of its three lines is stale

**Severity: medium-high. The founder's reporters 3 and 5.**

`pnpm stubs:report` builds its list from a registry that is populated by
`StubImplementation`'s **constructor** (`packages/core/src/contracts/stubs.ts`). A
stand-in that is a plain function, an object literal, or a class that does not
extend that base is invisible to the report entirely. `packages/jobs/src/optimize/generate.test.ts:163`
defines exactly such a class (test-only, so harmless, but it shows the shape).

Separately, the report's `JudgeLite` line is stale. `scripts/stub-report.mjs:57`
still constructs `StubJudgeLite`, while the real `LlmJudgeLite` is constructed in
production at `apps/web/app/api/recommendations/_lib/config.ts:152` and the double
is used only by tests.

The cost of the staleness is Finding 2: a reader who correctly dismisses the stale
line dismisses all three, and the other two are a live defect.

### 7. The quarantine on raw product descriptions stops the name, not the read

**Severity: medium-high. Mutation-proved.**

Covered above under invariant 3. The concrete card: either assert that
`readProductBody` (`packages/db/src/repositories/catalog.ts:599`) has exactly one
caller, or stop exporting it and give `productsForDistillation` a private helper.

### 8. A denominator written with literal numbers passes the copy check

**Severity: medium-high. Proved directly against the pattern.**

Covered above under invariant 23. `"3 of 30 articles"` and `"22/30 published"` both
pass `strings.test.ts`, because the pattern requires a `{placeholder}` on the left.

*Card shape:* two patterns rather than one — the existing placeholder form plus a
bare `\b\d+\s*(of|\/)\s*\d+\b` — and a rendered-output check on the five screens
that have none (Opportunities, Performance, Settings, Products, the recommendation
drawer), copying the Dashboard's approach, which strips tags and reads the finished
text precisely because a denominator can be assembled at render time from two
innocent values.

### 9. `contracts:check` still never looks at the routes on disk — but two tests now do

**Severity: medium. The founder's reporter 2, changed rather than fixed.**

`scripts/contracts-check.mjs` compares the contract to itself and to the generated
document. It does not read the route files. That is unchanged.

What has changed is that two tests now cover the gap from a different direction:
`apps/web/app/(app)/_lib/screen-addresses.test.ts` records the addresses screens
actually request (by driving the presses, not by reading strings) and holds them
against both the contract and the route files on disk; and
`apps/web/app/(app)/_lib/route-answers.test.ts` drives each real route handler
against a seeded database and parses its answer with the schema the contract
declares.

Both are good, and `route-answers.test.ts` is the right pattern. Two things a card
should look at: the `UNCONTRACTED_ROUTES` list (7 entries) and the `UNDRIVABLE` list
(7 entries) are where teeth get filed off, and both are hand-maintained. And the
founder's original complaint was about the *script*, which the gate runs
independently of the test suite.

### 10. The permission token that was supposed to make a check unskippable is not used

**Severity: medium.**

`CreateClearance` (`packages/core/src/opportunities/clearance.ts`) exists so that
"any function that proposes a new page takes one as an argument. A caller that
skipped the check has nothing to pass." `assertClearedToCreate` has **no production
caller**; `buildOpportunityDraft` takes no clearance.

Its one structural test asserts only that the minting function is named in two
files. Meanwhile two CREATE-producing branches
(`action-selection.ts:137,150`) reach a new-page recommendation without going
through the existing-target check at all.

### 11. Gate decisions are not stamped with the rules that produced them

**Severity: medium.**

`gate_decisions` (`packages/db/migrations/0008_wave3.sql:110-122`) has no
`rules_version` column, and its `prompt_version` and `model_id` are nullable. The
rules hash is written only as a free-form key inside `scores_json`, asserted for
gates 1 and 2 and not for gate 3.

Invariant 9 requires the hash "stamped on every opportunity **and gate decision**",
and invariant 25 requires every artefact stamped with model and prompt. Opportunities
have `NOT NULL` columns and a test proving the not-null bites; gate decisions have
neither. Needs a schema wave.

### 12. "No model substitution" is true only of the judge

**Severity: medium. The invariant describes something the product does not do.**

Invariant 22 says no model substitution. The judge is genuinely pinned on two
routes. Every other call type moves under a per-call `model:` override or the
`ANTHROPIC_MODEL_SONNET`/`_HAIKU` environment variables, and that behaviour is
tested as working.

Either the invariant should say "the judge is never substituted", or the overrides
should be narrowed. It is a wording decision with a real consequence, so it belongs
to the founder rather than to a lane.

### 13. Nothing stops article text reaching the analytics vendor from the server

**Severity: medium. Already an open finding; recorded here because it is still open.**

The browser side is genuinely well guarded: a declared event table, four
non-text property kinds, undeclared properties dropped at the wrapper, the vendor's
own library lint-banned outside it. The server side has none of that —
`PosthogServerCapture.capture` takes an open property bag and applies only a
credential scrubber. `DECISIONS.md` says plainly that "today the rule is upheld by
review alone".

### 14. "PostHog is never the control plane" has no mechanism (invariant 17)

The analytics port has no read method, which is a type and not a check. Nothing
asserts the absence, and no lint rule bans a read. The comment above the spend
ledger's tests claims those tests cover this; they do not.

### 15. Nothing asserts every worker takes the per-account lock (invariant 18)

`registerTask` wraps every handler in the kill-switch check and not in a lock. Six
task files take it by hand. The file's own reasoning about switches — "a switch that
half the code paths consult is not a switch" — applies verbatim and is not applied.

### 16. Nothing enforces the "over 60 seconds means checkpoint" rule (invariant 18)

Checkpointing works and is tested. No mechanism measures a step's duration or
asserts that a long one checkpoints.

### 17. Nothing enforces that notifications are append-only (invariant 26)

No revoke, no trigger, no test. The dedupe index is real; the append-only property
is a comment.

### 18. Nothing constrains where the second Shopify grant can be started from (invariant 21)

The invariant says the write grant is offered "only from Settings or a first publish
attempt". The route exists and can be reached from anywhere.

### 19. A canonical sentence has a second home outside the catalogue (invariant 24)

`apps/web/app/api/recommendations/_lib/handlers.ts:370` hard-codes the outage
sentence. The `no-literal-jsx-text` lint rule only sees JSX, so nothing would notice
the two copies drifting apart.

### 20. "One topic per day" has no database constraint (invariant 14)

`topics_account_scheduled_idx` is a plain index. The rule lives in one API check.
Two concurrent adds on the same day are not stopped. Needs a schema wave.

### 21. Nothing asserts that all state transitions are guarded (invariant 15)

Every transition found *is* guarded, and the guard is proved to bite on the race
that matters. But the universal rests on a `…Guarded` naming habit, with no
structural scan of the kind invariants 2, 3 and 21 all have.

### 22. Only three of the seven banned vendor SDKs have a planted lint proof (invariant 25)

`resend`, `stripe`, `posthog-node`, `@shopify/shopify-api` and `googleapis` are in
the rule's table and in nobody's proof. Five more files in `scripts/lint-proofs/`
would close it — the harness discovers them, so no shared list has to be edited.

### 23. `repair_loops_max` is a threshold in name only (invariant 11)

It is read only as `< 1`, so it is an on/off switch. The "one repair" rule is a
property of the code's shape. Either enforce the number or say in `packages/rules`
that it is a switch.

### 24. Invariant 18 names a database function the code deliberately does not use

`pg_advisory_xact_lock` appears nowhere but in two comments explaining the choice
against it. The code uses the session-scoped `pg_advisory_lock`. Journalled, and
already flagged for reconciliation in `docs/audits/T0.4.md`. A one-line edit to
`CLAUDE.md`, but it should be made rather than re-found by the next audit.

### 25. The competitor cap number exists a third time in `packages/ui` and enforces nothing

Recorded in `DECISIONS.md`. Two copies are locked to each other by a test; the third
is not.

### 26. Invariant 13 is entirely unenforced, and a passing test makes it look otherwise

No verdict computation exists. `article_labels` has no writer, `pattern_stats` has no
writer, and the six `learning.labels.*` numbers have no consumer.

The risk is not today's behaviour — nothing can violate a rule about a feature that
does not exist. The risk is that `packages/rules/src/rules.test.ts` asserts those six
keys are present, which reads like coverage. When the learning loop is built, this
invariant starts from nothing, and the person building it will find a green test
file with the invariant's citations in it.

---

## Over-claiming comments, collected

The card asked specifically for this class, because grepping for weak assertions will
not find it. Each of these describes a guarantee stronger than the assertion beside
it can deliver.

| File | What it claims | What is actually checked |
|---|---|---|
| `apps/web/app/api/auth/_lib/config.ts:65-68` | a test stops email sign-in falling off the screen | the built config object contains an `email` provider — and the screen has no email sign-in |
| `packages/core/src/gates/gate1.ts:14-20` | the cannibalization check "is the same function everywhere it runs" | the gate reacts correctly to a hand-built outcome |
| `packages/core/src/opportunities/clearance.ts:10-15` | "any function that proposes a new page takes one as an argument" | no production function takes one |
| `packages/ui/src/opportunities/why.ts:5-13` | "Nothing a language model wrote is ever shown here" | one fixture's card contains the catalogue sentence |
| `packages/core/src/ops/kill-switches.ts:18-20` | "There is no flag here that makes the product carry on with a cheaper model" | the switch list's names, shapes and two-operator rule |
| `packages/core/src/billing/stripeCallSites.test.ts:10-16` | "no Stripe API call ever sits in a request path" | four method names, one level deep, outside an allowlist |
| `packages/db/src/cache.test.ts:5-9` | "only the database can prove" write-before-processing | round-trip, expiry, overwrite, missing key — no vendor call |
| `packages/db/src/repositories/publishing.ts:130` | auto-publish is "guarded in the database as well as in the API" | a `WHERE` clause in one statement; no constraint or trigger |
| `packages/core/src/distill/quarantine.test.ts:20-23` | "the column has exactly one reader in the whole repository" | nobody *names* the column — mutation-proved insufficient |
| `packages/core/src/preview/disposable.test.ts:7-9` | nothing reads the preview cache | nothing *names* it, outside `packages/db` |
| `packages/core/src/gates/gate3/override.ts` | overridden articles are excluded from calibration, pattern learning **and** headline claims | only calibration has an enforcing query |
| `packages/core/src/gates/gate3/judge.ts` | the judge runs on "the same tier the writer runs on" | the request names no model; the tier relation is asserted nowhere |
| `packages/jobs/src/generation/daily-cycle.ts` | "the whole of the plan's 'up to one article per day' lives in this file" | the delivery cap lives in `publish/deliver.ts`; the recovery sweep is in a third file |
| `packages/core/src/{optimize,fix}/no-store-write.test.ts` | scans "the whole of what ships" | `packages/*/src` and `apps/web/app` only — not `scripts/`, `tools/`, `ops/`, or the rest of `apps/web` |
| `packages/db/src/repositories/domains.ts:9-14` | describes the merchant claim path | attached to a function the next comment says product code must never call |
| `packages/core/src/contracts/spend.test.ts:13-17` | covers "analytics is telemetry, never the control plane" | attribution shape, a negative cost, ledger summing, a logger that must not throw |
| `packages/ui/src/content/articles.ts:32` | a verdict is withheld inside the measurement window | the function translates whatever label it is handed; no window exists |

---

## Two patterns worth copying, and one to retire

**Copy `scripts/prove-lint.mjs`.** It plants a real violation on disk, runs the real
check, and fails unless the expected rule fires. It is discovered-by-file rather than
list-driven, so lanes add a case without editing anything shared, and it throws if
there are zero cases. It is the only mechanism in the repository that proves *the
checker itself* still works. The equivalent for tests would be a small number of
committed mutation cases for the load-bearing guards.

**Copy the write-before-processing test's technique** (`packages/llm/src/client.test.ts`,
`it('writes the response to the cache before processing it')`). It proves an
*ordering* — normally the hardest thing to assert — by making the later step fail and
observing that the earlier one already happened. The same shape would work in several
places above.

**Retire the habit of asserting on a configuration object and describing it as a
property of the screen.** Findings 3 and 10 are both that. The fix that already exists
in the tree is `screen-addresses.test.ts`: drive the thing, record what came out.
