# DECISIONS.md — Implementation Decision Journal

Every choice the specs don't dictate gets an entry, written at the moment of the decision (not at task close-out). Audits reconcile this file against the specs periodically; entries may be promoted into the specs or flagged as contradictions.

Format:

```
## <date> — <task ID> — <one-line decision>
Decision: <what was chosen>
Why: <rationale, incl. alternatives considered if any>
Nearest spec: <the section closest to this gap, e.g. "main §7.4 — silent on X">
Class (filled by audit): a: fine as-is | b: promote to spec | c: contradicts spec
```

---

(entries below, newest first)

## 2026-09-01 — R5 — FLAGGED, not fixed: `next start` kills the process before the drain finishes, so the shutdown flush cannot complete in production
Decision: the flush is wired (worker drain, plus a fallback when the worker is off) and proved in test, but **not** made effective in the deployed process, because the remedy is a deploy-config change outside this card: Next.js installs its own `SIGTERM`/`SIGINT` handler that exits immediately, and it only stands aside when the process is started with `NEXT_MANUAL_SIG_HANDLE=1`. Recommended fix, one line: add it to `railway.toml`'s `startCommand` (both entries), or set it as a Railway variable.
Why: measured, not assumed. Starting the built app and sending SIGTERM logs `[worker] SIGTERM received, draining in-flight jobs` and then the process is gone — no `[worker] drained cleanly`. The identical run with `NEXT_MANUAL_SIG_HANDLE=1` logs both and exits 0 through our own handler. **This is bigger than analytics**: the same race truncates Graphile's graceful drain, so tech §2.1's "the worker drains gracefully, and anything that doesn't finish resumes idempotently" and main §14.3.4's checkpoint-on-shutdown are also being cut short on every deploy — a step is stranded in `running` and waits for the lease sweep instead of stopping cleanly. Not taken unilaterally because it hands the whole process's shutdown to our handler: if `instrumentation.ts` ever fails to register one, the container stops responding to SIGTERM and waits for the platform's hard kill. That is a deployment-behaviour decision with a failure mode, not an implementation detail.
Nearest spec: tech §2.1 — "Railway sends SIGTERM with a grace period on deploy; Graphile Worker drains gracefully"; main §14.3.4; main §14.7.

## 2026-09-01 — R5 — Shared services come from a composition root at the process entry point, not from a global anyone can reach
Decision: `apps/web/instrumentation.ts` — the one startup hook Next runs per server process — is the composition root: it is the only place that names concrete adapters (`new PosthogServerCapture()`) and builds them. The bundle lives in a new module `packages/core/src/runtime/services.ts` (`AppServices`, `initAppServices`, `appServices`, `resetAppServices`), whose fields are **ports only**, so `packages/core` still imports no provider SDK. `initAppServices` takes a factory and memoises it, so the factory runs at most once per process. The module is deliberately **not** re-exported from the `@sortiva/core` barrel: it has to be asked for by name (`@sortiva/core/runtime/services`). Anything constructed with `new` keeps taking its ports as required constructor arguments — the registry is for code a framework calls (route handlers, Graphile task handlers), which no caller of ours can hand anything to.
Why: The card's real question is what every later call site copies. A bare module-level singleton (`getPosthog()`) is the quickest to type and makes ambient telemetry reachable from any domain function, which is how "capture" becomes "capture whatever is in scope" — and invariant 26 says events carry ids and aggregates only. Full constructor injection everywhere is the right default but cannot reach framework-invoked entry points. So: injection is the rule, the registry is the boundary exception, and it is kept awkward on purpose — out of the barrel, one import path, greppable in review. Memoising the factory rather than a `set`-then-`get` pair is what makes "one client per process" structural: two PostHog clients means two in-memory batches and a shutdown that flushes one of them, which is a data-loss bug that looks like nothing at all. `route-handler-imports` already permits `@sortiva/core/...`, so route handlers need no lint change.
Nearest spec: main §14.7 — requires server-side capture; silent on process wiring. tech §2.1 — one Node process runs both the server and the worker.

## 2026-09-01 — R5 — `bootstrapWorker` requires an analytics client, the way the paid wrappers require a cost ledger
Decision: `BootstrapOptions.analytics` is required, not optional. A caller that genuinely wants no telemetry passes `UnrecordedCapture`, the same named opt-out `AnthropicLlmClient` and `DataForSeoProvider` take for their recorders. Two further options, `signals` and `exit`, are test seams so a real drain can be driven without killing the test runner.
Why: R4's precedent (a required constructor argument with an explicitly-named opt-out) exists because an optional recorder is silently forgettable, and forgetting it is invisible — the exact failure this card is repairing. The day the worker splits into its own Railway service (tech §2.1: a start-command change on the same image), that second entry point will be written by someone who has not read this card; a required argument makes them decide, and `UnrecordedCapture` makes "no telemetry" a visible choice in the code rather than an omission.
Nearest spec: main §14.7; `docs/audits/T0.5.md` finding 6 (optional-and-silent recorders).

