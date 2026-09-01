# Wave 1, second handoff — the integration is now the work

> **Superseded by `handoff-wave2.md`.** The integration this document calls for
> has happened: everything is merged to `main`, 883 tests pass, and nothing is in
> flight. Kept for the history of wave 1. Work from `handoff-wave2.md`.

Written for the founder, who assigns the work, and for the session that picks it up.
Read this instead of asking anyone what happened; nothing here needs chat history.

The previous handoff (`handoff-wave1.md`) started wave 1. This one covers what
happened, what is half-finished, and what has to happen before anything new starts.

---

## The short version

**Twelve cards landed. Nothing is merged. That is now the problem.**

There are eleven branches and `main` has not moved since the wave began. Two
branches added database migrations independently. Four merge conflicts have already
been resolved by hand, each one a chance to have silently dropped something.

**Do the integration before starting another feature card.** Everything else in this
document is downstream of that.

---

## What exists now that did not before

Plain language, because none of it is visible from the outside yet.

- **A merchant can sign in, and a request cannot read another account's rows.** One
  function turns a session into an account identity, and the database layer refuses
  to run a query without the value only that function can mint. A route handler
  *cannot* look up rows using an id it read from a URL. A test walks every route file
  and fails if a new one skips it.
- **Billing works end to end against a fake Stripe** — checkout, the customer portal,
  payment failure pausing generation, cancellation at period end, and read access that
  is never revoked whatever the billing state.
- **The public preview works**, including the single SSRF-guarded fetcher that four
  later cards will reuse. That guard has 89 tests of its own against real HTTP servers
  and real DNS: redirects to private addresses, hostnames that resolve privately,
  decimal and hex spellings of loopback, and rebinding between check and connect.
- **Forty-odd database tables**, with the rules the product depends on enforced by the
  database rather than by code remembering: at most five competitors per account, one
  open opportunity per signal, no column anywhere that could hold a sentence written
  by an AI.
- **Background work survives a deploy.** Before, a step interrupted by the process
  dying stayed marked "running" forever and the merchant's onboarding silently
  stopped. Now it is reclaimed and resumes from its last checkpoint.
- **Money is written down.** Every call to a paid vendor records what it cost — on
  success, and on every failure path that reaches the vendor — to our own database,
  which is the only place the spending caps are allowed to read from.
- **Billing survives a misconfigured key and a same-second race.** Two failures that
  would each have cost real merchants their access are closed: a merchant paying while
  our Stripe keys point at the wrong world used to leave no record and no repair path,
  and two Stripe messages stamped in the same second used to be ordered by the
  alphabetical accident of a random id — so a stale "not active" could beat the "active"
  beside it and lock out someone who had just paid.
- **The pipeline logs per store.** Every step writes a line naming the account, job,
  step and attempt. Before this, no log line anywhere identified a store.
- **A merchant can claim their domain, and only one account can hold it.** Whatever
  they paste is reduced to the shortest name a business can own, so nobody becomes two
  accounts by connecting `shop.` and `blog.` separately — with Shopify's own
  `*.myshopify.com` as the deliberate exception, since two shops there are two
  businesses. Eight simultaneous claims on one domain leave exactly one row.

## What still does not exist

- **Any user interface at all.** The only `.tsx` files in the repo are Next.js's
  default scaffolding. `packages/ui` holds nothing but the mock API server.
- **`packages/ui/strings`**, where the constitution says all user-facing copy lives.
  Three cards have now had to park copy elsewhere because it does not exist.
- **Any product analytics event.** The road is built — the application now constructs
  one analytics client at startup and an event was proved to travel over HTTP and arrive.
  But roughly thirty events are described in the spec and none is reachable in a running
  app, because nothing yet reaches the code that would emit them.
- **Any deployment.** Nothing has ever been deployed from this repository.

---

## The branch situation

```
main ─┬─ lane-a          T1.1 T1.2 T1.3 T1.4       (M1 complete)
      ├─ lane-b          T2.0                    (T2.1 now unblocked)
      │   ├─ schema-2b   T2.0b
      │   │   ├─ fix-ledger    + R1 → R3
      │   │   │   └─ fix-wiring    + R2 → R4
      │   │   │       └─ fix-analytics   + R5
      │   │   └─ schema-2c     + T1.2 → T1.2a
      │   └─ fix-cost    R2
      ├─ fix-runtime     R1
      └─ lane-f          (empty — the design only arrived at the end)
```

`fix-wiring` is the most current infrastructure: it contains R1 through R4.
`fix-ledger` and `fix-cost` are ancestors of it and need no separate merge.

**Every session has landed. Nothing is in flight.** Twelve cards are committed across
the branches and none of them is on `main`.

