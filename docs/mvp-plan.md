# Sortiva MVP plan — what to build, what to throw out, how to test it

Written 2026-09-25 from a read of the whole repository, the three specs, the decision journal and the September bug ledger. **Decisions D1 to D9 were taken by the founder on 2026-10-08 and are recorded in §7 and in `DECISIONS.md`; the text below was updated to match them.** Audience: the founder, who directs the work and does not read the code. Every claim about the current system says whether the thing **exists**, is merely **declared** (a type, a table or an interface with nothing using it), or is **proposed** here.

---

## 0. The call, in one page

**Decided 2026-10-08 (D1): rebuild the product from scratch in a new repository, salvaging no code.** The old tree stays as a read-only reference for behaviour and test cases. The original recommendation was to port about ten modules; the founder chose a clean build instead, because an agent builds it and porting carries old coupling. Not "fix the 80 open defects", and not "delete features from the current tree until it is small".

Why not fix in place:

- The engine is about 197,000 lines of TypeScript, 57 database tables, 19 scheduled jobs, 63 API routes and 194 tuned numbers, for a loop that has never run end to end on a real store. Roughly half of that is features the MVP does not need (an opportunity-scoring engine, page-optimisation advice, technical-SEO fixes, drift repair, a learning loop, email digests, a public preview funnel). They are wired into each other: the calendar is filled from the opportunity engine, every gate decision is stamped with a hash of the threshold file, and lint rules enforce the constitution. Carving that down is slower and riskier than starting from a small schema and porting what is worth porting.
- The shell has to go anyway. Sign-in by email, the domain claim, the public preview and the two-stage permission grant all exist only because the app was sold as a standalone web app. An embedded Shopify app replaces all of them, and the account identity changes from an email address to a store.
- The tests are better than you think, but they miss the thing that matters. About 40 percent of the 345 test files already run on a real Postgres, and mocks are almost absent. What no test does is take a store's catalogue through to a published article in one run, and no fixture was ever recorded from a real vendor. That is exactly where the bugs that shipped lived: a retired Shopify API version, tokens that expire in an hour, and article HTML with the Markdown escaped into literal characters. A rebuild lets the test suite start from that end-to-end scenario instead of adding it last.

What the old tree does well, kept as **reference only** (read for behaviour and for the cases their tests cover; never copied):

| Module | What it is | Where |
|---|---|---|
| Shopify GraphQL client, token refresh, rate limiter | Talks to Shopify's current API, renews expiring tokens, stays under the request budget | `packages/providers/src/shopify/` |
| Two-phase publish | Posts an article to the store blog so a crash can never post it twice | `packages/jobs/src/publish/auto-publish.ts`, `recovery.ts`, `core/publish/intent.ts` |
| Catalogue walk with checkpoints | Reads the product list in pages and resumes where it stopped | `packages/jobs/src/ingestion/catalog.ts` |
| DataForSEO client with cache and cost ledger | Keyword volumes and search results, each call cached and priced | `packages/providers/src/seo/` |
| Search Console client and daily sync | Connects Google Search Console and pulls clicks, impressions, position per page and query | `packages/providers/src/gsc/`, `packages/jobs/src/gsc/` |
| LLM wrapper, prompts, eval sets | The one place model calls go through, with the prompt files and the graded test cases | `packages/llm/` |
| Product fact distillation | Turns a product description into a short list of checkable facts | `packages/core/src/distill/` |
| Draft grading (Gate 3) | Deterministic checks on a draft, then a separate blind judge, one repair | `packages/core/src/gates/gate3/` |
| Markdown to HTML and the export bundle | Renders the article and packages it for download | `packages/core/src/publish/markdown.ts`, `bundle.ts` |
| Per-store lock and idempotency ledger | Stops two workers touching one store, and lets a repeated job return its stored result | `packages/jobs/src/runtime/lock.ts`, `ledger.ts`, `runStep.ts` |
| Test database helper | Gives every test suite its own migrated database from a template in milliseconds | `packages/db/src/testing.ts` |
| Token encryption and log scrubbing | Keeps access tokens out of the database in clear text and out of the logs | `packages/providers/src/secrets/` |

Everything is left behind. For the record, the parts that are not even reference material, with sizes (source lines, tests excluded):

| Area | Lines | Why it goes |
|---|---|---|
| Opportunity engine: signals, scoring, action selection, scan | ~7,500 | Replaced by a ranked topic queue. See decision D2. |
| OPTIMIZE (advice for existing pages) and FIX (technical SEO) | ~3,100 | Not about articles. |
| Drift detection and repair | ~1,600 | Replaced by one simpler rule. See §3.8. |
| Learning loop (labels, pattern statistics) | ~900 | Needs months of published articles before it means anything. Measuring stays; learning comes later. |
| Notifications, email queue, monthly summary, reminders | ~2,500 | Deferred. The embedded app shows state on screen. |
| Public preview funnel, Turnstile, domain claim, sign-in, sessions | ~2,000 | Dies with the standalone shell. |
| Rules package: 194 thresholds in YAML, overrides table, hash stamping, lint rule | ~1,200 + 979 YAML | Replaced by one config file with about fifteen numbers. |
| Product families (grouping products into ranges) | ~1,700 | Replaced by Shopify collections plus product type. |
| CTR curve, query clusters, monthly rollups, dead tables | ~800 | Never needed by the MVP loop. Four tables have no reader at all. |
| Chaos harness | ~2,700 | Its idea survives as a much smaller crash test, §6.3. |

