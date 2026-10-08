# What is left before the first real store

Written 9 October 2026 for the founders, at the end of phase 3. It covers phases 1 to 3 (phase 1 was built by an earlier agent session; its open items are folded in) and everything still to do before Sortiva runs on the Hungarian pilot store. "You" means the founders; "the agent" means the building agent. Each item says what it unblocks, roughly how long it takes, and what it costs.

## Where things stand

Sortiva can install on a store, read its catalogue, turn each product into checked facts, draft a store profile, take the merchant through setup, find topics with real Google demand, keep a one-a-day queue, write an article, check it mechanically and with a separate reviewing model, repair it once, hold it with a plain reason when it still fails, and hand it over as a download. The merchant sees all of this in English or Hungarian.

All of it runs against **fakes**: small servers that stand in for Shopify, Anthropic, DataForSEO and Google and answer from recorded real responses. **Nothing has touched a real Shopify store, a real Search Console property or a production server yet.** That is the main gap between here and the first store.

What is not built at all yet (phase 4): publishing to the store's blog, Search Console, measuring results, keeping published articles true when products change, uninstall and data deletion, and deployment.

## Blocking right now

**1. Top up the Anthropic account.** It ran out of credit during the night of 8 October, partway through phase 3. Until it is topped up, no new model answer can be recorded, so 18 of the 20 writer-eval articles, all 50 distillation cases and all 20 judge cases cannot run, and checkpoint 3 has 2 of its 10 articles. *Suggested: 50 USD.* That covers the evals and checkpoint 3 (about 10 USD), two or three rounds of writer-prompt changes after you grade (about 20 USD), and phase 4's recordings. Afterwards the agent runs `npx tsx scripts/checkpoint-3.ts --record` and `pnpm eval … --record`.

## What only you can do, in the order it unlocks work

