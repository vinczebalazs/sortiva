# Kick-off prompt — remediation Phase A3 and Phase B

Written 2026-09-24. **Replaces `docs/handoff-next.md` for this run.** That document described a build adding features; this one describes a build fixing what the features got wrong.

The founder has taken every decision this scope needs. They are written out below so the session does not have to ask. Paste everything below the line into a fresh session.

---

You are working on the Sortiva project, in `/Users/balazs/Desktop/sortiva`. You are fixing confirmed defects, not building features. The founder is away. Work through the cards in order and do not wait for answers you already have.

## Read these first, in this order

1. **`CLAUDE.md`** — the constitution. It overrides your defaults. One task card per session's worth of work, the spec sections a card cites get read verbatim before you write code, and every choice the specs do not dictate goes in `DECISIONS.md` immediately.
2. **`docs/remediation-plan.md`** — §1 for the true state of the product, §4 Phase B for your cards, §5 for the full defect ledger. Several things you would assume from the repo are false and §1.2 lists them.
3. **`docs/agent-work-plan.md`** §3 for lane ownership, §6 for the card format.

## Where things stand

`main` is at `5e632f8`, clean, pushed, and it is the only branch. The full gate is green: lint, lint proofs, typecheck, 349 test files and 4,661 tests, contracts at 63 routes, build, both smoke checks, chaos ten of ten, environment check, stub report, and migrations against a fresh database.

The `shopify-hardening` branch was merged on 2026-09-24. It replaced REST with GraphQL, added token renewal, and closed thirteen defects. Do not go looking for it; it is in `main`'s history.

**The product has never been used by a real merchant.** The tests pass because every unit is tested with its neighbours replaced by stand-ins. Every defect you are about to fix is at a join.

## The one thing to internalise

Every defect in the ledger is a **liveness** bug and every test in the suite is a **safety** test. Safety is "when this runs it does the right thing". Liveness is "this runs at all". A retry is stamped and nothing fires it. A job is registered and nothing enqueues it. A route answers a code and no screen branches on it.

So: **write every done-when from outside the unit you are changing.** Not "the function computes the right backoff" but "an onboarding run that fails once finishes without anyone touching it". If your test only proves the unit is correct, you have reproduced the bug you were sent to fix.

A related warning from the last integrator, which the September bug hunt confirmed seven times over: the mechanism that tells you something is finished is often the broken thing, and it always fails reassuringly. When a check reports success, confirm it did the work.

## Decisions already taken — do not re-open these

| # | Question | The founder's answer |
|---|---|---|
| 1 | How does a stalled onboarding run resume? | A scheduled sweep, not a delayed re-enqueue |
| 2 | Where does a signed-out visitor to an app screen go? | Redirect from the app layout to sign-in |
| 3 | The Railway start command | Fix it now by passing the application directory. Deployment will not be run yet |
| 4 | Where does the Search Console picker live? | Carry the destination in the signed OAuth state, restricted to an allowlist of the two known screens |
| 5 | Where does sign-in land? | Branch on the local subscription status. Returning subscribers go to the dashboard. Checkout refuses an active subscriber with a machine-readable code and no billing-portal link |
| 6 | May prompts change if an eval set fails? | Yes, when the scores show the change is better. Gold cases and thresholds stay untouched |

## Your scope

Phase A3, then the seven Phase B cards. Nothing else. If you finish early, stop and report rather than starting Phase C.

### A3 — Re-confirm eleven findings before carding them

`docs/remediation-plan.md` §5.3 marks eleven findings **`branch-touched`**. They were confirmed against `main` before the Shopify merge and the code around them has moved. Open each, decide whether it still reproduces, and record the answer. Do not fix them; they are not in this scope. A short list of "still real" and "now fixed" is the deliverable.

### B1 — A stalled onboarding run resumes by itself · Lane B

When an ingestion step fails a retryable way the runtime stamps `next_attempt_at` on the `job_steps` row, and `dispatchableSteps` will offer that step again once the time passes. Nothing ever asks. The only callers of the dispatcher are the domain-claim route and the Shopify OAuth callback, so a merchant whose first step fails sits on "we'll retry automatically" for ever.

