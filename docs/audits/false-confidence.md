# False confidence in the 873 tests

**Question answered:** which of the tests that exist and pass would *keep* passing if the
thing they protect were broken.

**Method:** I copied the repository to a throwaway directory, broke one thing at a time
in the copy — the mistake a future card would plausibly make, never a syntax error — and
ran the tests that should have noticed. Everything below is something I actually did and
watched. The real repository was not modified.

**Terms used throughout.** *Invariant* — one of the 26 numbered rules in `CLAUDE.md` the
founder considers "silent violation corrupts the product". *Lint* — the automated
code-shape checker (`pnpm lint`); it reads the source text and rejects patterns, as
opposed to tests, which run the code. *Suite* — one test file. *Mutation* — a defect I
planted deliberately.

---

## The short version

Nine protections are not real. Two of them are load-bearing:

1. **The rule that stops us paying twice for the same work has no working test.** I made
   every "have I already done this?" fingerprint different on each process restart —
   the exact failure the rule exists to prevent — and **423 tests passed**.
2. **The promise that we hold no customer data has no test at all,** despite the invariant
   saying one exists. I added `customer_email` and `shipping_city` columns to the table
   built from Shopify orders, with the migration to match, and **433 tests plus lint passed**.

And one process finding that undermines everything else: **`pnpm test` is not a reliable
gate.** In one run on a quiet machine, 174 of the 873 tests silently did not run.

---

# Not real — ordered by what it costs if it breaks unnoticed

## 1. Invariant 18 (effectively-once): "keys derived from inputs, never random" is untested

**What the thing does.** Every unit of background work — fetch the catalogue, distil a
product, build the persona — carries a fingerprint computed from its inputs. If the worker
dies and the job is retried, the retry computes the *same* fingerprint, sees the work is
already recorded as done, and returns the stored answer instead of doing it again. That is
the entire defence against paying Anthropic and DataForSEO twice for the same answer, and
against a merchant's onboarding running twice.

**The defect I planted.** I mixed a value that changes per process into the fingerprint —
`sha256(process id + a random number)`, computed once when the module loads. Inside one
process every call still agrees, so nothing looks wrong. Across a restart, every
fingerprint changes.

**What should have caught it.** `packages/jobs/src/runtime/runtime.test.ts:66`, a test
literally titled *"derives the same key from the same inputs, never randomly"*.

**What actually happened.** Nothing. 423 tests passed across `packages/jobs`, `apps/web`
and `packages/core`. Lint clean.

**Why the test cannot see it.** It calls the function twice, back to back, in the same
process and the same millisecond, and asserts the two results match. Any source of
nondeterminism that is *stable within a process* — a module-level random value, the
process id, a counter — or *stable within a millisecond* — the wall clock — satisfies that
assertion perfectly. I confirmed the wall-clock version passes too. The test proves the
function is not calling `Math.random()` on every single call, which is not the property
anyone cares about.

**What it would cost.** Every worker restart and every deploy would re-run all completed
paid steps for any job in flight, re-billing both vendors and re-running a merchant's
onboarding. It would look like a vendor billing anomaly, not a bug.

**What would make it real.** Compute the fingerprint in a *separate process* and compare
it with one computed here; and pin one known input triple to its expected hash as a
literal, so any change to the derivation fails loudly.

**Related, worth knowing:** the function that runs a step — where the per-store lock,
the guarded state transitions, the checkpointing and the per-store logging all live —
**has no caller in the running product yet.** Only tests call it. The card that first
wires it up (`T2.1`, the Shopify catalogue sync) will inherit this untested fingerprint.

---

## 2. Invariant 4 (no customer data): the test the invariant claims exists does not exist

**What the thing does.** When we read a store's orders, we keep only aggregates — how many
orders landed on a page, and their total value — and throw away everything about the
person who bought. That is what lets us answer Shopify's GDPR "what do you hold about this
customer?" webhook with "nothing", truthfully.

**The defect I planted.** I added two columns to the order-derived table — `customer_email`
and `shipping_city` — together with the database migration that creates them. This is
exactly the shape of a future card's mistake: "we need the city for regional insights".

**What should have caught it.** `CLAUDE.md` invariant 4 states: *"A test asserts no customer
field reaches storage."*

**What actually happened.** Nothing. 433 tests passed. Lint clean. I searched the whole
repository: **no such test exists.** The protection is two prose comments, in
`packages/db/src/schema/revenue.ts` and `packages/db/src/schema/catalog.ts`, each saying
the rule "shows up here as an absence".

**What it would cost.** The "no data held" answer becomes a false statement to a regulator,
and nothing in the build would object. The stripping code itself does not exist yet either
(order ingestion is not built), so today there is nothing to strip — but the *columns* are
what the invariant guards, and they are unguarded now.