**Decisions** are in §7, all answered on 2026-10-08. In short: clean rebuild, no code salvaged (D1); the article queue is the product, built so the growth engine can be added later without a schema change (D2); no orders or revenue (D3); Search Console optional with a labelled limited mode (D4); product images only, chosen by aspect ratio (D5); no price in text (D6); Graphile Worker (D7); English and Hungarian are both MVP languages, the first pilot store is Hungarian (D8); the eight rules replace the constitution, nothing else survives (D9).

---

## 1. What the MVP is

An app a merchant installs on their webshop. It reads their catalogue, works out what their store can credibly write about, writes one article at most per day when it has something worth writing, and either publishes it to the store's blog or hands it over as a file. Google Search Console shows which articles brought searches and clicks. DataForSEO supplies keyword demand and what already ranks. Shopify is the first and only platform in the MVP, as an embedded app in the Shopify admin. The core is written so that a second platform is a new connector, not a rewrite. **Two languages from day one: English and Hungarian** (D8). A store's language comes from its Shopify primary locale; prompts, demand data, the writer, the judge and the eval sets exist for both. No third language in the MVP.

Not in the MVP: advice on existing pages, technical SEO fixes, an opportunity dashboard, email digests, a learning loop that changes behaviour, image generation, an in-app editor, revenue attribution, multi-store, our own sign-in and payment (deferred until a non-Shopify platform exists).

---

## 2. Where the current system stands (evidence for the call)

Facts from the inventory, all verified by reading the tree on `main` at commit `27b0acb`:

- **Size.** `packages/core` 34k lines, `packages/jobs` 24k, `packages/db` 16k, `packages/ui` 16k, `apps/web` 12k, providers and LLM 8k. About 28 percent of source lines are comments.
- **Built, not stubbed.** The worker refuses to boot if a scheduled job has no handler, and the stub report prints zero. The problem is not fakes pretending to be features; it is that everything was built.
- **Declared but dead.** Six of eighteen signal types have no detector. The automatic refresh ranking has no caller and its log table is never written. The technical-SEO "blocking" rule keys on a signal nothing produces. The weekly intent-gap scan is registered but deliberately not scheduled. Four tables have no reader: `gsc_monthly`, `gsc_query_monthly`, `deletion_confirmation_emails`, `dismissed_opportunities`. `stripe_events` stays by decision, unused.
- **Shopify-specific to the bone.** There is no store-platform interface. The ports are named `ShopifyPublishProvider`, `ShopifyListReader` and so on; the product table's unique key is the Shopify product id; the publish marker is a Shopify metafield. WordPress and WooCommerce appear only in the competitor research and one test fixture. So the "platform-neutral core" in the spec's principles was never built. This matters because you want other stores later.
- **Nothing embedded.** `shopify.app.toml` says `embedded = false` with the comment "Nothing in the code supports being embedded there". No App Bridge, no session-token check, no frame-ancestors header.
- **The quality gate is not yet usable.** After the eval fixes of 2026-09-24 the judge passes 5 of 20 human-approved articles. No eval set covers the writer at all. Nobody has seen an article this product would publish in a real store.
- **The Performance screen cannot show verdicts.** It hard-codes every article as "unrated". The weekly job that computes labels writes them to a table nothing reads.
- **The content spec disagrees with the code.** `docs/content-spec.md` marks the `opportunities` table and the claims table as "to build", both of which exist. It references a `functional-spec.md` that is not in the repo. It should be treated as a design sketch, not a source of truth.
- **The tests.** 345 files under the main runner, 135 on a real Postgres via a template-database helper, hand-written stateful fakes at the vendor boundary, 3 files using a mock framework. One eval file (80 model cases, needs an Anthropic key, 13 to 30 minutes). One chaos file (10 crash scenarios, nightly, fakes at the boundary, one real process kill). Five Playwright files, four of them against a fixture API, none running in CI.

---

## 3. The pipeline

One store, eight stages, each a job that runs under a per-store lock and writes its result before the next stage can start. Everything is keyed so that running a stage twice with the same inputs is harmless.

```
connect ─► learn the store ─► find topics ─► schedule ─► write ─► deliver ─► measure
                 ▲                                                            │
                 └──────────────── keep it true (product changes) ◄───────────┘
```

Vocabulary used below:

- **Fact sheet**: a short list of checkable statements about one product, each pointing at the field it came from (title, option, tag, metafield, description sentence). Marketing prose is never a fact.
- **Topic**: one thing to write about, with a target search query, the products it would reference, and a demand number.
- **Evidence pack**: everything the writer may use for one article: the fact sheets of the referenced products, the target query, what currently ranks for it, and the store profile.
- **Claim**: a sentence in a draft that says something about a product. Every claim must resolve to a fact.

### 3.1 Connect

The merchant installs the app from Shopify. Shopify's managed install grants read products, read content and write content in one request (founder decision of 2026-09-25). The app exchanges the session token for an access token, stores it encrypted, and creates the account keyed by the shop handle. Email is collected only for notifications, later.