Build the sweep. Migration `0000` already creates `job_steps_dispatch_idx` on `(state, next_attempt_at)` for a query nothing has ever run; that index is what it was for. Follow the shape of `signal_scan_onboarding_sweep` and `publish_intent_recovery_sweep`, which are the same idea on a five-minute schedule.

The dead-letter replay path has the same hole: it resets a step to pending and nothing dispatches it. The sweep should cover both.

*Done when:* a run whose first step fails once completes without anyone touching it, and a replayed dead-letter entry runs.

*Added by the session that wrote this plan, strike it if the founder disagrees:* also add a test that enumerates every registered task name and asserts each one is either on the crontab or has a call site that enqueues it. Three defects in the ledger are jobs nothing enqueues. It is about thirty lines and it closes that class.

### B2 — Detection survives a large home page · Lane B

Platform detection reads the whole body looking for two Shopify markers, and the shared fetcher rejects a response over its cap rather than truncating, so a big storefront fails and dead-letters. Reproduced: `allbirds.com` fails, `gymshark.com` works.

This one is settled by the specs, so do not treat it as a choice. Detection passes its own `maxBytes: 600_000`. tech §2 says the single fetcher uses the same budget as the preview endpoint, and main §3.2 puts that at about 1.5 MB, which is also the fetcher's own default and what the preview passes. The 600 KB is an undocumented tightening with no journal entry. Restore it to the documented budget.

Also: the underlying cause is dropped when the failure is wrapped, so an operator sees only "could not read". Keep the cause.

*Done when:* detection succeeds against a home page over the old cap, and the log carries the original reason.

### B3 — The public preview stops answering 500 · Lane A

The preview builds a file URL from the module's own address, which the bundler rewrites into a static asset path with no disk behind it. `packages/llm/src/prompts.ts` already solved this by composing the path instead, and your own journal recommended the switch on 2026-09-01.

Nothing blocks it. The rule that limits what the preview may import constrains only files under `packages/core/src/preview/`, and this config file already deep-imports the LLM package for its client.

One thing not to skip: the loader reads from the repository tree at call time, and `next.config.mjs` lists the rules config under output file tracing but not the prompts directory. Harmless today because the deploy runs from the tree. Note it in `DECISIONS.md` so it is not a surprise the day anyone turns on standalone output.

*Done when:* a preview request returns a card, and the boot smoke check exercises the preview route rather than only the landing page and the health check.

### B4 — A signed-out visitor cannot see the app · Lane F

Signed out, every app screen renders, and the dashboard offers a working "Connect your domain" form that fails with an unexplained 401 when submitted. The shell turns the 401 from the account route into an unknown account and renders the frame around it.

Redirect from the app layout to sign-in. Do not add a `middleware.ts`; the 2026-08-31 decision explains why there is exactly one place that resolves an account, and this is not a reason to add a second.

Note the product's sign-out sends people to the landing page rather than to sign-in. That is deliberate and stays as it is; you are only changing what happens to someone who never signed in.

*Done when:* an unauthenticated request to any route under the app group lands on sign-in, and a test covers it.

### B5 — The production start command points at a build · Lane G

`railway.toml` runs Next from the repository root while the build output is in `apps/web`, so the server would exit rather than start. Pass the application directory to `next start`. Do not set the service's working directory instead: that would also move the working directory for the migration that runs before deploy and for the on-disk rules config.

This cannot be verified without deploying and the founder is not deploying yet. Say so in the card and in `DECISIONS.md` rather than claiming it works.

**Do not remove `NEXT_MANUAL_SIG_HANDLE=1` from those lines.** The comment beside it is correct and load-bearing; the journal entry that calls it unapplied is stale.

*Done when:* the command names a directory that contains a build, and the limits of that claim are written down.

### B6 — Search Console can actually be connected · Lane C

The merchant grants Google access and lands on Settings, which shows a "connected" message and no picker. So no property is ever chosen, no history import is queued, and the account stays in Limited Intelligence while the screen says it worked. The picker component exists and works; the only screen that mounts it is the dashboard, which the callback never returns to, so that mount has never fired.