**What would make it real.** A test that reads the live database's column names and fails
on anything matching a customer vocabulary (`email`, `phone`, `name`, `address`, `city`,
`postcode`, `customer`, `order_id`) outside a short, explicit, commented allowlist. It runs
in seconds and catches every future wave.

---

## 3. `pnpm test` is not a reliable gate: a fifth of the suite can silently not run

This is the answer to the flaky run observed today. **It was contention, not a product
race** — but contention the test harness creates itself, and the way it fails is silence.

**What I measured.**

- One full run in my copy: **174 of 873 tests skipped**, spread over 15 files, including
  every database-backed test for sign-in, account scoping, the Stripe webhook, domain
  claim, the onboarding funnel and the billing routes. Only 5 failures appeared, all from
  a hand-written tripwire that 5 of the 15 files happen to carry.
- **Twelve test worker processes survived the run**, still holding Postgres connections
  minutes later. A later run's connection probe then times out, and every database suite
  concludes "no database" and skips itself.
- Each suite creates its own database, but **the names are fixed constants**
  (`sortiva_test_worker_runtime` and so on) and each suite starts by issuing
  `DROP DATABASE ... WITH (FORCE)`, which forcibly disconnects anyone attached. I proved
  the consequence: two `pnpm test` runs started one second apart against the same Postgres
  — one passed 60/60, the other failed 33/60 with *"terminating connection due to
  administrator command"*. That is the founder's observed symptom, exactly.

**Why it is false confidence rather than mere annoyance.** A skipped test is green. Ten of
the fifteen database-backed files had no assertion that the database was actually there. I
proved it: pointing the tests at a dead port, **all six web API suites reported success**
with roughly 45 tests silently not run — including the tests for invariant 1 (one domain
per account) and invariant 16 (billing never revokes read access), which are otherwise
genuinely good.

**Status.** The parallel investigation has already patched this in the working tree:
`databaseAvailable()` now throws rather than returning false when the `CI` environment
variable is set, so a CI database that fails to start turns the build red. That closes the
CI half. It does **not** close the local half — and the handoff document instructs the
integrator to run the whole gate locally on the merged tree, which is precisely where the
contention bites.

**What would make it real.** Two small changes: give each test run a unique database-name
prefix (a random suffix per run), so two runs cannot destroy each other; and make the run
fail if any worker process is still alive at the end. Both are in one file,
`packages/db/src/testing.ts`.

---

## 4. Invariant 16: a second writer of the billing status slips past its guard if the name is aliased

**What the thing does.** Whether a merchant is allowed to have articles generated is
decided by one column in our own database. Exactly one piece of code is allowed to write
that column — the worker that processes Stripe's messages. If a second writer existed, a
merchant's access would flip depending on which code ran last, and it would look like a
Stripe bug.

**Prior claim I verified.** The T1.2 audit reported that this rule was enforced by nothing
and that it planted a second writer past all 464 tests. That has since been fixed —
there is now a real guard (`singleWriter.test.ts`) that scans every source file for writes
to that table, and it **caught** my first attempt.

**The defect it did not catch.** The guard matches the table's literal name at the point of
the write. I renamed the table binding where it is imported — `import { subscriptions as
subs }` — and wrote through `subs` instead. **89 tests passed, lint clean.**

Two things compound it: the file I put it in (`apps/web/app/api/billing/_lib/handlers.ts`)
is one of seven files explicitly exempted from the lint rule that would otherwise object to
touching a raw table, so nothing there complained either.

**Realism:** moderate. Aliasing an import to avoid a name clash is ordinary, and the
exempted billing file is the natural home for a "support: re-activate this account" helper.

**What would make it real.** Resolve the imported binding's original name rather than
matching text at the call site — or, more cheaply, forbid aliasing that table's import at
all outside the sanctioned files.

---

## 5. Invariant 25 (one wrapper per vendor): two shapes of violation walk straight through

**What the thing does.** Every call to a paid vendor goes through a single wrapper, which
is where the caching, the cost record and the telemetry live. Lint bans importing the
vendor's SDK anywhere else. `pnpm lint:prove` plants seven violations and confirms lint
rejects all seven — I ran it; all seven do get rejected, and the rule that bans the
DataForSEO web address is genuinely good.

**Defect A — call the AI vendor over plain HTTP.** The lint rule bans the *package*
`@anthropic-ai/sdk`. It does not ban the *address* `api.anthropic.com`. I wrote, in
`packages/core`:

```
fetch('https://api.anthropic.com/v1/messages', { ... })
```

**Lint: zero errors.** That call would be uncached, uncosted and invisible to the spend
ledger. There is already a rule that bans a vendor address — the one that fences in
DataForSEO — and it has exactly one entry in its list. Adding `api.anthropic.com` is a
one-line change to a list.