One item is finished except for its last fifteen lines: **the plan endpoint answers 503**.
The route, its contract, its caching and its failure behaviour are built and tested, but
the call that asks Stripe for current prices has to live in `packages/providers` — the only
package allowed to touch the Stripe SDK — and that package was held by another session.
`T1.2a` declared the method optional so everything still compiles, which means its absence
is a runtime 503 rather than a compile error. **This blocks Lane F's plan screen**, and it
is roughly fifteen lines on two classes.

## Two migration streams that must not collide

`schema-2c` and the branches under `schema-2b` both add migrations. They were
numbered independently. **Check the numbering and the migration journal before
merging them**, and run `pnpm db:migrate` against a freshly created empty database
afterwards — not against your existing one, which already has the tables and will
happily report success on a broken chain.

---

## What to do next, in order

1. **Merge to `main` in dependency order**, resolving conflicts deliberately:
   `lane-b` → `schema-2b` → `fix-wiring` → `schema-2c` → `lane-a` → `fix-analytics`.
   Expect conflicts in `DECISIONS.md` (every card appends to the top — keep both
   sides), `scripts/prove-lint.mjs` (several cards add planted violations — keep all
   of them), and `apps/web/instrumentation.ts`.
2. **Run the whole gate on the merged tree**, each command separately:
   `pnpm lint`, `pnpm lint:prove`, `pnpm typecheck`, `pnpm test`, `pnpm contracts:check`,
   `pnpm build`, `pnpm eval`, `pnpm chaos`, and `pnpm db:migrate` on an empty database.
   `pnpm lint:prove` matters most — it is the check that proves the other checks work.
3. **Run the M1 exit gate** (`T1.4`) against the merged tree, not against `lane-a`
   alone.
4. **Triage `DECISIONS.md`.** It has grown past a hundred entries. Every one gets
   classified: fine as-is, promote into the spec, or contradicts the spec. Entries in
   the third class block the next wave.
5. **`T2.1` is now unblocked** — the one hard dependency of the wave. Read the warning
   below before starting it.
6. **Then start Lane F.** The design finally arrived and is in
   `docs/design/` — sixteen screens with a full token set. `T9.1` is the app shell,
   the navigation, and `packages/ui/strings`.

---

## The catch that mattered most this wave

`T1.2a` split one overloaded database column in two. Before writing the migration it
built a database at the *old* schema, inserted a subscription the way an existing customer
would have one, applied its own migration, and checked what happened. Without the backfill
line it then added, the new column would have defaulted to the present moment for every
existing row — **and every paying customer would have frozen out of the product at once,
on deploy, silently.** It found that by testing the upgrade path rather than the end state.

That is worth knowing as a standard: a migration that passes on an empty database has not
been tested. Ask for the before-and-after.

## The finding that outranks the rest

**Every deploy is cutting short the graceful shutdown — and that is not an analytics
problem, it is the resumability of the whole pipeline.**

`R5` measured it while wiring the analytics flush. On a termination signal the log shows
"draining in-flight jobs" and then the process is simply gone; the line that says it
drained cleanly never appears. The web framework exits before our own shutdown handler
finishes. So the work `R1` did — giving a long step the chance to save its position inside
the deploy's grace period — is being truncated in exactly the situation it was built for.
The stranded-step reclaim still catches it afterwards, so nothing is lost; it just means
every deploy takes the expensive path instead of the clean one.

The fix is one environment variable that hands shutdown to our own handler. The risk is
that shutdown then depends entirely on that handler registering, and a container that
ignores the signal gets killed by the platform instead. **This needs a decision, and it
should be made before the first deploy rather than after.**

## Two traps `T1.4` left behind, deliberately and flagged

**A claimed domain sits at "Detecting platform" until `T2.1` ships, and `T2.1` must not
create its own onboarding run.** The claim writes the durable record — the run and its
nine steps, first one waiting — but pushes nothing onto the background queue, because
the code that detects a store's platform does not exist yet and queueing work naming a
handler nobody wrote would create a permanently failing job. **`T2.1` must dispatch from
those existing rows.** If it creates a run of its own instead, every merchant gets two
onboardings.

**`packages/db`'s `claimDomain` is now dead code with weaker guarantees than the live
path**, because `packages/db` was held by another session when `T1.4` was written. The
integrator must **replace** it, not park the new one beside it — two claim functions with
different guarantees is how the wrong one gets called. The shape needed is exactly what
the new port declares: insert-with-conflict, read the conflicting row back inside the same
transaction, return which of the four outcomes happened, and create the ingestion run in
that transaction.

---

## Rules that changed during this wave

Both are in `CLAUDE.md` already; they are called out because sessions that learned
the old rules will reinstate them.