Optionally, and skippable, the merchant connects Google Search Console in a top-level window (Google's consent screen cannot open inside the Shopify iframe) and picks the property that matches the store's domain.

Stores: `stores` (one row per shop, tokens, granted scopes, storefront host, locale, timezone), `gsc_connections`.

What can go wrong and what catches it:

- Token expires within the hour: the client refreshes before use, serialised per store so two workers cannot both renew. The old tree has a tested version to read.
- Merchant revokes a permission later: a permission error pauses the affected stage and shows a banner. It never disconnects the store.
- Uninstall: Shopify sends `app/uninstalled`; we mark the store closed, stop all jobs, and delete its data after 30 days. GDPR webhooks answer "no customer data held", which is true because we never read customer fields (D3).

### 3.2 Learn the store

Reads every product (title, type, vendor, options, tags, price, images, collections, description HTML, metafields), every collection, every blog article and page the store already has. Then, per product, one model call distils the description into a fact sheet; the raw description HTML is stored but never given to the writer. The store profile (what the store sells, to whom, in which language and country, tone) is drafted from the catalogue and shown to the merchant on one screen to confirm or correct. Nothing is written until they confirm.

Stores: `products`, `product_facts`, `store_pages` (existing blog posts, collections, pages: URL, title, first 500 words), `store_profile`.

Safeguards:

- **Marketing copy is quarantined.** The writer only ever sees fact sheets (rule 1).
- **Too few products or too thin descriptions.** Each product gets a richness score (how many facts it yielded). A store whose products with adequate facts number fewer than a small floor (proposal: 5) goes into a limited state: the merchant is told plainly, "we can write about N of your products; add descriptions to the others", and the queue is built only from what is there. An empty queue is a legitimate state, and the app says so rather than writing generic content.
- **Wrong understanding.** The confirmation screen exists so the merchant sees what we understood before anything is written.
- **Catalogue walk dies mid-way.** Checkpoint per page, resume from the last page. The old tree's test enumerates the cases.

### 3.3 Find topics

From the confirmed profile and the products with facts, the model proposes candidate topics grouped by product type or collection, never per SKU. DataForSEO returns search volume for each candidate's target query and the top ten results for it. Then every candidate passes one function, **the existing-content check**, before it can become a topic:

1. Does the store already have a page whose title or target query overlaps this one? (Match against `store_pages` by normalised title, slug words and, where GSC exists, the queries that page already gets impressions for.) If yes, drop the candidate. In the MVP we do not advise on that page; we simply do not compete with it.
2. Does our own queue or article table already hold this topic? Topics get a canonical key: the target query, lower-cased, stemmed, stop-words removed. The key is unique per store in the database, so a duplicate insert fails rather than creating a competitor. Hungarian is agglutinative, so stemming alone is a weak key for it; the overlap check in step 3 is the primary dedup for both languages and the lexical key is the backstop.
3. Would this article compete with another queued topic? Two topics whose target queries share the same top-three ranking URLs (from the DataForSEO results) are the same intent; keep the higher-demand one.

Survivors are ranked by demand, by how many distinct facts back them, and by whether the top results are the kind of page a blog post can beat (all ten are product listings means a blog post will not rank; that candidate is dropped).

Stores: `topics` (state: candidate → queued → scheduled → written → delivered → held → vetoed), `keyword_metrics` and `serp_snapshots` as caches keyed on the request.

Safeguards:

- **Not enough topics.** A store with three products yields three topics, not thirty. When the queue is empty the app says "nothing worth writing this week" and tells the merchant what would change that.
- **Language and market.** Demand is fetched for the store's locale and country; a store selling in Swedish is not judged by English volumes. The demand floor is one number per locale (the current YAML has these; keep them, drop the other 170).
- **Cost.** DataForSEO calls are cached by request parameters, written before the call is made, and a per-store daily budget stops discovery when exceeded (rule 7).
- **Vetoed topics stay vetoed.** A veto records the canonical key in a not-interested list, so re-discovery cannot re-propose it.

### 3.4 Schedule

The queue is shown as a list, not a calendar: today's topic, then the next ones in rank order. At most one topic per store per day is taken, at the store's publish hour in its timezone. The merchant can veto or reorder any time before writing starts. A day with no topic is skipped, never back-filled.

Safeguards:

- **One per day, exactly.** The daily job's idempotency key is (store, calendar day in the store's timezone). Running it twice on the same day returns the stored result (rule 4).
- **Midnight and timezone.** The day key is computed from the store's timezone, not the server's. The old tree's "killed across midnight" crash scenario is the case to reproduce.
- **Paused store.** A store that has no active entitlement, has hit a spend cap, or is marked paused by the merchant is skipped with a visible reason.

### 3.5 Write

For the day's topic, assemble the evidence pack, then run the writer in two model calls: a plan (which facts, which sections, which products to link) and a draft in Markdown. Then the gate, in order of cost:

1. **Deterministic checks, free.** Every product claim cites a fact id and the fact says what the claim says. Every number, measurement or duration cites a fact. Every link points at the store's own domain and resolves in `store_pages` or `products`. No first-person experience ("I tested", "we tried"). Word count within bounds. Language matches the store's. No price appears in the text (D6). At least K distinct facts referenced (proposal: 6), otherwise the draft is thin by construction.
2. **The judge, one call.** A separate model call that sees only the draft and the evidence pack, never the writer's conversation, scores grounding, information gain, structure, and fit to the store. Floors: grounding and information gain 4 of 5, others 3. The judge prompt and its graded cases are written fresh (D1).
3. **One repair.** If the judge fails, the writer gets the judge's notes once. If it fails again the topic is **held** with the reason shown to the merchant. Never a second repair, never a smaller model, never a forced publish.

Stores: `articles` (Markdown, HTML, title, meta description, slug, referenced product ids, claim list, gate report, state), `llm_calls` (prompt version, model, request hash, response, cost; written before the call so a crash after the vendor answered does not pay twice).

Safeguards:

- **Invented facts.** Caught three times: the writer is only given fact sheets; the deterministic check refuses any product claim without a fact; the judge's grounding floor. The distillation eval (50 cases) guards the fact sheets themselves.
- **Invented experience or authority.** A pattern check, plus the judge's instruction. The spec's competitor research found this in every rival.
- **Foreign links.** Rejected mechanically. No link leaves the store's domain, ever.
- **Malformed model output.** The wrapper shows the model the JSON shape and retries once on a shape failure; a second failure is a held topic, not a crash.
- **Judge drift.** The judge eval runs whenever a prompt changes. New rule: it also runs on a schedule (weekly) against the same 20 cases, so a vendor-side model change shows up as a score change.
- **Duplicate article.** The article row is unique on topic id; the topic's canonical key is unique per store. Two layers.

