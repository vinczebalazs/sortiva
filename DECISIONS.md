# Decisions

Dated, one plain paragraph each. "Founder" entries were taken by the founders. "Assumed" entries were taken by the agent under the founders' standing instruction to proceed on the recommendation in the brief; the founders may overrule any of them, and the entry says what changes if they do.

## 2026-10-08 — Founder: the MVP rebuild, D1 to D9

Full text in `docs/mvp-plan.md` §7. In short:

- **D1.** Rebuild in this fresh directory. Not a single line is reused from the previous build: no code, no prompts, no graded eval cases. The old tree at `~/Desktop/sortiva-old` is read-only reference.
- **D2.** The article queue is the product. The schema and interfaces are shaped so the growth engine (signal detectors) can be added later without a migration (`mvp-plan.md` §3.10).
- **D3.** No orders, no revenue. The install asks for products and content only.
- **D4.** Search Console is optional at install, with a plainly labelled limited mode.
- **D5.** No AI images. Product images only, choosing the one whose aspect ratio best fits the card.
- **D6.** No price in article text, ever.
- **D7.** Graphile Worker is the job runtime.
- **D8.** English and Hungarian are both MVP languages. The first pilot store is Hungarian. No third language.
- **D9.** The eight rules in `CLAUDE.md` are the whole constitution.

## 2026-10-08 — Founder: keys and spend

The Anthropic, DataForSEO, Shopify app and Google OAuth credentials from the previous build are in `.env`. The founder approved spending on the Anthropic and DataForSEO keys for recordings and evals without further asking. A dev store and a Search Console test property do not exist yet.

## 2026-10-08 — Founder: the new directory

`~/Desktop/sortiva`, its own git repository (B0).

## 2026-10-08 — Assumed: framework, screens, checkpoints

Taken on the recommendations in `docs/mvp-ui.md` §11 and `docs/mvp-build-plan.md` §6, under the founder's instruction to proceed as far as possible without intervention.

- **B1 — Shopify's own app template** (React Router with App Bridge, session-token authentication, Shopify CLI) for the Shopify host shell only; **not Polaris**. The screens are our own design system (see the 2026-10-08 mockups entry). If overruled to Next.js, only the host shell is rewritten; the screens, `core/`, `connectors/`, `vendors/`, `jobs/`, `fakes/` and `scenarios/` do not move.
- **U1 — The queue is a list with expected dates**, not a calendar grid. Overruling adds a calendar screen over the same `topics` table.
- **U2 — Limited mode is a badge on Home**, not a banner everywhere.
- **U3 — No editor**, not even for titles. Overruling means an edited article re-runs the deterministic checks before it can go out.
- **U4 — Results live in the Articles table and the Article page**, plus one store-level card at the top of Articles. No separate Performance screen.
- **U5 — Review-first is on by default for auto-publish, off for export.**
- **B2 — Checkpoint 3 bar: seven of ten articles publishable** before phase 4 starts. Until the founders grade, the agent's own grading stands in and is labelled as such.
- **B3 — The pilot starts on the Hungarian store alone.**

## 2026-10-08 — Assumed: inside-out order

Phases 1 to 4 of `docs/mvp-build-plan.md` are built against fakes without waiting for the founders. The five checkpoints are not skipped: at each one the agent prepares what the founder would look at (a review page, a note, a path), records it here, and continues. Anything that touches a real vendor is labelled **unverified** until its contract run has passed against the dev store or the real property.

## 2026-10-08 — Founder: the mockups are the design system; our own components, not Shopify's

A Claude Design project (`docs/mvp-ui.md` §1.1) defines the look: colour, type, spacing, tone. It is not a screen specification; `mvp-ui.md` wins on screens, words and behaviour. The founder asked whether embedding forces Shopify's component library; it does not (only the optional "Built for Shopify" badge does). So the screens are one React design system of our own, hosted by a thin shell per platform: Shopify via App Bridge now, WordPress and a standalone site later, with the same screens. Reading the mockups needs the `claude_design` MCP and a `/design-login`, which the building agent may not have; if not, the screens are built behind the same component API with neutral tokens and the real tokens are deferred, not blocked on.

## 2026-10-08 — Noted: contradictions found while reading the brief