## 2026-09-01 — R5 — The shutdown flush belongs to the worker's drain, with a fallback handler when the worker is off
Decision: `bootstrapWorker` fills `installSignalHandlers`' previously-empty `onStopped` hook with `flushAnalytics(analytics)` — after in-flight jobs drain, so events emitted during the drain go too. A flush failure is logged, never raised. When the worker does not start (`WORKER_ENABLED=false`, and a web-only service if the worker ever splits), `instrumentation.ts` registers its own `SIGTERM`/`SIGINT` handler that flushes and then exits 0.
Why: PostHog batches and sends in the background, so the last seconds of events before every deploy live only in memory (`docs/audits/T0.5.md`, remediation D10's fourth item). Ordering matters: flushing when the signal arrives rather than when the drain finishes would drop whatever a draining step emits. Raising on a failed flush would turn a clean drain into a failed one and cost in-flight work, which is the opposite of what tech §2.1's grace period is for. The fallback exits explicitly because a process that registers a `SIGTERM` listener no longer dies by default — an added listener that only flushed could hang a deploy. Known cost: with the worker off, our handler and Next's own shutdown run concurrently, so the exit may be marginally earlier than Next's; in the v1 single-service topology that path only runs in local development.
Nearest spec: tech §2.1 — "Railway sends SIGTERM with a grace period on deploy"; main §14.7.

## 2026-09-01 — R5 — Delivery is proved against a local HTTP endpoint; **NOT proven** against PostHog itself
Decision: `packages/jobs/src/runtime/analytics.test.ts` stands up a real `node:http` server, points a real `PosthogServerCapture` at it, captures through an existing call site, asserts nothing has arrived while the event is still batched, then flushes and asserts the received body. A second case does the same through the real `bootstrapWorker` and a real termination signal. No PostHog credentials exist (`.env` has no key), so what remains unproven is that PostHog's own ingest accepts the payload, that the project key and host in production are right, and that events appear in the project.
Why: The failure this card exists to fix is a well-tested class with no caller, so "the capture function was called" is worthless evidence here — it was true throughout. The weaker substitute (mocking `fetch`, or asserting on the mock double) would repeat the mistake. Recording the remaining gap rather than claiming it: the first real deploy with a key set is what closes it, and `stub_used` appearing in the project is the check.
Nearest spec: main §14.7 — everything observable is a PostHog event; tech §5 — CI runs real integration tests.

## 2026-09-01 — R5 — `packages/jobs` takes a test-only dependency on `packages/providers`
Decision: `@sortiva/providers` is added to `packages/jobs`' **devDependencies**, for the delivery test above. Production code in `packages/jobs` still imports only `@sortiva/core`, `@sortiva/db` and `@sortiva/rules`, and the analytics client arrives as an argument.
Why: Same reasoning R4 recorded for `packages/db`: only a test spanning entry point → real client → wire can notice that three correct pieces are not connected. The alternative — testing delivery inside `packages/providers`, which cannot import the worker — would have proved the client works and left the wiring untested, which is the failure mode being repaired.
Nearest spec: CLAUDE.md code-structure rules; tech §5.

## 2026-09-01 — R5 — FLAGGED, not fixed: an event's `properties` are `Record<string, unknown>`, which is the one easy route to putting product content in an event
Decision: left as it is. This card added no new route to content — it hands out the same `PosthogCapture` port, through the same scrubber — but the port's property type accepts any value, so a future call site can pass an article draft, a prompt or a fact sheet and nothing complains. Recommended fix, for whoever owns the frozen contracts: narrow the property value type to primitives (`string | number | boolean | null`), which admits every property main §14.7 names and rejects the shapes product content arrives in.
Why: invariant 26 says events carry identifiers, counts, costs and flags only; the scrubber (tech §4) redacts credentials, not product text, so today the rule is upheld by review alone. Narrowing the type is a one-line change to `packages/core/src/contracts/analytics.ts` that every lane's future call sites inherit, and `T0.7` froze that contract — changing it is the integrator's call, not this card's.
Nearest spec: main §14.7 privacy note; CLAUDE.md invariant 26.

## 2026-09-01 — R4 — `spend_events` is written by `PostgresCostLedger`, and the row's account comes from the scope
Decision: `packages/db/src/spend.ts` implements the `CostLedger` port over the `spend_events` table, delegating to `appendSpendEvent()` in `packages/db/src/repositories/spend.ts`. The repository takes `AccountScope | SystemScope` and writes `account_id` **from the scope**, not from a caller-supplied field; preview rows take a `SystemScope` and carry `preview_target` instead. `PostgresCostLedger` picks between the two using `spendAttribution()`, the mapping function R2 shipped.
Why: A scope parameter that only sits beside the columns is decoration — the repository would type-check with an `account_id` that disagreed with the scope it was called under. Deriving the column from the scope makes the branded type load-bearing, and leaves the table's `spend_events_attribution_ck` constraint as the thing that guarantees every dollar is attributable to exactly one of an account or a preview target. The alternative — two functions, one per attribution case — duplicates the insert for no extra safety.
Nearest spec: main §14.5, §14.7 (the counter the caps read); CLAUDE.md code-structure rules (every repository method takes a scope).

## 2026-09-01 — R4 — `usd_cost` is written as a fixed-scale decimal string, never JavaScript's default
Decision: `appendSpendEvent` sends `usdCost.toFixed(8)`, matching the column's `numeric(14, 8)`.
Why: `numeric` crosses the wire as a string, and `Number.prototype.toString()` switches to exponent notation below 1e-6 — a judge call costing 0.0000004 would be sent as `"4e-7"`. Postgres does accept that, but the two spellings are different literals for the same number, and a fixed scale is what the column stores anyway. Rounding is the database's behaviour either way; doing it in one place makes it visible.
Nearest spec: main §14.7 — silent on representation.

## 2026-09-01 — R4 — The ledger is proved end-to-end from `packages/db`, which takes a test-only dependency on `packages/providers`
Decision: `packages/db/src/spend.test.ts` drives the real `DataForSeoProvider` (with a stubbed `fetch`) against a real Postgres, on a success path and on a vendor-error path, and asserts the rows. `@sortiva/providers` is added to `packages/db`'s **devDependencies** for it.
Why: The failure this card fixes was not in any one file — the port, the wrappers and the table were all correct and simply not connected, and every unit test passed throughout. Only a test spanning wrapper → adapter → table can notice that again. Putting it in `packages/db` keeps it beside the real-database harness; the dependency is test-only and does not exist at runtime (`packages/db` production code imports only `@sortiva/core`).
Nearest spec: tech §5 — CI runs integration tests against a real Postgres; silent on which package owns a cross-package test.

## 2026-09-01 — R4 — The `CostLedger` port moved to `packages/core/src/contracts`; `packages/llm` keeps `@sortiva/providers` as a devDependency only
Decision: `CostLedger`, `SpendEvent`, `spendAttribution`, `spendEventViolation`, `recordSpend`, `UnrecordedSpend` and `InMemoryCostLedger` now live in `packages/core/src/contracts/spend.ts` and are exported from `@sortiva/core`, resolving the contradiction R2 flagged. `@sortiva/providers` moves out of `packages/llm`'s runtime dependencies — but stays as a devDependency, because `client.test.ts` uses `MockPosthogCapture` and `UnrecordedCapture`, which are analytics test doubles that live in the providers package.
Why: The layering rule (DECISIONS 2026-08-31 T0.5) exists so the AI package and the vendor package need not depend on each other; that is now true of shipped code. Moving the PostHog doubles into core as well would be a second move this card was not asked for, and it is the same question for every provider double, so it belongs to whoever decides that once.
Nearest spec: CLAUDE.md code-structure rules; `docs/audits/remediation.md` D10 item 2.

## 2026-09-01 — R4 — The raw-table lint rule derives its list from the schema, and refuses to run on a list it cannot trust
Decision: `no-raw-db-access` reads `packages/db/src/schema/*.ts` at rule load and bans every `export const <name> = pgTable(` it finds, plus the four fixed client exports. It throws if it finds no tables, and throws if the number of names it matched differs from the number of `pgTable(` calls in those files.
Why: The hand-written list was written before schema wave 2 and named none of that wave's 22 tables nor mini-wave 2b's 2 — a guard that reads as protection and is none. Deriving it means the next migration cannot leave it stale. Both ways the derivation could fail quietly — an unreadable directory, or a table declared in a shape the pattern misses — are turned into a failed lint run instead, because "matches nothing" is indistinguishable from "everything is fine" in a rule's output. Two planted violations in `pnpm lint:prove` (a wave-2 table and a wave-2b table) hold it.
Nearest spec: CLAUDE.md code-structure rules; tech §3; `docs/audits/remediation.md` D10 item 3.

## 2026-09-01 — R4 — The prompt loader composes its path instead of naming a directory in `new URL`
Decision: `PROMPTS_DIR` in `packages/llm/src/prompts.ts` is `join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts')`, and the per-prompt path is a `join` on top of it.
Why: Webpack treats `new URL('<literal>', import.meta.url)` as an asset reference it must resolve at build time, and a directory is not an asset — so `next build` failed with "Module not found: Can't resolve '../prompts/'" as soon as any route imported `@sortiva/llm`, which is why card `T1.3` read its prompt file by hand rather than through the loader every prompt is supposed to go through. Runtime resolution is identical; the composed form is simply opaque to the bundler. Verified by building a route that imports the loader and serving it — not only by a unit test.
Nearest spec: main §14.2 — versioned prompt files and a meaningful `prompt_version`; silent on bundling.

## 2026-09-01 — R4 — NOT BUILT: flushing PostHog on worker shutdown, because nothing constructs a PostHog client yet
Decision: `docs/audits/remediation.md` D10's optional fourth item is left undone. `installSignalHandlers` already has the hook it needs (`onStopped`, currently unused), but no code path in a running process ever constructs `PosthogServerCapture` — it exists, is tested, and has no caller outside its own tests.
Why: Flushing needs a client to flush, so the missing piece is not a line in the shutdown handler but a decision about where a process-wide analytics client lives and who injects it — a wiring choice that shapes every future call site. Nothing is being dropped on deploy today, because nothing is being captured. Building a hook against a client that does not exist would be dead code that looks like coverage.
Nearest spec: main §14.7 — requires the events; silent on process lifecycle.

## 2026-08-31 — R2 — The `CostLedger` port lives in `packages/providers`, not `packages/core/contracts` — **flagged, not resolved**
Decision: `CostLedger`, `SpendEvent`, `UnrecordedSpend` and `InMemoryCostLedger` are declared in `packages/providers/src/spend/index.ts`, and `@sortiva/llm` gains a runtime dependency on `@sortiva/providers` (imported by the deep path `@sortiva/providers/spend/index`, so the barrel's Resend and PostHog SDKs are not pulled in).
Why: this port belongs beside `RequestCache` and `PosthogCapture` in `packages/core/src/contracts/` — DECISIONS 2026-08-31 T0.5 says so explicitly ("putting the ports there means `packages/llm` and `packages/providers` depend on the behaviour rather than on each other"), and `docs/audits/T0.5.md` finding 1 proposes exactly that location. **Card R2 is not permitted to write in `packages/core`**, whose contracts are frozen for other lanes. Every other option is worse: duplicating the interface in both packages leaves no single source of truth; putting it in `packages/llm` would make the SEO adapter depend on the LLM package. So the port sits in a package this card owns, and the llm→providers edge this creates is the cost. **This is a contradiction between the card's ownership boundary and the repo's own layering rule, recorded rather than resolved.** Moving the file to `packages/core/src/contracts/spend.ts` is a pure move — no behaviour, no shape change — and should be done by the next card that may write there, after which `@sortiva/providers` can leave `@sortiva/llm`'s dependencies again.
Nearest spec: main §14.7 (final paragraph); CLAUDE.md code-structure rules; `docs/audits/remediation.md` D1.

## 2026-08-31 — R2 — Nothing writes `spend_events` yet: the Postgres adapter belongs to `packages/db`
Decision: R2 ships the port, both wrappers' calls to it, and two implementations (`InMemoryCostLedger` for tests, `UnrecordedSpend` for an explicit opt-out). It does **not** ship a `PostgresCostLedger`.
Why: the adapter is a repository over the `spend_events` table, and repositories live in `packages/db`, which R2 does not own and which another session holds. The consequence is precise and must not be misread: **as of this card, a production process still records no cost to the database** — the wrappers now ask a ledger to record, and the only ledger anyone can hand them is a no-op. A follow-up card in `packages/db` writing ~30 lines (`insert into spend_events`, mapping through `spendAttribution`) completes the chain, and `T8.4` then reads the table for the §14.5 caps.
Nearest spec: main §14.7 (final paragraph), §14.5; `docs/audits/remediation.md` D1.

## 2026-08-31 — R2 — A failed call's recorded cost is an estimate, and is marked as one
Decision: a call that reached Anthropic and then failed is recorded at the model's rates over an estimated input-token count (≈4 characters per token), output zero, with `cost_estimated: true` on the analytics event. A stream cut off partway uses the SDK's accumulated `currentMessage.usage` instead, which is the vendor's real count, and is marked `cost_estimated: false`. A failed DataForSEO call is recorded at the endpoint's per-task list price.
Why: remediation D2 requires a record on every path that reached a vendor, and both vendors bill for work performed. Neither vendor returns usage on a failure, so the choice is between an approximate number and no number; the audit itself recommends "a best-effort cost". The flag exists so a spend query can exclude estimates if it ever needs to. Known bias: DataForSEO probably does not bill a client-error task, so `outcome: 'failed'` rows may over-count there — which is why the ledger records `outcome` rather than folding failures into one total, leaving the cap card (`T8.4`) to decide what its window sums.
Nearest spec: main §14.7 requirement (1) — "no call can escape tracking"; silent on failed-call cost.

## 2026-08-31 — R2 — A ledger write that fails does not fail the call; it logs at error level
Decision: `recordSpend()` swallows a rejection from `CostLedger.record` and logs `spend_event_not_recorded` at error level with the vendor, call type, cost and outcome. It never rethrows.
Why: on the success path the vendor is already paid and its answer is already cached, so turning a database hiccup into a job failure would discard work we bought. On the failure path, rethrowing would replace the vendor's typed error — which main §14.3.5's retry-versus-dead-letter routing reads — with a database error, changing how the step is retried. The cost of this choice is a silent under-count if the ledger is persistently down, which is why the log line is `error` and not `warn`: an unrecorded cost means the §14.5 caps are reading low. An alarm on that log line is the natural follow-up and belongs to the observability card.
Nearest spec: main §14.5, §14.3.5 — neither says what happens when the meter itself fails.

## 2026-08-31 — R2 — The DataForSEO request cache stores the vendor's whole envelope, not the extracted rows
Decision: `request_cache` rows of kind `dataforseo` now hold the raw response body (`{ tasks: [...] }`) rather than `{ result: rows }`, and `extractResult` runs after the read on both the fresh and the replayed path.
Why: audit finding 4. DataForSEO reports per-request failures inside an HTTP 200, and the previous order inspected for that before writing — so a request the vendor had executed and billed left no cache row, and the retry paid again. main §14.3.6 requires the response "written before it is processed", and parsing the envelope *is* processing. A visible consequence: a stored task-level failure now replays as the same failure for free instead of being re-bought, which is the same determinism §14.3.6 argues for on the LLM side. No deployed data is affected — nothing has written this cache in production.
Nearest spec: main §14.3.6; invariant 20.

## 2026-08-31 — R2 — The unpriced-endpoint guard moved from request time to module load
Decision: `assertEndpointsPriced()` runs when `packages/providers/src/seo/pricing.ts` loads and throws if any endpoint in `DATAFORSEO_ENDPOINTS` has no price. At request time, `chargeFor()` returns `{ usdCost: 0, priceKnown: false }` instead of throwing, and the wrapper logs `dataforseo_endpoint_unpriced` at error level and marks the analytics event `price_unknown: true`.
Why: audit finding 10 — the old guard threw *after* the vendor had been called and billed and *before* the cost record was emitted, so a guard against under-counting caused an under-count and turned a paid, successful call into a job failure. A missing price is a deployment mistake, and load time is where a deployment mistake belongs. **Known gap: `spend_events` has no `price_unknown` column**, so such a row is only distinguishable as `usd_cost = 0 AND cache_hit = false`. Not requested as a schema change, because the load-time assertion makes the request-time path unreachable for the three endpoints that exist.
Nearest spec: main §14.7 — "the price map is config"; silent on an incomplete map.

## 2026-08-31 — R2 — A per-call model override must name a registered model, and the judge cannot be overridden at all
Decision: `LlmRequest.model` is resolved through `overrideModel()`, which rejects a moving alias (`-latest`, `-preview`) and any id absent from the `MODELS` registry. An override on `call_type: 'judge'` is refused outright.
Why: audit finding 8 — the previous code applied the override to the model's *name* and kept the old tier's *prices*, so an override recorded the wrong cost, and it skipped the alias check the environment-variable path performs. The auditor's preferred fix was to delete `LlmRequest.model` entirely; it is declared in the frozen contract `packages/core/src/contracts/llm.ts`, which this card may not edit, so the alternative it offered is taken instead. The judge clause is the stronger reading of invariant 11 ("the judge is never run on a smaller model"): a per-call override is precisely the mechanism that would permit a downgrade, so it is closed rather than merely priced correctly.
Nearest spec: main §14.2 — "never 'latest' aliases"; §8.4, invariant 11.

## 2026-08-31 — R2 — The `MockLlmClient` cache is injectable and off by default, matching the live client
Decision: the double takes an optional `RequestCache`, `PosthogCapture` and `CostLedger`, defaulting the cache to `NullRequestCache` — which is what `AnthropicLlmClient` defaults to. It also performs main §14.2's single repair attempt.
Why: audit finding 11 says the double models a different cost curve than production. Defaulting the cache *on* would have been a second divergence in the other direction, and would silently change what the existing "accounts cost per call" test measures. Off-by-default with injection means a chaos run can hand both the real client and the double the same cache and get the same billable-call count — which is the parity `MockSeoDataProvider` already has and §14.3.9 asserts on the DataForSEO side.
Nearest spec: main §14.3.6, §14.3.9; the card's own "mock providers account cost".

## 2026-08-31 — R2 — The log scrubber registers connection strings by their value, not by their name
Decision: `registerEnvSecrets` additionally registers any environment value matching `scheme://user:password@…`, on top of the existing name-suffix rule.
Why: audit finding 14 — `DATABASE_URL` ends in none of SECRET/TOKEN/PASSWORD/API_KEY/KEY and carries a password inline, so a Postgres error echoing the connection string printed the password. The audit offered `URL$|_URI$|DSN$` as a name pattern; that would also capture `APP_URL`, redacting a value that belongs in logs and is asserted readable by the existing test. Matching the value's shape catches the credential-bearing ones and only those.
Nearest spec: tech §4; invariant 26.

## 2026-08-31 — R2 — Files edited outside the card's three owned directories
Decision: R2 also edits `eslint.config.mjs` (to wire the new rule) and `scripts/prove-lint.mjs` (to plant a violation the rule must catch). No lane directory is touched.
Why: a lint rule that is not registered in the config enforces nothing, and the card requires the new rule to be proved by a planted violation the way the existing two are — both of which live in shared tooling rather than in any lane. The planted file is written to `packages/llm/src/__lintproof__/`, inside this card's own package, and deleted by the script.
Nearest spec: CLAUDE.md — lane ownership; invariant 25.
## 2026-08-31 — R3 — The completed-work lookup reads `idempotency_ledger`, and the `job_steps` lookup is deleted outright
Decision: `packages/jobs/src/runtime/ledger.ts` is the new home of "have I already done this work": `lookupCompletedWork` reads `idempotency_ledger` by key, `recordCompletedWork` inserts into it. `lookupCompletedKey`, which read `job_steps WHERE idempotency_key = $1 AND state = 'succeeded'`, is **removed** rather than kept as a fallback, and `runStep` calls the ledger. `job_steps.idempotency_key` and `job_steps.output_ref` stay populated — main §13 puts the key there, the dead-letter entry carries it (§14.3.5), and an operator needs it to tie a stranded step to its ledger record — but neither is evidence any more.
Why: The queue is at-least-once, so this lookup is the only thing between a redelivered message and a second billed Shopify crawl or batch of LLM calls; when it read `job_steps` it was only as durable as the run, which cascades from the account (audit T0.4 [major]; remediation D7 item 2 took the structural fix; T2.0b built the table and left the runtime on the old path). No fallback to `job_steps` because nothing has ever run in production — the Railway project was deleted (remediation, Infrastructure) — so there is no history to honour, and a fallback would keep alive exactly the read whose durability is the defect. No backfill for the same reason.
Nearest spec: main §14.3.2 — "the cache is the ledger", silent on which table; main §13 — lists `idempotency_key` on `job_steps` and no ledger table.
Class (filled by audit):

## 2026-08-31 — R3 — The ledger row is written before the step row, and not in one transaction with it
Decision: On a handler returning, `runStep` inserts the ledger row first and only then runs the guarded `running → succeeded` transition. The two are deliberately *not* wrapped in one transaction.
Why: A process can die between them, and the two orders fail differently. Ledger first: the completion is recorded, the step is left `running`, and the next dispatch reclaims it, hits the ledger and marks it succeeded from the stored output — no second execution. Step first: the step reads `succeeded` with nothing in the ledger, and the next redelivery of that key re-runs billed work, which is the whole defect this card closes. One transaction looks safest and is not: an atomic pair that rolls back after the work really happened loses the record of it, and §14.3.6's precedent points the same way — the billable-read cache is "written before the response is processed". Cost accepted: a crash in that window leaves a step whose row disagrees with the ledger until it is reclaimed, which the lease already handles.
Nearest spec: main §14.3.2, §14.3.6 — require the record, silent on write order.

## 2026-08-31 — R3 — The ledger's answer is the returned answer, on every path
Decision: `recordCompletedWork` returns what the database holds for the key, not what the caller passed: on a conflict it reads the winning row back, and `runStep` uses that value for both the step's `output_ref` and its own return value, logging `step.ledger_conflict` when it was not the first writer.
Why: main §14.3.6 requires that "a retry can't get a *different* persona than the run it's resuming", and the write-once trigger (`0005_wave2b_guards.sql`) enforces the same rule in the database. If a duplicate execution's own output were returned while the ledger kept the first, the run, the step row and the ledger would carry three answers for one key. Consequence to accept: the returned value is JSON round-tripped even on the first run, so a handler returning a `Date` gets a string back — which is what every replay would have got anyway, so the first run now agrees with them rather than being the odd one out.
Nearest spec: main §14.3.2, §14.3.6.

## 2026-08-31 — R3 — The deletion tripwire is repointed at the ledger, not deleted
Decision: `packages/jobs/src/runtime/ledger.test.ts` keeps its job and changes its target: it fails if any production code path deletes or truncates `idempotency_ledger`, if the retention sweep's crontab entry stops saying the table is prunable by age only, or if the runtime goes back to reading a completed step's output. The ban on deleting `job_steps` / `ingestion_jobs` is dropped, and the crontab entry no longer calls those tables never-prunable.
Why: R1 wrote that test as the cheap stand-in for this card — the evidence lived on the job rows, so nothing could be allowed to delete them. The evidence has moved, so keeping the old assertion would forbid something that is now safe and wanted: a "restart onboarding" feature deleting an old run no longer risks re-billing anything. Deleting the file instead would throw away the guard the card's whole point is to preserve, one table to the left. The two assertions the old file made that are now proved better elsewhere — no foreign key into the ledger, and `UPDATE` refused — are live-Postgres assertions in `packages/db/src/constraints-wave2b.test.ts`, so they are not duplicated as text scans.
Nearest spec: main §14.3.2; tech §2.1 — gives the retention sweep its job.

## 2026-08-31 — R3 — `ledger.ts` joins the bounded raw-table lint exemption; no account column is needed
Decision: `packages/jobs/src/runtime/ledger.ts` is added to the `sortiva/no-raw-db-access` exemption in `eslint.config.mjs`, alongside `steps.ts` and `dlq.ts`. No `account_id` column is requested for `idempotency_ledger`.
Why: The rule (R1's D5 stopgap) bans importing raw tables outside `packages/db`; there is no repository for this table and writing one means editing `packages/db`, which this card does not own. The exemption is stated rather than left implicit because the rule's banned-name list was written before schema wave 2 and does not yet name any wave-2 or 2b table — so the import would have passed silently, which is worse than an explicit entry. **Reported separately to the integrator**: that list is stale for every table added since wave 1. On the account column, which T2.0b flagged as the open question — the runtime does not need one. The lookup is by key, the account is already in hand from the step context and stamped on every log line, and pruning is by age. An `account_id` would only serve ad-hoc operator queries, and it would hand a future data-deletion path a way to erase the record of paid work by account, which is precisely what the table exists to prevent.
Nearest spec: CLAUDE.md code-structure rules; main §14.3.2.

## 2026-08-31 — R1 — A `running` step is reclaimed after a lease, by the dispatcher, not by a sweep
Decision: A step left in `running` past a per-step time limit is treated as abandoned: `dispatchableSteps` offers it again and `claimStep` will take it, guarded on `started_at` in the same UPDATE. Option (a) of the two the audit proposed; no cron sweep is added. Lease durations live in `packages/jobs/src/runtime/lease.ts`: 15 minutes by default, 30 for `catalog_sync` and `distill`, and **no lease at all** for `oauth_wait`, `gsc_connect` and `awaiting_confirmation`.
Why: A step whose process died stays `running` forever — no dispatcher, sweeper, heartbeat or timeout existed (audit T0.4 [blocker]). §14.3.1 says "restarting a job just means re-dispatching non-succeeded steps", and `running` is not succeeded; the missing piece is only how to tell a live worker from a dead one. Doing it in the dispatcher rather than a cron sweep because the cron registry refuses to enable until every scheduled task has a handler (DECISIONS 2026-08-27 T0.4), so a new sweep entry would be inert through M0 — exactly the window the fix is needed in. Safe per the audit: §14.3.3's per-account lock already means one worker per account at a time. The durations are not in the spec; they are chosen against §14.3.3's "steps are sized to minutes, not hours" and its ~8-minute worst case for a 500-product `catalog_sync`. The three steps with no lease wait on a person and legitimately sit in `running` for days; a timer must never reclaim those.
Nearest spec: main §14.3.1 — requires the re-dispatch, silent on how a dead worker is recognised.

## 2026-08-31 — R1 — A step reclaimed past its retry budget dead-letters rather than being reclaimed forever
Decision: When an expired `running` step has already used the §14.3.5 attempt budget (4 attempts), `runStep` moves it to `failed_terminal` and writes a DLQ entry with `error_class: lease_expired` instead of reclaiming it again.
Why: Reclaim with no ceiling turns a step that crashes the process every time into a silent infinite loop — the same invisible stall the blocker is about, one level up. Dead-lettering makes it an operator signal: main §14.7 alerts on "DLQ depth > 0 for > 1h". Reuses the existing budget rather than inventing a second one.
Nearest spec: main §14.3.5 — sets the retry budget, silent on crashes that never reach a failure path.

## 2026-08-31 — R1 — The shutdown signal is process-wide, produced by the signal handler, consumed by default
Decision: `packages/jobs/src/runtime/shutdown.ts` owns one `AbortController` for the process. `installSignalHandlers` aborts it on SIGTERM/SIGINT *before* awaiting the drain, and `runStep` uses it as the default for `StepContext.signal` unless a caller passes its own.
Why: `StepContext.signal` existed with no producer anywhere (audit T0.4 [major]) — the drain waited for the whole step and Railway killed the process past the grace period, which is what turned the blocker above from theoretical into routine. Process-wide rather than passed down because a step handler reached through Graphile Worker has no other route to it, and a default rather than an option because a step that forgets to wire it is a step that cannot be drained. `resetShutdown()` exists for tests only.
Nearest spec: tech §2.1 — requires the graceful drain, silent on how a step learns of it.

## 2026-08-31 — R1 — The account lock is leak-proof, bounded and non-re-entrant by construction
Decision: In `lock.ts`: `pool.connect()` moved inside a try/finally so a failure before the lock is taken returns the connection; a failed unlock (or an unlock reporting the lock was not held) calls `client.release(err)`, which **destroys** the connection instead of pooling it; a bounded `lock_timeout` (10 minutes, overridable per call) turns a stuck holder into `AccountLockTimeout`, which classifies as retryable and so retries on the §14.3.5 backoff; and a nested acquisition for an account the current async call stack already holds throws `AccountLockReentry` rather than deadlocking. Re-entry is tracked with `AsyncLocalStorage`, not a process-wide set.
Why: The session-scoped lock chosen in DECISIONS 2026-08-27 T0.4 is right for the reason recorded there, but it loses three properties `pg_advisory_xact_lock` has for free, and each was a live defect (audit T0.4, two [major] findings): a connection leak per error on the acquire path (the pool is 10 and shared with the web server), a connection returned to the pool still holding a store's lock — after which every job for that store blocks forever with no error — and a nested call waiting on its own caller. `AsyncLocalStorage` rather than a process-local set because two *sibling* jobs for one account in the same process must still queue through Postgres; only a call nested inside its own holder can never be satisfied.
Nearest spec: main §14.3.3 — requires the serialisation, silent on the failure modes of the mechanism.

## 2026-08-31 — R1 — The account lock key is 64-bit, with the namespace as the hash seed
Decision: `pg_advisory_lock(hashtextextended(account_id, 0x5027))` — the single-key advisory space with a 64-bit hash — replaces the two-integer `(namespace, hashtext(account_id))` form.
Why: The two-int form gave 32 bits of account hash, in which unrelated stores collide with roughly 1% probability at 10,000 accounts and near-certainty in the low hundreds of thousands; the consequence is two merchants silently queueing behind each other, against §14.3.3's "cross-account work is fully parallel" (audit T0.4 [minor]). Postgres keeps the one-key and two-key advisory spaces separate, so the namespace was never what provided isolation from Graphile Worker's own locks — and `hashtextextended` takes a seed, so the namespace survives as that. Amends the key half of DECISIONS 2026-08-27 T0.4; the session-scope half of that entry stands.
Nearest spec: main §14.3.3 — names the lock, not the key width.

## 2026-08-31 — R1 — Job-runtime tables get a bounded lint exemption, not scoped repositories
Decision: A new lint rule `sortiva/no-raw-db-access` forbids importing any raw table object, the raw database handle, or `@sortiva/db/schema` / `@sortiva/db/client` outside `packages/db`. Exactly two files are exempt, named in `eslint.config.mjs`: `packages/jobs/src/runtime/steps.ts` (`createRun`, `dispatchableSteps`, `guardedTransition`, `claimStep`, `lookupCompletedKey`, `saveCheckpoint`, `readCheckpoint`, `getStep`, `findStep`) and `packages/jobs/src/runtime/dlq.ts` (`deadLetter`, `dlqDepth`, `listOpenDlq`, `replayDlqEntry`). Test files and the chaos scenarios are exempt as a class. `pnpm lint:prove` plants a violation of the new rule and fails if it is not caught, matching the existing rules' proof.
Why: This is the stopgap half of remediation D5. The durable fix — stop `@sortiva/db` exporting raw tables and add the join-scoped helpers the job tables need — has to happen inside `packages/db`, which card R1 does not own and which has a live session in it. `job_steps` has no `account_id` column of its own (main §13 hangs it off `ingestion_jobs`), so there is no scoped repository for this code to call yet. **The durable fix is still outstanding**; this rule stops the breach spreading to the eight lanes about to copy it.
Nearest spec: CLAUDE.md code-structure rules; tech §3 — "every query is `WHERE account_id = session.account_id`, enforced by a repository layer".

## 2026-08-31 — R1 — The idempotency ledger gets a tripwire, not a new table
Decision: `packages/jobs/src/runtime/ledger.test.ts` scans production source and fails if any code path deletes or truncates `job_steps` or `ingestion_jobs`, if the migration set grows a third cascade into them, or if the retention sweep's crontab entry stops naming them never-prunable. The crontab entry now says so in writing. No new table, no migration.
Why: The "have I already done this work" record is the `job_steps` rows themselves (DECISIONS 2026-08-27 T0.4), so deleting one lets a replay re-run and re-bill real work. Nothing deletes them today; the risk is the retention sweep that has a cron entry and no handler yet. The durable fix — a ledger table with no foreign key to jobs — is a schema-wave change and an open founder decision (remediation "Still open"), so this card takes only the cheap half, as instructed.
Nearest spec: main §14.3.2 — "the cache is the ledger", silent on the durability of that record.

## 2026-08-31 — R1 — A dead-letter replay whose step row is gone reports it instead of reporting success
Decision: `replayDlqEntry` returns a discriminated outcome — `replayed` | `already_replayed` | `step_missing` — instead of `DlqEntry | undefined`.
Why: `job_dlq.step_id` is `ON DELETE set null`, and non-ingestion work (publish, sweeps, email) dead-letters here with no step at all. The old code marked such an entry replayed and rescheduled nothing, reporting success — a replay button that silently does nothing (audit T0.4 [minor]). No consumer outside the tests exists yet, so the signature change costs nothing now and would cost an ops screen later.
Nearest spec: main §14.3.5 — "Ops can replay a DLQ item with one action", silent on an entry with no step.

## 2026-08-31 — R1 — The checkpoint write is guarded, and losing the guard stops the worker
Decision: `saveCheckpoint` is `UPDATE ... WHERE id = ? AND state = 'running'` and throws `StepOwnershipLost` on zero rows; `runStep` turns that into the `not_claimed` outcome without touching the row further.
Why: It was the one unguarded write in the runtime (audit T0.4 [minor]), and reclaiming abandoned steps is exactly the situation where a stale worker exists — it would otherwise rewind the new owner's cursor. `not_claimed` rather than a failure or a DLQ entry because §14.3.1 says such a worker "stops immediately": the step is progressing fine under someone else, and dead-lettering it would be a false alarm.
Nearest spec: main §14.3.1 — requires guarded transitions.

## 2026-08-31 — R1 — Every step logs through `packages/core`'s logger, and hands it to the handler
Decision: `runStep` stamps a child of the existing `createLogger` from `packages/core/src/observability/logger.ts` with `account_id`, `job_id`, `step_id`, `step`, `attempt` and `idempotency_key`, and emits `step.claimed`, `step.reclaimed` (with `stranded_ms`), `step.succeeded` (with `duration_ms`), `step.failed` (with `error_class`, message, stack and `will_retry`), `step.dead_lettered`, `step.not_claimed`, `step.ownership_lost` and `step.awaiting_reauth`. The same stamped logger is exposed to step handlers as `StepContext.log`. The instance is process-wide, in `packages/jobs/src/runtime/logging.ts`, replaceable via `setRuntimeLogger` for tests and for the bootstrap.
Why: The logger existed, was tested, and had zero callers; the running system printed five `console.log` lines about starting and stopping, none naming a store. `runStep` is the one place that knows the account, job, step and attempt at once, so one change there gives every step handler any lane ever writes a trail for free. Field names are snake_case to match §14.7's event property convention, so a log line and its PostHog event agree. Not a second observability system: PostHog answers "how often, across the fleet"; these lines answer "what happened to this one store, in order, with the error attached". **Identifiers, outcomes, durations and error classes only** — no product content, prompts or drafts (main §14.7's privacy note, constitution invariant 26). The stack trace is new and goes through the same scrubber (tech §4).
Nearest spec: main §14.7 — specifies the PostHog event taxonomy, silent on process logs; tech §4 — requires the scrubber on anything logged.

## 2026-08-31 — R1 — `@sortiva/rules` stays a declared dependency of `packages/jobs`
Decision: The unused `@sortiva/rules` dependency the audit flagged as a nit is left in place.
Why: Invariant 17 checks spend caps at job dequeue and invariant 9 puts every threshold in `packages/rules`, so the first step-handler card needs it. Removing and re-adding it churns the lockfile for nothing.
Nearest spec: CLAUDE.md invariants 9 and 17.
## 2026-08-31 — T2.0b — The idempotency ledger is its own table with no foreign key, and is write-once
Decision: `idempotency_ledger (idempotency_key text primary key, output_ref jsonb, completed_at timestamptz)` — no foreign key to `job_steps`, `ingestion_jobs` or `accounts`, and an `UPDATE` on it raises (`0005_wave2b_guards.sql`). `DELETE` is left alone. Recording a completion is therefore `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`, never an upsert.
Why: main §14.3.2 makes "have I done this work" and "where is the result" the same lookup, and the queue is at-least-once, so that lookup is the only thing standing between a redelivered message and a second billed Shopify crawl or batch of LLM calls. Today it reads `job_steps` (`lookupCompletedKey`, `packages/jobs/src/runtime/steps.ts`), which cascades from `ingestion_jobs`, which cascades from `accounts`; `docs/audits/T0.4.md` traced every deletion path and found the risk live but unrealised, and `docs/audits/remediation.md` D7 item 2 takes the structural fix over `R1`'s cheap guard. The absence of the foreign key is the whole design — a key that cascades from a job is exactly what goes wrong now — and it follows `spend_events`' precedent from T2.0: deleting the payer must not erase the record of the payment. Write-once because a revised `output_ref` would let a replay return a different answer than the run it is resuming, the hazard §14.3.6 names for LLM calls ("a retry can't get a *different* persona than the run it's resuming"). `DELETE` stays open on the same terms as `spend_events` (tech §2.1 retention), with the pruning rule written on the table: by age only, never by job or account, and only past redelivery.
Nearest spec: main §14.3.2, §14.3.6; main §13 — lists `idempotency_key` on `job_steps` and no ledger table.
Class (filled by audit):

## 2026-08-31 — T2.0b — The idempotency ledger carries no account column, and nothing reads it yet
Decision: three columns only, as `docs/audits/remediation.md` D7 describes. No `account_id`, no step name, no job reference. `packages/jobs/src/runtime` is untouched — the worker still reads `job_steps`.
Why: two separate reasons. (1) Scope: `packages/jobs/src/runtime` belongs to card `R1`, which was running in another worktree while this migration was written, so moving the runtime onto the table is a follow-up card the integrator schedules — the migration alone changes no behaviour. (2) Shape: an `account_id` would be operationally useful ("which store did this belong to") and `spend_events` carries one without a foreign key, but the card specified key + output ref + completion time and an extra column is a design choice, not mechanics. Flagged rather than taken: if the follow-up card wants per-account operability or per-account pruning it needs a column, and that is another migration. The cost of deciding now is one nullable column; the cost of deciding later is another wave exception.
Nearest spec: main §14.3.2; build plan §3 (lane directory ownership).
Class (filled by audit):

## 2026-08-31 — T2.0b — `verification_tokens` uses Auth.js's column names and has no foreign key
Decision: `verification_tokens (identifier text, token text, expires timestamptz, primary key (identifier, token))` plus a unique index on `token` alone and an index on `expires`. Column `expires`, not the house `*_at` suffix. No foreign key to `accounts`.
Why: the shape is dictated by the consumer — Auth.js refuses to start an email provider without an adapter exposing `createVerificationToken` / `useVerificationToken`, and the adapter reads these columns by name, so matching the house convention would mean a mapping layer for no gain (DECISIONS 2026-08-31 T1.1, the blocker entry). No foreign key because `identifier` is the address a link was sent to and a first-time visitor has no account row until the link is followed. The two additions beyond T1.1's stated shape: the unique index on `token` alone, because a secret valid for two mailboxes would be two live links and that is the one thing this table exists to prevent; the index on `expires`, because the sweep that clears dead links (tech §2.1 retention) scans by it. Single-use is by deletion, not by a `consumed` flag — a flag leaves a spent secret readable in the table and needs a second condition on every read.
Nearest spec: main §4.1; main §13 — silent on verification tokens.
Class (filled by audit):

## 2026-08-31 — T2.0b — NOT BUILT: `account_settings.limited_intelligence`, because §7.11 defines it as derived
Decision: the third item of the mini-wave is not built, and is reported back to the integrator instead. No column added.
Why: the card said to decline it if the spec read that way, and it does. main §7.11 is titled "Limited Intelligence mode (**no GSC**)" and main §6.7 says the account "runs in Limited Intelligence mode … **until connected**" — one entry condition, one exit condition, both about the presence of a Search Console connection. `gsc_conns` exists as of wave 2 with `account_id` as its primary key, so the mode is a one-row existence check, not a stored fact. Storing it creates two sources of truth that can disagree in two user-visible ways: the badge persists after a merchant connects (main §6.7's "until connected" broken), or the flag reads false with no connection and the GSC-dependent signals §7.11 forbids get evaluated against no data. The merchant's explicit skip is already durable elsewhere — main §14.3.1 has the `gsc_connect` step end `skipped` for exactly this. And `account_settings` holds merchant preferences (publish hour, timezone, delivery, vacation mode); a computed status filed among them reads as something a user sets. Contradiction surfaced: `docs/agent-work-plan.md` T3.1 says "skip path sets `limited_intelligence = true`" and lists the flag as in scope — that is the build plan, not a spec, and `T1.1` has already shipped `GET /api/account`'s `limitedIntelligence` computed as "no Search Console connected". Consequence to accept: if the integrator still wants the column, T3.1 needs a mini-wave or T3.1 computes the value.
Nearest spec: main §7.11, §6.7, §14.3.1; main §13 `account_settings` — lists no such column; build plan T3.1 — contradicts.
Class (filled by audit):

## 2026-08-31 — T2.0b — The mini-wave is two migrations, matching wave 2's split
Decision: `0004_wave2b.sql` is drizzle-generated from the schema diff; `0005_wave2b_guards.sql` is hand-written `--custom` for the write-once trigger. Constraint tests are their own file, `constraints-wave2b.test.ts`, on their own test database.
Why: wave 2 set this precedent (`0002` generated, `0003` hand-written) and the reason holds — drizzle-kit cannot express a trigger, and a generated file that has been hand-edited stops being reproducible from the schema. Separate test file and database because vitest runs test files in parallel and two suites truncating the same tables produce failures that look like constraint bugs; `setupTestDb` takes a per-suite label for this.
Nearest spec: CLAUDE.md code-structure rules (forward-only migrations, tests beside code); tech §5.
Class (filled by audit):


## 2026-08-31 — T2.0 — The competitor cap is a locking trigger, because a counting trigger is not a constraint
Decision: `competitors` gets a `BEFORE INSERT OR UPDATE OF account_id` trigger (migration `0003_wave2_guards.sql`) that takes `SELECT … FOR UPDATE` on the account row, then counts, then raises `check_violation` at six. No slot column, no changed insert shape.
Why: main §6.6 asks for a "count constraint" in the DB. A trigger that only counts is beatable: under Postgres' default READ COMMITTED two concurrent inserts each see five rows and both proceed, so an account ends with seven competitors — invariant 5 violated silently, and DataForSEO cost with it. Locking the account row first serialises inserts for that account, so the count is taken with nothing else in flight. Proven both ways: the suite's concurrency case leaves exactly five rows, and the same trigger body without the lock lets all six land. The alternative considered was a `slot smallint CHECK (1..5)` column with `UNIQUE (account_id, slot)` — equally airtight and purely declarative, but it puts a slot-allocation burden on every writer and adds a column §13 does not describe.
Nearest spec: main §6.6 — states the cap and that it is enforced in the DB, not the mechanism.

## 2026-08-31 — T2.0 — `spend_events`: append-only enforced by the database, and no foreign key to `accounts`
Decision: an `UPDATE` on `spend_events` raises (trigger in `0003_wave2_guards.sql`); `DELETE` is left alone; `account_id` is a plain uuid column with no foreign key.
Why: `docs/audits/remediation.md` D1 requires the ledger be append-only, and a rule enforced only by "no repository has an update method" lasts until someone writes one. `DELETE` stays open because tech §2.1 gives a retention sweep the job of keeping Postgres small and main §14.5's caps only ever read a trailing window. The missing foreign key is deliberate: `ON DELETE CASCADE` would let account deletion (main §14.6) erase money we actually spent, which is the opposite of append-only, and `ON DELETE SET NULL` would leave a row attributable to nobody and break the attribution check. What §14.6 requires hard-deleted is PII and order-derived aggregates; a vendor invoice line is neither.
Nearest spec: main §14.7 (final paragraph), §14.5, §14.6; remediation D1.

## 2026-08-31 — T2.0 — Every `spend_events` row is attributed to exactly one of an account or a preview target
Decision: a check constraint requires `account_id` XOR `preview_target`. Neither-set is refused as well as both-set.
Why: main §14.7's preview attribution rule — "the domain group is reserved for claimed domains… Preview events carry `target_domain` as a plain property instead" — is already a two-case union in the frozen contract `EventAttribution` (`packages/core/src/contracts/analytics.ts`), and the table mirrors it so the mapping at the seam is an identity. Refusing neither-set is the stronger half: unattributed spend is money nobody can be asked about, and §14.7 requires "how much is site X costing us" to be answerable. Known consequence: if card `R2` finds a paid call belonging to neither an account nor a preview, it cannot record it and must come back for a schema change. Every `call_type` §14.7 lists is one or the other, so I believe that set is closed.
Nearest spec: main §14.7 — states the attribution rule, not a constraint.

## 2026-08-31 — T2.0 — The ledger carries `outcome` and a three-value `vendor` enum
Decision: `spend_events.outcome` is `succeeded | failed`, not null and not defaulted; `vendor` is `anthropic | dataforseo | resend`.
Why: remediation D2 makes card `R2` record a cost on every failure path — "recording a cost is an obligation of making the call, not a side effect of the call succeeding" — and `R2` is not a schema wave, so a column it needs must exist now or it is blocked. No default, because a caller that has not thought about which path it is on should not get one silently. `resend` is in the enum for the same reason: main §14.5's caps only sum `anthropic` and `dataforseo`, but `EmailProvider` is one of the three instrumented wrappers of invariant 25 and does cost money, and an append-only ledger must not need a migration to admit it.
Nearest spec: main §14.7 requirement (1), §14.5; remediation D1, D2; audit `docs/audits/T0.5.md` findings 2–5, 13.

## 2026-08-31 — T2.0 — Columns added beyond main §13's wave-2 sketches
Decision: `products.checksum`; `product_facts.prompt_version` / `.model_id`; `personas.product_categories` / `.prompt_version` / `.model_id` / `.generated_at`; `opportunities.limited_intelligence`; `gsc_conns.invalidated_at`; `products.synced_at`; `product_families`, `top_products` and `store_pages` timestamps.
Why, in groups. **`products.checksum`** — build plan T2.3 keys the distillation cache on "`updated_at` + checksum" and T2.2's reconciliation sweep diffs on a checksum (main §14.3.8); neither is buildable without it. **`prompt_version` / `model_id` on the two LLM artefacts** — invariant 25 says every artefact is stamped with both, and §13's sketches list them on `optimize_recommendations` but not on `product_facts` or `personas`, which are equally LLM output. **`personas.product_categories`** — §6.5's own output schema contains it. **`opportunities.limited_intelligence`** — §7.11 makes it a property of the row, §14.7's `opportunity_detected` event carries it, and the frozen `Opportunity` contract declares it. **`gsc_conns.invalidated_at`** — main §14.4 requires a refresh failure to raise a reconnect prompt while the content pipeline continues; recording when the token was found dead is what makes that reminder idempotent, exactly as `shopify_conns.invalidated_at` does for Shopify (DECISIONS 2026-08-27 T0.3). The remaining timestamps are sync/compute bookkeeping the sweeps need.
Nearest spec: main §13 (sketches only), §6.3, §6.5, §7.11, §14.3.8, §14.4; invariant 25.

## 2026-08-31 — T2.0 — Wave-2 tables key on internal uuids; external ids are unique columns
Decision: `products`, `store_pages`, `keywords`, `competitors`, `opportunities` and friends carry a `uuid` primary key. Shopify's product id, a store URL and a competitor domain are `NOT NULL` columns under a unique index scoped to the account, never the key itself.
Why: main §13 sketches `products` as "account_id, product_id, …", which reads as a composite key on the vendor's identifier. Foreign keys from `product_facts`, `top_products` and `products.family_id` would then all carry the account id and the vendor id, and a vendor that renumbers (or a second platform after V1) would rewrite every child row. The uniqueness main §13 actually asks for is preserved as an index, which is what the constraint tests assert.
Nearest spec: main §13 — sketches column lists, states no keys.

## 2026-08-31 — T2.0 — GSC daily rows are keyed on all four dimensions, none nullable
Decision: `gsc_query_daily`'s primary key is `(account_id, date, page, query, device, country)`, with `device` and `country` `NOT NULL`. `gsc_daily` is keyed `(account_id, date, page)`. `ctr_curve` is keyed `(account_id, fitted_at)` so weekly refits accumulate.
Why: main §12.2 requests exactly those four dimensions from the Search Analytics API, so a row is one full bucket of them. §13 marks `device?` and `country?` optional, but a nullable column inside a key silently permits duplicates — Postgres treats nulls as distinct — which is the same failure mode that made `notifications.dedupe_key` `NOT NULL` in wave 1. `ctr_curve` keeps history because §13 lists `fitted_at` as a column and §7.3 refits weekly; the live curve is the newest row.
Nearest spec: main §12.2, §13, §7.3 — none states a key.

## 2026-08-31 — T2.0 — Three wave-2 tables have no account, extending the `SystemScope` exemption
Decision: `serp_snapshots` (no `account_id`), `rules_overrides` (nullable) and `spend_events` (nullable) join the wave-1 account-less set documented on `SystemScope` in `packages/db/src/scope.ts`.
Why: CLAUDE.md says "there is no unscoped table access outside migrations and admin scripts", and DECISIONS 2026-08-27 T0.3 already flagged that the rule has no case for genuinely account-less tables. Each of these three is one: a SERP snapshot is keyed on canonical request parameters so two stores asking the same question in the same locale don't pay DataForSEO twice (main §12.1); a rules override is global or per-locale in V1 (main §7.10); preview spend happens before an account exists (main §14.7). Recorded rather than resolved — the repositories are not written by this card, and the durable fix named in remediation D5 is still open.
Nearest spec: CLAUDE.md code-structure rules vs main §12.1, §7.10, §14.7.

## 2026-08-31 — T2.0 — `ttl` and `body_ref` are realised as `expires_at` and compressed bytes
Decision: `serp_snapshots.ttl` becomes `expires_at timestamptz`; `store_pages.body_ref` becomes `body_compressed bytea`, and `products.raw_body_html` is `bytea` too. A `bytea` column builder is declared once in `packages/db/src/schema/columns.ts`.
Why: the same reasoning wave 1 applied to `request_cache` — an instant is directly indexable and sweepable, where a duration has to be added to a timestamp on every read. tech §2.1 rules out any blob store ("Postgres is the cache") and says both bodies are compressed, so there is nothing for a "ref" to point at. drizzle-orm 0.38 has no `bytea` builder, hence the one custom type.
Nearest spec: main §13; tech §2.1; DECISIONS 2026-08-27 T0.3 (`response_ref` → `response_json`).

## 2026-08-31 — T2.0 — `signal_type` enum values are the keys of `signals.config.yaml`, verbatim
Decision: the 18 values of the `signal_type` Postgres enum are copied from `defaults.signals` in `packages/rules/signals.config.yaml` — including `missing_or_weak_metadata` and `wrong_canonical_or_duplicate`, which main §7.3 writes as "Missing / Weak Metadata" and "Wrong Canonical / Duplicate".
Why: main §7.6 requires "a closed enum matching §7.3", but §7.3 gives display names, not identifiers. Detection looks a signal's thresholds up by key, so a row whose `signal_type` names no config key has no thresholds to be judged by. Making the two lists the same list means a mismatch is a compile-or-insert failure rather than a silently unconfigured signal. Consequence: adding a signal is a migration plus a config edit, together.
Nearest spec: main §7.3, §7.6, §7.10.

## 2026-08-31 — T2.0 — `recommended_action` is stored lower-case, and confidence is stored as a number
Decision: the `recommended_action` enum is `create | optimize | refresh | fix | hold`, as main §13 spells it. `opportunities.confidence` is an integer 0–100; there is no stored band column.
Why: the frozen contract `Opportunity` (`packages/core/src/contracts/opportunities.ts`) uses upper-case `CREATE | OPTIMIZE | …` and carries both `confidenceScore` and a `confidence` band. DECISIONS 2026-08-31 T0.7 settled that where the table and the contract differ, the table is authoritative and the producing card maps — this is that case, and it is two `toLowerCase()`-shaped lines in Lane C's producer. The band is not stored because §7.6 puts its cut-points in config ("bands: high ≥ 70, medium 40–69, low < 40. The numbers are config"), and a stored band would be a threshold literal frozen into data — invariant 9 in spirit.
Nearest spec: main §13, §7.6, §7.10; DECISIONS 2026-08-31 T0.7.

## 2026-08-31 — T2.0 — The wave-2 constraint suite is its own file and its own test database
Decision: `packages/db/src/constraints-wave2.test.ts`, using `setupTestDb('constraints_wave2')`, keeping the wave-1 file untouched. `truncateAll` now truncates both waves.
Why: DECISIONS 2026-08-27 T0.4 gives each integration suite its own database because vitest runs files in parallel and two suites truncating shared tables produce failures that look like constraint bugs. The wave-1 suite's fail-loudly-when-no-database ending is repeated verbatim rather than shared, so neither file can be made to skip by a change to the other.
Nearest spec: tech §5, §6; DECISIONS 2026-08-27 T0.3, T0.4.


## 2026-08-31 — T0.7 — The OpenAPI document is generated from the zod route table, not maintained beside it
Decision: `packages/core/src/api/routes.ts` is the single source of truth — method, path, request and response schemas, conflict codes, spec citation. `packages/core/openapi.json` is generated from it with zod 4's built-in `z.toJSONSchema()` and committed; `pnpm contracts:check` regenerates and diffs, failing on any difference.
Why: T0.7's done-when asks for "zero shape mismatches between zod and OpenAPI". Two hand-maintained descriptions of one API agree only while someone is watching, and the drift is invisible until a frontend built against the document meets a backend built against the schemas. Generating one from the other makes a mismatch structurally impossible and turns the check into something with teeth: it catches a hand-edited document and a schema change nobody regenerated. zod 4 ships the JSON Schema converter, so this adds no dependency beyond zod itself.
Nearest spec: tech §3; build plan §4, T0.7.

## 2026-08-31 — T0.7 — 55 routes derived from ui §1–§10 and tech §3; `/api/auth/*` excluded
Decision: the route table enumerates every `/api/*` endpoint the UI spec's screens and the tech spec's conventions imply, with a spec citation on each. Auth.js's own routes are absent.
Why: the UI spec describes screens and states, not endpoints, so the route list is derived rather than copied — which makes it a judgement call worth recording. Auth.js owns `/api/auth/*` and defines those shapes itself (main §4.1); documenting them would be describing someone else's contract. The route table is where a reviewer should look to check the derivation, and every entry names the section it came from.
Nearest spec: ui §1–§10; tech §3; main §4.1.

## 2026-08-31 — T0.7 — Entitlement failure is 402 with its own code, not a 409 conflict
Decision: `CONFLICT_CODES` holds only codes a guarded transition returns (409). Entitlement failure is a 402 carrying `entitlement_inactive`; the preview's rate limit is a 429 carrying `rate_limited`. Routes declare `requiresEntitlement` and `rateLimited` flags, and the generator documents the corresponding response.
Why: `pnpm contracts:check` flagged `entitlement_inactive` as a code no route returned — the check working as intended on its first run. tech §3 defines the 409 code as "the guard failed"; nothing about a resource's state conflicts when an account simply is not entitled to start new work. Keeping the enum to exactly the 409 codes is what lets the check assert that every code in it is reachable, which is what stops the UI building a toast that never fires. Invariant 16's other half is enforced by a test: no GET route may carry `requiresEntitlement`, because read access is never revoked.
Nearest spec: tech §3; main §4.2, §3.2; invariant 16.

## 2026-08-31 — T0.7 — Two product invariants are enforced in the schema shape, not per screen
Decision: no response schema has a field that could carry a denominator or a target (invariant 23), and every user-facing "why" is a `{templateKey, params}` pair with no field for rendered prose (invariant 8). Both are asserted by a test over the generated document.
Why: invariant 23 says the cap is a ceiling, not a promise, and invariant 8 says every why renders from a template over the scoring record and never from an LLM. Left as screen-level rules, both depend on every frontend card remembering them. Left out of the schema, a well-meaning API card adds `remaining: 27` and the rule is broken before any screen exists. A field that does not exist cannot be rendered.
Nearest spec: main §8.6, §7.1, §9.6.8; ui §4; invariants 8 and 23.

## 2026-08-31 — T0.7 — Stubs register themselves and emit `stub_used`; the report can fail per milestone
Decision: every seam double extends `StubImplementation`, which registers `{contract, filledBy, behaviour, mustBeGoneBy}` and emits `stub_used` on every call it serves. `pnpm stubs:report` lists them; `--milestone=M3` fails if any stub was due to be gone by then, and `--fail-if-any` is the absolute form.
Why: build plan §4 requires "a CI check fails if any stub is still wired at M3 exit", but different stubs are due at different milestones — `CatalogEvents` at M2, `existingTargetCheck` at M3, `JudgeLite` at M6. A single all-or-nothing gate would either fire too early or never. The `behaviour` line is the point of the registry: `existingTargetCheck` returning `no_match` forever means every CREATE bypasses the check main §7.7 makes mandatory — invariant 6 — and nothing about the product would look broken.
Nearest spec: build plan §4; main §7.7; invariant 6.

## 2026-08-31 — T0.7 — MSW handlers are generated from the route table, and every fixture is schema-validated
Decision: `apiHandlers()` builds one handler per route from `ROUTES`, serving a fixture keyed by `METHOD /path`. A test fetches every route through a real `setupServer` and validates each response against that route's own zod schema. Handlers accept options to force a 409 or a 401 per route.
Why: T0.7's done-when says "MSW mock server boots the UI shell", but the shell is Lane F's M9.1 card and does not exist — so the criterion cannot be met literally today. What is provable is the stronger half of the claim: a mock server built from the contract answers every route, and every answer validates against the schema the real API is bound to. A frontend built against these mocks therefore cannot be built against a shape the API will not produce. The forced-conflict option exists because tech §3's state-conflict toasts otherwise cannot be built until a real race happens in production.
Nearest spec: build plan §4, T0.7; tech §3; ui §5.4.

## 2026-08-31 — T0.7 — Seam contract types are declared in core, separate from the wave-2 tables
Decision: `Opportunity`, `QueryCluster`, `ScheduledTopic`, `JudgeVerdict`, `CatalogEvent` and the notification type enum live in `packages/core/src/contracts/opportunities.ts`, independent of the `opportunities` / `opportunity_tasks` tables that schema wave 2 (T2.0) will add.
Why: the same reasoning as T0.6's fixture shapes — the contracts must be frozen before the tables exist, and inventing the tables here would be a migration outside a schema wave. Where the two differ once wave 2 lands, the table is authoritative and its card maps to the contract shape at the seam. The cost is one mapping layer per producer; the alternative is a frozen contract that cannot be written until the schema it was supposed to precede has shipped.
Nearest spec: main §13, §7.6; CLAUDE.md migration rule; build plan §4.

## 2026-08-31 — T0.6 — Eval, chaos and Playwright are separate vitest/Playwright gates, not part of `pnpm test`
Decision: `pnpm eval` (`vitest.eval.config.ts`, `*.eval.spec.ts`), `pnpm chaos` (`vitest.chaos.config.ts`, `*.chaos.spec.ts`) and `pnpm e2e` (Playwright, `*.e2e.spec.ts`) each run on their own config; the per-merge `pnpm test` excludes all three.
Why: tech §5 gives each a different cadence — evals "when prompts/models changed", the chaos test "nightly", Playwright against a deployed environment — and each has a different cost. Evals call the model and spend money; a chaos scenario restarts a full synthetic run several times. Folding them into the per-merge run would either make every merge slow and billable, or make them optional in practice. Separate configs reuse the runner we already have rather than adding tooling.
Nearest spec: tech §5, §6; main §14.2, §14.3.9.

## 2026-08-31 — T0.6 — The chaos harness kills at scenario-declared checkpoints, and tightens its kill point to fit the run
Decision: a scenario's driver calls `ctx.checkpoint(label)` wherever a worker could realistically die; the harness draws one of those points with a seeded PRNG, throws `WorkerKilled` there, and re-runs the driver from the top until a pass survives. If a draw overshoots the run's length, the harness tightens its ceiling to the observed count and retries rather than counting an uninterrupted pass as a kill.
Why: §14.3.9 says "kills workers at random points" without saying how. Killing at arbitrary instants would need process-level interruption and would produce failures that are not reproducible; a failing chaos run that cannot be replayed is not actionable. Declared checkpoints make the kill points meaningful (after a page write, between publish intent and execute) and the seed makes a failure reproducible. The tightening rule exists because the first version silently spent its kill budget on kills that never fired — the harness reported a clean run as a chaos run, which is exactly the "reports green while proving nothing" failure the test exists to prevent.
Nearest spec: main §14.3.9.

## 2026-08-31 — T0.6 — The §7.8 fixtures carry evidence, never the expected opportunity
Decision: each of the eight scenarios in `packages/core/src/fixtures/scenarios.ts` supplies the store and the GSC rows the spec's table states, plus `expectedAction` recorded as documentation. Detection results are not asserted here; Lane C's card adds those assertions.
Why: §7.8 calls these "acceptance fixtures — each becomes a unit test over a synthetic store". If the fixture also encoded the answer, the implementation could be written to satisfy the fixture rather than the spec, and the fixture would stop being independent evidence. One assertion is made now: scenario 7's store genuinely fails main §8.2's substance floor, read from `packages/rules`. Without it the generator could drift into producing substance and "HOLD" would quietly become the wrong expected answer.
Nearest spec: main §7.8, §8.2.

## 2026-08-31 — T0.6 — Fixture shapes are their own types, not the wave-2 schema
Decision: `SyntheticProduct`, `SyntheticFamily` and `SyntheticGscRow` are declared in the fixtures module, independent of the `products` / `product_facts` / `gsc_query_daily` tables, which schema wave 2 (T2.0) has not created.
Why: T0.6 is required to ship fixtures for scenarios 1–8 before the tables they will eventually populate exist. Waiting would block the card; inventing the tables would be a migration outside a schema wave (the rule T0.4 already bent once). The mapping from fixture to row is written by the cards that add the tables. The cost is one mapping layer; the alternative is either a blocked card or a second process violation.
Nearest spec: main §13; CLAUDE.md migration rule; build plan T0.6, T2.0.

## 2026-08-31 — T0.6 — An eval set with cases but no registered runner fails; an empty set passes
Decision: `runEvalSet` returns pass for a set with zero cases, and fail for a set with cases whose `runner` key is absent from `EVAL_RUNNERS`. A case with an input file and no gold file is a load-time error.
Why: §14.2 makes eval sets a deploy gate, so the failure modes that matter are the silent ones. An empty set claims nothing and should not fail the build — that is M0's honest state. A set with fifty cases and no runner is a suite that has stopped running, which must look like a failure, not a pass. A case missing its gold file is the same hazard in miniature.
Nearest spec: main §14.2.

## 2026-08-31 — T0.6 — F1 is scored on `field=value` pairs; hard fails are checked per case
Decision: `fieldF1` compares `field=value` pairs rather than field names, and the runner checks fabrication (distillation) and false passes (judge) per case, outside the aggregate.
Why: §14.2 requires "zero inferred-fact violations (any fabricated field value = hard fail)" and "no draft that humans failed is graded as passing". Comparing field names would score "said the material is leather when it is nylon" as a correctly-populated field. Folding either check into the aggregate would let a high average absorb exactly the violation the spec refuses to tolerate — the runner's own tests assert both: a fabrication fails a set whose F1 is above the bar, and a false pass fails a set whose MAE is zero.
Nearest spec: main §14.2.

## 2026-08-31 — T0.6 — The PostHog provisioner fails when definitions exist but credentials do not
Decision: `--check` passes on an empty definitions directory, and fails when definitions are declared but `POSTHOG_PERSONAL_API_KEY` / `POSTHOG_PROJECT_ID` are unset. The `--apply` writer is not implemented; it lands with T8.4, the card that adds the first dashboards.
Why: tech §5 makes drift a build failure. Passing when credentials are missing means the build stops noticing drift the moment someone forgets a secret — the check would still be green and would be proving nothing. An empty directory is different: nothing is declared, so nothing can have drifted, and saying so is honest.
Nearest spec: main §14.7, tech §5.

## 2026-08-31 — T0.6 — The Playwright scaffold starts its own dev server unless pointed at a deployment
Decision: `apps/web/playwright.config.ts` runs `next dev` with `WORKER_ENABLED=false` against a seeded database, unless `E2E_BASE_URL` is set, in which case it tests that deployment and starts nothing. `pnpm db:seed` writes one deterministic development account. Browsers are not installed by `pnpm install`.
Why: tech §6 puts Playwright "against staging", but tech §2.1 makes staging on-demand, so a local run needs its own server or the suite is unrunnable between staging spin-ups. The worker is disabled because the in-process worker would pick up jobs mid-test and change state the flows are asserting (tech §2.1). The seed is deterministic because a UI test that asserts "4 families" must get the same four families each run. Browsers are left out of install because they are a ~400 MB download that every `pnpm install` would otherwise pay for.
Nearest spec: tech §6, §2.1, §5.

## 2026-08-31 — T0.5 — Provider interfaces live in `packages/core/contracts`, implementations in their own packages
Decision: `LlmClient`, `SeoDataProvider`, `EmailProvider`, `PosthogCapture` and `RequestCache` are declared in `packages/core/src/contracts/`; `AnthropicLlmClient` lives in `packages/llm`, the DataForSEO / Resend / PostHog adapters in `packages/providers`, and `PostgresRequestCache` in `packages/db`.
Why: the build plan §4 already names those four as contracts "in `packages/core/contracts/`", and T0.7 fills that directory with the rest of the seams. Putting the ports there now means `packages/llm` and `packages/providers` depend on the behaviour rather than on each other, and nothing has to be moved in T0.7. It also keeps the boundary test honest: `core` declares the interfaces and imports no SDK.
Nearest spec: build plan §4; CLAUDE.md code-structure rules.

## 2026-08-31 — T0.5 — `$ai_generation` is captured by hand, not via PostHog's Anthropic auto-instrumentation
Decision: the wrapper emits `$ai_generation` itself through `posthog-node`, with PostHog's documented AI property names (`$ai_model`, `$ai_input_tokens`, `$ai_output_tokens`, `$ai_latency`, `$ai_total_cost_usd`) plus §14.7's required `call_type`, `prompt_version` and `cache_hit`. We do not wrap the Anthropic client in PostHog's LLM-observability integration.
Why: §14.7 asks for the integration *and* for three things it cannot do. A replay served from `request_cache` makes no model call at all, so an auto-instrumented client has nothing to capture — yet §14.7 requires exactly those replays to be captured with `cache_hit: true` and zero cost, or cached work inflates the spend numbers. One capture path for live and cached calls is the only way both hold. Costs are computed from an explicit model→price table, so a cached call is priced at zero deliberately rather than by omission.
Nearest spec: main §14.7 — "we wrap the Anthropic client with the PostHog SDK's LLM observability integration"; same paragraph's requirements (1)–(3).

## 2026-08-31 — T0.5 — Model ids: `claude-sonnet-5` and `claude-haiku-4-5`, pinned, alias-rejecting
Decision: the registry pins Sonnet to `claude-sonnet-5` and Haiku to `claude-haiku-4-5`, with prices ($2/$10 and $1/$5 per million input/output tokens) used to cost every call. `ANTHROPIC_MODEL_SONNET` / `ANTHROPIC_MODEL_HAIKU` can pin a different id per environment, but a value ending in `-latest` or `-preview` throws at resolve time.
Why: main §14.2 requires explicit ids, "never 'latest' aliases", and §15 fixes which tier does what (Haiku for distillation and the preview card, Sonnet for persona, seeds, drafting and the judge). Allowing an env override without also rejecting aliases would let "latest" back in through configuration, which is the same failure the spec is guarding against. The registry also records that the current Sonnet generation rejects `temperature`, so §3.3's "temperature low" is forwarded only on the preview's Haiku call rather than producing a 400.
Nearest spec: main §14.2, §15, §3.3 — name the tiers, never the ids.

## 2026-08-31 — T0.5 — The LLM request cache is keyed per model call, so a validation retry is its own entry
Decision: `llmCacheKey = llm:<prompt_version>:<model_id>:sha256(system + messages)`. The §14.2 repair turn appends the validation errors to the message list, so it hashes differently and gets its own cache row.
Why: §14.3.6 keys on `(prompt_version, model_id, sha256(rendered_prompt))`, and the repair turn *is* a different rendered prompt. The consequence is the useful one: a step that retries after a `failed_validation` replays both stored completions, fails deterministically and for free, instead of paying to re-sample twice and possibly getting a different answer. §14.3.6's own reason for the LLM cache — "a retry can't get a *different* persona than the run it's resuming" — argues for exactly this.
Nearest spec: main §14.3.6, §14.2.

## 2026-08-31 — T0.5 — DataForSEO request-cache TTL is 24h; §12.1's 30-day and 7-day TTLs are a separate layer
Decision: every DataForSEO response is cached for 24 hours under `request_cache`. The 30-day keyword-metrics and 7-day SERP TTLs are not implemented here.
Why: §14.3.6 states the request-level TTL as 24h and says it "sits *under* the semantic TTLs of §12.1". Reading those as the same cache would mean a crash-safety mechanism doubling as the product's memory of what a keyword is worth. They are different jobs: this layer makes a step retry free; the semantic layer belongs to the cards that persist `keywords` and `serp_snapshots` (T2.6, T3.x).
Nearest spec: main §14.3.6, §12.1.

## 2026-08-31 — T0.5 — The DataForSEO price map lives in `packages/providers`, not `packages/rules`
Decision: `ENDPOINT_PRICES` (endpoint → per-task and per-row USD) sits beside the SEO adapter. Values are **UNSIGNED** — starting figures, not confirmed against a current vendor price list. An endpoint with no entry throws rather than costing zero.
Why: invariant 9 puts *product thresholds* in `packages/rules` — search volume, position, CTR — the numbers that decide what Sortiva does. A vendor's list price is an external fact we record so §14.7 can report spend and §14.5 can cap it. §14.7 also describes it as its own config table. Recorded here because an auditor sweeping for stray numbers will find these and should know they were considered.
Nearest spec: main §14.7 — "the price map is config"; §7.10 / invariant 9 — scope of the rules module.

## 2026-08-31 — T0.5 — Country → DataForSEO location code is derived, not tabulated
Decision: `locationCodeFor(country)` returns `2000 + the ISO-3166-1 numeric code` from a table of ~45 alpha-2 → numeric entries. An unmapped country throws.
Why: DataForSEO's country location codes are Google Ads geo-target IDs, which for countries follow that rule (US 840 → 2840, DE 276 → 2276), so only the ISO table is needed and extending it is mechanical. Defaulting an unknown country would return plausible search volumes for the wrong market, and nothing downstream could tell — a wrong demand floor decision with no symptom.
Nearest spec: main §12.1 — "pass the persona's main_language + country as the DataForSEO location/language parameters", without saying in what form.

## 2026-08-31 — T0.5 — Envelope encryption format, and rotation by key fingerprint
Decision: `v1.<masterKeyId>.<wrappedDataKey>.<wrapIv>.<wrapTag>.<iv>.<tag>.<ciphertext>`, all AES-256-GCM. A random 32-byte data key per row encrypts the token; the master key wraps the data key. `masterKeyId` is the first 8 hex characters of sha256(master key). `ENCRYPTION_MASTER_KEY_PREVIOUS` holds retired keys, decrypt-only, and `needsRewrap()` reports rows still on one.
Why: tech §4 requires envelope encryption but not a format. Naming the key in the stored value means a rotation decrypts with the right key directly instead of trying each, and makes "which rows still need re-wrapping" a query rather than an exception count. One string keeps it in a text column, so no schema change is needed when rotation lands.
Nearest spec: tech §4.

## 2026-08-31 — T0.5 — The log scrubber has a registry as well as pattern matching, and a logger to sit on
Decision: `scrub()` redacts by object key name and by vendor token shape, **and** redacts any literal registered via `registerSecret()`. Every secret-shaped environment variable is registered at process start (`registerEnvSecrets`, called from `apps/web/instrumentation.ts`), and `TokenCipher` registers each token it decrypts. `createLogger()` in `packages/core` applies the scrubber to every record.
Why: tech §4 says tokens never appear in logs or error reports, and pattern matching alone cannot deliver that — a Shopify token has a recognisable prefix, but a DataForSEO password or a decrypted custom-app token has no shape at all, and an exception message has no key name to match on. The registry closes that gap. The logger exists because a scrubber nothing calls is not a guarantee; making it the log path is what lets the test assert on the exact bytes written.
Nearest spec: tech §4 — "scrubber on the exception path", mechanism unspecified.

## 2026-08-31 — T0.5 — `classify()` also recognises structurally-classified provider failures
Decision: `packages/jobs`'s `classify()` now accepts any `Error` carrying a boolean `retryable` and a string `errorClass`, alongside its own `StepFailure` subclasses. `LlmValidationFailure`, `LlmRequestFailure`, `SeoRequestFailure` and `EmailSendFailure` carry those two fields.
Why: main §14.3.5 lists LLM `failed_validation` as a `failed_retryable` class, and §14.7's `dlq_entry_created` carries `error_class` — so a validation failure must reach the DLQ named, not as `unclassified`. The provider packages cannot extend `StepFailure` without depending on the job runtime, which would invert the dependency (`core` and `providers` are consumed by `jobs`, not the reverse). Structural recognition is the only option that keeps both the class names and the package boundaries.
Nearest spec: main §14.3.5, §14.7.

## 2026-08-31 — T0.5 — Test doubles enforce contracts rather than returning fixtures
Decision: `MockLlmClient` validates scripted responses against the call's schema and accounts cost per call; `MockSeoDataProvider` deduplicates on the same canonical cache key as the live adapter and bills from the same price map; `MockEmailProvider` returns the first result for a repeated idempotency key; `MockPosthogCapture` runs the same attribution and scrubbing code as the live wrapper.
Why: §14.3.9's chaos test asserts "DataForSEO billable-call count equals the number of *distinct* canonical requests" — a double that merely counts calls cannot prove that. Making the doubles enforce the same contracts means a green test against a double is evidence about production, and a fixture that would fail schema validation in production fails in the test too.
Nearest spec: main §14.3.9, §12.1; build plan §4 (contracts have doubles).

## 2026-08-27 — T0.4 — The per-account lock is session-scoped, not `pg_advisory_xact_lock`
Decision: `withAccountLock` takes a **session-level** advisory lock (`pg_advisory_lock`) on a dedicated pooled connection for the duration of a step, rather than the transaction-scoped `pg_advisory_xact_lock` main §14.3.3 names first. Key is the two-int form: a fixed namespace (`0x5027`) plus `hashtext(account_id)`.
Why: §14.3.3 says "`pg_advisory_xact_lock(account_id)` **or equivalent**", and the transaction-scoped form is not usable here. It would require holding one transaction open for a whole step, but §14.3.4 requires long steps to commit checkpoints as they go — a checkpoint only visible after the step commits is not a checkpoint, and `catalog_sync` is ~8 minutes for a 500-product store. Holding the lock on its own connection lets the step body checkpoint on pooled connections while still serialising all work for the account. The namespace exists because Graphile Worker takes advisory locks of its own in the same database.
Nearest spec: main §14.3.3 — "or equivalent"; §14.3.4 — checkpoint requirement.

## 2026-08-27 — T0.4 — `job_dlq` lands as a wave-1 addendum migration
Decision: New table `job_dlq` (account, job, step, idempotency_key, error_class, last_error, attempts, input_refs, first_failed_at, replayed_at/by) in `0001_wave1_addendum_job_dlq.sql`.
Why: main §14.3.5 requires DLQ entries carrying "step, idempotency key, input refs, last error, attempt timestamps" and a one-action replay; T0.4's done-when is "DLQ entry carries step + key + error". main §13 lists no such table. **This breaks the letter of CLAUDE.md's "migrations are added only by schema-wave cards"** — flagged rather than done quietly. It is a wave-1 addendum committed minutes after wave 1 in the same milestone by the same session; the integrator should either fold it into wave 1 or accept it as a mini-wave. `job_id`/`step_id` are nullable because publish, sweeps and email sends dead-letter through the same table without being ingestion steps.
Nearest spec: main §14.3.5, §13; CLAUDE.md migration rule.

## 2026-08-27 — T0.4 — The completed-key ledger is `job_steps` itself, with a known limit
Decision: `lookupCompletedKey` reads `job_steps WHERE idempotency_key = $1 AND state = 'succeeded'`, and `output_ref` holds the stored output. No separate ledger table.
Why: §13 puts `idempotency_key` on `job_steps` and §14.3.2 says "the *cache is the ledger*: 'have I done this work' and 'where is the result' are the same lookup" — this is the reading that requires no new table. **The limit it accepts**: deleting a job cascades its steps, which erases those ledger entries; work whose key lived only on a deleted run would execute again. That is acceptable because runs are not deleted in normal operation (accounts are, and then the work is moot), but it is the reason a dedicated ledger table would be the alternative if run pruning is ever added.
Nearest spec: main §14.3.2, §13 `job_steps`.

## 2026-08-27 — T0.4 — Step dependency graph
Decision: `detect → oauth_wait → catalog_sync → distill → family_group → persona → keywords_competitors → {gsc_connect, awaiting_confirmation}`, with `awaiting_confirmation` depending on `keywords_competitors` only.
Why: main §6's numbered steps give the order. The one judgement call is `gsc_connect`: §6.7 puts it "right after keyword/competitor discovery and before confirmation", while §14.3.1 says it "never blocks `awaiting_confirmation`". Both are satisfied by making it depend on `keywords_competitors` while confirmation does not depend on it — so skipping GSC (Limited Intelligence, §7.11) cannot stall onboarding. A `skipped` dependency counts as satisfied for the same reason. Tested.
Nearest spec: main §6.1–6.8, §14.3.1 — the ordering is prose, never a graph.

## 2026-08-27 — T0.4 — Cron stays off until every scheduled task has a handler
Decision: `CRON_ENTRIES` registers all 13 recurring jobs tech §2 names, but `bootstrapWorker` enables cron only when every entry resolves to a registered task; `startWorker` throws if asked to enable cron with a gap. M0 ships an empty task registry, so the worker runs with no schedule.
Why: A crontab entry naming a task nobody registered is a scheduled job that silently never runs — discovered a month later when the retention sweep turns out never to have swept. The registry plus the assertion turns that into a startup error. The log line names what is still missing, so it reads as a to-do rather than a fault.
Nearest spec: tech §2 — lists the scheduled jobs; silent on what happens when one has no handler.

## 2026-08-27 — T0.4 — Crontab is UTC; per-account clocks are resolved inside the task
Decision: All 13 entries use UTC schedules. Work that main §9.4 / §9.6.1 defines in the persona country's timezone (the publish hour, the Monday signal scan) is filtered inside the task against `account_settings.timezone`.
Why: A crontab cannot express "09:00 in each account's own zone", and pretending otherwise is how a German store gets published to at 09:00 UTC. Making this explicit now stops a later card from reading `0 9 * * *` as satisfying §9.4.
Nearest spec: main §9.4, §9.6.1 — define the clock, not the mechanism.

## 2026-08-27 — T0.4 — Typed failure classes, with token errors routed away from the DLQ
Decision: `RetryableFailure` / `TerminalFailure` carry an `errorClass` slug; `TokenInvalidFailure` is a terminal subclass carrying the provider. An unrecognised exception is classified retryable.
Why: main §14.3.5 makes the *class*, not the exception shape, decide what happens next, and says "token errors route to `awaiting_shopify_auth` (§6.2), everything else to the DLQ" — modelling that as a class lets the executor route it without string-matching a message. Retryable-by-default for unclassified errors is the safe side under an at-least-once queue: a spurious retry costs a run, a spurious dead-letter costs a stalled account.
Nearest spec: main §14.3.5 — names the classes and the routing, not their representation.

## 2026-08-27 — T0.4 — In-process worker starts from `apps/web/instrumentation.ts`
Decision: Next's `register()` hook calls `bootstrapWorker()` on the Node runtime; `WORKER_ENABLED=false` skips it.
Why: tech §2.1 requires the worker in the same Node process as the server, and `instrumentation.ts` is the only once-per-server-process startup hook the App Router offers. The env switch is what makes the later split to a dedicated Railway service "a config change (same image, different start command)" rather than a code change.
Nearest spec: tech §2.1.

## 2026-08-27 — T0.4 — Each integration test suite gets its own database
Decision: `setupTestDb(label)` creates and migrates `sortiva_test_<label>`, dropped and recreated per run.
Why: vitest runs test files in parallel; two suites truncating the same tables produce failures that look like constraint bugs and are not (observed while building this card). Per-suite databases cost about a second each and remove the whole class.
Nearest spec: tech §5, §6 — CI runs integration tests; silent on isolation.

## 2026-08-27 — T0.3 — Drizzle ORM + drizzle-kit for schema and migrations
Decision: `packages/db` defines the schema in TypeScript (`src/schema/*.ts`); `drizzle-kit generate` diffs it into forward-only SQL in `packages/db/migrations`; `drizzle-kit migrate` applies it. Repositories query through Drizzle.
Why: **Founder decision, asked and answered in session** (alternatives offered: Kysely + hand-written SQL migrations; plain `pg` + node-pg-migrate). Consequence carried forward: the generated migration is the reviewed artefact — once merged it is never regenerated in place, and a schema-wave card commits the `.sql` alongside the schema change so the integrator reviews SQL, not a TypeScript diff.
Nearest spec: tech §2 names Postgres 16 and Graphile Worker; CLAUDE.md requires forward-only migrations in `packages/db/migrations`. Neither names a tool.

## 2026-08-27 — T0.3 — Scope is a branded type, not an `accountId: string` parameter
Decision: Repository methods take `AccountScope` (branded, only producible by `accountScope(id)`) as their first argument. `SystemScope` (branded, carries a written reason) covers the account-less tables. `packages/db/src/scope.test-d.ts` proves omission and substitution are compile errors via `@ts-expect-error`, checked by `pnpm typecheck`.
Why: CLAUDE.md requires "every repository method requires an `accountId` scope parameter", and T0.3's done-when is "a repository call without scope fails to compile". A plain string parameter satisfies neither in practice: any string type-checks, including one read straight from a request body — which tech §3 explicitly forbids ("resolves `account_id` from session — never from the request body"). The brand makes that specific mistake impossible rather than merely discouraged.
Nearest spec: tech §3; CLAUDE.md code-structure rules.

## 2026-08-27 — T0.3 — `SystemScope` for the five wave-1 tables that have no account
Decision: `stripe_events`, `webhook_events`, `request_cache`, `preview_cache` and `email_suppressions` are reached through repositories taking `SystemScope('<reason>')` rather than through unscoped access.
Why: CLAUDE.md says "there is no unscoped table access outside migrations and admin scripts", but these five genuinely have no `account_id` — a webhook is HMAC-verified and stored before it is routed (main §14.3.8), a preview happens pre-signup (main §3), the request cache is keyed by canonical params rather than by tenant (main §14.3.6), and a suppressed address stays suppressed across accounts (tech §1.5). **Flagged as a contradiction rather than resolved silently**: the rule as written has no case for them. `SystemScope` keeps the rule's intent (no method without a scope; system access is explicit and greppable) while admitting the exception in the type system instead of in a comment.
Nearest spec: CLAUDE.md code-structure rules vs main §13 — the rule does not contemplate account-less tables.

## 2026-08-27 — T0.3 — Three columns added beyond main §13's table sketches
Decision: `job_steps.output_ref` (jsonb), `webhook_events.source` (enum shopify|resend), `request_cache.kind` (text). Plus `request_cache.response_ref` is realised as `response_json` (jsonb).
Why, one at a time. **`job_steps.output_ref`**: main §14.3.2 requires "completed keys are stored with their output reference; a worker seeing a completed key returns the stored output without executing", and T0.4's done-when tests exactly that — but §13's `job_steps` sketch has nowhere to put the output. Without this column T0.4 cannot pass. **`webhook_events.source`**: tech §1.4 routes Resend webhooks through the same receiver pattern as Shopify's; without a discriminator the table cannot tell whose id it holds. The unique constraint stays on `webhook_id` alone exactly as §13 states — `source` is for routing, not identity. **`request_cache.kind`**: §14.3.6 distinguishes billable reads from LLM calls and the retention sweep and cost dashboards need to separate them; deriving that from the key's shape would be parsing. **`response_json`**: tech §2.1 rules out Redis and any blob store ("Postgres is the cache"), so there is nothing for a "ref" to point at.
Nearest spec: main §13 (sketches), §14.3.2, §14.3.6, §14.3.8; tech §1.4, §2.1.

## 2026-08-27 — T0.3 — Two columns added for lifecycle mechanics §13 implies but does not list
Decision: `domains.release_after` and `shopify_conns.invalidated_at`.
Why: main §14.6 requires the domain claim be "released after a 7-day grace window" on account deletion — the row must survive that window still holding the unique index, so the release needs a timestamp to sweep on (T8.3 fills it). main §14.4 requires a 401 from Shopify to move the account to `awaiting_shopify_auth`; recording *when* the token was found invalid is what lets the 24h reminder sweep (T2.1) be idempotent.
Nearest spec: main §14.6, §14.4 — both mandate the behaviour, §13 lists no column.

## 2026-08-27 — T0.3 — Partial unique indexes make an active kill switch singular
Decision: `ops_flags` carries two partial unique indexes — one active `global` flag per name, one active `account` flag per (account, name), both `WHERE reset_at IS NULL` — plus a check constraint that a `global` flag has no `account_id` and an `account` flag must have one.
Why: main §14.5 says auto-trips "never auto-reset" and "every flip is logged with actor + reason", which implies at most one open incident per flag. Without the index a retrying auto-trip writes a new incident row on every dequeue. With it, the second trip is a no-op at the database level and the repository returns `undefined` — the same insert-with-conflict shape as every other dedupe in this schema.
Nearest spec: main §14.5 — states the semantics, not the constraint.

## 2026-08-27 — T0.3 — `notifications.dedupe_key` is NOT NULL
Decision: Every notification row must name its dedupe key.
Why: tech §1.2 makes `(account_id, type, dedupe_key)` the exactly-once guarantee under at-least-once workers, and lists a key for every type (article_id, topic_id, opportunity_id, ISO week, date). A nullable column would silently disable the constraint for the one type someone forgot, since Postgres treats NULLs as distinct in a unique index — the exact failure mode invariant 26 exists to prevent.
Nearest spec: tech §1.2 — names the key per type, does not say the column is required.

## 2026-08-27 — T0.3 — The constraint suite fails loudly when no database is present
Decision: `constraints.test.ts` skips its cases when Postgres is unreachable, but a final test then throws with instructions to run `pnpm db:up`.
Why: A silently-skipped constraint suite reports green while proving nothing — and this is one of the three audit-flagged cards. Skip-plus-fail keeps the developer-experience benefit (a clear message rather than 21 connection errors) without letting CI or a local run pass on an empty result.
Nearest spec: tech §5, §6 — CI gates on integration tests; silent on absent-dependency behaviour.

## 2026-08-27 — T0.3 — Relative imports are extensionless repo-wide
Decision: `import { x } from './y'`, not `'./y.js'`, in every package.
Why: `moduleResolution: "Bundler"` (T0.1) makes extensionless the idiom, and drizzle-kit's config loader transpiles to CJS and cannot resolve `.js` specifiers pointing at `.ts` files. Applied consistently rather than per-package so there is one convention.
Nearest spec: none — internal.

## 2026-08-27 — T0.2 — Per-locale demand floors: values invented, flagged UNSIGNED
Decision: `gates.demand_floor.monthly_search_volume_min` defaults to 100/mo, with per-language overrides descending to 10/mo for the smallest EU markets (en 100 · de/fr/es 60 · it/pt 50 · nl/pl 40 · sv/da/nb/fi/cs/hu/ro/el 20 · sk 15 · sl/et/lv/lt 10). Keyed by language subtag; the resolver falls back full tag → language → global default.
Why: main §8.2 requires per-country floors ("50/mo in Danish ≠ 50/mo in English") and supplies no table, and T0.2's done-when requires the keys to exist. Floors are set roughly proportional to the search market's size so equivalent commercial seriousness clears the bar in a small language as in English. **These numbers need founder calibration sign-off** — they decide which topics Gate 1 admits, which is user-visible. Nothing consumes them until T4.1, so changing them is a one-line YAML edit.
Nearest spec: main §8.2 — mandates per-locale floors, states no values. Appendix B does not cover them.

## 2026-08-27 — T0.2 — Five further UNSIGNED numbers the specs mandate but do not state
Decision: `gates.winnability.limited_intelligence_constant: 0.25` (main §9.6.4 says "a conservative constant"); `gates.substance_floor` = 8 distinct facts / 4 populated fields per product / 3 contributing products, margin ×1.5 (main §8.2 defines the metric, no floor); `auto_trips.account_llm_spend.hard_cap_usd_per_day: 5.00`, `auto_trips.dataforseo_spend.global_cap_usd_per_day: 50.00`, `auto_trips.preview_spend.global_cap_usd_per_day: 10.00`, `budgets.intent_gap.analyses_per_account_per_day: 10` (main §14.5 names each cap as "configured"/"config", none with a number); `learning.outcomes.optimize.impressions_not_collapsed_ratio_min: 0.5` (main §9.6.10 says "impressions not collapsed").
Why: T0.2's scope is "**every** number from ... §14.5 (auto-trip thresholds)", so the keys must exist. Each is marked `UNSIGNED` in the YAML. Sizing rationale: the account LLM cap is a loud-failure ceiling far above the ~$2.90/day of revenue a $89/mo plan produces, not a budget; the preview cap follows main §14.5's own note that this trip firing "means Turnstile, rate limits, or the cache are being defeated — investigate, don't just raise the cap", so it is deliberately low.
Nearest spec: main §14.5, §8.2, §9.6.4, §9.6.10 — each mandates the knob, none states the value.

## 2026-08-27 — T0.2 — main §8.4's gate floors are in signals.config.yaml, beyond the card's enumeration
Decision: `gates.draft_grading` holds §8.4's numbers — information gain ≥ 4, grounding ≥ 4, other criteria ≥ 3, one repair loop max, 1–5 score range.
Why: T0.2's card enumerates §7.3/§7.6/§8.2/§9.6/§10.2/§14.5 and does not name §8.4, but invariant 11 gates on those four numbers and there is no other home for them; leaving them out guarantees Lane D writes them as literals in T4.4. The lint rule cannot catch it (it matches volume/position/impression/CTR field names, not judge scores), so the config is the only defence. Trivially reversible: delete one YAML block and one schema block.
Nearest spec: main §8.4 — states the floors; §7.10 does not list §8.4 among the sections it governs.

## 2026-08-27 — T0.2 — main §14.1 drift thresholds stay out of signals.config.yaml
Decision: The Product Change Impact drift numbers (OOS ≥ 14d, price ≥ 20%, deleted, family-axis change) stay with the drift/repair card; the signal entry here carries only priority and GSC-dependence, with a pointer.
Why: §7.10's config layer is scoped to §7.3/§7.6/§8.2 (+§9.6 via its parenthetical), and §7.3's row for this signal defers wholesale to §14.1 ("already built as the repair loop"). Pulling §14.1's table forward would put thresholds in this file that no §7.10 reader expects and that the drift card owns. Flagged for the integrator: if the invariant sweep prefers one home for every number, this is the block to move.
Nearest spec: main §7.3 (row) → §14.1 — silent on which module owns the values.

## 2026-08-27 — T0.2 — rules_version is the full sha256 hex of the file's bytes
Decision: `rules_version = sha256(utf8 bytes of signals.config.yaml)`, 64 hex chars, not truncated and not derived from the parsed document.
Why: main §7.10 and tech §2 both say "content hash". Hashing raw bytes rather than the parsed tree means a comment or ordering change also produces a new version — correct, because main §8.5's calibration posture treats every edit to this file as a reviewable change, and §14.7's weekly review breaks PostHog down by `rules_version`.
Nearest spec: main §7.10 — "its content hash", no format given.

## 2026-08-27 — T0.2 — Locale overrides are validated after merging, not in isolation
Decision: A locale layer restates only the keys it changes. The loader deep-merges it over `defaults` and validates the *merged* layer against the full schema (`additionalProperties: false`).
Why: A partial layer cannot be validated on its own without a second, weaker schema — which is exactly how a typo (`monthly_search_volume_typo`) becomes a value that is silently never read. Validating the merge turns that into a startup failure. Tested.
Nearest spec: main §7.10 — specifies the layering, not its validation.

## 2026-08-27 — T0.2 — Hand-written TypeScript types alongside the JSON Schema
Decision: `packages/rules/src/types.ts` mirrors `schema/signals.config.schema.json` by hand rather than being generated from it.
Why: Two sources of truth, accepted knowingly. The generator route (`json-schema-to-ts`) adds a dependency and a build step to a package that deliberately has neither, for a document that changes only through the §8.5 calibration process. The 100-row threshold-enumeration test walks the config through the typed accessor, so a drift between schema and types surfaces as a test failure rather than as a runtime surprise. Revisit if the document starts changing often.
Nearest spec: none — internal to packages/rules.

## 2026-08-27 — T0.2 — Committed snapshot is the fully resolved config, defaults plus every locale
Decision: `packages/rules/snapshot/loaded-config.json` holds `rules_version`, the resolved defaults, and each locale's fully merged layer, written and checked by vitest's file snapshot.
Why: A snapshot of the raw YAML would only restate the file. Snapshotting the *resolved* layers makes the merge semantics reviewable in a diff — a change to one default that silently alters twenty locale layers shows up as twenty lines in the PR. Also means editing a threshold without updating the snapshot fails CI, so no threshold change lands unreviewed.
Nearest spec: build plan T0.2 done-when — "snapshot of the loaded config committed".

## 2026-08-27 — T0.1 — pnpm workspaces with no build-orchestrator layer
Decision: Monorepo is plain pnpm workspaces (`apps/*`, `packages/*`, `tools/*`) with fan-out via `pnpm -r`. No Turborepo/Nx.
Why: The constitution names the package list and the tech spec names a single deployable; neither implies a task graph. One `pnpm -r run typecheck` and one root `vitest`/`eslint` invocation cover CI today, and adding a cache layer is reversible at any point without touching package boundaries.
Nearest spec: tech §2 — names the stack, silent on build tooling.

## 2026-08-27 — T0.1 — Workspace packages are consumed as TypeScript source
Decision: `@sortiva/*` packages point `main`/`types`/`exports` at `src/*.ts` and have no build step. `apps/web` lists them in `transpilePackages`; vitest and `tsc` read the sources directly.
Why: Removes an entire build-ordering problem between eight packages for a codebase that ships as one Next.js deployable. Consequence a later card must respect: any non-Next consumer (the Graphile worker bootstrap, scripts) must run through a TS-aware loader, which the worker bootstrap in T0.4 does.
Nearest spec: tech §2.1 — "same codebase", one image; silent on module format.

## 2026-08-27 — T0.1 — Constitution lint rules are a local ESLint plugin, not `no-restricted-imports`
Decision: `tools/eslint-plugin-sortiva` provides three rules: `no-direct-provider-sdk` (invariant 25), `no-threshold-literals` (invariant 9), `route-handler-imports` (code-structure rule).
Why: Two of the three cannot be expressed with built-in rules. The threshold ban must inspect *what a number is compared against*, and the route-handler rule must be an allowlist (handlers may import only core + serialisers) where `no-restricted-imports` only expresses a denylist. Making the SDK ban a custom rule too keeps all three in one place with spec citations in the messages, and makes the vendor list extensible as `SeoDataProvider`/`EmailProvider`/Stripe/PostHog wrappers land.
Nearest spec: main §7.10, §14.7; CLAUDE.md code-structure rules.

## 2026-08-27 — T0.1 — Threshold-literal rule: field-term list and test exemption
Decision: `no-threshold-literals` fires on a numeric literal compared against an identifier or property whose name (camelCase normalised to snake_case, whole name or trailing word) is one of `volume, position, impression(s), click(s), ctr`. It is disabled inside `packages/rules`, and inside `*.test.ts` / `fixtures/`.
Why: The constitution's wording is "numeric comparisons against volume/position/impression/CTR fields"; this is that list made mechanical. The test exemption is necessary because the tests that prove `packages/rules` serves the right numbers must state those numbers. The risk it accepts: a threshold smuggled into production code through an intermediate variable with an unrelated name is not caught by lint — the T0.2 config-key enumeration test is the second line of defence.
Nearest spec: main §7.10 — mandates the lint, does not define its matcher.

## 2026-08-27 — T0.1 — Planted lint violations are a CI check, not a one-time demonstration
Decision: `pnpm lint:prove` (`scripts/prove-lint.mjs`) writes the two violations the card names into throwaway files, asserts `eslint` rejects each with the expected rule id, and deletes them. It runs in CI.
Why: The done-when is a property of the lint config that can silently regress (a broadened ignore, a disabled rule). Proving it once at authoring time proves nothing about next month.
Nearest spec: build plan T0.1 done-when — silent on how the proof is retained.

## 2026-08-27 — T0.1 — Vitest as the unit/integration runner; Playwright reserved for UI flows
Decision: Vitest at the repo root for every `*.test.ts`; Playwright is scaffolded separately in T0.6 for the flows tech §6 assigns to it.
Why: tech §6 names Playwright only for UI flows and leaves everything else as "unit/integration tests". One root vitest project keeps the fixed-name suites the constitution requires (`distillation.eval`, `judge.eval`, `persona.smoke`, `signals.fixtures`, `chaos`) discoverable by a single glob.
Nearest spec: tech §6 — names the mapping, not the runner.

## 2026-08-27 — T0.1 — Local Postgres on port 54329
Decision: `docker-compose.yml` maps Postgres 16 to host port 54329, not 5432.
Why: Avoids colliding with a developer's system Postgres (one is installed on this machine). Purely local; CI and Railway are unaffected.
Nearest spec: tech §5 — "local: docker-compose Postgres", silent on ports.

## 2026-08-27 — T0.1 — `.env` keeps non-secret local defaults rather than being literally empty
Decision: `.env` mirrors every key in `.env.example`; secrets are blank, but `DATABASE_URL`, `NODE_ENV`, `APP_URL`, `POSTHOG_HOST`, `SEO_PROVIDER_MODE=mock` and the `WORKER_*` values are carried over. `pnpm env:check` fails if the two files' key sets ever diverge.
Why: The founder's instruction was "an identical `.env` with empty values"; blanking the local database URL and the mock-provider switch would make a fresh clone fail to run tests, which is the opposite of the intent. Flagged rather than resolved silently. `SEO_PROVIDER_MODE=mock` in particular is a cost guard — tech §5 puts real DataForSEO spend in prod only.
Nearest spec: tech §4 — "`.env.example` documents every required variable", silent on `.env`.

## 2026-08-27 — T0.1 — Railway `postgres` is template-provisioned, not declared in `railway.toml`
Decision: `railway.toml` configures the `app` service only (build, start command with `--max-old-space-size=384`, healthcheck on `/api/health`, `sleepApplication = false`, one replica). The `postgres` service is created from Railway's Postgres template and reaches `app` via `DATABASE_URL`.
Why: Railway's repo-level config describes the service built from the repo; database services are provisioned from templates and cannot be declared there. This is a Railway constraint, not a departure from tech §2.1's two-service topology.
Nearest spec: tech §2.1 — specifies the topology, not the file that expresses it.