**Defect B — the raw connection pool is not on the ban list.** The rule that stops code
reaching database tables without naming an account derives its table list from the schema
(so it cannot go stale) but keeps a **hand-written list of four** other exported names.
The package exports five. The fifth, `dbPool`, is the raw connection handle. I wrote, in
`packages/core`:

```
import { dbPool } from '@sortiva/db'
dbPool().query('SELECT * FROM domains')
```

That is unscoped raw SQL across every account's rows. **Lint: zero errors.** And this is
not hypothetical shape-play — `dbPool` is already imported this way today in
`apps/web/app/api/webhooks/stripe/_lib/receiver.ts`, a file that is *not* on the
exemption list, and lint has never objected.

**Defect C — the same rule only inspects plain import statements.** A re-export
(`export { db } from '@sortiva/db'`) and a dynamic import (`await import('@sortiva/db')`)
both reach the same raw surface and both pass. The sibling rule that bans vendor SDKs
handles all four shapes; this one handles one. Less likely as an accident than A or B, but
free to close.

---

## 6. Invariant 9 (no threshold numbers outside the rules file): the natural way to write one escapes

**What the thing does.** Every number that decides something — "position better than 15",
"volume above 100" — lives in one configuration file, so the founder can change the
product's behaviour in one place and every decision is stamped with which version of the
numbers produced it. Lint bans comparing a literal number against a ranking field anywhere
else.

**The defect.** I wrote the same threshold the way most people would write it:

```
const MIN_POSITION = 15
return position < MIN_POSITION
```

**Lint: zero errors.** The rule only fires when the *literal digit* is on one side of the
comparison. Naming the constant — which every style guide encourages — defeats it. The
canonical form (`position < 15`) is still caught, which is what `lint:prove` checks.

**What it would cost.** Thresholds drift out of the configuration file one named constant
at a time, and the version stamp on each decision stops meaning what it says.

**What would make it real.** Also reject a comparison against a `const`-bound numeric
literal declared in the same file, which is a small addition to the existing rule.

---

## 7. Invariant 16: the "no vendor call in a request path" guard is a list of four method names

**What the thing does.** Nothing that runs while a merchant waits for a page may call
Stripe. If it did, a Stripe outage would become a Sortiva outage. A guard scans every
source file for calls to Stripe's remote methods and allows them only in five named files.

**The defect.** The guard's list of remote methods is hand-written and has four entries.
I added a fifth method to the Stripe port (`listInvoices`) and called it from a request
handler. **89 tests passed.**

**Realism:** high. Adding a method to the vendor port is exactly what the next billing
card does, and the guard's list is in a different package from the port.

**What would make it real.** Derive the method list from the port's own type rather than
copying it, so a new method is guarded the moment it is declared.

---

## 8. Invariant 2 (preview output is disposable): the guard is name-based and exempts the database package

**What the thing does.** The public teaser — a few cents' worth of homepage summary shown
to a stranger before they sign up — must never feed the real analysis a paying merchant
gets. A test asserts nothing outside the preview module imports the preview module or names
the preview cache.

**The defect.** I added a repository function in `packages/db` that reads the preview cache
and returns it, named `loadStoredSummary` — no occurrence of the word "preview". Then I had
a module in `packages/core` consume it, again without naming preview anywhere.
**367 tests passed. Lint clean.**

Two things let it through: the guard matches on names (`previewCache`, `preview_cache`,
`preview`) rather than on what the code reaches, and it exempts the whole of
`packages/db/src` on the grounds that the package legitimately declares the table.

**Realism:** moderate. `packages/db` is the sanctioned home of the preview cache
repository, so a second reader landing there is plausible; the neutral name is the part
that requires a little bad luck.

**What would make it real.** Anchor the rule on the table, not the identifier: fail if any
file outside the preview module's own directory reads the `preview_cache` table by any
route, including through a repository whose name does not mention it.

---

## 9. Invariant 26 (events carry ids and aggregates only): nothing stops product content leaving

**What the thing does.** Analytics events sent to PostHog must carry identifiers and
counts, never article text, prompts, or tokens.

**What I did.** I sent an event through the analytics wrapper carrying an article title,
an article body, a prompt, and a Shopify token. Output:

```
{"account_id":"acc-1",
 "article_title":"Ten Ways To Style A Merino Base Layer",
 "body":"Merino wool regulates temperature across a wide range...",
 "prompt":"You are an SEO writer. Write 1200 words about...",
 "shop_token":"[redacted]"}
```

**The token is redacted. The article, the body and the prompt are not.** The scrubber
matches secret-shaped values and secret-sounding key names; product content is neither.
The wrapper's own comment claims *"Nothing customer-derived leaves the process. Properties
are scrubbed"* — the first sentence is not true, and reads as a guarantee.