- **Polaris.** The kick-off message pasted into the build session lists Polaris among the template's parts; this journal's founder entry of 2026-10-08 and `docs/kickoff.md` say the screens are our own components, not Polaris. The dated founder entry is followed: not Polaris. If Polaris was meant, only the screen layer changes.
- **Design mockups not reachable.** The kick-off message mentions an attached Claude Design reference. Nothing was attached in the build session and the `claude_design` connection is not available there. Per the founders' fallback, screens are built with a neutral token set behind our own component API; swapping in the real colours, type and spacing is listed in `docs/for-the-founders.md`.
- **Wrong-language scenario.** `mvp-plan.md` §4 proves the wrong-language safeguard with "a Swedish store", but D8 limits the product to English and Hungarian. The scenario is instead: a Hungarian store whose draft comes back in English is held. A store whose Shopify language is neither picks English or Hungarian in setup.
- **Table count.** `mvp-plan.md` §5 lists seventeen tables, the build plan says sixteen. The schema follows §5, plus one table §5 does not name: `job_ledger`, the idempotency ledger that §3.9 requires ("completed keys return the stored output"). It is kept apart from the queue's own tables so that clearing finished jobs can never re-open finished work.

## 2026-10-08 — Assumed: how the repository is put together (step 1)

- **One package, not a workspace.** The directories in `CLAUDE.md` (`core/`, `connectors/`, `vendors/`, `jobs/`, `fakes/`, …) sit side by side under one `package.json`. The Shopify template's `app/` directory will be the root app's route folder, which matches the layout. Splitting into packages later is mechanical.
- **Plain SQL with the `pg` driver, no ORM or query builder.** The schema is `db/schema.sql`; `pnpm db:reset` rebuilds the local database from it. Fewer moving parts; the trade-off is no generated row types, so each module types the rows it reads.
- **Test databases.** One template database is built from `schema.sql` plus Graphile Worker's own tables; its name carries a hash of both, so editing the schema builds a fresh one automatically. Every test file gets its own copy in milliseconds and drops it afterwards.
- **Per-store lock.** A Postgres advisory lock held on a dedicated connection for the whole job. A second job for the same store waits up to two minutes, then fails loudly and is retried by the queue, rather than hanging. Taking the same store twice inside one job is refused with an error instead of deadlocking.
- **Pause reasons.** `store_flags` carries, besides the operator and merchant pause switches §3.9 names, the reasons we pause on our own (daily budget reached on a given day, permissions lost, target blog missing, Search Console disconnected), because each one is a distinct banner in `mvp-ui.md` §5.5.

## 2026-10-08 — Founder: the look comes from the mockup screens

The mockup folder (`~/Desktop/Website UI mockups project`) holds the sixteen mockup screens and, separately, a "Modernist" design-system file that no screen uses. Asked in the build session, the founder said: use what is on the screens; ignore Modernist. The app's colours, type (Poppins for headings, Plus Jakarta Sans for text), radii, shadows and component shapes are taken from the screens' own stylesheet into `app/ui/tokens.css`. The screens' content still follows `mvp-ui.md`; the mockups were drawn for the older product (opportunities, calendar grid, revenue) and none of that is built. Inside Shopify the mockups' left icon rail is not drawn, because Shopify's own sidebar is the navigation.

## 2026-10-08 — Assumed: phase 1 choices that shape the system