### 3.6 Deliver

Two delivery modes, chosen by the merchant as a setting (founder decision 2026-09-25): **export** or **auto-publish**. Draft-first is a sub-option of auto-publish: the article is created in Shopify as a hidden draft for the merchant to publish from their admin.

Export produces three files: the Markdown, the rendered HTML, and a metadata JSON (title tag, description, slug, target query, image URLs). The merchant is asked to paste the live URL back once published, so Search Console rows can be matched to the article.

Auto-publish is two-phase. Write an intent row keyed by article id. Call Shopify's article-create with a marker (a metafield holding our article id). Confirm the intent with the remote id. A sweeper runs every few minutes: any intent stuck between execute and confirm is checked by searching the blog for our marker before anything is re-sent. An update is only ever sent against the stored remote id and never falls back to create (rule 5). The old tree's 30-case publish test lists the cases the new one must cover.

Stores: `publish_intents`, `articles.remote_id`, `articles.published_url`.

Safeguards:

- **Crash between create and confirm** cannot double-post. The recovery sweep exists for exactly this.
- **Merchant edits our article in Shopify.** We never overwrite it. The only update we ever send is the product-change rule in §3.8, and that update is skipped if the remote body's hash differs from what we last sent.
- **Target blog missing.** Auto-publish cannot be switched on until a target blog is chosen; if the blog is later deleted, delivery pauses with a banner.
- **Images.** Product images from the catalogue only, referenced by Shopify CDN URL, never re-uploaded (D5). Each product card has a slot ratio (one number in config); the card takes the product image whose aspect ratio is closest to it, and the first image if the product has only one. Alt text is the product title.

### 3.7 Measure

Nightly, pull Search Console rows per page and per query for the last three days (rows settle late) and store them. Once a day, for every delivered article with a known URL, compute clicks, impressions and average position over the trailing 28 days. The article's screen shows those numbers and a plain label after day 28: better than the store's median article, about the same, or worse. Nothing is labelled before day 28 and no label is absolute.

Two things the numbers feed back, both simple:

- **Topic ranking** gets one multiplier per product type: if articles about type X are winners, more topics of type X rise. That is the entire learning loop in the MVP.
- **Refresh candidates**: an article with impressions on a query where it ranks 5 to 20 goes back into the queue as a refresh topic. Writing a refresh reuses the existing article's remote id. This is where GSC turns from reporting into an input, and it is the one signal from the old engine that survives.

Without Search Console the store runs in a plainly labelled limited mode: no measurement, no refresh candidates, topic ranking by demand alone.

Stores: `gsc_daily` (page, query, date, clicks, impressions, position), `article_metrics` (article, window, numbers, label).

### 3.8 Keep it true

Three layers keep the catalogue current, because none is reliable alone. **Webhooks** from Shopify (`products/create`, `products/update`, `products/delete`, and the collection topics) arrive within seconds; each is signature-checked, deduplicated by Shopify's delivery id, and turned into a job that re-reads that product from the API, never trusting the payload, since deliveries repeat and arrive out of order. A burst of deliveries for one store collapses into a single catalogue re-read. **A nightly full re-read** compares every product with what we hold and catches whatever the webhooks missed. **A "Sync now" button** on the Products screen runs the same job on demand, one at a time per store. In all three, fact extraction re-runs only for a product whose title, description, options or tags changed, detected by a hash; price and image changes update the row without a model call. Webhooks only arrive once the app's configuration file is pushed to Shopify, which is on the founder's list.

For each delivered article, if a referenced product is gone or its facts have changed, the article is flagged. One rule handles it: if the product is gone, the product card and links to it are removed and the article is re-sent (only if the merchant has not edited it, see §3.6); if only facts changed, the article is queued as a refresh topic. No substitution logic, no impact scoring. That replaces the current 1,600-line drift module.

### 3.9 The runtime underneath

- One worker process, Postgres-backed queue (D7). One job type per stage plus the sweepers (publish recovery, catalogue re-read, GSC sync, spend cap).
- Every job takes a per-store advisory lock on its own connection; a second job for the same store waits.
- Every job's idempotency key is derived from its inputs (store, stage, subject, day), never random. Completed keys return the stored output.
- Any step longer than a minute checkpoints to a table so a restart resumes rather than repeats. Catalogue walk and GSC backfill are the two that need it.
- Spend: `llm_calls` and `vendor_calls` hold the cost of every external call; a per-store daily cap and a global daily cap are checked before each stage that spends. When a cap trips, the store pauses with a reason on screen. No PostHog in the control path.
- Ops switches: one table, `store_flags`, with paused-by-operator and paused-by-merchant. That is the whole kill-switch system.

### 3.10 Leaving the door open for the growth engine (D2)

The MVP ships the queue only, but four design choices make the opportunity engine an addition rather than a rewrite:

- **Every topic has a source and evidence.** `topics.source` is an enum that starts with `discovery`, `refresh` and `manual`; each later detector (striking distance, decay, cannibalization, uncovered query, and so on) is one more value. `topics.evidence` is a JSON record of the numbers that justified the topic, with the source and date of each number. The queue's "why" line renders from a template over that record, never from model text.
- **Topic sources are one interface.** A topic source is a function from a store to candidate topics with evidence. Discovery and refresh are the two MVP implementations. A detector is a third, reading the same tables. The existing-content check and the ranking function take candidates from any source.
- **The data a detector needs is already stored at the right grain.** Search Console rows are kept per page and per query per day, not rolled up. The store's existing pages are inventoried with URL, title and excerpt. Nothing has to be backfilled.
- **Actions stay out of the schema until needed.** The MVP has two topic kinds, `create` and `refresh`. OPTIMIZE and FIX are new kinds later, with their own delivery, and do not touch the article path.