The rule's only current enforcement is a doc comment on a field typed as "any object".
There is no production code emitting article text today, so nothing is leaking now; the
false confidence is that the wrapper looks like it prevents it.

**What would make it real.** Either an allowlist of property key names per event type, or
a test that rejects any property whose value is a string over some length — either turns
"never product content" from a comment into a check.

---

## 10. The only production AI client can lose its cache with nothing failing

**What the thing does.** Invariant 20: every paid vendor answer is written to a cache
*before* it is processed, so a crash after the vendor answered replays rather than re-bills.

The two wrappers both default to a **no-op cache** when no cache is handed in. Exactly one
place in the running product constructs an AI client — the preview endpoint's wiring — and
it does pass a real cache. I deleted that one line. **142 tests passed.** Lint objected
only by accident, because the deletion left an unused import; a *new* client constructed
without a cache would leave no unused import and nothing would fail.

The wrappers' own caching tests are good — I broke both cache-key builders and both were
caught by well-named tests (see below). But they run against an injected in-memory cache.
They prove the wrapper's behaviour, not that production hands it one.

**What would make it real.** Make the cache a required constructor argument rather than one
that silently defaults to nothing — the same choice already made for the cost ledger,
whose comment explains exactly this reasoning.

---

# What held — things I broke and the tests caught

Each of these is a guarantee the founder can rely on. In every case the failing test's
name described the real problem.

| I broke | What caught it |
|---|---|
| **Domain normalisation stopped folding subdomains** (so `shop.` and `blog.` of one business become two accounts) | `normalise.test.ts` — "keeps the multi-tenant allowlist to the suffixes main §2 names" |
| **Normalisation stopped lowercasing** (an uppercase spelling claims a second row) | `normalise.test.ts` — "folds every spelling of one business onto one key", plus one more |
| **Domain claim rewritten as check-then-insert** (the classic race: two people claim the same domain at once) | `domain.test.ts` — three tests, including "lets exactly one of eight simultaneous claims win" |
| **A merchant whose card failed stayed entitled** | 4 tests across `entitlement.test.ts` and `statusWorker.test.ts` |
| **Read access revoked when not entitled** | 5 tests, including "keeps read access open in every billing state" |
| **AI cache key stopped including the model** (a cheap model's answer would be replayed for an expensive one) | `client.test.ts` — "keys the cache on prompt version, model and prompt hash" |
| **DataForSEO cache key stopped sorting its parameters** (same query, two keys, billed twice) | `seo.test.ts` — "keys on the same canonical function the live provider uses" |
| **A second writer of the billing status, using the table's plain name** | `singleWriter.test.ts` — "no file outside the billing store writes the subscriptions table" |
| **A route handler importing the rules package** (domain logic creeping into the web layer) | lint — `sortiva/route-handler-imports` |
| **A bare threshold literal in a route** | lint — `sortiva/no-threshold-literals` |

Also verified rather than assumed:

- **`pnpm lint:prove` does what it claims.** All seven planted violations are rejected. The
  planted cases are honest, not strawmen — they are the canonical shape of each mistake.
  Its gap is what it does *not* plant: the four escapes in findings 5 and 6 above, and
  the route-handler rule, which has no planted case at all (I confirmed by hand that the
  rule itself works).
- **The crash-recovery suite refuses to skip.** Unlike the ordinary database suites, it
  throws if Postgres is missing. It runs nightly, not per merge, and currently contains one
  real scenario (plus an empty placeholder) — a real one: it spawns a child process, lets
  it commit two pages of progress, has it kill itself outright, and asserts the work
  resumes at page three. That is the right shape of test.
- **An audit claim I re-checked and found held.** The T0.5 audit reported that the AI test
  double diverged from the real client on caching and cost. That has been fixed — the
  double now takes the same cache, telemetry and cost ledger. A test using it is now
  testing something production shares.
- **An audit claim I re-checked and found only half fixed.** The T1.2 audit's "the
  single-writer rule is enforced by nothing" is now enforced — but see finding 4 for the
  escape that remains.

---

# Suggested order of work

Cheap and high value, roughly in order:

1. Make the fingerprint test real (finding 1) — half an hour, and it protects the money.
2. Add the customer-column test (finding 2) — half an hour, and it protects the GDPR claim.
3. Unique per-run database names and a leaked-worker check (finding 3) — one file; without
   it, every other test result is provisional.
4. Add `api.anthropic.com` to the banned-host list and `dbPool` to the banned-names list
   (finding 5) — two lines, both closing holes that exist in committed code today.
5. The rest are one-line-to-one-function changes and can ride with the cards that touch
   those areas.