| # | What | Unblocks | Time | Cost |
|---|---|---|---|---|
| 1 | Top up Anthropic (above) | Checkpoint 3, evals | 5 min | ~50 USD |
| 2 | Top up DataForSEO (0.26 USD left) | Real demand numbers for the other six test shops; any topic-prompt change; the pilot store's topic search | 5 min | 10–20 USD |
| 3 | Grade checkpoints 1, 2 and 3 (below) | Writer prompt changes; the go-ahead for phase 4 | 1–2 h | — |
| 4 | Two Shopify development stores, install the app on one, run the contract tests (`docs/for-the-founders.md` steps 2–3) | The first proof that sign-in, token exchange, permissions, webhooks and the catalogue read work against real Shopify. 28 tests are waiting for these recordings | 1–2 h | free |
| 5 | Google Cloud project with the Search Console API, an OAuth consent screen, and one real property with search traffic | Search Console in phase 4 | 1 h, plus Google's review (see risks) | free |
| 6 | Connect PostHog (decided 8 October) | You hear about vendor failures and low DataForSEO credit; until then nobody on our side is told | 30 min | free tier |
| 7 | Railway project and the production domain | Deployment | 30 min | ~5–20 USD a month (estimate, unverified) |
| 8 | Choose how the app is distributed in Shopify (decision below) | Installing on a store that is not a development store | 15 min | — |
| 9 | A privacy policy and a support contact at public addresses | Shopify's app settings ask for them (needed for public distribution; check whether custom distribution needs them) | 1–2 h | — |
| 10 | The pilot merchant's agreement, and their Search Console access | The pilot | — | — |
| 11 | A Hungarian reader for the Hungarian halves of the evals and checkpoints | Hungarian article quality; the agent's Hungarian grades are not a native speaker's | ongoing | — |
| 12 | Twenty real English and twenty real Hungarian product descriptions (can be the pilot store's) | The distillation eval on real copy instead of the agent's invented cases | 30 min | — |

### What to grade

- **Checkpoint 1, facts** (`docs/checkpoints/checkpoint-1-fact-sheets.html`): are the kept facts true, and are they facts? Open question: keep trivial facts like "is made by Fernhill", or tell the extractor to skip them?
- **Checkpoint 2, topics** (https://claude.ai/artifact/LvjY53S6G8mvCXi9BQ4Kty): would a merchant want these topics, and are the why lines true?
- **Checkpoint 3, articles** (`docs/checkpoints/checkpoint-3-articles.html`; 2 of 10 written until the credit is back): would you publish each one? The plan's bar is **seven of ten** before phase 4 starts. The agent's grades on the page are labelled as its own.

## What the agent still builds

**Finish phase 3 (once credit is back):** write the remaining 18 eval articles and run the distillation and judge evals; rebuild checkpoint 3 with ten articles; add "no HTML" to the writer's instructions (a check already refuses HTML; the instruction just saves repairs); then change the writer prompt according to your grades, and re-run.

**Phase 4, the remaining build:**
- **Publishing to the store's blog.** Two-phase: we record our intent, create the article in Shopify with a hidden marker, then confirm. A sweeper repairs anything a crash interrupted, by finding our marker before re-sending, so a crash can never post twice (rule 5). Live or draft-in-Shopify, at the publish hour, creating the blog if the merchant asked us to. "Approve" then really sends.
- **Never overwriting the merchant** (rule 6): before any update we compare the article in Shopify with what we last sent, and skip if they edited it.
- **Search Console:** the connect flow (today setup only offers "Skip"), choosing the property, a nightly sync, 28-day numbers and the above/typical/below labels on the Articles screen, and "refresh" topics for articles ranking 5th to 20th.
- **Keep it true:** when a product in a published article is deleted or its facts change, remove its card and re-send once.
- **Uninstall and privacy requests:** Shopify already sends these to us (the subscriptions are declared), but nothing acts on them yet. Uninstall must stop all work and delete the store's data after 30 days; the three privacy webhooks must answer that we hold no customer data.
- **Deployment to Railway:** the web app and the job worker as two services, the database, secrets, a health check, and the schema turned into its first migration.
- **Crash tests that really kill the process**, rather than throwing an error at a checkpoint.
- **A weekly run of the judge eval**, so a change on Anthropic's side shows up as a score change.
- **PostHog events** for vendor failures and low DataForSEO credit, once you have connected it.

**Phase 5, the pilot:** install on the Hungarian pilot store with review-first on, one article a day, a daily review page from the agent, and you approve or discard every article in the first week.

## The path, step by step

1. Top up Anthropic and DataForSEO. The agent finishes phase 3's runs.
2. You grade checkpoint 3. If fewer than seven of ten are publishable, the agent changes the writer prompt and you grade again.
3. You create the dev stores and run the contract tests. The agent fixes whatever the real Shopify does differently from the fake.
4. You set up Google Cloud and Search Console. The agent builds phase 4 against the fakes, then records the real answers.
5. **Checkpoint 4:** the whole loop on the clean dev store, and you look at a published article in the store's theme, on desktop and phone.
6. You set up Railway, the domain and PostHog, and choose the distribution method. The agent deploys.
7. The pilot merchant installs. Review-first stays on for the first week.
8. **Checkpoint 5**, after ten delivered articles: none held for an invented fact, none duplicated, each published one findable by its marker, Search Console rows attached.

## Decisions waiting for you that matter for production

- **Shopify distribution.** *Custom distribution* gives an install link for one store: simplest for a pilot, no app review. *Public distribution* is needed before other merchants can install, and goes through Shopify's review. As far as the agent knows, an app's distribution method cannot be changed once chosen, so one option is a separate "Sortiva Pilot" app with custom distribution, keeping the main app free for public listing later. *Unverified: check this in the Partner Dashboard before choosing.*
- **Start the pilot without Search Console?** It is optional by your decision D4; the store then runs in the labelled limited mode (no results, no refresh topics). If Google's review of the consent screen is slow (see risks), starting limited and connecting later avoids waiting.
- **Daily spending caps** are 10 USD per store and 60 USD in total (assumed in phase 1). A day of writing typically costs 0.35–0.75 USD per store, so the caps leave room; a first catalogue read of a large store can reach the per-store cap, and then finishes the next day.
- **Trivial facts**: keep or drop (checkpoint 1).
- **Common-knowledge numbers**: you allowed them on 8 October. On the first articles the reviewing model accepted every one it was shown, so it is permissive. Worth watching in grading.

## Risks and unverified items

- **Google OAuth.** While a consent screen is in "testing" mode, Google expires the refresh tokens after seven days, so Search Console would disconnect weekly. Moving it to "in production" with the read-only Search Console permission may require Google's verification, which can take days to weeks. *Unverified; check before phase 4 depends on it.*
- **Embedded sign-in is our own code** (phase 1 decision), not Shopify's library. The dev-store install is its first real test.
- **Permissions:** whether reading the store's language needs one more Shopify permission is unverified until the dev store.
- **Throttling and "too expensive" errors** from Shopify were never seen for real; their handling is built from Shopify's documentation.
- **Downloads inside the Shopify admin:** the export button starts a browser download from inside Shopify's frame. Whether the admin allows that is unverified until the dev store.
- **The Shopify API version** pinned is 2026-07, supported until July 2027; a test starts failing three months before.
- **Cost per store, estimated from the recorded runs:** an article that passes costs about 0.30–0.40 USD in model calls; a held article roughly the same again; topic-finding about 0.10 USD of model calls plus about 0.10 USD of DataForSEO per run, at most weekly; reading a new product about 0.015 USD once. Roughly 10–20 USD a month per store at one article a day.

## Spend so far

Anthropic about 7.15 USD (phases 1–2: 2.66; phase 3: 4.49), DataForSEO 0.57 USD. Details in the "Spend" table in `DECISIONS.md`.