- **No spec citations in code or commit messages.** The build is the source of truth.
  A comment says what the code cannot show, in plain language — `§14.3.6` is not an
  explanation, "so a crash after the vendor answered doesn't make us pay twice" is.
  Deviations from a spec go in `DECISIONS.md` and the session report, never a comment.
  About 726 existing citations remain; a sweep card removes them **after** integration,
  when there is one tree instead of eleven branches.
- **Audits compare against the spec *plus* the recorded decisions.** Otherwise an
  auditor reports deliberate build decisions as defects.

## Session mechanics, learned the hard way

- **Two or three concurrent sessions, never five.** Five sessions each running the
  full test suite saturated a 12-core machine (load average 18) and all five stalled
  simultaneously. Check `uptime` before launching another.
- **Run gate commands one at a time, never chained with `&&`.** A stall then costs one
  command's progress instead of six.
- **Commit as soon as the work is green, before writing the report.** Two sessions died
  in exactly that gap.
- **Never put two sessions in one worktree**, even when one is read-only. It was done
  once here and the auditor noticed files changing under it.

---

## Open decisions

Nothing below blocks the integration. Each is recorded in full in
`docs/audits/remediation.md`.

**Needs a founder answer**

- **The DataForSEO prices are guesses**, marked as such in the code. The daily spending
  cap is wrong in exactly the proportion the prices are. Needs someone with a vendor
  account, not a code change.
- **Do the spending caps count failed vendor calls?** Failed calls are now recorded,
  priced as estimates. DataForSEO very likely does not bill for a request it rejected,
  so those rows probably over-count — and an over-counting meter pauses the product for
  money that never left. The ledger stores an outcome per row so this can be decided
  later; it has not been decided.
- **Are job rows wanted as an audit trail?** A guard forbidding their deletion was
  deliberately removed once the completed-work record moved to its own table. If those
  rows are wanted for a different reason, that requirement is now unguarded.
- **Ratify an invented refusal.** An account that already holds a different domain is
  refused with a message `T1.4` wrote itself — the spec covers "someone else has it" and
  is silent on this case, which the intended screens never reach. If the real answer is
  "there should be a self-serve way to change your connected domain", that is a different
  card and this refusal is a placeholder.
- **Close the one route by which product content could reach analytics.** An event's
  properties currently accept any value, so nothing structurally prevents a future card
  putting article text or a prompt into one — which the constitution forbids. The type
  sits in a contract frozen for all lanes, so narrowing it is an integrator decision, not
  a card's.
- **Vendor credentials.** Still none. Stripe, Turnstile, Anthropic and PostHog work
  are all built and tested against fakes, with the real-vendor evidence recorded as
  outstanding rather than claimed. Three cards will need re-running against real keys.

**For the spec keepers**

- **The spec's own status list is now wrong.** `T1.2a` added a fifth subscription status
  because storing "card still being authorised" as "gave up" was corrupting the signup
  funnel — but main §4.2 and §13 both enumerate exactly four and neither lists it. The
  session flagged the contradiction rather than diverging quietly. Both enumerations need
  editing to match the build.

**Requested for the next schema wave**

- **A partial uniqueness rule so the seven-day domain release is real.** Today the release
  depends on a cleanup job running: if that sweep never runs, the domain stays blocked
  forever. That fails safe — nobody is handed someone else's domain — but it does not
  deliver the promise. The same problem applies to a revoked Shopify connection, which
  still blocks that shop from being connected by anyone else.

**Small, and waiting on a word**

- One line in the web config so prompt files survive a switch to standalone output.
- Whether the API route table's `spec:` data field is removed with the comment sweep —
  it is machine-read, and the generated API document feeds Lane F's mocks, so removing
  it may be a contract change.

**Already answered this wave** — recorded so nobody reopens them: the spend ledger
lands in schema wave 2; failure paths record cost; stranded steps are reclaimed; the
account-scoping lint rule ships as a stopgap with the durable fix later; per-store
logging goes in the worker runtime; email sign-in and the idempotency ledger ride a
mini-wave; the ordering race is fixed by re-reading from Stripe; the plan screen gets
its own endpoint and the contract is re-frozen; analytics gets wired now; preview spend
is attributed to the registrable domain so it joins to the account that later signs up.

---

## Where the audits are

`docs/audits/` holds five reports and the remediation record. Every finding has a
file and line reference. `remediation.md` is the integrator's log of what was decided
and which card owns it — read that first; it is the index to the rest.

Three cold audits of the foundation cards found two blockers and twelve majors, all
now fixed. A fourth audited billing and found a path where a merchant could pay and
never be granted access, with nothing repairing it. That fix was in flight at handoff.
