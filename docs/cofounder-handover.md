# Taking over Sortiva: a handover for the co-founder

Written 9 October 2026 by the building agent, at Balázs's request, for the co-founder who takes over directing the build. It assumes you have not followed the build so far and that, like Balázs, you direct the work rather than read the code. Everything named here is in the `sortiva` folder unless it says otherwise.

## What Sortiva is

An app a merchant installs on their Shopify store. It reads the catalogue and turns each product's description into short, checkable facts. From those it works out what the store can credibly write about and which of those topics people actually search for on Google. Then it writes at most one blog article a day and either publishes it to the store's blog or hands it over as files. Every claim about a product must come from one of the store's own facts, no link leaves the store, and nothing is published that failed our checks. English and Hungarian. The first pilot store is Hungarian.

The full brief is in `docs/`: `mvp-plan.md` (what and why), `mvp-ui.md` (every screen), `mvp-build-plan.md` (the order of work and five checkpoints).

## How the work is done

The code is written by an AI agent (Claude Code), working in this folder. A founder directs it: says what to build next, answers its questions, and judges results at each checkpoint. The agent does not decide anything that shapes the product; it asks, and it records every decision in `DECISIONS.md` (dated, one plain paragraph each, marked "Founder" or "Assumed"). It commits its work with plain descriptions, never pushes or deploys on its own, and never touches the previous build in `~/Desktop/sortiva-old` except to read it.

Two sets of instructions shape how the agent behaves:

- **`CLAUDE.md` in the folder**: the project's eight rules and working rules. It travels with the code.
- **Balázs's personal instructions** (`~/.claude/CLAUDE.md` on his laptop): plain language, say whether something exists or is only proposed, ask before deciding anything that shapes the system, don't build what wasn't asked for, every question starts with where it comes from. These live on his machine only. **Ask Balázs for a copy and put it in your own `~/.claude/CLAUDE.md`**, or the agent will work differently for you.

A session starts with: *"Read CLAUDE.md, then docs/handoff.md, and continue."* `docs/handoff.md` is the agent's own technical handover between sessions; it is kept current at the end of each phase.

## Where things stand

| Phase | What | State |
|---|---|---|
| 1 | Install, read the catalogue, products into facts, store profile, setup screens | Built against stand-ins for Shopify; never run on a real store |
| 2 | Find topics with real Google demand, the daily queue, Home, Products, Settings | Built; real search numbers for the two main test shops |
| 3 | Write articles, check them, repair once, hold with a reason, Articles screens, download, evals | Built; 8 of the 10 checkpoint articles pass our checks, not yet graded by a founder |
| 4 | Publish to the blog, Search Console, results, keeping articles true, uninstall, deployment | Not started |
| 5 | Pilot on the Hungarian store | Not started |

"Built against stand-ins": nothing has touched a real Shopify store, a real Search Console property or a production server yet. Shopify, Anthropic (the model), DataForSEO (search numbers) and Google are replaced in tests by small fake servers that answer from recorded real responses. 197 automatic tests pass.