---

## 4. Edge cases and the safeguard for each

Every row here becomes at least one scenario in the test suite (§6.2).

| Risk | Safeguard | Enforced where | Proven by |
|---|---|---|---|
| Same topic written twice | Canonical topic key unique per store; article unique per topic | DB constraints | Scenario: re-run discovery twice, count topics |
| Two of our articles compete for one query | Shared top-3 ranking URLs means one intent; lower-demand candidate dropped | Existing-content check | Scenario with two near-identical candidates |
| Our article competes with a page the store already has | Title, slug and GSC query overlap against `store_pages` | Existing-content check | Scenario: store with a blog post on the candidate topic |
| Store has too few products | Richness floor; limited state with plain explanation; empty queue allowed | Learn the store | Scenario: 3-product store yields ≤3 topics, no generic ones |
| Product description is marketing fluff with no facts | Distillation returns few facts; product excluded from topics | Distill + richness | Distillation eval; scenario with a fluff product |
| Writer invents a product attribute | Claim must cite a fact; judge grounding floor | Deterministic check + judge | Scenario: seeded draft with an uncited claim is held |
| Writer invents a number | Any number needs a fact | Deterministic check | Scenario |
| Writer invents personal experience | Pattern check + judge instruction | Deterministic check | Scenario |
| Link to an outside site or a competitor | Only store-domain links that resolve | Deterministic check | Scenario |
| Wrong language | Store locale drives the prompt; output language detected | Deterministic check | Scenario: Swedish store |
| Price in text goes stale | No prices in text; product card rendered from live data at delivery (D6) | Deterministic check + renderer | Scenario: price change after write |
| Product discontinued after publish | Nightly re-read flags; card removed and article re-sent, or refreshed | Keep it true | Scenario: delete product, run sweep, inspect fake store |
| Crash between publish create and confirm | Intent row + marker lookup before re-send | Two-phase publish | Crash test: kill at each checkpoint, converge to exactly one remote article |
| Merchant edited our article in Shopify | Remote body hash compared before any update | Deliver / keep it true | Scenario: edit in fake store, run sweep, assert untouched |
| Token expired mid-run | Refresh before use, serialised per store | Shopify client | Contract test against dev store with a short-lived token |
| Permission revoked | Pause the stage, banner, never disconnect | Shopify client error mapping | Scenario with fake returning 403 |
| Two workers on one store | Per-store advisory lock | Runtime | Runtime test with two concurrent jobs |
| Day boundary, timezone | Day key from store timezone | Schedule | Crash test across midnight (exists) |
| Model returns malformed output | Shape shown, one retry, then hold | LLM wrapper | Wrapper test (exists) |
| Judge gets stricter or looser after a vendor change | Weekly judge eval on fixed cases | Eval suite | Eval run; alert on score delta |
| Spend runaway | Per-store and global daily caps checked before spending; request cache | Runtime | Scenario: cap hit mid-discovery pauses store |
| Vetoed topic comes back | Not-interested list keyed by canonical key | Find topics | Scenario |
| Uninstall | Webhook marks closed; jobs stop; data deleted after 30 days | Connect | Scenario |
| GDPR data request | We hold no customer data; webhook answers so | Connect | Test that no order or customer field has a column |
| Store with an existing blog on the same topics | Existing-content check reads `store_pages` | Find topics | Scenario |
| No Search Console | Limited mode, labelled; no refresh candidates | Measure | Scenario |
| Published HTML mangles the Markdown | Render through a real Markdown library; snapshot of rendered HTML for three article shapes; one visual check on the dev store | Deliver | Snapshot test + the one real install smoke |

---

## 5. Data model

Seventeen tables, replacing 57. Names are proposals.

| Table | Holds |
|---|---|
| `stores` | One per shop: handle, encrypted tokens and expiry, scopes, locale, timezone, storefront host, delivery mode, target blog, publish hour, closed_at |
| `store_flags` | Operator pause, merchant pause, entitlement status (manual flag until Shopify Billing) |
| `gsc_connections` | Encrypted Google tokens, chosen property |
| `products` | Platform id, title, type, vendor, options, tags, images, collections, raw description (quarantined), content hash, richness, last seen at |
| `webhook_deliveries` | Shopify delivery id (unique), topic, received at; the dedup record |
| `product_facts` | Product, fact text, source field, extracted at |
| `store_pages` | Existing blog posts, collections, pages: URL, title, excerpt |
| `store_profile` | What the store sells, audience, tone, language, country, confirmed at |
| `topics` | Canonical key (unique per store), target query, product ids, demand, rank, state, held reason, refresh-of article id |
| `not_interested` | Store, canonical key |
| `articles` | Topic, Markdown, HTML, title, meta, slug, claims JSON, gate report JSON, state, remote id, published URL, last sent hash |
| `publish_intents` | Article, state, remote id, attempts |
| `article_metrics` | Article, window end, clicks, impressions, position, label |
| `gsc_daily` | Store, date, page, query, clicks, impressions, position |
| `llm_calls` | Request hash, prompt version, model, response, cost, store |
| `vendor_calls` | DataForSEO request hash, response, cost, store |
| `jobs` / `job_checkpoints` | Whatever the queue library needs, plus checkpoints for the two long steps |