- **Embedded sign-in is ours, not the template library's.** The app uses the structure of Shopify's React Router template (routes, Vite, Shopify CLI, `shopify.app.toml`, App Bridge from Shopify's CDN) but not its server library (`@shopify/shopify-app-react-router`). That library keeps its own copy of each store's tokens and renews them on its own, which would compete with the worker renewing the same single-use refresh token, and it cannot be pointed at the fake Shopify. Instead, as `mvp-ui.md` §1.1 describes: the page asks App Bridge for a session token, `/api/session` verifies it (Shopify's five published checks), installs the store on first sight, and returns our own 15-minute token; the screens use only ours. *Risk:* the embedded sign-in is now our code, which is what B1 tried to avoid. It is one small module with tests against the fake, and it is the first thing the founders' install on the dev store proves or disproves. If overruled, only `app/routes/api.session.ts` and `app/shell/shopify.tsx` change.
- **One model for every call, no refusal fallback.** Claude Opus 5.5 (`claude-opus-5-5`, 4 / 20 USD per million tokens). Anthropic's API offers to re-run a refused request on another model; that would be "degrading to a smaller model" (rule 8), so it is off and a refusal holds the work with a reason. Fact extraction and profile drafting run at effort "medium".
- **Facts are checked mechanically at the source.** A fact is stored only if its quote appears word for word in the field it names, and every number in the fact appears in that quote. This is stricter than the plan asked and is what lets the writer's claim check (phase 3) lean on facts being exact.
- **Daily spending caps: 10 USD per store, 60 USD for everyone.** The brief names caps without numbers. Large catalogues may hit the per-store cap on their first day; facts for the rest are extracted the next day.
- **Catalogue pages of 15 products.** Under Shopify's documented cost rules a page of 50 products with images, collections and metafields costs over 5,000 points against a 1,000-point ceiling. Shopify's demo shop charged far less than the documented rules for similar queries, but its real formula is not published, so queries are sized to the documented rules. Images, collections and metafields per product are capped at 10 each.
- **Webhook burst threshold: more than 25 product deliveries in one batch become one full catalogue re-read**; batches gather for 5 seconds.
- **Nightly re-read at 3 a.m. in each store's own timezone.**
- **The interface speaks English or Hungarian, by the Shopify admin user's language**, not only the articles. `mvp-ui.md` does not say; it cost little now and much later.

## 2026-10-08 — Noted: things found while building phase 1

- **The demo shop is a source of real Shopify answers.** Shopify's documentation explorer serves real data from Shopify's own demo shop. Our exact read queries were run against it and saved in `fakes/fake-shopify/captures/`; a test checks the fake answers each in the same form. These are not recordings from our dev store (no token, no permission limits, no writes), so `recordings/` stays empty as the brief asks.
- **The demo shop does not throttle**, so the throttled response and the "too expensive" refusal could not be captured; their shapes in the fake come from the error code Shopify's docs name and are unverified until the dev store's contract run.
- **Whether `read_locales` is needed is unverified.** The store's language is read from `shop.primaryDomain.localization.defaultLocale`; the demo app holds `read_locales`, so we cannot yet tell whether our three permissions are enough. The merchant confirms the language in setup either way.
- **Shopify's newest version is 2026-10.** The template already uses it; `.env` pins 2026-07, which stays supported until 16 July 2027. A test fails three months before that date.
- **Throttling.** Shopify reserves a query's requested cost and refunds the difference after answering. The fake does the same, charging one point per object returned in place of Shopify's unpublished formula.

## 2026-10-08 — Checkpoint 1 (built against fixtures; not waited on)

**What was built.** Installing a store (session token → expiring offline token, stored encrypted), reading the catalogue in checkpointed pages, inventorying existing collections, pages and blog posts, distilling each product into a fact sheet, drafting the store profile, keeping products current through webhooks, a nightly re-read and "Sync now", pausing with a named reason on a refused permission or a spent budget, and setup screens 1 and 2 in both languages.

**Scenarios that exist and pass (all against fakes):** install creates the store with encrypted tokens and the shop's language, country and timezone; reinstall reuses the store; a token past expiry is renewed before the first call; a withdrawn permission pauses with the permission named and never disconnects; the 250-product catalogue resumes after a crash at page 3 with no page read twice; a product gone from Shopify is marked deleted; a price change re-reads the product without a model call; a description change re-extracts its facts; the same delivery twice is processed once; a delete webhook is acted on only after re-reading; a forged signature is refused; 500 updates in a minute become one catalogue re-read; "Sync now" is refused while a sync runs; every fact quotes its source verbatim (English and Hungarian rich stores); marketing-only stores come out thin with one usable product; empty stores stop setup and spend nothing; two jobs for one store never overlap; the nightly re-read picks each store in its own night, once; no table has a column for customer or order data. Plus the connector behaviour suite, the fake's own tests, and the query checks against the pinned schema.

**What to look at.** The fact sheets for five products of every fixture store, beside the products: `docs/checkpoints/checkpoint-1-fact-sheets.html` (also published as a private page: https://claude.ai/artifact/LsPqnSMS1Nj8qaMtZKtqKJ). Regenerate with `pnpm seed:preview <fixtures…>` then `npx tsx scripts/checkpoint-1.ts`.

**Agent's reading of it.** The kept facts are faithful: each traces to a quoted span, numbers and units are unchanged, and marketing lines ("Elevate your mornings", "A tökéletes nap tökéletes lezárása") were left out. Some kept facts are trivial (the product's vendor, "is a dripper"); they are true but give a writer little. Whether to tell the extractor to skip such restatements is for the founders.

**Unverified.** Everything that touches a real Shopify: the session-token check and token exchange against a real install, token renewal, the version header, throttling, webhook signatures from Shopify itself, whether three permissions suffice for the store's language. The contract suite (`pnpm test:contract`) proves or disproves these against the dev store.

**Unsure.** (1) Whether "Understanding each product" should block setup for a large catalogue: today the profile waits for every fact sheet. (2) The crash test kills the job by throwing at a checkpoint, not by killing the process; a real process kill is planned with the phase 4 crash tests.

## 2026-10-08 — Founder: phase 2 topic rules

Asked at the start of phase 2; answered in the session.

- **Topic-finding runs again when the queue runs low**: when fewer than 5 topics are waiting, at most once a week, and also after the merchant changes the store profile. Each run costs one model call and about 0.10 USD of DataForSEO.
- **Queue size**: a thin store (fewer than 5 products with enough facts) gets at most one topic per such product; any other store at most 30 waiting topics, about a month.
- **A topic the merchant types in** is accepted even if few people search for it (their choice overrides our minimum), and if it is already in the queue, that topic moves to the top and the screen says so. Neither adds an outcome to `mvp-ui.md` §5.3 beyond "moved to the top".
- **DataForSEO money is left until the end of the phase.** The account holds 0.82 USD; recording real answers for all fixture shops costs about 1 USD per version of the topic prompt on the Google Ads volume endpoint (0.09 USD a request; top-ten results 0.002 USD a phrase). Until that is settled, scenarios run against the fake DataForSEO answering in the shape of DataForSEO's published examples, with numbers each scenario sets.

## 2026-10-08 — Assumed: how topics are found and checked (phase 2)

- **Demand floors are the old build's: 100 monthly searches for English, 20 for Hungarian**, as `mvp-plan.md` §3.3 says to keep them. The handoff's placeholder for English was 50. The old file itself marked these numbers as never signed off, so they are worth a look once real volumes come in.
- **"Already has a page about this"** means an existing blog post or page whose title or address covers at least two thirds of the query's meaningful words, ignoring words that run through the whole shop (such as "dog" in a dog shop). Without that exception, "how to clean a dog leash" was thrown out because the shop has a post on leash length. Collections are not compared: they are the shop's product listings, which an article links to rather than competes with. Hungarian title matching is weak (word forms change a lot), so for Hungarian the main duplicate check is the next one.
- **Same intent** means two phrases whose top three Google results share at least two pages. The higher-demand one is kept; a new candidate never displaces a topic already waiting in the queue.
- **"All ten results are product listings"** is judged per result: one with a price on Google or with a shop address (/products/, /collections/, /termek/ and similar) counts as a listing.
- **Ranking** multiplies demand (on a log scale) by how many distinct facts back the topic and by how much of the first page is not shop listings. The weights are in `core/config.ts`.
- **"Skip this one"** on today's topic takes it out of the queue without marking it "not interested", so a later search may propose it again; if it had already taken today's slot, today stays empty.
- **A pause on the day's run is final for that day.** If the shop is paused at its publish hour, the day is recorded as skipped with the reason and is not made up later the same day.
- **Search answers are reused for 30 days (volumes) and 7 days (top results)**, then fetched again, never served stale (rule 8).
- **When DataForSEO cannot answer** (including an empty balance), topic-finding stops and is retried; it never continues without the numbers. No banner exists for this in `mvp-ui.md`; the queue simply does not grow. Worth a decision before launch.
- **Changing the article language** in Settings takes waiting topics in the old language out of the queue and searches again.
- **"Create a blog called 'Blog'"** in setup step 4 is recorded as the merchant's choice; the blog is created when auto-publish is built in phase 4.

## 2026-10-08 — Founder: Google's top ten through DataForSEO's queue

DataForSEO's instant ("live") top-ten request answers this account only with "50000 Internal Server Error", on both its variants and on every retry, while the service reports itself healthy; the queued request works. Asked in the session, the founder chose the queue. Topic-finding now submits every phrase in one request and collects the results about 30–60 seconds later; it costs 0.0006 USD a phrase instead of 0.002. A task submitted by a run that died is collected later, never submitted and paid for twice. "Add a topic" waits for this too, so it can take about a minute. The live failure is worth raising with DataForSEO support; switching back is a change to `vendors/dataforseo/client.ts` only.

## 2026-10-08 — Checkpoint 2 (fixture shops, real Google demand; not waited on)

**What was built.** The fake DataForSEO (answers shaped like DataForSEO's published examples, checked against the real answers recorded so far), the DataForSEO client (priced against the daily caps before every call, answers reused 30 days for volumes and 7 for top results), topic-finding (one model call per shop, then the existing-content check, the demand floor, the shop-listings check, the same-intent check, ranking and the queue cap), "Add a topic", "Not interested", "Move to top", "Skip this one", the daily pick at the publish hour keyed on the shop's own calendar day, re-finding topics when the queue runs low, setup steps 3 and 4, and the Home, Products and Settings screens in both languages, with Shopify's navigation once setup is done.

**Scenarios that exist and pass (all against fakes):** finding topics twice adds no duplicate (English and Hungarian rich shops); Hungarian demand is asked for Hungary in Hungarian and English for the shop's own country, and every topic carries its numbers with source and date; all candidates go into one demand request per run; three-product shops get at most three topics, all about products we hold facts for; a shop with one usable product gets at most one; two candidates with the same top three collapse to the higher-demand one; nothing queued competes with an existing post, and asking for that post's subject is answered with the post (dog shop and bike shop); "Not interested" keeps a topic out of the next search; a spending cap hit during topic-finding pauses the shop with the budget banner, queues nothing and does not retry; a merchant's own topic goes to the top, and asking again moves it rather than adding it twice; a topic only fluff products relate to is refused, naming them; the daily pick runs once per shop-local day across midnight in New York; a paused shop's day is recorded as skipped with the reason and shows no dates; "Skip this one" leaves today empty without back-filling; a low queue sends topic-finding out again after a week.

**What to look at.** The queues for the Hungarian and English rich shops, with real monthly searches and Google results: `docs/checkpoints/checkpoint-2-queues.html` (published privately: https://claude.ai/artifact/LvjY53S6G8mvCXi9BQ4Kty). On screen: `pnpm seed:preview rich-hu:done rich-en:done`, then `pnpm preview` and the addresses it prints. Regenerate the page with `npx tsx scripts/checkpoint-2.ts`.

**Agent's reading of it.** The topics are ones these shops can write credibly (brewing cold brew, using a French press, preparing nettle and thyme tea), and the why lines state only what the numbers show. But only 8 of 35 proposed topics cleared the minimum: Google Ads reports no figure, or a tiny one, for most of the exact phrases the model chose. At this rate a rich shop runs dry in about a week. **Open question for the founders**, with the agent's recommendation first: (1) ask the model for two or three phrasings per topic and keep the most searched, at no extra DataForSEO cost; (2) lower the minimums (100 English, 20 Hungarian); (3) leave it.

**Unverified.** Everything touching Shopify (no dev store yet), the embedded navigation inside the real admin, DataForSEO error answers other than the ones seen (their bodies are not published), and the volumes and results for the fixture shops other than the two rich ones, which still come from the fake's stable placeholder numbers.

## Spend

Running total of what this build has spent on the founders' keys.

| Date | Key | What | USD |
|---|---|---|---|
| 2026-10-08 | Anthropic | Phase 1 recordings: fact sheets and profile drafts for the ten fixture stores and the 250-product catalogue (69 calls, Claude Opus 5.5) | 0.92 |
| 2026-10-08 | Anthropic | Phase 2 recordings: topic proposals and "Add a topic" matches (14 calls) | 0.53 |
| 2026-10-08 | DataForSEO | Checkpoint 2: monthly searches for the two rich shops (2 requests), their top ten through the queue (9 tasks) | 0.19 |

**Total: 1.64 USD** (Anthropic 1.45, DataForSEO 0.19). DataForSEO balance left: 0.64 USD. Anthropic figures are computed from the token counts in the committed recordings at 4 / 20 USD per million input / output tokens; DataForSEO figures from the account balance before and after.