**Quality so far.** On the ten checkpoint articles (the top five topics of an English and a Hungarian test shop), 8 pass our checks: all five English, three of five Hungarian. Across the wider set of twenty, 12 pass. On 9 October Balázs chose to tighten the writer (never add anything a fact doesn't state) rather than relax the checks; that cut holds for unsupported claims from six to three. The remaining holds are mostly for filler: strings of one-fact sentences, repetition, product mentions off the topic. That is the next thing to improve in the writer's instructions, once you have graded. The reviewing model agrees with expected verdicts on 20 of 20 test cases, and fact extraction passes 50 of 50.

## What you should look at first

1. **`docs/first-real-store.md`**: everything left before the pilot store, in order, with time and cost, split into what only the founders can do and what the agent builds. Also published privately: https://claude.ai/artifact/JVgWgskVwBfjfZuZAAgC8B
2. **Checkpoint 3, the articles** (`docs/checkpoints/checkpoint-3-articles.html`; https://claude.ai/artifact/2r6QQYRd3zwaU5y63nbxTS): ten articles with what the checks and the reviewer found. Nobody has graded these versions yet; that is your first job. The bar is seven of ten you would publish before phase 4. The Hungarian ones need a native reader.
3. **Checkpoints 1 and 2**: the facts (`docs/checkpoints/checkpoint-1-fact-sheets.html`) and the topic queues (https://claude.ai/artifact/LvjY53S6G8mvCXi9BQ4Kty).
4. **`DECISIONS.md`**: every decision so far, and the "Spend" table.

The published pages are private to Balázs's account until he shares them with you from each page's Share menu.

## Decisions already taken (the ones that shape everything)

- Rebuild from scratch; nothing reused from the old build. The product is the article queue, not the old "growth engine".
- No orders or revenue data, so no customer data at all. No AI images; product photos only. No prices in article text.
- Search Console optional, with a labelled limited mode. English and Hungarian only.
- The eight rules in `CLAUDE.md` (facts only, every claim cited, no outside links, one article a day, safe publishing, never overwrite the merchant, every external call priced and capped, never degrade quality to keep going).
- Topics: several phrasings per topic, keep the most searched; a wide menu of article kinds; a thin store gets one topic per usable product, otherwise at most 30 waiting.
- Writing (8–9 October): general-knowledge numbers allowed if the reviewer accepts them; one repair for any failure; a held article gives the day one more topic; the article may speak as the shop but never claim experience; the writer must add nothing to a fact.
- Failures: the merchant sees one calm line and we retry the next day; the founders will learn about failures through PostHog (not yet connected).

## Your next steps towards a complete product

In order; each one unlocks the next. "Tell the agent" means starting a session and saying it in plain words.

1. **Get set up** (half a day, once). Get the code and the `.env` file from Balázs, and his personal agent instructions; run the setup below until every test passes.
2. **Grade checkpoint 3** (1 hour). Read the ten articles and mark each "would publish" or not, with a sentence why; have a Hungarian reader do the Hungarian five. Tell the agent your grades. Below seven of ten, it changes the writer's instructions and re-measures; repeat until seven or more.
3. **Answer the open decisions** (15 minutes): trivial facts, common-knowledge figures (below).
4. **Prove the app on real Shopify** (1–2 hours). Create two Shopify development stores, one sacrificial and one clean, with a few real products each, one Hungarian and one English. Install the app on the sacrificial one, run the contract tests (`docs/for-the-founders.md`, steps 2 and 3). Tell the agent what happened; it fixes whatever real Shopify does differently from its stand-in.
5. **Set up Google Search Console access** (1 hour, plus Google's review). A Google Cloud project with the Search Console API and an OAuth consent screen, and access to one real website with search traffic. Start early: Google may take days to review the consent screen.
6. **Tell the agent to build phase 4** (the agent's work, days): publishing to the store's blog, Search Console results, keeping articles true when products change, uninstall and data deletion, deployment. It will ask you questions along the way.
7. **Checkpoint 4** (30 minutes). On the clean dev store, run the whole loop and look at a published article in the store's own theme, on desktop and phone: product cards, images, headings, links.
8. **Production accounts** (1–2 hours): a Railway project and the domain, PostHog, a privacy policy and support address, and the Shopify distribution choice (custom for a single pilot store, or public; see `docs/first-real-store.md`). Then tell the agent to deploy.
9. **The pilot** (weeks). The Hungarian merchant installs with "review every article" on. For the first week you approve or discard every article and note why; the agent sends a daily review page.
10. **Checkpoint 5**, after ten delivered articles: none held for an invented fact, none duplicated, every published one findable, Search Console data attached. Then a second store, ideally English.

After that, what makes it a product other merchants can buy, none of it started or decided: Shopify billing (today a store is simply switched on by hand), the public App Store listing and Shopify's review, and email notifications.

## Decisions waiting for you

- **Grade checkpoint 3** (eight of ten pass our checks; would you publish them?).
- **Trivial facts** (open since checkpoint 1): should the extractor skip facts like "made by Bükki Füvesház"? Under the tightened writer, the reviewer now holds an article for stating such a fact as filler.
- **Common-knowledge figures**: the reviewer refused roast-specific brewing temperatures (93–96 °C) as common knowledge. Keep that strict, or accept such ranges?
- **Shopify distribution method** and **starting the pilot without Search Console**: see `docs/first-real-store.md`.

## Setting up on your own computer

The repository exists only on Balázs's laptop today; there is no shared copy (no GitHub remote). Two things must reach you:

1. **The code.** Balázs creates a private GitHub repository and pushes to it (the agent can do this when he asks), or copies the folder to you.
2. **The secrets file `.env`**, which is deliberately not in the code: the Anthropic and DataForSEO keys, the Shopify app's id and secret, and two random secrets. Send it through a password manager, not chat or email. `.env.example` lists its entries.

Then, on your computer: Docker Desktop running, Node 22 or later, pnpm; in the folder `pnpm install`, `pnpm db:up`, `pnpm db:reset`, `pnpm test`. Every test should pass, with about 28 skipped (they switch on once a real Shopify store exists). To see the screens without Shopify: `pnpm seed:preview rich-hu:written rich-en:done`, then `pnpm preview`, then open the addresses it prints.

## Money

- **Anthropic** (the model): 19.47 USD spent so far. Topped up on 9 October.
- **DataForSEO** (search numbers): 0.57 USD spent; balance 50.26 USD.
- **Standing approval**: the agent may spend on both keys for recordings and evals, and stops to ask if one run would exceed 20 USD. Each spend is logged in `DECISIONS.md`.
- **In production**, estimated 10–20 USD a month per store at one article a day, with hard daily caps of 10 USD per store and 60 USD overall.

## Things that will trip you up

- **Changing anything a model is asked costs money.** Tests replay recorded model answers keyed on the exact request. Change a prompt and the old recordings no longer match; the agent then re-records them (a few dollars) with your approval.
- **Anthropic credit can run out mid-run.** The tests then fail with "credit balance is too low"; it happened on 8 October.
- **The agent asks before acting on anything consequential**: pushing code, deploying, spending over 20 USD, or deciding anything that shapes the product. Answer its questions; if one doesn't make sense, say so and it will explain where it comes from.
- **Real Shopify is still unproven.** The next big unlock is the founders creating two Shopify development stores and installing the app (`docs/for-the-founders.md`, steps 2 and 3).
