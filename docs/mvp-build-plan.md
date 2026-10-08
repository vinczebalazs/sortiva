# Sortiva MVP — build plan

Written 2026-10-08. Companion to `docs/mvp-plan.md` (what and why) and `docs/mvp-ui.md` (the screens). Audience: the founders, and the first agent session in the new repository. Agent time is cheap; the plan is ordered by dependency and by the points where a human has to look at something, not by effort.

---

## 1. Ground rules

1. **Fresh directory, fresh repository, nothing reused.** Not a line of code, not a prompt, not a test case from the old tree. The old tree may be read for behaviour and for the cases its tests enumerate. The old tree is not deleted until the pilot has run.
2. **The fake comes before the stage that needs it.** No stage is built against a vendor until the fake server for that vendor exists and has at least one recording from the real service.
3. **The scenario suite is the source of truth.** A stage is done when its scenarios pass, not when its code exists. Every safeguard in `mvp-plan.md` §4 is a scenario before it is code.
4. **Checkpoints are where a human looks.** Five of them, listed in §4. The agent stops at each and does not continue until a founder has looked and said so. This is the single rule that would have caught every bug the old build shipped.
5. **One agent owns the skeleton.** Until the end of phase 1 one session works alone, because everything later depends on the shape it sets. After that, three or four agents at most in parallel (the usage window was blown twice at thirteen).
6. **Decisions still go in a journal.** `DECISIONS.md` in the new repository, dated, one paragraph each, plain language. That is the only ceremony kept.

---

## 2. The new repository

**Name and place (B0, founder).** Proposed: `~/Desktop/sortiva-next`, its own GitHub repository, renamed when the old one is archived.

**Framework (B1, founder).** Two real options:

- **Shopify's own app template** (React Router, formerly Remix, with App Bridge, session-token authentication, Polaris components and the Shopify CLI wired in). *For:* embedded authentication, the hardest part to test, is done by Shopify's code; the CLI runs the app in a dev store with one command and sends sample webhooks; the screens look native with no effort. *Against:* a framework nobody on the team has used.
- **Next.js, as the old app**, with App Bridge and session-token checking written by us. *For:* known. *Against:* the embedded auth is ours to get right, and the old build never got that far.

*Recommendation:* Shopify's template. The part of this product that cannot be tested with fakes is the embedded session, and the template is the one place that code already exists and is maintained by the vendor.

**Layout**, whichever framework:

```
app/            the embedded screens and their routes (thin: parse, call core, render)
core/           the pipeline stages as plain functions; no framework, no vendor SDK
connectors/     StoreConnector interface; shopify/ as its first implementation
vendors/        dataforseo/, google-search-console/, anthropic/ clients, each with a cache and a cost ledger
db/             one schema file, the test-database helper; migrations start at launch
jobs/           Graphile Worker tasks: one per stage, plus the sweepers
fakes/          fake-shopify/, fake-dataforseo/, fake-google/, fake-anthropic/ — HTTP servers with recordings/
scenarios/      the pipeline suite: fixture stores + tests
evals/          graded cases, English and Hungarian halves, and the runners
docs/           this plan and its companions, the old specs as history, DECISIONS.md
```

A test proves `core/` imports nothing from `app/`, `connectors/` or `vendors/` except their interfaces.

**Tooling.** pnpm, TypeScript, Vitest, Postgres in Docker Compose for local runs and a service container in CI, Playwright for the screens. Two CI jobs on every push: the fast suite (scenarios, crash tests, screens against the fake vendors, under ten minutes) and the contract suite (nightly and on demand, needs the stored credentials). Deployment to Railway from phase 4.

---

## 3. Phase 0 — what the founders do before and alongside phase 1

Nothing in phase 1 waits on the Shopify items; phase 1 builds against the fake and the public schema. The items are ordered by how long they take to come back.

