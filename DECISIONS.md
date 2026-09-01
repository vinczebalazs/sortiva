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

## 2026-09-01 — T1.4 — The domain claim resolves eTLD+1 with `tldts`, ICANN section only, plus an explicit multi-tenant allowlist
Decision: `packages/core/src/domain/normalise.ts` resolves the registrable domain with the `tldts` package (a new dependency of `packages/core`, MIT, bundles the Public Suffix List). It uses the list's ICANN section only, and adds one explicit allowlist entry — `myshopify.com` — for which the claim stops one label lower (`acme.myshopify.com`, not `myshopify.com`).
Why: main §2 requires eTLD+1 "using the Public Suffix List", which is a data set, not an algorithm — a hand-rolled "last two labels" rule gets `example.co.uk` wrong, and hand-maintaining the list is worse. The alternative rejected is turning on the list's PRIVATE section wholesale, which `tldts` offers as a flag: that section holds thousands of entries (`github.io`, `blogspot.com`, `s3.amazonaws.com`), so enabling it would silently change how every merchant on any of those platforms is claimed. main §2 asks instead for "allowlisting known multi-tenant suffixes", so the allowlist is a code constant with a test pinning its contents, and adding an entry is a deliberate change. Also decided here: a host whose suffix is not in the ICANN list (`example.con` — a typo, not a store) is rejected as ui §3.1's "invalid domain" rather than claimed, because claiming it parks an account on a domain that can never resolve. No DNS lookup happens at claim time; unreachability is the `detect` step's business (main §6.1).
Nearest spec: main §2 — names the Public Suffix List and the allowlist, silent on the library and on unknown TLDs.

## 2026-09-01 — T1.4 — The claim returns a four-way result decided inside one transaction, and the ingestion run commits with it
Decision: the claim port (`packages/core/src/domain/ports.ts`) is a single method, `claimWithIngestionRun`, which inserts with `ON CONFLICT DO NOTHING`, reads the conflicting row back **in the same transaction**, and returns `claimed | already_yours | taken_by_other | account_has_other_domain`. On a real claim it also creates the `ingestion_jobs` row and its `job_steps` inside that transaction. The transaction is pinned to `read committed`.
Why: main §5 asks for three distinct behaviours and T0.3's `claimDomain` repository returns `undefined` for all of them (audit T0.3, `[minor]` "Claiming a domain cannot report which of three things went wrong"); this card is where that need became real. Reading the conflict back inside the transaction is what makes the answer non-stale — a follow-up query could see a different world than the insert did. The isolation level is load-bearing rather than incidental: under `read committed` each statement takes a fresh snapshot, so the loser of a race sees the winner's just-committed row and can say *why* it lost; under `repeatable read` it would see nothing and could not. Putting the ingestion run in the same transaction follows main §5 step 3 — a claim that committed without its run would leave the merchant on a progress screen nothing will ever advance, and no code path re-checks.
Nearest spec: main §5 steps 1–3; audit `docs/audits/T0.3.md`.

## 2026-09-01 — T1.4 — Claim persistence lives in `apps/web`, not `packages/db`, and replaces the repository's `claimDomain`
Decision: `apps/web/app/api/domain/_lib/store.ts` holds the transactional claim; `packages/db/src/repositories/domains.ts::claimDomain` is left untouched and is now dead code with no caller.
Why: the constitution puts repositories in `packages/db`, and this belongs beside `findDomainForAccount` there. `packages/db` was held by a concurrent session for the whole of this card and could not be edited — the same constraint T1.2 recorded for the billing queries. **The move is a mechanical follow-up for the integrator**, and it should replace `claimDomain` rather than sit next to it, so there is one claim function and not two with different guarantees.
Nearest spec: CLAUDE.md code-structure rules — repository location is convention, not spec.

## 2026-09-01 — T1.4 — `domains.release_after` is a deletion-sweep deadline, not a modifier on uniqueness
Decision: the claim path ignores `release_after` entirely. A domain row blocks every other account until the row is **deleted**; the 7-day grace of main §14.6 is implemented by the deletion sweep (T8.3) not deleting the row before the deadline. A test in `apps/web/app/api/domain/_lib/domain.test.ts` pins this: a claim is refused while `release_after` is in the future *and* while it is in the past, and succeeds once the row is gone.
Why: audit T0.3 flagged the column as "a mechanism with nothing behind it" and asked for a decision between (a) a partial unique index `WHERE release_after IS NULL`, which makes the release real in the database, and (b) an audit note on a row a later card hard-deletes. (b) is what ships, because (a) needs a migration and this card is forbidden from adding one while two other branches carry migrations. Consequence to accept knowingly: the release depends on the sweep job running. If T8.3's sweep never runs, the domain stays blocked forever — which fails in the safe direction (nobody is handed someone else's domain) but does not deliver §14.6's "released after 7 days". **Recommended for the next schema wave:** the partial index, as defence in depth, together with the matching one on `shopify_conns.invalidated_at`. Until then the column means "the sweep may delete this row after this time" and nothing else.
Nearest spec: main §14.6 — "domain claim released after a 7-day grace window"; audit `docs/audits/T0.3.md`.