Until the first paying store, the schema is one file and the database is reset on change. Forward-only migrations begin at launch. That is the answer to the migration ceremony.

---

## 6. Testing

### 6.1 Principles

1. **The main suite is the pipeline run on fixture stores.** Not units, not screens. A fixture store is a JSON description of a shop (products, collections, existing posts, locale) that the fake Shopify serves. The test runs the real jobs against a real Postgres and asserts on outcomes: which topics exist, which article was written, what the fake store now contains.
2. **Fakes are servers, not objects.** The fake Shopify, DataForSEO, Google and Anthropic are HTTP servers started by the test run. The real client code, with its real parsing, retries and rate limiting, talks to them. That is the difference between the current fakes (which implement the app's own interfaces, so they can never disagree with the app) and fakes that can catch a wrong field name.
3. **Every fake is checked against a recording.** A contract test, run on demand with real credentials, sends the same requests to the real vendor and to the fake and diffs the shapes. When Shopify changes, the recording changes, and the fake fails until updated.
4. **The only mocks are at the model boundary, and they replay.** Model responses are recorded by request hash. A scenario with a new prompt runs once for real (with your key), and the recording is committed. After that it is deterministic and free.
5. **One crash test per checkpoint.** Every job that checkpoints or writes an intent gets a test that kills it at each checkpoint and re-runs to convergence.
6. **Quality has its own suite and its own cadence.** Model-graded evals run on prompt change and weekly, with a real key, and post a score table.

### 6.2 The layers

| Layer | What it proves | Runs where | Time | Needs you |
|---|---|---|---|---|
| **L1 Scenario suite** | Every row of §4, through the whole pipeline, on fixture stores | Every commit, CI | Minutes | No, after the first recordings exist |
| **L2 Vendor contracts** | The fakes match the real Shopify, DataForSEO, Google, Anthropic | On demand; weekly | Minutes; costs cents | Credentials once; a dev store once |
| **L3 Crash tests** | Exactly-once under process death | Every commit | Minutes | No |
| **L4 Quality evals** | Fact sheets are faithful (target 50 cases), judge agrees with humans (target 20 cases), **writer eval**: given a fixed evidence pack, the draft cites correctly and passes the gate. **All cases are new and each set has an English and a Hungarian half** (D1, D8) | On prompt change; weekly | 15 to 30 min; costs a few dollars | Your Anthropic key; grading of new cases, the Hungarian ones by a Hungarian speaker |
| **L5 UI** | The embedded screens work against the real API on a seeded store | Every commit | Minutes | A dev bypass session for Playwright (no Shopify login in tests) |
| **L6 Real install smoke** | Install on a dev store, run the whole loop once, an article appears in the dev store's blog | On demand; before each pilot | 10 min; costs a few dollars | Dev store, app pushed, install clicked once |
| **L7 Pilot** | Real merchants, real articles, real Search Console | Weeks | — | Merchants, and your eyes on the first articles |

### 6.3 What an agent can do without you

- Write every L1 scenario from the §4 table, and add one whenever a bug is found.
- Build and maintain the four fake servers.
- Run L1, L3, L5 on every change; run L2 and L4 when the stored credentials allow it.
- Refresh recordings when a contract test fails, and report the diff in plain words.
- Produce a review page after each L4 or L6 run: the articles, their gate reports, the scores, so you only read and grade.
- Run the L6 smoke against the dev store once the install has been done and the token is stored.

### 6.4 What only you can do, stated plainly

| Need | Why an agent cannot | When |
|---|---|---|
| Shopify Partner account, the app created in the Dev Dashboard, 2 dev stores | Shopify login is yours | Before any L2 or L6 |
| Push `shopify.app.toml` and install the app on a dev store, once | Requires your browser session; no webhooks arrive until pushed (memory note) | Before L6; before webhooks can be tested at all |
| Anthropic key with a budget for evals and recordings | Costs money; the account is yours | Before L4 and before the first L1 recordings |
| DataForSEO key with a small budget | Same | Before L2 for keywords and the first recordings |
| A Google Cloud project with the Search Console API enabled and an OAuth consent screen, plus **one real property with traffic** | Google has no sandbox; a fresh dev store has no search data. The recorded GSC fixture must come from a site you own with real rows | Before L2 for GSC; the recording is then reused forever |
| Grade articles: about 20 judge cases and about 20 writer cases, half English and half Hungarian, all new | "Would a merchant be happy to publish this" is a human judgement, and the Hungarian half needs a Hungarian speaker | Once, then on each writer prompt change |
| Look at the first three published articles in the dev store's blog, in the theme | The Markdown-to-HTML bug survived because nobody looked | Once at L6 |
| Protected customer data approval from Shopify | Only if D3 says orders are in; I recommend not | — |
| Railway project, domain, secrets, Resend domain records | Yours | Before deploy |
| Pilot merchants | Yours | L7 |

### 6.5 How the fake vendors stay honest

Each fake ships with a `recordings/` folder. A recording is a request and the real response, captured by running the client against the real service with `RECORD=1`. The fake serves from its own logic but a contract test replays every recording through the fake and asserts the fake's answer has the same shape and the same meaningful fields. When you rotate keys or a vendor changes, an agent re-records and shows you the diff.

### 6.6 How the fake Shopify is kept honest (the failure to design against)

The old fakes implemented the app's own interfaces, so they could only agree with the app, and their response shapes came from the author's memory. Nothing in that loop ever touched Shopify, which is how a retired API version and hour-long token expiry shipped under a green suite. Every fact the new fake encodes must come from the real service, and the fake must lose a test when it drifts.

1. **Built from Shopify's published schema.** Shopify publishes the GraphQL schema per API version; its code-generation tooling fetches it without a store token (the agent confirms the endpoint). The pinned version's schema lives in the repo. Every query the client sends is validated against it at build time (unknown or deprecated field fails the build). Every fake response is validated against it at test time. Nightly the schema is re-fetched and diffed; a diff touching a field we use is reported in words.
2. **Every fake response descends from a recording.** No fake response is written from memory. Each response template points at a recording: real request, real response, headers, API version, capture date. A test fails if a template has no recording. Recordings are captured by running the shipping client against a dev store with a record flag.
3. **Same behaviour tests, two backends.** One test file runs against the fake on every commit and against the dev store nightly and on demand: paginate products, create blog, create article with marker, find by marker, update by id, list since date, hit the cost throttle and back off, bad token gives one error class, missing scope gives another. A test that passes on the fake and fails on the real store means the fake lies; the fake is fixed, never the other way.
4. **Probes for what only the real store can tell.** Token expiry: the nightly run reuses yesterday's stored token, so it is always expired, and asserts refresh happened before the first call. Version fallback: assert the version header Shopify answers with equals the pinned one. Retirement: a no-network test fails when the pinned version is within three months of its retirement date (quarterly releases, twelve-month support). Consistency lag: measure how long a created article takes to be findable by marker; the fake replays that delay. Throttle: one burst probe records the real throttle response. Webhooks: Shopify's CLI sends signed sample deliveries of any topic to a local URL (one-time CLI login).
5. **The dev store is sacrificial.** Contract runs create and delete products, blogs and articles on a dev store holding nothing else; every run first deletes what the last run made. A second dev store stays clean for viewing articles in a theme.
6. **What this still cannot prove.** Theme rendering, large catalogues, Plus-only behaviour, load. Those are the pilot, and the reason a human looks at the first three published articles.

---

## 7. Decisions, as taken on 2026-10-08

Each entry keeps the original framing and adds the founder's answer in bold at the end.

**D1 — Rebuild around a small core, salvaging the modules in §0.** *What exists:* the current tree, described in §2. *What I introduced:* the salvage list and the cut list. *Alternative:* fix the 80 open defects in place and delete features afterwards; keeps more code, keeps the coupling, and the end-to-end test still has to be built last. *Recommendation:* rebuild. Realistic size: the salvaged modules are about 12,000 lines with tests; the new core, connector, jobs and screens are perhaps 15,000 more. Weeks, not months, with the testing framework built first. **Answer: rebuild in a completely fresh directory. Not a single line is reused: no code, no prompts, no graded eval cases. The old tree is reference reading only.** (Clarified by the founder on 2026-10-08 after the assumption about reusing the graded cases was flagged.)

**D2 — The article queue replaces the opportunity engine as the central object.** *What the spec says:* main §1.1 makes the "Growth Opportunity" the central object and the article one execution form. *What exists:* a 7,500-line engine that detects nine signals, scores them and selects actions, and fills the calendar from them. *What I propose:* the MVP has a ranked topic queue; the one signal that survives is "our article ranks 5 to 20 for a query it gets impressions on, so refresh it". *Cost of the recommendation:* the "growth OS" positioning is postponed; the product is, for now, the thing the spec said it must not be, "an AI SEO blog writer for Shopify", but one that does not invent facts, does not link out, and measures itself. *Recommendation:* the queue. The positioning can return once the loop has run on real stores. **Answer: the article queue only, built so the growth engine is easy to add later. See §3.10.**

**D3 — Orders and revenue: out of the MVP.** *What exists:* order ingestion into a per-landing-page revenue table, aggregated with customer fields stripped, and a 60-day window. *What it costs to keep:* the `read_orders` scope, Shopify's protected customer data approval, and the GDPR webhook logic. *What it buys:* nothing shown in the MVP (the spec already hides revenue until V1.5). *Recommendation:* out. The install asks for products and content only, and the GDPR answer is trivially true. **Answer: out.**

**D4 — Search Console at install: optional with a labelled limited mode.** *What the spec says:* soft-required (Appendix B). *What I propose:* the same, but the limited mode is only "no measurement, no refresh candidates", not a scoring penalty. *Alternative:* require it; fewer installs, better data. *Recommendation:* optional. **Answer: optional, as recommended.**

**D5 — Images: product images from the catalogue, by URL, no generation.** *History:* a 2026-09-04 decision shipped without images; the competitor research and roadmap both want them. *What exists:* the sync already fetches image URLs; the export bundle lists them. *Recommendation:* the writer places a product card per referenced product; the card carries the product's first image by Shopify CDN URL and its alt text is the product title. No AI images. **Answer: no AI images; product images only, picking the one whose aspect ratio best fits the card.**

**D6 — Prices: never in article text.** *What exists:* the export renders "live" prices at bundle time, which the research found was not actually live. *What I propose:* the text never states a price; the product card shows the store's own price by linking to the product, which the theme renders. *Alternative:* a price token re-rendered on each price change, which means re-sending the article on every price edit. *Recommendation:* never in text. **Answer: never in text.**

**D7 — Job runtime: keep Graphile Worker.** *What exists:* Graphile Worker running inside the Next.js process, with a lock, ledger and DLQ layer on top. *Alternatives:* pg-boss (similar, simpler API), or a plain jobs table polled by one loop. *Recommendation:* Graphile Worker as a separate process from the web app, with a per-store lock and an idempotency ledger written fresh, without the DLQ and step-dependency graph. It is known and Postgres-only. **Answer: keep Graphile Worker.**

**D8 — The first real store.** The plan needs one Shopify dev store from day one and a real merchant store at L7. Is there a friendly store lined up, and is it in English? The first pilot store's language decides which locale's demand floor gets calibrated first. **Answer: there is one, and it is Hungarian. Hungarian and English are both MVP languages; no other language for now.** Consequences: DataForSEO is called with the Hungarian market and language for Hungarian stores; demand floors exist for `hu` and `en` only; the writer and judge prompts carry the store language; every eval set gets a Hungarian half graded by a Hungarian speaker; the dedup key leans on ranking-URL overlap rather than stemming (§3.3).

**D9 — What replaces the constitution.** See §9. Confirm the eight rules or strike some. **Answer: keep the eight rules; everything else in the constitution goes.** Rule 5 is explained in full in §9.

---

## 8. Build order

Each phase ends with something you can look at. Sizes are in agent working days and are estimates.

| Phase | Builds | Done when | Size |
|---|---|---|---|
| 0 | Your decisions (D1 to D9); Partner account, dev stores, keys (§6.4) | Decisions in `DECISIONS.md`; keys in the secret store | You, 1 to 2 weeks of waiting on Shopify |
| 1 | New repo layout, schema, fake Shopify server (§6.6), scenario harness, Shopify client with token refresh, catalogue walk with checkpoints, **connect** and **learn the store** | An L1 scenario installs a fixture store, learns it, and the fact sheets match the fixture; a contract test passes against the dev store | 5 to 7 days |
| 2 | Fake DataForSEO, **find topics**, existing-content check, queue, the confirmation screen and the queue screen embedded in the admin | Scenarios for every dedup and thin-store row of §4 pass; you can see the queue in a dev store's admin | 5 to 7 days |
| 3 | Fake Anthropic with recordings, **write** with the gate, **export**, writer eval in both languages | First article for the dev store, graded by you; export files open correctly | 5 to 7 days |
| 4 | **Auto-publish** (two-phase, rule 5), fake Google, **measure**, **keep it true**, spend caps | L6 smoke: install, loop, article in the dev store's blog; crash tests green | 5 to 7 days |
| 5 | Pilot on the Hungarian store first, then one or two more, one article a day, you grading the first week | Ten articles delivered, none held for an invented fact, none duplicated, Search Console rows attached | 2 to 3 weeks elapsed |

Phases 1 to 4 are sequential because each fake and each stage feeds the next. Inside a phase the fake server and the stage can be built in parallel.

---

## 9. What replaces the constitution

The current `CLAUDE.md` has 26 invariants, lane ownership, one-card-per-session, a migration rule already withdrawn, and lint rules that enforce spec citations. For an unreleased product most of it protects nothing. Eight rules earn their place because each one maps to a way this product can silently harm a merchant or you:

1. The writer only ever sees fact sheets, never raw descriptions.
2. Every product claim and every number in an article cites a fact; the check is mechanical.
3. No link in an article leaves the store's domain.
4. At most one article per store per day, keyed on the store's calendar day.
5. Publishing is two-phase and an update never falls back to create. *In full:* before calling the store we write a row saying "about to publish article X"; the call carries a marker holding our article id; the store's id is written back on success. A sweeper finds rows stuck between those steps and searches the blog for the marker before re-sending, so a crash can delay a publish but never duplicate it. Later changes are sent as an update to the stored id; if the store says that id no longer exists, the merchant deleted the article, we record that and stop. We never create a replacement, because recreating what a merchant deleted is the behaviour competitors are punished for, and a "not found" can also be a transient fault where creating would mean a duplicate. A deleted article only comes back through the queue, as a new topic the merchant can see and veto.
6. We never overwrite anything the merchant edited or wrote.
7. Every external call is cached and priced before it is made, and every store has a daily cap.
8. Nothing degrades to a smaller model, stale data or a forced publish; it pauses and says why.

Everything else, including how migrations work, who owns which directory, how many cards per session, and spec citations in comments, is dropped (D9, 2026-10-08). Specs become design notes; the scenario suite is the source of truth. The new repository's `CLAUDE.md` is these eight rules, the package layout, and one line: "the scenario suite is the source of truth".

---

## 10. Reference list, for the agent doing phase 1

**Nothing on this list is copied (D1).** These are the places in the old tree worth reading before writing the equivalent, because their tests enumerate cases the new build must also cover. The new connector is a `StoreConnector` interface (products, pages, blogs, articles: list, create, update, find-by-marker) with Shopify as its first implementation:

- `packages/providers/src/shopify/{graphql,oauth,limiter,publish}.ts` and tests
- `packages/providers/src/seo/` (client, cache, cost ledger, pricing) and tests
- `packages/providers/src/gsc/client.ts` and tests
- `packages/providers/src/secrets/`
- `packages/llm/` whole, including `prompts/`, `eval/`, the wrapper's shape retry
- `packages/core/src/distill/`
- `packages/core/src/gates/gate3/` (deterministic checks and judge), dropping the duplication check against the opportunity table
- `packages/core/src/publish/{markdown,bundle,intent}.ts`
- `packages/jobs/src/publish/{auto-publish,recovery,attempts}.ts` and the 30-case test
- `packages/jobs/src/ingestion/catalog.ts` and test
- `packages/jobs/src/runtime/{lock,ledger,runStep,idempotency}.ts` and tests
- `packages/db/src/testing.ts` and the global setup
- `packages/jobs/src/chaos/harness.ts` and `kill-victim.ts`, reduced to the crash-at-checkpoint helper
- The locale demand floors from `packages/rules/signals.config.yaml` (21 numbers) and the gate floors (2 numbers)
- `apps/web/app/api/webhooks/shopify/[topic]` HMAC verification

Nothing under `packages/llm/eval/` is reused either; new eval cases are written and graded fresh (D1). The old tree is not deleted until the pilot has run.