| Item | Needed by | Notes |
|---|---|---|
| Answer B0, B1 above and U1 to U5 in `mvp-ui.md` | Start of phase 1 | B1 decides what the skeleton is |
| Shopify Partner account; create the app in the Dev Dashboard; two dev stores (one sacrificial, one clean, both with Hungarian and English test products) | Phase 1 checkpoint | The agent writes the exact app settings and scopes to paste |
| Install the app on the sacrificial dev store once, from the browser | First contract run, end of phase 1 | After this the stored token is refreshed by the agent's runs |
| Anthropic key with a monthly budget | Phase 3 | Recordings and evals cost a few dollars per run |
| DataForSEO key with a small budget | Phase 2 | Recordings cost cents |
| Google Cloud project, Search Console API enabled, OAuth consent screen, and one real property with search traffic | Phase 4 | Google has no sandbox; the recording must come from a real site |
| Shopify CLI login once, for sample webhook deliveries | Phase 1 contract run | |
| Twenty English and twenty Hungarian product descriptions for the distillation eval, and someone to grade the Hungarian halves | Phase 3 | Can be real products from the pilot store |
| Railway project and the production domain | Phase 4 | |
| The Hungarian pilot store's agreement | Phase 5 | |

---

## 4. Phases and checkpoints

Each phase lists what is built, which scenarios it adds, what "done" means, and where the founder looks.

### Phase 1 — Skeleton, harness, fake Shopify, connect, learn the store

Builds:

- Repository, layout, tooling, CI, the one-file schema (the sixteen tables in `mvp-plan.md` §5), the test-database helper (template database per suite), Graphile Worker in its own process with the per-store lock and the idempotency ledger.
- **Fake Shopify** per `mvp-plan.md` §6.6: built from the published schema of the pinned API version, serving fixture stores over GraphQL, with OAuth and token-exchange endpoints, token expiry, cost-based throttling, webhook delivery with signatures, and a `recordings/` folder. Fixture stores: a rich English store, a rich Hungarian store, a three-product store, a store with an existing blog, a store with fluff descriptions, an empty store.
- The `StoreConnector` interface and its Shopify implementation: install, token refresh, read products and collections and pages and blog articles in pages with checkpoints, create and update and find-by-marker articles, webhooks (product and collection topics: signature check, dedup by delivery id, re-read from the API, burst collapse into one catalogue job), and the catalogue re-read job that "Sync now" and the nightly pass share, with the content hash that limits fact re-extraction to changed products.
- **Connect** and **Learn the store**: install flow, store row, catalogue walk, fact extraction (against the fake Anthropic, see below), store profile draft, the setup screens 1 and 2.
- A minimal **fake Anthropic** early, because fact extraction needs it: records and replays by request hash; a new prompt runs once for real and the recording is committed.

Scenarios added: install a fixture store; walk a 250-product catalogue in pages and resume after a kill; a product webhook re-reads that product and re-extracts facts only if its description changed; the same delivery twice is processed once; 500 update webhooks in a minute produce one catalogue re-read; "Sync now" while a sync is running is refused; a product's facts cite their source fields; a fluff description yields few facts and a low richness; an empty store stops setup; a token past expiry is refreshed before the first call; a 403 pauses with a banner and does not disconnect; two jobs for one store serialise.

Contract run (needs the dev store): the same connector tests against the sacrificial store; the version header equals the pinned version; a sample webhook from the CLI passes the signature check.

**Checkpoint 1 (founder):** open the app in the dev store's admin, watch setup read the store, read the fact sheets for five products side by side with the products. Are the facts true, and are they facts?

### Phase 2 — Topics, queue, Home, Products

Builds:

- **Fake DataForSEO** with recordings for keyword volume and top-ten results, for English and Hungarian markets.
- **Find topics**: candidate generation from the profile and facts, demand lookup, the existing-content check (store pages, our own topics, ranking-URL overlap), ranking, the thin-store floor, the not-interested list, manual topic add with the same checks.
- **Schedule**: the daily job keyed on the store's calendar day, pause flags, the spend caps (per-store and global daily, checked before every spending stage).
- Screens: Home with Today, Up next, Add a topic, thin-store state, banners; Products with "Last synced" and "Sync now"; Settings profile and pause sections; setup steps 3 and 4 as screens only (Search Console connect is wired in phase 4).

Scenarios added, one per row of `mvp-plan.md` §4 that concerns topics: discovery run twice yields no duplicate; two near-identical candidates collapse to one; a candidate matching an existing store page is dropped; a three-product store yields at most three topics and no generic ones; a vetoed topic is not re-proposed; a Hungarian store is priced on Hungarian volumes; a cap hit mid-discovery pauses the store with a reason; the day key is computed in the store's timezone across midnight.

**Checkpoint 2 (founder):** the queue for the Hungarian dev store and the English dev store, on screen. Are these topics a merchant would want? Are the why lines true?

### Phase 3 — Write, gate, export, the Article page, evals

Builds:

- **Write**: the evidence pack, the plan call, the draft call, the deterministic checks (claims cite facts, numbers cite facts, store-domain links only, no first person experience, length, language, no price, minimum distinct facts), the judge call (blind to the writer), one repair, hold with reason. Product cards with the aspect-ratio image choice.
- **Export**: Markdown, HTML, metadata, as a zip; the "where did you publish it" field.
- Screens: Articles table, the Article page with preview, facts panel, checks, actions; review-first flow (approve / discard).
- **Evals**: distillation (target 50 cases), judge (target 20), writer (target 20), each with an English and a Hungarian half, graded by the founders; the runner that prints a score table and a review page of the articles produced.

Scenarios added: a seeded draft with an uncited claim is held; an uncited number is held; a first-person experience sentence is held; an outside link is held; wrong-language output is held; a price in text is held; a draft referencing fewer than the fact floor is held; a malformed model answer retries once then holds; the judge failing twice holds with the second set of notes; an approved article moves to ready; a discarded one marks the topic not interested; the rendered HTML snapshot for three article shapes (list-heavy, table, long-form) matches, and the Markdown structure survives rendering.

**Checkpoint 3 (founder):** the first ten articles, five per language, as a review page with their gate reports, graded by you and your co-founder. This is the first time anyone sees what the product writes, and the writer prompt will change here. Phase 4 does not start until at least seven of ten are ones you would publish.

### Phase 4 — Auto-publish, Search Console, measure, keep it true, deploy

Builds:

- **Deliver**: two-phase publish against the connector (rule 5), the recovery sweeper, draft-in-Shopify mode, publish hour, the remote-body hash check before any update, target blog creation.
- **Fake Google** with a recording from the founder's real property; the Search Console connect flow in a top-level window; property selection; the nightly sync per page and per query; the 28-day article metrics and labels; the refresh candidate rule; the Articles results columns and the one store-level card.
- **Keep it true**: the nightly catalogue re-read, product-gone and facts-changed handling.
- Uninstall webhook, 30-day deletion, the GDPR webhook answers.
- Deployment to Railway: web and worker as two services, migrations on deploy (the schema file becomes migration 0001 here), health check, secrets.

Scenarios added: kill between create and confirm converges to exactly one remote article; the sweeper finds the marker and only records the id; an update to a deleted remote id marks the article removed and creates nothing; an article edited in the fake store is never updated; a product removed from the fake store removes its card and re-sends once; a store without Search Console shows no results and no refresh topics; an article ranking 11th with impressions becomes a refresh topic; labels appear only after day 28 and are relative to the store's median; uninstall stops jobs and deletes after 30 days.

Contract run: the same publish tests against the sacrificial dev store; a real article created, found by marker, updated, and the measured consistency lag written into the fake's replay delay.

**Checkpoint 4 (founder):** install on the clean dev store, run the whole loop, open the article in the dev store's blog **in the theme**, on desktop and phone. Does it look like an article a merchant would be proud of? Check the product cards, the images, the headings, the links.

### Phase 5 — Pilot

- Install on the Hungarian pilot store with review-first on. One article a day. The founders approve or discard every article for the first week and note why in the journal.
- The agent produces a daily review page: yesterday's article, its checks, anything held and why, spend.
- After the first week, review-first stays the merchant's choice.
- Search Console connected on the pilot store; the first labels appear after 28 days.

**Checkpoint 5 (founder):** after ten delivered articles: none held for an invented fact, none duplicated, every published one findable by its marker, Search Console rows attached. Then a second store, ideally English.

---

## 5. What the agent produces at each checkpoint, so the founder only has to look

- A short note in plain language: what was built, which scenarios were added, what is uncertain.
- A link or a path to the thing to look at (the dev store's admin page, the review page of articles, the blog post).
- The score table from the evals, when they ran.
- The open questions, each with the agent's recommendation.

The founder's answer is one of: continue; change this and show me again; stop.

---

## 6. Decisions for the founders in this document

- **B0** — Directory name and repository. Proposed `~/Desktop/sortiva-next`, own repository.
- **B1** — Shopify's app template or Next.js. Recommendation: the template, because embedded sign-in is the one thing fakes cannot test.
- **B2** — Checkpoint 3's bar: seven of ten articles publishable before phase 4 starts. Raise or lower it.
- **B3** — Whether phase 5 starts on the Hungarian store alone or on both dev stores' languages with a second friendly store. Recommendation: Hungarian alone first, because you can read it.