## 2026-09-01 — T1.4 — An account that already holds a different domain gets 422 `account_has_other_domain`, not a 409
Decision: when the session's account already holds another domain, the route answers HTTP 422 with `{ code: 'account_has_other_domain' }` and a message naming the domain they already hold. Only "someone else has it" answers 409 `domain_already_claimed` with main §5's verbatim string.
Why: invariant 1 has two halves and main §5 writes copy for only one of them; the other is unreachable through the intended UI, because main §4.3 shows the connect box only to an account with no domain. It is reachable by a stale tab, a second browser, or a direct API call. The frozen route table (T0.7) lists `domain_already_claimed` as the one conflict code this route may return, and that enum is closed on purpose — the UI maps each code to specific copy — so this card may not add one, and reusing `domain_already_claimed` would send a merchant to support with the wrong story about their own domain. 422 keeps the closed 409 enum intact while still being a machine-readable refusal. **This is invented user-facing behaviour and copy; it needs founder ratification, and if the answer is "there should be a self-serve way to change your domain" it becomes a different card entirely.**
Nearest spec: main §5 — silent on this case; `packages/core/src/api/errors.ts` — the closed conflict enum.

## 2026-09-01 — T1.4 — The claim enqueues durable step rows, not a Graphile job
Decision: claiming creates the `ingestion_jobs` row and all nine `job_steps` rows (via the worker runtime's own `createRun`), with `detect` the only step whose dependencies are met. It does **not** push a Graphile Worker job.
Why: main §5 step 3 says the claim "enqueues the deep ingestion job", and the durable record of that job is the run and its steps — which is what ui §3.2's progress stepper renders and what a worker re-dispatches from after a crash (main §14.3.1). The task that executes `detect` does not exist: `packages/jobs`' task registry is empty and T2.1 (Lane B) owns the `detect` step. Queueing a job naming an unregistered task would create a permanently failing job, and the worker deliberately refuses to enable cron until every scheduled task has a handler. So the run waits, correctly, for the first worker able to run it. The run id is derived — `claim:<domain_normalized>` — per main §14.3.2, so a retried or repeated claim reuses one run instead of starting a second onboarding. **T2.1 must dispatch from these rows, not create its own run.**
Nearest spec: main §5 step 3, §14.3.1–14.3.2 — silent on which half of "enqueue" the claim owns.


## 2026-09-01 — T1.3 — `loadPrompt` cannot be called from the Next bundle; the preview reads its prompt file directly
Decision: `apps/web/app/api/preview/_lib/config.ts` reads `packages/llm/prompts/preview.v1.md` through a single literal `new URL(<file>, import.meta.url)` and `readFileSync`, and deep-imports `@sortiva/llm/client` so the barrel (which re-exports the loader) is never pulled into the bundle.
Why: `packages/llm/src/prompts.ts` builds its path as `new URL('../prompts/', import.meta.url)` — a **directory**. Webpack resolves `new URL()` at build time and fails with "Module not found: Can't resolve '../prompts/'", so `next build` breaks the moment any route imports `@sortiva/llm`. Verified: adding the package to `transpilePackages` does not help. A single literal *file* URL is the form webpack handles, which is why `packages/rules` already loads `signals.config.yaml` this way and builds fine.
**This is a shared problem, not a preview problem, and it needs a one-line fix in `packages/llm` that T1.3 was not permitted to make:** compose the path as one literal (e.g. `new URL(\`../prompts/${version}.md\`, import.meta.url)`) or resolve from `fileURLToPath(new URL('.', import.meta.url))` with `node:path`. Until then, every Next-side card that needs a prompt hits the same wall. The preview's local reader should be deleted the moment `loadPrompt` is bundler-safe.
Nearest spec: main §14.2 — "prompts live in versioned files in the repo"; CLAUDE.md — `prompts/<name>.v<N>.md` loaded via `loadPrompt`.

## 2026-09-01 — T1.3 — The preview cache **writer** lives in `apps/web`, not in `packages/db`, and should be moved
Decision: `PostgresPreviewCache` (read + write of `preview_cache`) and `OpsFlagPreviewSwitch` are in `apps/web/app/api/preview/_lib/store.ts`. They use the shared `previewCache` table definition and a `SystemScope` exactly as a repository would.
Why: `packages/db/src/repositories/system.ts` already has `readPreviewCache` and is the correct home for the matching writer, but this card was instructed not to edit `packages/db` while other sessions hold it. **Flagged rather than resolved silently**: this is the one place in the codebase where table access sits outside `packages/db`, which CLAUDE.md's code-structure rules do not allow for. It is a cut-and-paste move at the next integration pass, and the invariant-2 boundary test already restricts who may name `previewCache` to exactly this directory.
Nearest spec: CLAUDE.md code-structure rules — "no unscoped table access outside migrations and admin scripts"; main §13 `preview_cache`.

## 2026-09-01 — T1.3 — The preview endpoint reads the spend trip; it does not raise it
Decision: the preview checks one `ops_flags` row, `global.pause_preview`, on every cache miss. The job that sums the day's preview LLM spend and compares it against `auto_trips.preview_spend.global_cap_usd_per_day` (already in `signals.config.yaml`) is **not** in this card.
Why: invariant 17 puts spend enforcement in our own code against our own DB counters, and card R2 is building that cost ledger in another worktree. Inventing a second spend counter here would give the product two answers to "what did previews cost today". What T1.3 delivers is the half §14.5 describes as behaviour — "serve cache hits as normal, and answer cache misses with the graceful generic card" — wired to a flag anything can raise. **Outstanding:** nothing raises `global.pause_preview` automatically until R2's ledger lands; today it is a manual switch.
Nearest spec: main §14.5 — names the trip and its effect; §14.7 — "the budget auto-trips read spend from our own DB counters".

## 2026-09-01 — T1.3 — The preview's numbers live in `packages/core/src/preview/limits.ts`
Decision: the fetch budget (8 s / 1.5 MB / 2 redirects), the rate limits (5/min, 20/day, 4 concurrent scrapes), the 7-day TTL, the ~200-char signal floor and the ~2k-token input budget are named constants in one file, each carrying its spec §.
Why: invariant 9 puts thresholds in `packages/rules`, but `signals.config.yaml` is scoped by T0.2 to the Opportunity Engine's numbers (main §7.3, §7.6, §8.2, §9.6, §10.2, §14.5) and this card may not edit that package. These are main §3.2's endpoint budget, which that config has no section for. If the integrator wants them tunable without a deploy, they need a `preview:` block in `signals.config.yaml` and a schema change — a rules-package card, not this one.
Nearest spec: main §7.10 / invariant 9 — "no threshold literal outside `packages/rules`", written about the scoring layer.

## 2026-09-01 — T1.3 — Rate limits and the outbound concurrency cap are per process
Decision: `PreviewRateLimiter` and `OutboundScrapeCap` hold their counters in memory in the `app` process.
Why: tech §2.1 pins v1 to a single `app` service and "no Redis in v1", and a Postgres round trip per public request to count requests would cost more than the fetch it protects. **The limit this accepts:** if `app` is ever scaled past one replica, both become per-instance and the effective limits multiply by the replica count. That is survivable — they sit behind Turnstile and in front of a 7-day cache, and they are a cost guard rather than an authorisation boundary — but it is the thing to change first when a second replica is added.
Nearest spec: main §3.2 — states the limits, silent on where the counter lives.

## 2026-09-01 — T1.3 — A full outbound concurrency pool serves the generic card rather than queueing
Decision: `OutboundScrapeCap.acquire()` returns nothing when the cap is reached and the request answers with main §3.3's generic card.
Why: the alternative is holding a public request open behind other strangers' scrapes, which turns a concurrency cap into a latency amplifier and a denial-of-service lever. The generic card is the spec's own answer for "we could not read this site" and costs nothing.
Nearest spec: main §3.2 — "a global concurrency cap on outbound scrapes", silent on saturation behaviour.

## 2026-09-01 — T1.3 — Check order: URL → rate limit → Turnstile → cache → spend trip → fetch
Decision: the per-IP rate limit is checked before Turnstile; Turnstile gates the cache read as well as the fetch; the spend trip is checked *after* the cache.
Why, in order. Rate limiting first because it is local and free, so an abusive caller costs us nothing, not even a Cloudflare round trip. Turnstile before the cache because main §3.2 requires a token "on every request" — gating only the fetch would leave the cache scrapeable by any bot that skips the challenge. The trip after the cache because main §14.5 requires a tripped preview to "serve cache hits as normal".
Nearest spec: main §3.2 — "verified server-side before any fetch happens"; §14.5.

## 2026-09-01 — T1.3 — A generic card is never written to the preview cache
Decision: only a real summary produces a `preview_cache` row. Fetch failures, thin pages, model failures, the spend trip and the concurrency cap all return the generic card without storing it.
Why: the TTL is 7 days (main §3.2). Caching a failure would mean a site that was down for ten minutes shows every later visitor "we couldn't read this site" for a week — the funnel dead-ending in slow motion, which is exactly what main §3.3 forbids. The cost of not caching failures is bounded by the rate limits and the Turnstile check in front of them.
Nearest spec: main §3.3 step 6 — "store `{domain, summary, fetched_at}`", silent on failures.

## 2026-09-01 — T1.3 — Rate-limited and challenge-failed requests emit no PostHog event
Decision: `preview_requested` is captured after the rate limit and Turnstile have both passed; a refused caller produces no event at all.
Why: a public endpoint that captures an event per rejected request hands an attacker a free way to inflate our PostHog bill and distort the funnel. §14.7's preview abuse canary is "total preview spend/day", which is unaffected — a refused request spends nothing. **The limit this accepts:** blocked-attempt volume is not visible in PostHog; it is visible in the app logs and in the 429 rate at the edge.
Nearest spec: main §14.7 — lists `preview_requested` / `preview_served`, silent on refusals.

## 2026-09-01 — T1.3 — The preview's Haiku call returns prose, with no JSON schema
Decision: `call_type: preview` sends no `schema`, and `runPreview` treats a completion under 20 characters as a failed summary.
Why: main §14.2's schema-validation rule names its call types explicitly — "distillation, persona, seeds, judge" — and preview is not among them; main §3.3 asks for "a 2–3 sentence plain-language summary". Wrapping one short paragraph in JSON would spend a meaningful share of a 150-token output budget on punctuation. The degeneracy check preserves §14.2's actual principle, "never parse what we can", for prose.
Nearest spec: main §14.2, §3.3.

## 2026-09-01 — T1.3 — Extraction is regular expressions over a capped string, not a DOM
Decision: `extractPreviewSignals` reads `<title>`, meta description, OpenGraph tags and JSON-LD with regular expressions and strips tags for the body-text fallback. No `jsdom`, no `@mozilla/readability`.
Why: main §3.3 titles the pipeline "cheap by design" and calls step 3 "Readability.js-**style**". A real DOM parse of hostile HTML on the product's only public endpoint is both a memory cost per request and an attack surface, for output that feeds one 150-token summary. Input is capped before parsing and malformed JSON-LD is skipped rather than thrown.
Nearest spec: main §3.3 step 3.

## 2026-09-01 — T1.3 — The preview normalises to a host, not to eTLD+1
Decision: `normalisePreviewUrl` lowercases, strips the scheme, `www.`, the path, the query and any port, and keeps every other subdomain. `shop.example.com` and `example.com` are two preview cache rows.
Why: the domain *claim* normaliser (main §2, §5 — PSL eTLD+1, T1.4) folds subdomains together because one account owns one business. A preview must not: it fetches the exact site pasted, and folding `shop.example.com` into `example.com` would show a stranger a card about a different website. **The consequence to know about:** §14.7 says a domain's pre-signup preview spend becomes visible when it later connects; that join works on the `www`-stripped host, so a visitor who previewed a subdomain and later claims the apex will not have the two joined. Preview output is disposable (invariant 2), so nothing else depends on the two agreeing.
Nearest spec: main §3.2 — "cache key = normalized domain", silent on which normalisation.

## 2026-09-01 — T1.3 — The preview always fetches the homepage over https
Decision: whatever is pasted, the fetch target is `https://<domain>/`.
Why: main §3.3 step 1 is "fetch homepage HTML" regardless of the pasted path, and main §3.2's budget is "one page fetch". Trying http after an https failure would be a second fetch outside that budget; a store that is http-only in 2026 gets the generic card.
Nearest spec: main §3.2, §3.3 step 1.

## 2026-09-01 — T1.3 — The visitor's address comes from `x-forwarded-for`
Decision: the per-IP bucket is the left-most `x-forwarded-for` entry, then `x-real-ip`, then a shared `unknown` bucket.
Why: Railway proxies to the app, so the socket address is always the proxy's and per-IP limiting would otherwise be one global bucket. A spoofed header can only cost the spoofer their own bucket, never anyone else's, because the limit is a cost guard in front of a cache and not an authorisation boundary. The `unknown` bucket means a request arriving with no proxy headers at all shares one limit with every other such request, which is the conservative direction.
Nearest spec: main §3.2 — "per-IP", silent on how the IP is determined behind a proxy.

## 2026-09-01 — T1.3 — A missing Turnstile secret answers 503, it does not disable the check
Decision: `wire()` constructs `CloudflareTurnstile`, which throws when `TURNSTILE_SECRET_KEY` is absent; the handler turns that into `503 preview_unavailable`.
Why: mirrors T1.2's `BillingNotConfigured` handling. The alternative — running the preview with the check disabled when the secret is missing — makes a deploy misconfiguration silently open the funnel's spend to bots, which is the one failure main §14.5 says must never happen quietly.
Nearest spec: main §3.2; tech §4 — "`.env.example` documents every required variable".

## 2026-09-01 — T1.3 — `prompts/preview.v1.md` lands in `packages/llm`, crossing this card's directory constraint
Decision: the preview's system prompt is `packages/llm/prompts/preview.v1.md`, a new file in a package this session was told not to edit. Nothing else in `packages/llm` was touched; `packages/core` receives the prompt *text* through a port because `packages/llm` depends on `packages/core` and the reverse import would be circular.
Why: CLAUDE.md requires prompts to be versioned files at `prompts/<name>.v<N>.md`, and `packages/llm/prompts/README.md` already allocates the `preview` prompt to this card by name. Holding the prompt as a string constant in `packages/core` would break the versioning rule that makes `prompt_version` on a stored artefact meaningful. The file is new, so it cannot collide with a concurrent edit. **Flagged rather than done silently.**
Nearest spec: main §14.2 — "prompts live in versioned files in the repo"; CLAUDE.md code-structure rules.

## 2026-09-01 — T1.3 — The shared page fetcher lives in `packages/providers/src/fetch`, not in `packages/core`
Decision: the single SSRF-guarded HTTP client tech §2 requires is a new `packages/providers/src/fetch` module: `PageFetcher` interface, `GuardedPageFetcher` implementation, `MockPageFetcher` double, and the address/port policy as pure functions. `packages/core/src/preview` depends on a structural port, not on the implementation.
Why: it is an outbound I/O client behind an interface with a test double, which is precisely what `packages/providers` is for (CLAUDE.md plumbing rules); `packages/core` is domain logic and a boundary test keeps vendor plumbing out of it. Putting it in core would also mean core owning `node:dns` and `node:http`. The seam it is *not* in — `packages/core/src/contracts/` — was frozen at T0.7 and this card is not allowed to change it, so the interface ships beside its implementation and should be promoted into `contracts/` at the next re-freeze, before T2.5 (persona), T4.3 (evidence packs) and T6.1 (intent gap) start calling it.
Nearest spec: tech §2 — "one SSRF-guarded HTTP client ... serves every non-API page fetch", silent on which package.

## 2026-09-01 — T1.3 — The fetch policy is one object covering address categories *and* ports, with a named test carve-out
Decision: `FetchPolicy { allowedCategories, allowedPorts }`. Production is `PUBLIC_ONLY` — public addresses only, ports 80/443 only (main §3.2). `packages/providers/src/fetch/testing.ts` exports `loopbackAllowedPolicy(port)`, which differs only by admitting the `loopback` category and one ephemeral port.
Why: the redirect tests have to redirect *from* a real HTTP server, and a real server on this machine can only listen on loopback on an ephemeral port — both of which production correctly refuses. Rather than stub the guard out (which would make the tests a rehearsal), the carve-out is one named function, is not imported by any production code, and `fetch.test.ts` asserts that `PUBLIC_ONLY` refuses that same server on both counts. Every other blocked range — 10/8, 172.16/12, 192.168/16, 169.254/16, CGNAT, unique-local, multicast, reserved, tunnels — is still enforced by the same code production runs.
Nearest spec: main §3.2 — states the rule, silent on how to test it.

## 2026-09-01 — T1.3 — A host that resolves to *any* blocked address is refused entirely
Decision: `GuardedPageFetcher` resolves the hostname with `all: true` and rejects if a single returned address is out of policy, rather than picking a permitted one.
Why: a name answering with both a public and a private address is either misconfigured or hostile, and choosing the good one leaves the outcome to resolver ordering — which the attacker, not us, controls. Refusing the host is the only stable reading of main §3.2's "block private/reserved IP ranges after DNS resolution".
Nearest spec: main §3.2 — silent on multi-address answers.

## 2026-09-01 — T1.3 — The connection is pinned to the address the guard cleared
Decision: after validation the request is issued with a `lookup` function that ignores the hostname and returns the one validated address, with `agent: false` so no pooled socket bypasses it, plus a post-connect re-check of `socket.remoteAddress`.
Why: without pinning, the resolver runs a second time inside the socket layer, and an attacker controlling the DNS answer can return a public address for our check and a private one for our connection — DNS rebinding, the standard way a "checked" fetcher is defeated. Redirects are also followed manually for the same reason: a client's built-in redirect following would connect without re-running the guard.
Nearest spec: main §3.2 — requires the check, silent on the check-to-connect gap.

## 2026-09-01 — T1.3 — Outbound page fetches request no compression
Decision: the fetcher sends `accept-encoding: identity` and refuses any `Content-Type` outside html/xhtml/xml/plain text.
Why: the 1.5 MB cap (main §3.2) has to count bytes we would have to hold. A decompressing client turns that cap into a decompression bomb — a few hundred KB on the wire expanding to gigabytes in memory — on a public, unauthenticated endpoint. Refusing non-page content types stops us paying egress for a PDF or a video the extractor cannot read anyway.
Nearest spec: main §3.2 — "max download size (~1.5 MB)", silent on encoding.

## 2026-09-01 — T1.3 — Turnstile fails closed
Decision: `CloudflareTurnstile` throws at construction when `TURNSTILE_SECRET_KEY` is missing, and returns `success: false` when siteverify is unreachable or answers non-200.
Why: Turnstile is the first of the three cost controls on a public endpoint (main §3.2), and everything after it spends money. A verifier that passes traffic through when Cloudflare is down inverts its purpose; the funnel losing previews during a Cloudflare outage is the cheaper failure. Constructing rather than request-time throwing means a missing secret is an ops failure visible at boot, not a silent bypass.
Nearest spec: main §3.2 — "verified server-side before any fetch happens", silent on verifier failure.

## 2026-08-31 — T1.2 — The Stripe test-clock evidence is outstanding, and is not what the webhook replay proves
Decision: T1.2's done-when "test-clock scenarios (activate, payment_failed → past_due → paid, cancel_at_period_end) drive `subscriptions.status` correctly" is **recorded as not met**. A Stripe test clock is a live Stripe API feature and this build has no Stripe key, no webhook secret and no price ids. What was built and proved instead: the webhook sequences those three scenarios emit, replayed through the receiver and the status worker in order, newest-first, shuffled and twice, against real Postgres — `packages/core/src/billing/statusWorker.test.ts` and `apps/web/app/api/webhooks/stripe/_lib/webhook.test.ts`.
Why: The founder ruled that this card builds and tests against a test double (the T0.5 provider pattern). Marking the criterion met on the weaker evidence would hide the real gap. **What stays unproven until keys exist:** that Stripe emits these event types with these payload shapes and this ordering; that `stripe.webhooks.constructEvent` accepts our raw-body handling under a real signing secret; that a real Checkout session returns `client_reference_id` on `checkout.session.completed`; and that `subscriptions.retrieve` returns `current_period_end` where our reader looks for it. Re-run the three test clocks against Stripe test mode the day credentials land, before anything ships to a paying merchant.
Nearest spec: tech §5 — "Stripe runs in test mode in dev/staging (test-clock fixtures for renewal and dunning scenarios)"; no credentials exist to run them.

## 2026-08-31 — T1.2 — `subscriptions.synced_at` holds the Stripe-side time of the state, not the time we wrote it
Decision: `synced_at` stores the `created` timestamp of the Stripe event (or the moment of a reconciliation fetch) that produced the row's state. The subscription upsert is guarded with `WHERE subscriptions.synced_at <= EXCLUDED.synced_at`, so an older delivery is a no-op instead of a rollback. A reconciliation fetch writes `max(now, stored synced_at)` so it always wins, even against a row stamped in the future.
Why: Stripe delivery is at-least-once and unordered; without an ordering key a late `active` event silently un-cancels a cancelled subscription, or un-pauses a `past_due` one. Wave 1's `subscriptions` table has no other column carrying a Stripe-side timestamp, and no migration was permitted on this card. Reading `synced_at` this way costs nothing elsewhere: tech §3's nightly job scans "any subscription whose `synced_at` is >24h stale", and under either reading a quiet subscription becomes stale on the same schedule. Alternative rejected: deriving the ordering key by querying `stripe_events` payloads on every write.
Nearest spec: main §13 `subscriptions` — lists `synced_at` with no stated semantics; tech §3 — requires the staleness scan, silent on ordering.

## 2026-08-31 — T1.2 — Stripe's nine subscription statuses map onto main §13's four
Decision: `active`/`trialing` → `active`; `past_due`/`unpaid` → `past_due`; `canceled`/`paused` → `canceled`; `incomplete`/`incomplete_expired` and any future unknown → `incomplete_expired`.
Why: main §13 fixes the stored enum at four values and this card added no migration. Only two distinctions drive behaviour — `active` is the one entitled state (main §4.2), `past_due` is the one that raises the non-dismissible banner and the payment-failed email — so every other Stripe status is behaviourally identical. One edge is genuinely lossy and is flagged: `incomplete` (Stripe's "first payment not finished, may still succeed") is stored under `incomplete_expired`. Nothing user-facing distinguishes them and both gate identically, but a founder reading the database will see a recoverable state named as an expired one. Unknown future statuses default to not-entitled, which is safe in both directions since read access is never revoked.
Nearest spec: main §13 `subscriptions.status` — a four-value enum against a nine-value vendor field.

## 2026-08-31 — T1.2 — `checkout.session.completed` reads the subscription back from Stripe
Decision: on `checkout.session.completed` the webhook worker attaches the customer id and then calls `subscriptions.retrieve` once to write the first `subscriptions` row.
Why: main §4.2 assigns that event the job of attaching "customer **+ subscription** to account", but a Checkout session payload names the subscription without describing it — no status, no price, no period end. Stripe announces a new subscription with `customer.subscription.created`, which main §4.2's webhook list does not include, so without this read a freshly paid account would hold no `subscriptions` row, and therefore no entitlement, until Stripe's next subscription event — a month away on a healthy monthly plan. The read is in the webhook worker, which is exactly where invariant 16 permits a Stripe call; it is not in a request path and not at scheduler dequeue. Alternative rejected: subscribing to `customer.subscription.created`, which changes the event set main §4.2 fixes.
Nearest spec: main §4.2 — names the event and its job, silent on where the subscription's fields come from.

## 2026-08-31 — T1.2 — An invoice event never writes `subscriptions.status`
Decision: `invoice.payment_failed` and `invoice.paid` are stored and then ignored by the status writer. Status comes only from `customer.subscription.updated` / `.deleted`. The payment-failed notification fires on the transition into `past_due`, deduped per billing period on tech §1.2's `(account_id, type, dedupe_key)` triple.
Why: main §4.2 says in as many words that the subscription events are "the single writer of `subscriptions.status`". Letting an invoice also decide status would put two writers on one column with no ordering between them.
Nearest spec: main §4.2 — lists all four events without saying what the invoice ones do.

## 2026-08-31 — T1.2 — Billing repository queries live in `apps/web`, not `packages/db`
Decision: the six subscription/event queries this card needed (`findAccountIdByCustomerId`, `attachCustomer`, the guarded subscription upsert, `staleSubscriptions`, `claimUnprocessed`, `markProcessed`) are written in `apps/web/app/api/billing/_lib/store.ts`, behind ports declared in `packages/core/src/billing/store.ts`.
Why: the constitution puts repositories in `packages/db`, and these belong in `packages/db/src/repositories/billing.ts` next to `recordStripeEvent`, which T0.3 already wrote there. `packages/db` was held by a concurrent session for the whole of this card and could not be edited. The scoping discipline is kept — the port shape is core's, the binding mints `AccountScope` from ids read out of our own database, never from a request — but this is a structural deviation and the move is a mechanical follow-up for the integrator. `apps/web` gained a direct `drizzle-orm` dependency as a consequence.
Nearest spec: CLAUDE.md code-structure rules — "Every repository method requires an `accountId` scope parameter"; the file's location is convention, not spec.

## 2026-08-31 — T1.2 — Canonical billing copy lives in `packages/core/src/billing/copy.ts` until a strings package exists
Decision: the cap line, the three cancellation facts, "Cancel anytime.", the Checkout-cancelled note and the payment-failed banner are exported constants in `packages/core/src/billing/copy.ts`, held by snapshot tests.
Why: the constitution puts copy in `packages/ui/strings/*.json`, keyed by its main Appendix A row. That directory does not exist — no card has created it — and `packages/ui` is another lane's. Inlining the strings in components would scatter them; putting them in one module keeps exactly one copy of each string and one snapshot guarding it. Note also that main Appendix A writes the cap as "Up to 1 article per day, quality permitting" while invariant 16 quotes it lower-cased; Appendix A wins (invariant 24) and the test asserts both forms.
Nearest spec: CLAUDE.md code-structure rules — names a location that does not exist yet; main Appendix A — the strings themselves.

## 2026-08-31 — T1.2 — The webhook drain is started in-process; only the nightly reconciliation is a registered job
Decision: after storing an event the receiver starts `drainStripeEvents` without awaiting it, then returns 200. `subscription_reconciliation_nightly` — already named in `packages/jobs`' crontab — gets its handler registered from `apps/web/instrumentation.ts`, alongside an unscheduled `stripe_event_drain` task.
Why: tech §3 requires the 200 before any processing. A durable queue hand-off would need a new task plus a crontab entry in `packages/jobs`, which this session did not own. The in-process drain is safe to lose: it reads a table it did not empty, every step is idempotent, and the nightly reconciliation repairs anything missed. It is nonetheless weaker than a queued job under a crash-and-redeploy, and should become one when `packages/jobs` is available. Note the worker still runs with cron disabled until every crontab task has a handler, so the nightly job does not yet fire.
Nearest spec: tech §3 — "200 immediately, async processing", silent on the mechanism; main §14.3.8 — the store-then-process pattern this follows.

## 2026-08-31 — T1.2 — No `/api/billing/plan` route; the plan screen's content is a core constant
Decision: the card's "plan screen API" is not built as an endpoint. `PRO_PLAN` in `packages/core/src/billing/plan.ts` carries the intervals, the verbatim cap line, the inclusions and the cancellation facts; prices are absent by design.
Why: T0.7 froze the route table and the constraint on this session was not to change it. The table has `/api/billing/checkout` and `/api/billing/portal` and no plan route, and `/api/account` already carries subscription status. **Flagged as a contradiction rather than resolved**: if the plan screen needs the live Stripe amounts (main §4.2 forbids hardcoding them) it needs either a route the frozen table does not have, or a build-time read, and the integrator has to re-freeze the contract either way.
Nearest spec: main §4.2, ui §2.3 — describe the screen; `packages/core/src/api/routes.ts` — offers no route for it.

## 2026-08-31 — T1.1 — Sign-in with Google asks for identity scopes only
Decision: the Google provider requests `openid email profile` and nothing else. Search Console keeps its own OAuth client and its own consent screen (`GSC_OAUTH_CLIENT_ID` in `.env.example`, wired by T3.1).
Why: invariant 21 — read and write are separate consents, and the general principle behind it is that a user should never be asked for a capability at a moment that has nothing to do with it. Folding `webmasters.readonly` into the sign-in button would make the first screen a new user sees ask for their search data, which is a different decision they have not been offered yet. A test asserts the scope string, so it cannot drift into the login screen later.
Nearest spec: main §4.1, §12.2; invariant 21.


## 2026-08-31 — T1.1 — Auth.js v5 (`next-auth@5.0.0-beta.32`), JWT sessions, Google only; email sign-in is blocked
Decision: sign-in runs on Auth.js v5 with the **JWT session strategy** and no database adapter. Google is the only provider wired. The email (magic-link) half of the card is **not built** — see the separate blocker entry below.
Why: tech §3 proposes Auth.js and the app is Next 15 App Router, which only Auth.js v5 supports natively; v5 is still published as a beta, so the beta pin is forced rather than chosen. The session strategy is forced too: Auth.js's database-session strategy needs an adapter with `createUser`/`getUser`/`getSessionAndUser`/… and wave 1 created none of those tables, and this session may not add a migration. Consequence to accept knowingly: a JWT session cannot be revoked server-side before it expires (default 30 days), so "sign out everywhere" and instant lockout are not available until session storage exists. Sessions are short-lived (24h) to bound that.
Nearest spec: main §4.1 ("standard email + OAuth (Google) signup. Nothing exotic."); tech §3.

## 2026-08-31 — T1.1 — BLOCKER: email (magic-link) sign-in needs a `verification_tokens` table that no schema wave created
Decision: not built. Recorded rather than worked around.
Why: main §4.1 asks for "email + OAuth (Google) signup". Auth.js refuses to start an email provider without an adapter exposing `createVerificationToken`, `useVerificationToken`, `getUserByEmail` (`@auth/core/lib/utils/assert.js:135`). The first two need a row per outstanding magic link — `(identifier, token, expires)`, single-use. main §13 lists no such table and migration `0000_wave1.sql` creates none; `getUserByEmail` alone is already servable from `accounts`. The alternatives are both worse without a founder decision: a stateless signed-token link (no single-use guarantee — a link in a forwarded email or a mail scanner's prefetch stays valid until expiry), or reusing `request_cache`, whose documented purpose is billable-read replay (main §14.3.6). Needs a one-table mini-wave: `verification_tokens(identifier text, token text, expires timestamptz, primary key (identifier, token))`.
Nearest spec: main §4.1; main §13 — silent on verification tokens.

## 2026-08-31 — T1.1 — The session→account seam is a handler wrapper under `apps/web/app/api/auth/_lib`, not Next middleware
Decision: authenticated routes are written as `withAccount(async (request, { scope }) => …)`. The wrapper reads the Auth.js session, turns the account id into the branded `AccountScope` that every repository method demands, and answers 401 `unauthenticated` when there is none. It lives in `apps/web/app/api/auth/_lib/session.ts` — a Next.js private folder (leading underscore), so it is a module, not a route.
Why: tech §3 says "every authenticated route resolves `account_id` from session — never from the request body", and the build plan calls this "session→accountId middleware". Real Next.js `middleware.ts` runs before the route on a runtime with no database access, so it can gate but cannot produce a scope — the scope would still have to be rebuilt per handler, and the place it is rebuilt is the place a mistake happens. A wrapper is the single place the conversion exists. Location: lane A owns `apps/web/app/api/auth` (build plan §3) and every other lane's routes will import this, so it is deliberately inside lane A rather than in a new shared directory nobody owns; the existing route-handler lint allowlist already permits a relative import containing `_lib`. **The integrator should confirm this is where cross-lane request plumbing belongs before four other lanes import it.**
Nearest spec: tech §3; build plan §3.

## 2026-08-31 — T1.1 — `accounts` repository added to `packages/db`, which no lane owns
Decision: `packages/db/src/repositories/accounts.ts` — create-or-find by email, scoped account read, and an `ops_flags` reader that lists the flags active for one account. No schema change of any kind.
Why: the card requires "account row on signup" and "repository scoping enforced in all routes", and CLAUDE.md forbids raw table access from anywhere but migrations and admin scripts, so the queries have to be repository methods. Build plan §3 assigns `packages/db` to no lane (only migrations are restricted, and to schema-wave cards). Flagged so the integrator can decide whether repository files should be lane-owned; every later lane will hit the same question.
Nearest spec: CLAUDE.md code-structure rules; build plan §3 — silent on repository ownership.

## 2026-08-31 — T1.1 — Signup provisioning is create-or-find on the unique email index, and `signup_completed` fires only on a real create
Decision: first successful sign-in inserts `accounts(email)` with `ON CONFLICT DO NOTHING` and re-reads on conflict; the PostHog `signup_completed` event is captured only when the insert actually produced a row.
Why: main §5 establishes insert-with-conflict as the house pattern for exactly this race (two callbacks for one identity arriving together), and it is the only pattern that cannot double-create. Firing the event on every sign-in would make main §14.7's funnel — and the "cost per acquired signup" number it feeds — count returning users as signups. The event carries the account id and no domain group, because §14.7 reserves the domain group for claimed domains and a fresh account has `domain = null` (main §4.1).
Nearest spec: main §14.7 (funnel events); main §4.1, §5.

## 2026-08-31 — T1.1 — `GET /api/account` ships now, and every field is answerable from wave-1 data
Decision: the frozen `accountResponseSchema` route is implemented in full. `limitedIntelligence` is `true` and `connections.searchConsole` is `none` for every account, `connections.lastScanAt` is `null`, and `servicePaused` is true when `global.pause_all` or this account's `account.pause_generation` flag is set.
Why: main §4.3 — a cited section of this card — describes exactly this: a logged-in user with `domain = null` sees "Connect your domain" and everything else renders locked. Something has to tell the dashboard that. The three values that look like placeholders are not: Limited Intelligence *is* "no Search Console connected" (main §7.11), and no code path can connect Search Console until T3.1, so `true` is the correct answer today rather than a stub — it stops being constant when T3.1 lands. `servicePaused` picks those two flags out of main §14.5's four because they are the ones that stop this account's work; `pause_publishing` stops a later stage and has its own surface. Contract unchanged: no field added, removed or retyped.
Nearest spec: main §4.3, §7.11, §14.5; tech §3.


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