Carry the return destination in the signed OAuth state, restricted to an allowlist of the two known screens. Do not accept an arbitrary path: even a forged state must only be able to choose between two safe values. Then mount the picker on the Connections screen too, because ui §9.3 names it there, and main §6.7 says connecting later from Settings, the dashboard nudge or the Limited Intelligence badge all trigger the same backfill.

*Done when:* a merchant who starts from onboarding finishes on the dashboard with a property stored, a merchant who starts from Settings finishes on Settings with a property stored, and the history import is queued in both cases.

### B7 — Sign-in lands somewhere sensible · Lane A

Sign-in always lands on the plan page, which reads no session, so a merchant who has paid for months is shown a live Subscribe button. Checkout also carries no entitlement check and will happily sell a second subscription.

main §4.2 gives the flow for a new customer and the plan screen is correct for them. Branch on the local subscription status: not active goes to the plan screen, active goes to the dashboard. Read the status from our own table, never from the vendor, which invariant 16 requires anyway.

Make checkout refuse an active subscriber with a machine-readable code, and let the screen render the message. Do not add a billing-portal link. Billing may move to Shopify, and a Stripe portal handoff would be work with a short life.

Decide what a past-due account sees and write the reasoning in `DECISIONS.md`. Entitlement is off for them, but the dunning copy lives on the dashboard banner rather than the plan screen.

*Done when:* a subscriber signing in reaches the dashboard, a merchant with no subscription reaches the plan screen, and checkout refuses an active subscriber with a code the screen handles.

## The eval suite

`pnpm eval` has never run in this project's history. It grades what gets written into merchants' stores: fifty distillation cases, twenty judge cases, ten persona cases, one real model call each. The key in `.env` works. Run it once, early, so its result is known before anything else changes.

Three rules, and two of them are not mine:

- **Gold cases are append-only.** main §14.2 says eval sets are append-only and production failures get minimised and added as regression cases. Never edit or delete a case to make a set green. Nothing in CI enforces this, which is exactly why it matters.
- **Thresholds are spec text, not config.** All six pass marks are written in main §14.2. Lowering one is amending the spec, which is the founder's call.
- **Prompts may change, when the scores say so.** The founder has authorised this. A prompt change must be a **new version file**, never an edit in place, because the version stamped on an article a year ago has to keep meaning what it said. Record the before and after scores in `DECISIONS.md`. If a change does not improve the score, it does not land.

Report the scores whatever happens.

## How you work

**Git.** One commit per card, in the repository's style: a title that says what changed in words, a body that explains why in plain language, no spec section lists. Push as you go. End every commit message with the co-author line the session gives you.

**The gate.** Eleven commands, one at a time, never chained. `pnpm test` and `pnpm lint:prove` share a fixture and must not run together.

```
lint · lint:prove · typecheck · test · contracts:check · build · smoke:boot · smoke:dev · chaos · env:check · stubs:report
```

Plus `db:migrate` against a freshly created empty database whenever migrations change, and `pnpm build` again after `smoke:dev`, which replaces the production build. If Postgres is unreachable, `pnpm db:up`; if Docker is not running, start it.

**Schema.** Migrations land only in schema-wave cards. If a card needs a column, write a `DECISIONS.md` entry and stop; do not add a migration.

**When you are blocked.** The founder is away and the six decisions above are all you get. If a card turns out to need a seventh, write the question into `DECISIONS.md` in plain terms, skip that card, and move to the next one. Do not stop the session, and do not guess at a user-visible behaviour nobody chose.

**Run the product.** After each card, start the app and walk the journey that card touched. Three of the criticals in the ledger were found in the first twenty minutes of doing that, and none by the gate. `scripts/dev.mjs` starts it with the repository's environment. To sign in without Google, insert a `sessions` row whose `session_token` is the SHA-256 hex digest of your cookie value, then send `authjs.session-token=<the plain value>`.

**Your report.** For each card: what externally visible behaviour changed, why the old behaviour was not enough, the two or three things most worth scrutinising, and anything you left out. For A3: which of the eleven still reproduce. For the eval run: the scores. Written for someone who has not read the code.
