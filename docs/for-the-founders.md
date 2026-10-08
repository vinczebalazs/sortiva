# What the founders need to do

Written for you by the building agent. Updated at the end of each phase. Everything below is in the order it unlocks work: each step lists what to do, the command to run afterwards, and what you should see. Nothing here needs you to read code.

**Where things stand (8 October 2026, end of phase 1).** The app installs a store, reads its catalogue, turns each product into a list of checked facts, drafts a store profile, and shows the first two setup screens. All of it is proven against a fake Shopify and recorded model answers; none of it has touched a real Shopify store yet, because none exists. Spend so far: 0.92 USD on the Anthropic key, nothing on DataForSEO.

---

## 0. Once, on your computer

You need Docker Desktop running, Node 22 or later, and pnpm. Then, from the `sortiva` folder:

```
pnpm install
pnpm db:up
pnpm db:reset
pnpm test
```

You should see every test pass. About 30 are listed as "skipped": those switch on by themselves once real Shopify recordings exist (step 3).

## 1. Look at checkpoint 1 (10 minutes, no setup needed)

Open the fact-sheet review page, either the private link (https://claude.ai/artifact/LsPqnSMS1Nj8qaMtZKtqKJ) or the file `docs/checkpoints/checkpoint-1-fact-sheets.html` in a browser.

For each of ten made-up shops (five English, five Hungarian), you see five products as the merchant wrote them beside the facts we kept. The question is the one in the build plan: **are these facts true, and are they facts?** Note anything wrong in `DECISIONS.md` under a dated "Founder" heading. One open question for you there: some kept facts are trivially true ("is made by Fernhill"). Keep them, or tell the extractor to skip restatements of the title, type and vendor?

To see the setup screens themselves without Shopify:

```
pnpm seed:preview rich-hu rich-en empty-en
pnpm preview
```

`seed:preview` wipes and rebuilds the local database, so don't run it after step 2 unless you mean to reinstall. Then open `http://localhost:3000/dev?shop=bukki-fuveshaz.myshopify.com&locale=hu-HU` (Hungarian) or `http://localhost:3000/dev?shop=fernhill-coffee.myshopify.com` (English).

## 2. Create two Shopify dev stores and install the app on one

1. In the Shopify Partner Dashboard (Dev Dashboard), open the existing Sortiva app (its client id and secret are already in `.env`).
2. Create **two** development stores. Put a handful of real products in each, some with full descriptions and some with thin ones; one store in Hungarian, one in English. The first is **sacrificial**: the contract tests create and delete blogs and articles on it. The second stays **clean**, for looking at articles in a theme later.
3. Put the sacrificial store's address in `.env`: `SHOPIFY_DEV_STORE_DOMAIN=your-store.myshopify.com`.
4. Start everything and install. This logs the Shopify CLI in with your browser, opens a tunnel, pushes `shopify.app.toml` (the permissions and the webhooks), and installs the app when you open it:

```
pnpm db:up
pnpm worker          # in its own terminal: runs the jobs
pnpm dev             # in another terminal: the Shopify CLI; pick the sacrificial store when asked
```

5. Open the app from the dev store's admin (Apps → Sortiva). You should see "Reading your store" with three lines ticking off, then the profile screen.

What this proves for the first time: that Shopify's session token is accepted by our sign-in, that the token exchange works, and that three permissions (read products, read content, write content) are enough to read the store's language. If any of these fail, the screen says it could not open Sortiva; tell the agent what the terminal printed.

## 3. Run the contract suite against the sacrificial store

With `pnpm dev` still running (so the store's token is in the local database):

```
pnpm test:contract
RECORD=1 pnpm test:contract
pnpm test
```

The first run checks the connector against the real store: paging products, creating a hidden blog post with our marker, finding it again, updating it, and refusing to "update" an article that doesn't exist. The second does the same and saves Shopify's real answers into `fakes/fake-shopify/recordings/`. The third is the ordinary suite. From now on it also checks the fake Shopify against those real answers, and it **fails if the fake answers differ from the real store**. That failure is the point: it means the fake was wrong, and the agent fixes the fake.

Then send one signed sample webhook from Shopify to check our signature check (the tunnel address is printed by `pnpm dev`):

```
pnpm shopify app webhook trigger --topic products/update --address https://<tunnel-address>/webhooks
```

## 4. Later phases (the agent will fill these in)

- **Grade articles.** Checkpoint 3 produces a review page of ten articles, five per language; you and your co-founder grade them. The Hungarian half needs a Hungarian reader.
- **Search Console.** A Google Cloud project with the Search Console API, an OAuth consent screen, and one real property with search traffic, so the fake Google can be checked against a real recording.
- **Look at three articles in the clean dev store's theme**, on desktop and phone (checkpoint 4).
- **Railway project and domain** before anything is deployed. The agent does not deploy.

## Decisions waiting for you

All are written up in `DECISIONS.md`, each saying what changes if you overrule it. The ones most worth your eyes:

1. **Embedded sign-in is our own code** rather than the template's library, as `mvp-ui.md` describes. Step 2 is its first real test.
2. **Daily spending caps**: 10 USD per store, 60 USD in total.
3. **The interface follows the Shopify admin user's language** (English or Hungarian), not only the articles.
4. **Trivial facts**: keep or drop (step 1).
