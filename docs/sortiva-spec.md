# Sortiva — Product & Technical Spec

Companion documents: `sortiva-ui-spec.md` (screens, states, navigation, settings map) and `sortiva-tech-spec.md` (notification system, architecture, delivery infrastructure). Scope of this document: the full product — unauthenticated preview funnel, auth and Stripe billing, domain connection, deep ingestion (Store Intelligence), Google Search Console as an intelligence input, the Opportunity Engine (signals → opportunities → actions), content planning and generation as the CREATE/REFRESH execution path, existing-page optimization (OPTIMIZE) and the light technical layer (FIX), publishing, learning, integrations, data model, and operational stability.

---

## 1. Positioning, principles & V1 decisions

### 1.1 What Sortiva is

> **Positioning:** Sortiva is the organic growth agent for ecommerce: it finds the highest-value Google (and, later, AI-search) growth opportunities for a store, acts on them, and learns from the results.

> **End state:** "Sortiva decides what your ecommerce store should do next to grow organically — and does it." V1 is the content-heavy but already growth-oriented first version of that.

The strategic risk to avoid: a content engine on its own is an excellent "AI SEO blog writer for Shopify". That category is commoditized ("30 articles/month" apps) and caps the price. The way out is not a different content engine — the one specified in §8–§9 is a moat, keep it — but a different **central object**:

> **The central object of Sortiva is the Growth Opportunity, not the article.** The system's job is not to produce content every day; it is to recognise the most valuable organic growth opportunity for the store and to recommend or execute the right action. Content is one of several execution forms.

The final product rule, stated once so nobody optimises the wrong thing: Sortiva is good when it doesn't ask *"what article should we write today?"* but *"what is the next most valuable organic growth action for this store?"*

### 1.2 What we are not

- Not a general SEO suite in the Ahrefs/Semrush mould (we don't show the same SEO data as everyone else; we connect store/catalog data to search data and pick a next step).
- Not a plain AI content generator, and not a "30 articles/month" commodity Shopify app.
- Not a universal CMS editor in V1 (Shopify is the editor).
- Not a technical-SEO crawler for every conceivable issue (a 200-issue audit report is an anti-pattern here, §20).

The category we want to own: **ecommerce organic growth.** The ideal merchant is not asking to analyse a keyword list; they are asking "what do I do now that grows my store organically?" — and Sortiva must give a credible, ranked, executable answer.

### 1.3 North star

Long-term, the headline metric is **not** articles generated, keyword count, or an SEO score. It is **organic revenue / revenue influenced by Sortiva**, and the number of **high-confidence growth opportunities executed**. V1 ships with clicks/impressions/positions (§9.6, §12.2) because they're measurable on day one; the revenue layer is roadmapped (§17) with the data captured from launch so it needs no backfill. "Influenced/attributed revenue" and any future "estimated incremental revenue" are kept as separate concepts — never conflated (§20).

### 1.4 V1 product principles

| Principle | What it means in practice |
|---|---|
| **Quality over quota** | The system would rather not publish than publish thin or weak content. Appears verbatim in pricing copy ("up to 1 article per day, quality permitting", §4.2) and is enforced by the gates (§8). An empty day is a legitimate state. |
| **Action over dashboard** | Sortiva primarily gives the merchant something to do — and does it where it safely can — rather than reporting. Every screen leads to an action (§7.12, UI spec). |
| **Ecommerce context first** | Every search opportunity is evaluated together with the store's catalog, product families, availability, and business relevance — never as a bare keyword. |
| **Read trust before write trust** | Write permission is a separate, later grant (§9.5). The merchant first sees, safely, what the system understood (§6.8). |
| **No silent degradation** | On any failure: pause or delay — never a weaker model, stale competitive data, or forced publication (§14.4). |
| **Explain every decision** | Every opportunity, rejection, refresh, and calendar entry carries a visible, *true* "why" generated from the actual evidence/scoring record, never from a free-text LLM (§7.6, §9.6.8). |
| **Platform focus, architecture flexibility** | User-facing V1 is Shopify-only (§6.1). The internal commerce data model (products → facts → families → pages → queries → content) is platform-neutral so a WooCommerce/Shopware connector can be attached later without a rewrite (§17). |
| **Configurable, not hardcoded** | Signal thresholds, scoring weights, and gate floors live in a versioned configuration layer, not scattered through code (§7.10). |

### 1.5 Product decisions

| Status | Decision | Why |
|---|---|---|
| DECIDED | Shopify-only V1 | Focus, faster PMF, stable native execution. |
| DECIDED | One store per account, one account per domain | Simple ownership, billing, support. Multi-store later. |
| DECIDED | Free URL preview (the lure) | Strong acquisition hook; cheap; doesn't commit the backend pipeline. |
| DECIDED | $89/mo single plan, annual −20%, no trial | Simple launch pricing; re-priced later on Growth-OS value (§4.2). |
| DECIDED | "Up to 1 article per day, quality permitting" | Prevents quota-driven weak content. |
| DECIDED | Product fact extraction, quarantined marketing copy | The basis of factual grounding. |
| DECIDED | Product family grouping (read-only in V1) | Avoids SKU-by-SKU thin content. |
| DECIDED | Three quality gates + separate blind judge, one repair loop | Quality and positioning moat. |
| DECIDED | Calendar + veto anytime + optional draft review, no in-app editor | Autopilot stays; the user keeps control. |
| DECIDED | Separate write permission; export mode default | Trust and safety. |
| DECIDED | Idempotency/resumability, two-phase publish, kill switches, PostHog observability, Railway topology | Engineering foundation; unchanged. |
| DECIDED | GSC as a performance add-on → **GSC as an Opportunity Engine input**, soft-required at onboarding | Without GSC we can't see real query/page performance, CTR, striking-distance pages, or reliable cannibalization. (§6.7, §7.11, §12.2) |
| DECIDED | Content plan as the product → **Growth Opportunities as the central UI and narrative**; the calendar becomes the Content module's execution schedule | Keeps Sortiva out of the "AI blogger" category. (§7, UI spec §1) |
| DECIDED | Weekly refresh scan → generalised into the **weekly signal scan** over *all* store pages, not only our articles | The refresh rule was the Striking Distance signal in disguise; it should apply to collections and product pages too. (§7.5) |
| DECIDED | **CREATE / OPTIMIZE / REFRESH / FIX / HOLD** action types | Not every search gap is solved by a new article. (§7.4) |
| DECIDED | **Existing-page opportunities** (striking distance, low CTR, decay, cannibalization, intent gap) and the mandatory **existing-target check before CREATE** | The system must recognise when improving an existing page beats creating a new one. (§7.7, §10) |
| DECIDED | **Light technical layer** (limited FIX) | Flag ecommerce-relevant blockers even where we don't auto-fix. (§11) |
| DECIDED | **Products screen** (families, richness, knowledge gaps as merchant tasks) | HOLD opportunities need a home. (UI spec §7) |
| LATER | AI visibility (commercial prompt tracking, citation/share of voice) | Required for the "AI + Google growth" positioning; must not block V1. (§17) |
| LATER | Merchant Center / Google commerce visibility | Ecommerce-specific differentiator, V1.5/V2. (§17) |
| LATER | Revenue intelligence | The eventual moat: prioritise and measure by business value, not traffic. (§17) |

### 1.6 Build order

1. Shopify connector + Store Intelligence (§5–§6) → 2. GSC / Search Intelligence (§6.7, §12.2) → 3. Opportunity Engine (§7) → 4. CREATE execution: the existing content pipeline (§8–§9) → 5. OPTIMIZE recommendations (§10) → 6. Performance & learning (§9.6) → 7. Limited FIX (§11) → 8. V1.5: AI visibility, revenue, commerce layers (§17).

Steps 1–4 deliver the content product with the opportunity model underneath it; nothing in 5–8 blocks launch, but the data model for all of it ships in step 3 (§7.6, §13) so no later step needs a backfill.

---

## 2. Core invariants

These constraints shape the whole data model and must be enforced at the database level, not just in application code.

1. **One domain per account.** An account row has at most one connected domain.
2. **One account per domain.** A domain can be claimed by exactly one account, globally. Enforced with a unique index on the normalized domain.
3. **Preview data is disposable.** Anything produced by the cheap pre-auth scrape (Haiku extract) is marketing bait only. It is never promoted into the production ingestion record — the deep ingestion pass starts from zero and the preview record is discarded (or retained briefly for funnel analytics only, clearly separated from production data).
4. **Reading a store and writing to a store are separate consents.** Users who never want auto-publishing must be able to grant read-only access and export articles manually.

**Domain normalization** (used everywhere a domain is stored or compared): lowercase, strip scheme, strip `www.`, strip path/query/fragment, resolve to the registrable domain (eTLD+1) using the Public Suffix List. `https://www.Shop.example.co.uk/about` → `shop.example.co.uk`... careful: eTLD+1 of that is `example.co.uk`. Decide once: we claim at **eTLD+1** level so a user can't claim `blog.example.com` while another claims `shop.example.com` — same business, one account. Subdomain edge cases (genuinely separate businesses on subdomains, e.g. `*.myshopify.com` — see §6.1) are handled by allowlisting known multi-tenant suffixes into the PSL logic.

---

## 3. Unauthenticated preview ("the lure")

### 3.1 Flow

Landing page has a single URL input. User pastes their site URL and gets back, within a few seconds, a short "here's what we understood about your business" card plus a teaser: *"See your organic growth opportunities →"* (canonical copy, Appendix A — never "content plan"). Clicking the teaser prompts login/signup. That's the entire job of this feature — convert a curious visitor into a registered user. It has **no production value** and its output must never leak into the real ingestion pipeline.

### 3.2 Endpoint design

`POST /api/preview` — public, **not** login-gated, but hardened:

- **Cloudflare Turnstile** token required on every request; verified server-side before any fetch happens.
- **Rate limiting**: per-IP (e.g. 5/min, 20/day) and a global concurrency cap on outbound scrapes.
- **Heavy caching**: cache key = normalized domain. TTL ~7 days. A cache hit skips the scrape *and* the LLM call entirely and returns the stored card. This is the primary cost control — repeated demos, shares, and bot traffic on the same domain cost us nothing after the first hit.
- **Strict budget per miss**: one page fetch (homepage), hard timeout (~8s), max download size (~1.5 MB), follow at most 2 redirects, only ports 80/443, block private/reserved IP ranges after DNS resolution (SSRF protection).

### 3.3 Extraction pipeline (cheap by design)

1. Fetch homepage HTML.
2. Pull the cheapest signals in priority order: `<title>`, `meta description`, OpenGraph tags, JSON-LD `Organization`/`Product` blocks.
3. Run a Readability.js-style extraction on the homepage body as fallback content.
4. Optionally (only if the above yields < ~200 chars of signal): try one more fetch of a likely about page (`/about`, `/about-us`, `/pages/about-us`), same budget.
5. Concatenate, truncate to a small token budget (~2k tokens input), and call **Claude Haiku** with a single prompt: produce a 2–3 sentence plain-language summary of what this business does and sells, in the site's own language. Temperature low, max ~150 output tokens.
6. Store `{domain, summary, fetched_at}` in the preview cache table.

Failure modes return a graceful generic card ("We couldn't read this site automatically — sign up and we'll take a deeper look") rather than an error; the funnel must never dead-end.

---

## 4. Auth & subscription (Stripe)

### 4.1 Auth

Standard email + OAuth (Google) signup. Nothing exotic. An account is created with `domain = null`.

### 4.2 Subscription — real billing via Stripe from day one

Billing is **real Stripe from the start** — no mock. But we build almost no billing UI ourselves: **Stripe Checkout** for purchase and **Stripe Customer Portal** for everything after (card updates, invoices, cancel). Our app never renders a card form (keeps us in PCI SAQ-A and deletes an entire surface).

**Plan (single tier):**

| Plan | Price | Cap | Includes |
|---|---|---|---|
| Pro | $89/mo (annual −20%) | **Up to 1 article per day, quality permitting** | Growth opportunities (CREATE / OPTIMIZE / REFRESH / FIX), export + auto-publish, Search Console intelligence, full calendar |

The cap wording appears verbatim on the plan screen and in the Stripe product description: "**up to** 1 article per day, **quality permitting**" — some days legitimately produce nothing (§8), and the product never pads to the cap. Two Stripe Prices (monthly, annual) on one Product; price IDs are config, amounts live in Stripe only — the app never hardcodes a dollar amount.

**Flow: signup → plan screen → Stripe Checkout (subscription mode) → return → onboarding continues.** **No trial period (decided):** the subscription is paid from day one; the first charge happens at Checkout. The preview lure (§3) and the transparent quality posture carry the pre-purchase conviction — the product does not give away free ingestion or free articles.

**$89 is a launch price, not a ceiling (decided).** It is right for PMF search; as AI visibility, revenue intelligence, technical execution, and Merchant Center land (§17) the product belongs in a $149–$399+ band. Because price IDs are config and amounts live only in Stripe, repricing is a Stripe change plus a copy change — never a code change.

**Entitlement is local state, synced by webhooks — never a Stripe API call in a request path or at scheduler dequeue.** A `subscriptions` row mirrors Stripe: `status ∈ active | past_due | canceled | incomplete_expired`. Entitled = `active`. Enforcement points: the daily scheduler (§9.1) checks entitlement exactly like kill switches — not entitled → no dequeue; auto-publish and export actions check it API-side. Read access (dashboard, articles, calendar history, performance) is **never** revoked by billing state — only generation and publishing gate.

**Webhooks** (`/api/webhooks/stripe`, signature-verified, event-ID deduped and processed async per the §14.3.8 pattern): `checkout.session.completed` (attach customer + subscription to account), `customer.subscription.updated` / `.deleted` (status sync — the single writer of `subscriptions.status`), `invoice.payment_failed` / `invoice.paid`. Stripe is the source of truth; our row is a cache of it, reconciled nightly (fetch subscription state for any account whose row is stale >24h — the billing analog of the catalog sweep, because webhooks drop here too).

**Dunning:** on `past_due`, Stripe Smart Retries runs its schedule; we immediately pause generation/publishing (LLM spend on an unpaid account is our loss), show a non-dismissible "payment failed — update your card" banner linking to the Customer Portal, and send the payment-failed email (tech §1). `invoice.paid` restores entitlement automatically; the calendar resumes where it left off (§8.7 gap semantics — missed days are gaps, never back-filled bursts). Final failure → Stripe cancels → `canceled` semantics below.

**Cancellation** (via Customer Portal, `cancel_at_period_end`): entitlement runs to period end, then generation/publishing stop; published articles are never touched (they live on the user's store); read access persists indefinitely. The three facts stated on the Portal return screen and in §14.6.

Selecting/holding the plan writes `account.plan = 'pro'`; PostHog events: `checkout_started`, `subscription_activated`, `payment_failed`, `subscription_canceled` — funnel-critical, domain-grouped once connected.

### 4.3 Dashboard empty state

Auth ≠ domain connected. A logged-in user with `domain = null` lands on the dashboard showing a single empty state: **"Connect your domain"** with the URL input. Everything else (content plan, articles, performance) renders as locked/empty until a domain exists and ingestion completes.

---

## 5. Connecting a domain

1. User enters a URL → normalize (§2) → check the global unique constraint.
   - Already claimed by another account → error: "This domain is already connected to another account. If you believe this is a mistake, contact support." (Support-mediated transfer flow; no self-serve domain stealing.)
   - Claimed by this account → no-op / redirect to dashboard.
2. Claim is written **transactionally** with the uniqueness check (insert with unique index, catch conflict) — no TOCTOU race between two signups claiming the same domain simultaneously.
3. Claiming enqueues the **deep ingestion job** and the dashboard flips to an ingestion-progress state (multi-step progress UI: "Detecting platform → Connect your store → Reading your store → Building your business profile → Finding keywords & competitors → Connect Search Console → Review").
4. The preview-cache record for this domain is now irrelevant; production data comes exclusively from deep ingestion.

Open question (recommend deferring past v1): domain *ownership verification* (DNS TXT / meta tag). For v1, connecting Shopify OAuth or GSC effectively proves ownership; a pure-scrape custom-site user is unverified but also gets no write access to anything, so risk is low.

---

## 6. Deep ingestion — Store Intelligence (Sonnet)

Runs as a background job with resumable steps and per-step status persisted, so a crashed job resumes rather than restarts. The full execution model — step state machine, idempotency keys, per-account locking, checkpointing, retry/DLQ policy — is specified in §14.3.

### 6.1 Step 1 — Technology detection

Fetch the homepage and probe for Shopify signals: `Shopify` in response headers / `X-ShopId`, `cdn.shopify.com` assets, `window.Shopify` in HTML, or a `200` on `/products.json`. Also resolve the canonical `*.myshopify.com` handle if discoverable (needed for OAuth).

- **Shopify detected** → continue to §6.2.
- **Not Shopify** → mark the account `platform = custom_unsupported`, stop ingestion, and show a persistent dashboard banner: *"This doesn't look like a Shopify store. We currently support Shopify only — contact us for a custom solution or join the waitlist."* (contact form + waitlist CTA). The domain stays claimed; the account is parked in this state.

Only these two outcomes exist in v1. Don't build WooCommerce/Wix detection scaffolding yet.

### 6.2 Step 2 — Shopify OAuth (read scopes) *before* scraping

Rationale: "top products" must mean **best sellers**, and best-seller data is order data, which is not publicly scrapeable. So when the platform is Shopify, we prompt Shopify OAuth **before** the rest of ingestion and prefer the Admin API over scraping entirely.

- **Read-scope OAuth is a hard requirement for Shopify stores.** Ingestion pauses at this step until it is granted — there is no scrape fallback. The dashboard shows a blocking state: "Connect your Shopify store to continue. Read-only — we can't change anything in your store with this permission, and auto-publishing is a separate optional setting you control later." If the user abandons OAuth, the account parks in `state = awaiting_shopify_auth` with this prompt persisting; a resume path exists from the dashboard and a reminder email after 24h.
- **Scopes requested at this stage (read-only):** `read_products`, `read_orders`, `read_content`. (`read_locales` was requested until 2026-09-12 and never used: the store's language comes from its primary domain, which needs no permission of its own.) Explicitly **not** requesting any `write_*` scope here — publishing consent is a separate, later grant (§9). This separation must be stated on the connect screen, since fear of unwanted auto-posting is the main reason users would hesitate.
- **Once granted:** all product and store data comes from the Admin API — no public scraping of the storefront is needed beyond the homepage/about content used for the persona. Pull the full catalog with pagination (title, body_html, product_type, tags, vendor, variants, prices, images, **metafields** — spec-minded merchants often keep real attributes there — and review data if a supported review app exposes it). Catalog size is a non-issue at this stage: fetching and storing 500+ products is cheap; what's expensive is deciding what to *write about*, which is handled by the topic model and quality gate (§8). Top products are computed properly: aggregate order line items over the trailing 60 days (quantity and revenue), take top N (e.g. 10). **Sixty, not ninety:** Shopify gives an app like ours the last 60 days of orders and no more — older orders need `read_all_orders`, which Shopify grants case by case — so a 90-day window silently measured 60 and labelled it 90 (decided 2026-09-12). Store both metrics; default sort by revenue. **Order ingestion strips all customer fields at read time** — only line-item aggregates are ever persisted, which is what lets us answer Shopify's GDPR customer webhooks with "no data held" (§14.6); enforce with a test.
- Handle token revocation: if the token is later invalidated (app uninstalled from the store), the account drops back to `awaiting_shopify_auth` with a reconnect banner, and generation/publishing pauses.

Store the Shopify token encrypted at rest, scoped per account, with the granted-scope list persisted so the app can distinguish read-only vs read+write connections.

### 6.3 Step 3 — Product distillation (fact sheets, not marketing copy)

Most product descriptions are long and full of marketing fluff. Ingesting them as prose poisons the pipeline twice: at persona/topic time (keywords derived from adjectives instead of attributes) and at writing time (articles inherit the fluff register and then correctly fail our own quality gate). So raw descriptions are **never** fed downstream. Instead, every product passes through a distillation step:

- **Model:** Haiku (extraction, not reasoning; at 100s of products the cost difference matters). Batched; cached per product; re-run only when the product's `updated_at` changes (Shopify webhook, else daily diff).
- **Output — structured fact sheet per product:**

```json
{
  "material": null, "dimensions": null, "weight": null, "capacity": null,
  "compatibility": [], "use_cases_stated": [], "care": null,
  "variant_axes": [], "price_range": null,
  "certifications": [], "origin": null,
  "verifiable_claims": [],
  "fluff_discarded": true,
  "fact_count": 0
}
```

- **Extraction rules:** extract-only, no inference. "Premium quality leather" → `material: leather` (the "premium" dies). "Perfect for any occasion" → nothing. A field the text doesn't support stays `null` — empty fields are signal, not failure. Only falsifiable statements land in `verifiable_claims`. Supplementary structured data (variants, price, product_type, tags, collections, metafields, review text — reviews are where authentic use-case language lives) is merged in without distillation since it's already factual.
- Raw `body_html` is stored but **quarantined**: available for display/debugging, never included in persona derivation, topic selection, or article evidence packs.
- **Data richness score:** per-product `fact_count` rolls up to a per-store richness score. Some stores' descriptions *are* the substance (technical shops, ingredient-driven cosmetics) — the `fluff_discarded` flag + fact counts detect this per store rather than assuming. Low richness is surfaced honestly at confirmation (§6.8) and later drives Gate 1 substance checks (§8.2): "We couldn't find materials or dimensions for these 12 products — add them and we'll retry."

### 6.4 Step 4 — Product family grouping (dedup)

A store with 40 similar shoes cannot support 40 shoe articles. Products are clustered into **product families** — a first-class entity — and everything downstream (topic mapping, substance inventory, evidence packs, cannibalization) operates on families, never individual products. The 40 shoes become ~4–6 families.

**Clustering signals, cheapest first:**

1. **Merchant taxonomy.** `product_type`, collections, tags, vendor. Collections are the primary grouping candidate, filtered for noise: promo-pattern collection names ("Summer Sale", "New Arrivals", "Featured") are blocklisted, and collections spanning wildly different `product_type`s are ignored as non-categorical.
2. **Split-variant detection.** Many merchants publish "Trailblazer Shoe — Red" and "Trailblazer Shoe — Blue" as separate products instead of variants. Strip color/size/material tokens from titles; if residual titles collide *and* fact sheets match, merge into one **logical product** (tighter than a family — it's the same product). Nearly free, deterministic.
3. **Fact-sheet clustering.** Cluster on structured fact sheets (§6.3), never on prose embeddings of marketing copy (fluff makes everything look similar). Products whose attribute sets match except along one or more axes belong to the same family, and **the differing axes are recorded** — they are the prize (see below). Attribute comparison is deterministic and auditable.
4. **Embeddings fallback only** for genuinely messy stores (no product_type, junk collections, sparse facts): embed title + fact sheet, agglomerative clustering with a conservative threshold, results flagged `confidence = low`.

**Family record — merged fact sheet + differentiation axes.** Each family stores the attributes shared across members and the axes along which members differ. The axes drive content structure directly: a family differing only by *color* supports at most one article; a family differing by *terrain, drop, width* supports a buying guide whose comparison skeleton is literally those axes ("by terrain: … / for wide feet: …") — one strong article covering 40 products, which is the topic-first model (§8.1) made concrete.

**Guardrails:**

- **No merging on sparse data.** Products below a fact-count floor don't participate in similarity merging — near-empty fact sheets make everything look identical and would collapse the store into one blob. They stay singleton and count against the richness score. Sparse must read as *unknown*, never as *same*.
- **Provenance logged.** Every family records which signal produced it (collection / split-variant / fact-cluster / embedding) so misgroupings are debuggable.
- **Recompute trigger:** same as distillation — product `updated_at` changes re-run distillation, then family assignment for affected products only.

**User visibility (v1, deliberately minimal):** families appear read-only in a collapsible section of the confirmation screen (§6.8) and, permanently, on the **Products** screen (UI spec §7) together with the richness score and any open HOLD merchant tasks (§7.4) — at minimum those containing top sellers — and every topic/rejection card names the family it drew from. A "report wrong grouping" escape hatch exists; a full split/merge/rename editor is deferred (it's an entire UI surface).

### 6.5 Step 5 — Business profile ("persona") construction

Inputs: **product fact sheets and family structures** (§6.3–6.4) + top-seller list, homepage + about page content, shop locale/currency (from `read_locales` / shop settings, else `<html lang>`, hreflang tags, currency symbols, TLD heuristics). Raw product descriptions are excluded per §6.3. Family-level categories give the persona call a truthful picture of the catalog's real breadth (4–6 shoe lines, not "40 products").

One **Claude Sonnet** call (this is the quality-critical step, hence Sonnet not Haiku) producing structured JSON:

```json
{
  "business_description": "2–4 sentences, in the store's language",
  "product_categories": ["..."],
  "main_language": "de",
  "country": "DE",
  "audience": "short description of the likely customer",
  "brand_tone": "e.g. playful / clinical / premium"
}
```

Persisted alongside the computed `top_products` list.

### 6.6 Step 6 — Keyword & competitor discovery (DataForSEO)

This runs **during ingestion**, immediately after the persona draft exists — it is part of onboarding, not a later analysis phase. Keywords and competitors are as much a part of the confirmed persona as the business description.

**Seed keywords:** derived by Sonnet from the persona draft + top-selling **product families** (merged fact sheets, differentiation axes, stated use cases — not marketing copy; one small structured call: ~15–25 candidate terms in the store's language). Family axes are strong seed material ("wide fit trail running shoes" exists as a keyword precisely because *width* and *terrain* are differentiation axes). Candidates are enriched via DataForSEO (search volume, difficulty, CPC — using the persona's language/country as location parameters) and the strongest ~10–15 are kept as the draft keyword set.

**Competitor auto-detection:** query DataForSEO SERPs for the top seed keywords, collect recurring organic domains, filter out marketplaces/aggregators (Amazon, Etsy, eBay, Wikipedia, Pinterest, YouTube — maintain a blocklist), and rank the remainder by how many seed-keyword SERPs they appear in. Take the top candidates as the draft competitor list.

**Hard cap: 5 competitors per account.** Auto-detection proposes at most 5; the cap is enforced in the API and DB (application-level check + count constraint), not just the UI, because competitor count directly drives DataForSEO cost in topic discovery and the learning loop (§8.7, §9.6). These are **business competitors**; query-level **SERP competitors** are a separate, uncapped, non-editable concept stored inside SERP snapshots (§7.2.1, §12.6) — never mixed into this list.

### 6.7 Step 7 — Google Search Console (soft-required)

Runs right after keyword/competitor discovery and before confirmation, so the confirmation screen can already show what GSC changed (winnability calibration, existing-page signals). The mechanics of the OAuth and property picker are in §12.2; this section is the onboarding posture.

- **Soft-required (decided; Appendix B):** technically optional, strategically required. The step is a card in the stepper — *"Connect Google Search Console to unlock full Growth Intelligence"* — with a primary connect button and an explicit **Skip for now**. Skipping is never hidden or punished, but the consequence is stated on the card: without GSC we cannot see real query/page performance, CTR, striking-distance pages, or reliable cannibalization, so the account runs in **Limited Intelligence** mode (§7.11) with a persistent badge until connected.
- Why not a hard blocker: GSC ownership/permission is real onboarding friction, and the merchant should see the product's base value (store intelligence, catalog- and market-driven opportunities) without it. Why not silent-optional: the full Growth-OS experience needs it, and the product must say so.
- On connect: the property picker (§12.2) validates the host against the claimed eTLD+1; `gsc_connected_at` is set; the historical backfill (16 months, page × query) is enqueued as a job step so the onboarding run (§7.5) can use it. If the backfill is still running at confirmation, opportunities are computed on what has arrived and re-scored when it completes (§7.9 dedupe — no duplicates).
- Connecting later (from Settings → Connections, the dashboard nudge, or the Limited Intelligence badge) triggers the same backfill plus an immediate onboarding-style scan.

### 6.8 Step 8 — User confirmation (mandatory)

Ingestion output is a **draft** until confirmed. The dashboard presents an editable review screen covering *all* of it:

- **Business profile:** description (textarea), language and country (dropdowns), audience/tone (text).
- **Top products:** sortable list — remove, reorder, pin.
- **Keywords:** editable chip list — remove any, add by hand (free-text; hand-added terms are enriched with DataForSEO metrics asynchronously and display volume/difficulty once fetched, but can be confirmed before enrichment returns).
- **Competitors:** list capped at 5 — remove any auto-detected entry, and **add by hand** via a domain input (normalized per §2, validated as a real resolving domain, cannot be the user's own domain, cannot be on the marketplace blocklist without an "add anyway" override). Manual and auto-detected entries are visually distinguished (`source` badge). The "Add competitor" control disables at 5 with a tooltip explaining the cap.
- **Product families (read-only, collapsible):** how we grouped the catalog (§6.4), at minimum the families containing top sellers, with a "report wrong grouping" link. No split/merge editing in v1.
- **Data richness (informational):** the per-store richness score from §6.3, with a plain-language note when it's low ("Your product pages have little concrete information — this limits how many articles we can responsibly write. Products missing key details: …"). Sets expectations upfront about how much content the catalog can support; the same per-product gaps later become HOLD merchant tasks on the Products screen (§7.4).

Only on "Confirm profile" does the account move to `state = ready_for_planning` and the onboarding opportunity run starts (§6.9). Every section remains editable later from settings; edits after confirmation don't re-trigger full ingestion — keyword/competitor edits only trigger their own enrichment lookups. Swapping a competitor later invalidates that competitor's cached analysis, nothing else.

### 6.9 Step 9 — First growth opportunities (the activation moment)

Confirmation is not the end of onboarding; the first opportunity set is. On `ready_for_planning`, the onboarding run of the Opportunity Engine (§7.5) executes: detection over GSC history (if connected), the confirmed keywords and competitors, and the catalog; scoring; action selection; and construction of the initial ~3-month calendar (§8.7) from the accepted CREATE/REFRESH opportunities. The dashboard shows a short progress state ("Finding your growth opportunities…", minutes, SSE like the ingestion stepper) and then lands on the **Opportunities** screen with the headline *"We found {N} ways to grow your store organically"* (Appendix A). The `opportunities_ready` notification and email fire here (tech spec §1.2) — this, not "content plan ready", is the activation moment the funnel measures (§16).

---

## 7. Search Intelligence & the Opportunity Engine

This is the product's decision system and the most important part of the product. Sortiva does not manufacture topics; it ranks **opportunities**, and an opportunity's outcome can be CREATE, OPTIMIZE, REFRESH, FIX, or HOLD. The content engine (§8–§9) is the execution module for CREATE and REFRESH; existing-page optimization (§10) executes OPTIMIZE; the light technical layer (§11) executes FIX; HOLD produces a merchant task. The purpose of specifying it this precisely is that engineering should never have to interpret SEO concepts — only explicit product rules.

### 7.1 Glossary & decision model

**Base flow:** `SIGNAL → EVIDENCE → OPPORTUNITY → ACTION → TASK → OUTCOME → LEARNING`

| Layer | What it contains | Example |
|---|---|---|
| **Signal** | What we measured or noticed in the data. | Striking Distance |
| **Evidence** | The signal's proof and source data. | 9,402 impressions, avg. position 7.3, 28-day window, GSC |
| **Opportunity** | Why this may be a growth opportunity for the store. | The page is already relevant; a small improvement can win more clicks. |
| **Action** | The category of solution Sortiva proposes. | OPTIMIZE |
| **Task** | The concrete change(s) to make. | Title rewrite, collection copy, FAQ, 4 internal links. |
| **Outcome** | The measurable result. | Position 7.3 → 4.8; clicks +34%. |
| **Learning** | The result fed back into future scoring. | Similar collection opportunities gain weight. |

**Developer principles (enforced in review):**

- Signal and action are **never hardcoded 1:1**. The same signal yields different actions under different conditions (§7.8). `IF position 4–15 THEN striking_distance THEN optimize` may be *one rule inside signal detection*; it is never the decision engine.
- Every opportunity stores **evidence, confidence, impact, reason, recommended action, and preconditions** (§7.6). No opportunity exists without at least one traceable evidence source.
- The user-facing "why" is always generated **from the actual scoring/evidence record**, from template strings — never generic LLM prose. Same rule as the calendar why-line (§9.6.8); same renderer.
- Action selection is a **separate logical step** from signal detection (§7.5), and always considers: the existing URL for that intent, the intent itself, technical blockers, catalog substance, and the other evidence on hand.

### 7.2 Data sources — what each one is truth for

| Source | Treated as truth for | Main data / use | V1 |
|---|---|---|---|
| **Shopify Admin API** | Commerce truth | Products, variants, collections, descriptions, metafields, images, price, availability, inventory, order-derived bestsellers, catalog changes; **plus the store's own pages, blogs, and collection bodies + SEO titles/descriptions** (the site content inventory, §12.3). | ✔ |
| **Google Search Console** | Google performance truth | Query, page, clicks, impressions, average position, CTR, device, country, time series. | ✔ (soft-required, §6.7) |
| **Search / SERP data provider** (DataForSEO, §12.1) | External search-market truth | Keyword demand, SERP composition, ranking URLs, SERP competitors, query discovery, competitor ranked keywords, and — in Limited Intelligence mode — approximate ranked keywords for the store's own domain. | ✔ |
| **Sortiva page fetcher / parser** | Website truth | For Shopify stores in V1 the content inventory comes from the Admin API (no crawl). A light fetcher exists only for (a) the persona homepage/about pages (§6.5) and (b) top-SERP competitor page content for Gate 3 and intent-gap analysis. A real internal-link crawler is **P1** (needed for orphan/internal-linking signals, §11). | partial |
| **Google URL Inspection API** | Indexation truth / diagnostics | Index status, user-declared vs Google-selected canonical, crawl/index signals. | P1 |
| **GA4** | Behaviour / revenue attribution | Landing pages, organic sessions, ecommerce conversion, revenue. | V1.5/V2 (§17) |

#### 7.2.1 One competitor list; SERP domains stay internal (decided)

The merchant sees **one** "Competitors" list. Underneath, two kinds of data exist and must not share a table or a cap:

- **Business competitor** — a direct market competitor the merchant recognises. Account-level, user-managed, auto-proposed at ingestion, **hard cap 5** (§6.6). Drives *competitor coverage gap* detection and competitor ranked-keyword lookups (the expensive queries the cap exists to bound).
- **SERP ranking domains** — whoever occupies the top results for a specific query: could be a publisher, Reddit, a marketplace, or a domain the merchant would never call a competitor. Per-query, dynamic, **not capped and not user-managed**; stored only inside SERP snapshots (7-day TTL, §12.1) and referenced from opportunity evidence. Used for information-gain grading (Gate 3), intent-gap analysis (§10), and winnability. Never called "competitors" in the UI.

- **Suggestions into the list:** a domain that ranks in the top 10 for ≥ 3 of the store's confirmed keywords (config, §7.10) and is not on the marketplace blocklist is *suggested* on the Competitors section ("appears in 8 of your top queries — add?"). Adding is always the merchant's click and counts against the cap of 5; nothing is ever auto-added.

The confirmation screen and Settings show the one list. SERP ranking domains appear only inside an opportunity's evidence ("top results for this query: …").

### 7.3 V1 signal catalog

The full taxonomy is specified now so the data model (§7.6, §13) is built around all of it, not around the first few implemented signals. V1 priority marks what must actually work at launch (P0) vs. what the model must *accommodate* (P1). All thresholds below are **starting heuristics** and live in the configuration layer (§7.10), never as literals in code.

| Signal | Meaning | Source | V1 detection rule (defaults; configurable) | Typical action | Needs GSC | Prio |
|---|---|---|---|---|---|---|
| **Striking Distance** | A page is already close to a valuable Google position. | GSC | Page × query-cluster mean position **4–15** over trailing 28d; impressions ≥ store median for rated pages; applies to *any* store URL (collection, product, page, blog post, our article). | OPTIMIZE (store pages) / REFRESH (our articles) | yes | **P0** |
| **Low CTR at Strong Rank** | Ranking well but winning few clicks vs. the store's own baseline. | GSC | Mean position ≤ 5 over 28d, impressions ≥ 2× store median, observed CTR < **0.6×** the CTR predicted by the *store's own* fitted position-CTR curve (fallback: standard curve) — never a fixed industry benchmark (device, brand/non-brand and SERP features distort it). Branded queries excluded where the brand token is detectable from the persona. | OPTIMIZE (title/meta/snippet) | yes | **P0** |
| **Content Decay** | A previously performing page is losing organic performance for a sustained period. | GSC | Trailing 28d vs. the same-length window 12 weeks earlier: clicks ≤ **0.6×** *and* position worsened ≥ **3**; baseline clicks ≥ store median (so we don't "recover" pages that never worked); trend must hold across ≥ 2 consecutive weekly evaluations. | REFRESH (or FIX if a technical cause is found) | yes | **P0** |
| **Cannibalization** | Several of our own URLs compete for the same or very similar intent. | GSC + content mapping | For a query cluster, ≥ 2 store URLs each hold ≥ **20%** of the cluster's impressions over 28d, both within position ≤ 30. **Not treated as an error until validated:** same intent class for both URLs *and* (ranking alternation — the leading URL flips week-over-week — *or* aggregate performance loss vs. the 12-week baseline). | FIX / OPTIMIZE (primary-page designation, internal links, consolidation, canonical recommendation) | yes | **P0** |
| **Uncovered Commercial Query** | Relevant commercial demand exists, but no suitable store URL. | Search data + SERP + catalog | Keyword candidate (from §6.6 seeds, related-keyword expansion, competitor keywords) with volume ≥ locale demand floor (§8.2), commercial intent class (buying guide / comparison / category-supporting), maps to ≥ 1 product family passing the substance floor, and the **existing-target check (§7.7) finds no suitable URL**. | CREATE | no (better with) | **P0** |
| **Existing Page Intent Gap** | We have the right page, but it doesn't cover what the SERP expects. | SERP + page analysis | Page ranks 4–20 for the cluster (GSC) *or* is the existing target for a competitor-gap keyword; subtopic coverage analysis (§10.3) finds ≥ **2** subtopics present on ≥ 3 of the top-5 SERP pages and absent on ours. LLM-assisted; runs only on candidates that already passed cheap filters. | OPTIMIZE | no (better with) | **P0** |
| **Competitor Coverage Gap** | Business competitors rank for a valuable topic; the store doesn't. | SERP provider | ≥ **2** of the ≤5 business competitors rank ≤ 10 for a keyword that maps to a family we sell; we hold no position ≤ 20 (GSC; DataForSEO ranked-keywords in limited mode). | CREATE (no relevant URL) / OPTIMIZE (relevant URL at 11–30) | no | **P0** |
| **Product Family Coverage Gap** | A commercially important family has no adequate search content. | Shopify + content graph + search data | Family in the top-seller set (or ≥ **10%** of 90d revenue) with zero published/ranking content mapped to it, and ≥ 1 keyword candidate clearing the demand floor. | CREATE | no | **P0** |
| **Catalog Richness Gap** | There would be an opportunity, but the catalog lacks the facts to write responsibly. | Shopify product data | A CREATE/OPTIMIZE candidate clears demand + winnability but the mapped families fail the substance inventory (§8.2). Lists the specific products and missing fields. | **HOLD** + merchant task | no | **P0** |
| Internal Linking Gap | A valuable page receives few relevant internal links. | Crawler + content graph | Requires the internal-link crawler; conservative (nav links unseen ⇒ don't flag). | FIX | no | P1 |
| Orphan Page | An important page is effectively unreachable via internal links. | Crawler + Shopify structure | Same dependency as above. | FIX | no | P1 |
| Indexing Issue | An important URL isn't properly indexed. | GSC / URL Inspection | Not indexed / blocked / crawl-related. | FIX | yes | P1 |
| Wrong Canonical / Duplicate | Google picks a different canonical, or there's meaningful duplication. | URL Inspection + crawler | Declared vs Google-selected canonical mismatch; duplication pattern. | FIX | yes | P1 |
| Missing / Weak Metadata | Missing, duplicate, or weak title/meta. | Shopify API | Empty/duplicate `seo.title`/`seo.description` across collections/products; clear SERP-alignment mismatch. Cheap via the content inventory (§12.3); runs as soon as the inventory exists. | OPTIMIZE | no | **P0** |
| Content Overlap | Two of our contents are thematically too close. | Content embeddings + GSC | High semantic overlap + same/adjacent intent (extends the Gate 3 near-duplicate lint to cross-page). | FIX / consolidate | partial | P1 |
| Product Change Impact | Published content references a product that changed materially. | Shopify | The drift table in §14.1 (deleted, OOS ≥14d, price ≥20%, family-axis change). | REFRESH / FIX | no | P0 (already built as the repair loop) |
| Broken Product Reference | A product link/recommendation in our content no longer resolves. | Shopify + fetch | Deleted product / 404 / invalid reference (§14.1). | FIX (auto where safe) | no | P0 (repair loop) |
| Freshness Opportunity | An older page can become competitive again with an update. | Content age + GSC + SERP | Age > **12 months**, position stagnant/declining over 12 weeks, and the top-5 SERP set differs ≥ **40%** from the snapshot stored at publish. | REFRESH | yes | P1 |

Note the priorities: the drift/repair signals are fully specified in §14.1 and are P0; they are simply re-expressed as opportunities so they appear in the same list with the same evidence/why fields.

### 7.4 Action catalog — exact meaning

> **Definition.** The action is not the opportunity. The action is the *type of solution* Sortiva chose. V1 uses four actions plus HOLD: CREATE, OPTIMIZE, REFRESH, FIX, HOLD.

| Action | Meaning | When chosen | Typical output | V1 execution mode |
|---|---|---|---|---|
| **CREATE** | Create a new URL / new content. | A real coverage gap and **no suitable existing URL** (§7.7). | Buying guide, comparison, category-supporting article; later landing/collection recommendations. | **Automatic** via the content calendar (§8.7) with veto anytime and optional draft review. |
| **OPTIMIZE** | Improve an existing URL for more search/commerce performance. | A relevant page exists but underperforms or is incomplete. | Title/meta, headings, content blocks, FAQ, factual details, internal links, collection copy. | **Recommendation + suggested copy** (§10) — exportable; the merchant applies it in Shopify. No direct edits to collection/product pages in V1 (decided; Appendix B). Our *own* published articles are the exception: they go through the article pipeline and may auto-publish. |
| **REFRESH** | Rethink/update an asset that already has a history, to recover lost performance or accuracy. | Decay, staleness, SERP or catalog change, inaccuracy. | Updated prose, product replacements, new sections, freshness update. | Our articles: **automatic** via a calendar slot (same as CREATE, §8.1). Store pages: recommendation, as OPTIMIZE. |
| **FIX** | Remove a technical or structural obstacle. | Indexing, canonical, broken link, orphan, schema, or structural issue; validated cannibalization. | Auto-fix where safe; otherwise a concrete developer/merchant recommendation. | **Limited** (§11): broken product references in our own content auto-repair (existing §14.1 rules); everything else is recommendation-only. Never auto-modify theme or custom code. |
| **HOLD** | The opportunity is real but blocked by a precondition. | Catalog richness gap; technical blocker that must be fixed first. | A merchant task stating exactly what to do, then automatic re-evaluation. | Task on the Products screen (UI spec §7); re-evaluated at the next scan after the underlying data changes. |

**OPTIMIZE vs. REFRESH, stated once:** technically both modify an existing URL; the product meaning differs. `OPTIMIZE = unlock potential` (the page has never reached what it could). `REFRESH = recover lost performance / accuracy` (the page has a track record and lost some of it). The distinction matters for the why-line, for outcome measurement (§9.6.10), and for the refresh cooldown (§9.6.5), which applies to REFRESH only.

**CREATE is not automatically "blog article".** The intent class picks the content/page type (§8.7). If a later scan shows an existing collection is the better target for that intent, the pending CREATE converts to OPTIMIZE (§7.9 lifecycle) rather than proceeding.

### 7.5 Decision pipeline & cadence

The pipeline, in order, with the V1 implementation of each step:

1. **Signal detection** — deterministic rules (§7.3) over data already in our tables: `gsc_query_daily`, `store_pages`, `keywords`, `product_families`, `articles`, `article_product_refs`, SERP snapshots. No LLM, no billable calls at this step.
2. **Evidence aggregation** — join GSC, SERP snapshot, catalog, content inventory, and historical outcomes for each candidate into an `evidence_json` blob with source and window stamped per fact.
3. **Eligibility / precondition checks** — existing-target check (§7.7), substance inventory (§8.2), overlap/cannibalization, open technical blockers, pending repairs, cooldowns, not-interested list, dismissed-opportunity list. Failing a precondition doesn't drop the candidate: it becomes `HOLD`/`blocked` with the precondition named (a blocked opportunity is information the merchant needs).
4. **Opportunity scoring** — impact + confidence (§7.6).
5. **Action selection** — CREATE / OPTIMIZE / REFRESH / FIX / HOLD per §7.8; a separate function from detection, taking the full evidence.
6. **Task generation** — concrete executable units. Deterministic for FIX/HOLD (templated from evidence); LLM-assisted for OPTIMIZE (§10.3) and only on demand; for CREATE the "task" is the calendar topic (§8.7).
7. **User approval or autopilot policy** — per action type (§7.9): content actions auto-schedule with veto; OPTIMIZE/FIX are user-initiated in V1.
8. **Outcome measurement + learning** — §9.6, extended with per-opportunity outcomes (§9.6.10).

**Cost ordering is the design:** steps 1–5 spend nothing beyond data we already hold; DataForSEO SERP checks are spent only on top-ranked candidates (the ordering rule from §9.6.4); LLM calls happen only for intent-gap analysis on shortlisted pages (§10.3) and for generation the user or calendar actually triggers.

**Cadence — three jobs, all idempotent per §14.3:**

| Job | When | Does |
|---|---|---|
| **Onboarding run** | Immediately after profile confirmation (§6.9) | Full detection over whatever data exists (GSC history if connected; otherwise Limited Intelligence, §7.11). Produces the first opportunity set — **the activation moment** — and the initial ~3-month CREATE/REFRESH calendar (§8.7) from the accepted content opportunities. |
| **Weekly signal scan** | Every Monday, persona-country clock (the former "weekly refresh scan", generalised) | Re-runs detection over all store pages and our articles; creates new opportunities, updates evidence on open ones, expires those whose evidence no longer holds (§7.9), recomputes article labels (§9.6.2). Feeds the candidate pool — never the calendar directly. |
| **Monthly replenishment** | When the calendar's `planned` horizon < ~60 days (§9.6.1) | Fills empty calendar slots from accepted CREATE/REFRESH opportunities by score, honouring refresh share (≤40%) and exploration reservations (§9.6.5–9.6.6). |
| *Event-driven* | Shopify webhooks / reconciliation sweep (§14.1) | Product-change and broken-reference opportunities are created within the existing drift-handling flow; the repair queue is now the FIX/REFRESH execution path for those opportunities. |

### 7.6 The opportunity object & scoring

**Required fields (V1):**

| Field | Meaning | V1 requirement |
|---|---|---|
| `signal_type` | Which signal produced it. | Required; closed enum matching §7.3. |
| `evidence` | Concrete measurements and their sources. | Required; auditable; each fact carries `source`, `window`, `fetched_at`. |
| `affected_entity` | Query cluster, URL, product family, article, product, … | Required (`entity_type` + `entity_ref`). |
| `impact` | Expected effect size. | `low / medium / high` shown; `impact_score` (0–100) stored. **No dollar estimate in V1** (decided; Appendix B) — the evidence numbers (impressions, position) are shown instead. |
| `confidence` | How sure the diagnosis is. | 0–100 stored; shown as a band. |
| `reason` | Why this is an opportunity. | Deterministic, evidence-based, user-facing; stored as `reason_template_key` + params, rendered at display time (same as why-lines). |
| `recommended_action` | CREATE / OPTIMIZE / REFRESH / FIX / HOLD | Required. |
| `preconditions` | What blocks execution. | List; e.g. `catalog_richness_gap`, `indexing_issue`, `pending_repair`. Non-empty ⇒ status `blocked`/HOLD. |
| `tasks` | Concrete execution units. | 0..n (§7.5 step 6). |
| `status` | Lifecycle state. | §7.9. |
| `outcome` | Later measured result. | Filled by §9.6.10; null until measured. |
| `rules_version`, `detected_at` | Which config produced it, when. | Stamped like `prompt_version` (§14.2). |

**Scoring inputs (all of these must be available to the scorer, even where a V1 weight is zero):** search demand, commercial intent, catalog fit, current position/visibility, ranking probability (winnability), product availability, data richness, competition, expected business value, execution effort, confidence. The exact formula is internal and versioned; the merchant sees Impact / Confidence / Why / Recommended action, never a formula.

**V1 formulas:**

- **CREATE candidates:** `score = opportunity × pattern_multipliers × source_bonus` exactly as §9.6.4 — `opportunity = log(volume) × winnability`, pattern multipliers clamped to [0.5, 2.0], competitor-gap source bonus ×1.15. Family-coverage-gap candidates get a `business_weight` multiplier = the family's share of 90d revenue rescaled to [1.0, 1.5] (this is the "ecommerce context first" principle expressed as one number).
- **Existing-page candidates (OPTIMIZE / REFRESH):** `expected_gain = impressions_28d × (CTR(target_position) − CTR(current_position))` exactly as §9.6.5, using the store's fitted CTR curve where available; `target_position` = 3 for striking distance, current position for Low-CTR (where the gain is CTR recovery to the curve's expectation), baseline position for decay. Multiplied by the same pattern multipliers (dimension `action_type` added, §9.6.10).
- **Comparability:** the two families of scores are not on one scale, so **`impact_score` is the candidate's percentile rank within its own action family across the store's current candidate set**, and `impact` bands are terciles of that (relative to the store, like labels in §9.6.2 — a niche store's best opportunity is "high" for that store). The Opportunities screen sorts by `impact_score` then `confidence`.
- **Confidence (0–100) — additive heuristics, deterministic:** +30 GSC evidence present (else DataForSEO ranked-keyword proxy only); +20 evidence window ≥ 28 days (+10 if ≥ 84); +15 ≥ 2 independent sources agree (e.g. GSC + SERP); +15 mapped families pass the substance floor with margin; +10 no open precondition; +10 signal validated across ≥ 2 consecutive weekly scans; −20 Limited Intelligence mode. Clamped; bands: high ≥ 70, medium 40–69, low < 40. The numbers are config (§7.10).

### 7.7 The existing-target check (mandatory before any CREATE)

The single most important rule in the merge — it is what makes "improve the existing collection instead of creating another page" an expert behaviour rather than a hope:

1. Resolve the candidate's **query cluster** (target keyword + its related-keyword expansion, §9.6.3).
2. Look for an existing store URL for that cluster, in order: (a) GSC — any store URL with impressions on the cluster at mean position ≤ **30** over 28d; (b) content mapping — any `store_pages` row (collection, product, page, blog article) or our own article whose mapped families and intent class match; (c) Limited Intelligence fallback — DataForSEO ranked keywords for the domain.
3. If a match exists: **do not CREATE.** Emit an OPTIMIZE opportunity on that URL (or REFRESH if it's our article older than the cooldown), carrying the evidence that triggered the CREATE candidate. The why-line reads: *"You already rank for this. Improving the existing collection is safer than creating another page."*
4. If the match is weak (position > 30, or a product page for a category-level intent), CREATE may proceed **only** with the existing URL recorded in `evidence.existing_target` and an internal-linking task attached (link the new content to and from it) so the two don't compete blind.
5. Gate 1's cannibalization check (§8.2) is this rule applied at admission time; both read the same function.

### 7.8 Signal → opportunity → action mapping, with worked examples

Why the same signal doesn't always yield the same action:

| Signal / situation | Opportunity interpretation | Action |
|---|---|---|
| Competitor gap + no relevant own URL | Missing coverage. | CREATE |
| Competitor gap + relevant URL exists at #18 | Existing asset not competitive enough. | OPTIMIZE |
| Content decay + outdated content | Lost relevance/freshness. | REFRESH |
| Content decay + canonical error | The cause is technical. | FIX |
| High impressions + low CTR + good rank | SERP click opportunity. | OPTIMIZE |
| Commercial query + a collection already ranks #7 | The existing collection is the better target than a new article. | OPTIMIZE |
| Commercial query + no suitable URL | Real coverage gap. | CREATE |
| Good topic, too few store facts | Can't responsibly produce content. | HOLD + merchant task |

**Worked examples (acceptance fixtures — each becomes a unit test over a synthetic store, §14.2/tech spec §6):**

| # | Scenario | Evidence | Opportunity | Action | Tasks |
|---|---|---|---|---|---|
| 1 | Striking Distance | GSC: query "best trail running shoes", page `/collections/trail-running`, position 7.3, 9,402 impressions / 28d. | High-potential ranking opportunity; Google already deems the page relevant. | OPTIMIZE | Collection copy; buying-criteria section; 4 internal links; title rewrite; sizing FAQ. |
| 2 | Strong rank, weak CTR | GSC: position 3.4, 15,000 impressions, 310 clicks; CTR below the store's own curve. | Ranking is fine; the snippet doesn't win clicks. | OPTIMIZE | Title/meta rewrite; SERP intent alignment; structured-data check. |
| 3 | Missing coverage | Search data: commercial query with volume; Shopify: matching family with substance; no suitable URL. | The store doesn't cover the demand. | CREATE | Buying guide or comparison on the calendar. |
| 4 | Existing intent gap | Collection at #11; top SERPs all cover waterproofing, terrain, fit, sizing; ours doesn't. | The existing collection is the right target but coverage is incomplete. | OPTIMIZE | Add the missing decision-support blocks. |
| 5 | Cannibalization | Collection, blog post, and product URL alternate for the same query. | Google may be unsure of the primary target. | FIX / OPTIMIZE | Intent audit; designate primary URL; internal-link realignment; possible consolidation. |
| 6 | Decay | Page moved 3.8 → 7.1 over 3 months; clicks 1,700 → 860/mo. | A previously proven asset is losing performance. | REFRESH | SERP diff; content update; product references; freshness; internal links. |
| 7 | Catalog richness gap | Keyword is good and commercial; the mapped products' descriptions are marketing fluff only. | Not enough factual substance for a quality article. | HOLD | Merchant task: add material, dimensions, use case, compatibility; re-evaluate at next scan. |
| 8 | Index issue (P1) | Important collection not indexed / canonical points elsewhere. | Content can't compete while the technical block exists. | FIX | Show index/canonical reason; auto-fix only if safe, else developer recommendation. |

### 7.9 Lifecycle, dedupe, expiry & approval policy

**Status:** `new → accepted → scheduled → executing → completed | dismissed | blocked | expired`.

- `new` — detected, visible on the Opportunities screen. `accepted` — the user (or autopilot policy) accepted it. `scheduled` — a CREATE/REFRESH with a calendar topic (`topic_id` set); the topic's own state machine (§8.7) governs from here. `executing` — an OPTIMIZE recommendation is being generated, or a FIX auto-repair is running. `completed` — content published, recommendation marked applied by the user, or repair confirmed. `dismissed` — user said no; goes to the not-interested list (§8.7) keyed by `(signal_type, entity_ref)` so it is never re-proposed, with a "show dismissed" view to undo. `blocked` — open precondition (HOLD renders as this). `expired` — the evidence no longer holds at a later scan (page moved to #2, query lost volume, product deleted); expiry is automatic, logged with the reason, and never deletes the row.
- **Dedupe:** partial unique index on `(account_id, signal_type, entity_ref) WHERE status IN (new, accepted, scheduled, executing, blocked)` — a re-detected signal **updates evidence and score on the open row** instead of creating a duplicate. Completed/expired rows stay as history and feed learning.
- **Autopilot policy per action type (decided; V1):**
  - CREATE / REFRESH (our content): **auto-accept** and schedule via the calendar. The user's controls are the existing calendar operations — veto, move, pin, add (§8.7). This is the autopilot-with-veto posture of §8.7; the opportunity model sits underneath it.
  - OPTIMIZE (store pages): **user-initiated**. The card offers "Generate recommendations" (§10); nothing is generated, let alone applied, without that click. Default cap: 2 recommendation generations per account per day (config), inside the daily LLM budget guard (§14.5).
  - FIX: automatic only for the mechanical repairs already allowed by `auto_repair` (§14.1) on auto-publish accounts; everything else recommendation-only.
  - HOLD: never executes; surfaces the merchant task.
- **Technical blockers precede content:** if an entity has an open FIX opportunity of a blocking kind (indexing, canonical — P1), CREATE/OPTIMIZE on the same entity are `blocked` with that precondition until it resolves.

### 7.10 Configurable thresholds & scoring layer

Every number in §7.3, §7.6, and §8.2 (demand floors per locale, position bands, CTR ratio, decay ratios, impression shares, confidence points, multiplier clamps, exploration reservation, refresh share) lives in a **versioned configuration file in the repo** (`signals.config.yaml`, one schema-validated document), loaded at worker start and stamped onto every opportunity and gate decision as `rules_version`. Rules of the layer:

- No threshold literal in application code; lint bans numeric comparisons against GSC/volume fields outside the rules module.
- Overrides are layered: global defaults → per-locale → (later) per-store / per-market / per-query-type / per-page-type. V1 ships global + per-locale; the override tables exist in the schema (§13) even if empty.
- Changing a threshold is a code change that goes through the calibration posture of §8.5 (start strict, loosen with evidence) and CI; the weekly calibration review reads the PostHog `opportunity_detected` trend broken down by `rules_version` (§14.7).

### 7.11 Limited Intelligence mode (no GSC)

GSC is **soft-required** (decided; Appendix B): technically optional, strategically required. Without it the engine runs, but:

- GSC-dependent signals (Striking Distance, Low CTR, Decay, Cannibalization, Indexing/Canonical, Freshness) are **not evaluated**; the Opportunities screen shows the *Limited Intelligence* badge with the copy in Appendix A and lists which signal types are unavailable.
- Catalog- and market-driven signals run: Uncovered Commercial Query, Competitor Coverage Gap, Product Family Coverage Gap, Catalog Richness Gap, Product Change Impact, Broken Reference.
- The existing-target check (§7.7) falls back to content mapping + DataForSEO ranked keywords for the domain (cached, 30-day TTL); opportunities carry `confidence −20` and the evidence names the proxy.
- Winnability falls back to the conservative constant of §9.6.4; the learning loop degrades to pure opportunity scoring (it functions; it learns nothing).
- Connecting GSC later triggers an immediate onboarding-style run; existing opportunities are re-scored, not duplicated (§7.9 dedupe).

### 7.12 User-facing minimum (V1)

The Growth Opportunities surface (UI spec §5) must not be a content topic list. Every opportunity card shows: **type (signal), impact, confidence, evidence/reason, affected URL/query, recommended action** — and makes the action type (CREATE / OPTIMIZE / REFRESH / FIX) unmistakable. Blocked/HOLD cards say what the merchant must do first. For an existing page with the same intent, the default is never a new competing URL. A technical block, where detected, precedes the content action. The dashboard's first element is *"Sortiva found N ways to grow your store organically"* with next best actions — article count is a secondary result (UI spec §4).

---

## 8. Content model & quality gates — the CREATE / REFRESH execution path

### 8.1 Topic-first, not product-first

**Position in the product (changed):** the content engine is the execution module for CREATE and REFRESH opportunities (§7.4) — no longer the whole product. A calendar topic is a CREATE/REFRESH opportunity that passed the existing-target check (§7.7) and was accepted under the autopilot policy (§7.9); every topic carries its `opportunity_id`. Nothing below changes mechanically.

The unit of content is a **topic** — a search opportunity + intent + product-family link: a keyword opportunity mapped to one or more **product families** (§6.4), never raw products. A single "best X for Y" piece covers many long-tail products at once; category/collection-level content is how large catalogs (100s of products) get coverage without per-product thinness. A family's differentiation axes supply the article's comparison structure directly. Consequences:

- No sliding-window iteration over the catalog. The long tail of a 600-product store is where search demand is zero — per-product articles there would manufacture exactly the thin content we refuse to publish.
- Coverage over time comes from (a) new topics as they clear the gate and (b) **refreshing** existing articles that have earned rankings (freshness signal, compounding returns) — top sellers naturally get the most refresh attention. Concrete refresh/repair triggers (product deleted, sustained out-of-stock, price drift, family-axis changes) are defined in §14.1.
- **Override policy (decided):** users can publish a Gate-3-rejected draft anyway — see §8.6.
- **Refresh accounting (decided):** a refresh occupies a daily calendar slot exactly like a new article (§8.7) — no fractional weighting.

### 8.2 Gate 1 — Topic admission (before any writing; ~free)

Deterministic, data-driven checks. Fail early, fail cheap, and every failure has a precise user-facing reason:

- **Demand floor:** keyword volume ≥ threshold in the store's locale (tuned per country — 50/mo in Danish ≠ 50/mo in English). Zero-volume topics auto-reject unless the user manually pinned them.
- **Winnability:** difficulty vs. the site's estimated authority (GSC data, once connected, calibrates what positions the site realistically reaches).
- **Substance inventory:** the topic must map to families whose **merged fact sheets** (§6.3–6.4) have enough populated fields across enough member products. This metric can't be gamed by long fluffy descriptions or by 40 near-identical clones — a 400-word description that distills to two facts reads as a thin product, and 40 clones read as one family, not 40 content sources.
- **Existing-target / cannibalization check (§7.7 — literally the same function):** no existing store URL — our article, the store's own blog, or a collection/product/page from the content inventory (§12.3) — already targets the same intent or ranks ≤ 30 for the query cluster. A match converts the candidate to OPTIMIZE (store page) or REFRESH (our article) instead of admitting a CREATE; it never proposes a competing URL.
- **Intent & commercial relevance:** the intent class is one the store can serve and the topic maps to a family the store sells — an informational query with no family mapping is rejected as off-catalog, with that reason.

### 8.3 Gate 2 — Evidence pack check (after research, before drafting)

Article generation writes **only from an evidence pack** assembled first: relevant fact sheets, DataForSEO SERP context, competitor angles. Before drafting, a cheap check verifies the pack contains enough distinct, non-generic claims; a 90%-boilerplate pack is killed here. Writing only from the pack is also the anti-hallucination control that makes Gate 3's grounding check tractable.

### 8.4 Gate 3 — Draft grading

**Deterministic lints first (free):** length floor; n-gram/embedding similarity vs. the store's other articles (near-duplicate detection — the classic at-scale failure where article #40 sounds like article #12) and vs. top SERP results; broken product links; missing internal links; keyword-stuffing density.

**LLM-as-judge, rubric-based:**

- **Separate call, blind to generation** — the judge sees draft + evidence pack + top-3 ranking competitors' content, never the writer's conversation (same-context grading inflates scores).
- **Per-criterion scores (1–5), each with required written justification:** information gain vs. the current SERP (the money criterion), factual grounding (every product claim traceable to the pack), search-intent match, actionability/specificity, language quality in the store's language.
- **Gate on the minimum, not the average.** Information gain and grounding are hard floors (≥4); the rest ≥3. A 5/5/5/1/5 draft fails.
- **One repair loop, max.** Fail → judge justifications go back to the writer as revision instructions → regrade once → still failing = rejected. No further loops (they converge on judge-pleasing mush and burn tokens).

### 8.5 Calibration & drift

Thresholds start strict and loosen only with evidence — never the reverse: the acceptable error is a false *reject*, never a false *pass* ("not posting is better than thin content" is literally the tuning target). During beta, sample both gated-out and gated-in articles for human review. Log every gate decision with scores and justifications to audit drift across model/prompt changes. Known open issue: the information-gain floor is niche-sensitive (easy in hobby verticals, brutal in commoditized ones like phone cases) — expect per-vertical threshold offsets, or accept that some stores legitimately get fewer articles than their plan allows.

### 8.6 User notification (required, not optional)

Quality-gate outcomes are always surfaced:

- **Per-rejection card:** topic, which gate, plain-language reason, and — when actionable — what the user can do ("add material/dimension details to these 3 products and we'll retry this topic").
- **Monthly summary:** reports what happened, with no denominator — 1/day is a ceiling, not a promise, so the summary never frames output against a day count or target. "This month: 22 articles published. 5 topics were held back by our quality bar — here's each one and why." Skipped days without a scheduled topic aren't 'missed'; they simply don't appear. Stating reasons for held-back topics is the trust posture; padding with thin content burns the domain. The summary also reports what Sortiva did across *all* action types (OPTIMIZE recommendations generated/applied, repairs, HOLD tasks resolved) and the top open opportunities for next month — it is the flagship retention email (tech spec §1.4).
- Plan copy consequence: the cap is marketed as "**up to** 1 article per day, quality permitting" (§4.2) — never a promised count.
- **Override (decided): "publish anyway" exists.** A Gate-3-rejected draft is viewable and can be published against recommendation via an explicit, deliberately non-casual action (confirmation dialog restating the judge's failing criteria in plain language). Every override is logged (`gate_decisions` outcome `overridden`), the article carries an internal `published_via_override` flag, and overridden articles are **excluded from our calibration data (§8.5) and from headline performance claims** — they can't pollute the judge's tuning or our "articles we published perform X" story. Their GSC performance is still shown to the user (it's their site), just segmented.

### 8.7 The content calendar — auto with rolling veto

**Position (changed):** the calendar is the Content module's execution schedule for CREATE and REFRESH opportunities. It is no longer the product's main screen — that is Growth Opportunities (UI spec §5). Every mechanic below is unchanged.

**Posture (decided): auto-with-veto, veto anytime.** The system plans and generates on its own; the user can intervene at any moment up to the instant a generation job dequeues. There is no review window and no approval step — generation is daily, and the entire planned horizon is always visible and editable, so nothing ever generates that the user couldn't have seen coming.

**The calendar is the planning surface** (queue and calendar are the same object, viewed by date): every planned topic sits on its scheduled generation date across the full horizon — a ~3-month backlog built at onboarding, replenished monthly. (Topics come from the Opportunity Engine — CREATE opportunities from uncovered commercial queries, competitor gaps, and family coverage gaps; REFRESH opportunities from the weekly scan (§7.3, §7.5) — seeded from confirmed keywords × product families, expanded via DataForSEO related-keyword and competitor ranked-keyword lookups, filtered by Gate 1; each topic carries an intent class — buying guide | comparison | how-to | informational — which selects its article template.) Each calendar entry shows: title, target keyword + volume, intent class, mapped families, new-vs-refresh, and the originating opportunity (signal type + why-line, linking to its card). Topic states: `planned → generating → in_review (if draft review enabled) → published | rejected_by_gate | vetoed`.

**User operations, all available anytime:**

- **Delete (veto):** removing a `planned` topic is free and instant. The calendar keeps the gap by default (replenishment fills it later) rather than silently pulling everything forward — no surprise early publishes. Deleted topics go to a "not interested" list that replenishment consults, so a vetoed topic is never re-proposed.
- **Reorder / move:** drag any `planned` topic to any future date.
- **Pin:** fix a topic to a date; replenishment and reordering never move pinned topics. (Pin + manual add is how a merchant preps launch content for a specific day.)
- **Manual add:** the user can add a topic by hand ("write about X") on any date. Manual topics **still pass Gate 1** — the user chooses the subject, the gate still checks demand and substance, and responds honestly: proceed, proceed-with-warning ("heads-up: ~0 search volume for this"), or reject with the standard reason card. Manual topics are marked `source: manual` and, like everything else, must clear Gates 2–3 after generation.

**Lock semantics — the one hard edge, stated rather than hidden:** when the daily job dequeues a topic it flips `planned → generating` (guarded transition per §14.3.1). A veto arriving after that flip cancels *publication* — the draft is discarded (or parked as viewable-but-unpublished) — but the generation cost is already spent; we absorb it (it never counts against the user). The calendar's full visibility makes this race rare by construction.

**The calendar governs generation intent, not publication promise.** A scheduled topic can still fail Gate 2/3 after generating. The calendar shows this in place: the slot renders as "didn't meet our quality bar" with its §8.6 reason card — the calendar never silently shows fewer published articles than were scheduled. The §8.6 transparency posture lives exactly where users look.

**Generation limit (decided): single tier, at most 1 article per day** (§4.2). The scheduler dequeues at most one topic per account per day; days can produce zero (gate failure, empty calendar, vacation mode) and that's by design. This also settles refresh accounting: **a refresh occupies a daily slot exactly like a new article** — no fractional weighting needed. The planner balances new-vs-refresh when filling the calendar (§9.6); the user sees and can rearrange the mix like any other topics.

---

## 9. Article generation & publishing

### 9.1 Daily generation cycle

One scheduler pass per account per day (anchored to the persona country's timezone, matching the publish hour in §9.4): take the calendar's topic scheduled for today — **and only today**: an empty or vetoed slot means no article today (consistent with §8.7's keep-the-gap rule; the scheduler never pulls a future topic forward, which would be exactly the surprise early publish §8.7 forbids) → flip to `generating` (guarded, §14.3.1) → run the pipeline: evidence pack → Gate 2 → draft → Gate 3 (+ one repair loop) → `in_review` or publish/export. **At most one topic dequeues per account per day — this is the plan cap's enforcement point** (§4.2); no topic on the calendar for today, or a gate failure, means no article today, and the calendar slot says why. Vacation mode (§14.6) and kill switches (§14.5) are checked before dequeue.

### 9.2 Article construction

- **Template by intent class** (§8.7): buying guide, comparison, how-to, informational — each a structural skeleton (sections, comparison table presence, FAQ block), not canned prose.
- **Structure from family axes:** for buying guides/comparisons, the section skeleton comes from the mapped families' differentiation axes (§6.4) — "by terrain / for wide feet / by budget" is literally the axis list.
- **Evidence-pack-only writing** (§8.3), in the persona's language and tone (§6.5).
- **Length (default — my call, veto-able): SERP-matched per topic.** The evidence pack includes the top-ranking pages' depth for the target keyword; the draft targets comparable coverage, not a global word count. A fixed count either pads thin topics or truncates deep ones; the SERP already encodes what depth ranks.
- **Internal linking (Gate 3 lint, already specced):** every article links the referenced product/collection pages and at least one related earlier article once any exist.
- **Images: product images from the catalog only.** The products referenced by the article supply imagery (selected during evidence-pack assembly); alt text is generated from the fact sheet (free SEO value). **No AI image generation for now** (out of scope, §18). Export includes image URLs in the metadata block; auto-publish sets images via the API.
- **On-page metadata:** title tag, slug (stable once published — refreshes never change a live slug), meta description, target keyword — generated with the draft, part of both export metadata and API publish.

### 9.3 Draft review (optional setting — my call, veto-able)

A per-account toggle, **default off**: when on, a Gate-3-passing draft enters `in_review` instead of publishing; the user reads the rendered draft and **approves or discards** — there is deliberately **no in-app editor** (decided): users who want to tweak wording do it in Shopify after publishing (or in their own tools after export). This keeps review a one-decision surface instead of a rich-text editing product. No expiry pressure — an unreviewed draft just sits (and the day's slot was consumed by generation, not publication). Users who want zero human touch never see this; users who want final say get it without us building approval into the main flow.

### 9.4 Publish mechanics

- **Timing (my call, veto-able):** passing drafts publish at a fixed hour — default 09:00 **in the confirmed persona country's timezone** (§6.5), configurable — rather than the instant Gate 3 passes. The audience's clock, not the merchant's or ours: a German store run from Bali publishes at 09:00 Berlin time. For countries spanning multiple timezones (US, CA, AU, BR, RU), default to the country's most populous business timezone (US → America/New_York, etc.) and let the user pick a specific one in settings. Predictable for the merchant, and naturally spaced at ≤1/day so publishing never looks like an algorithmic burst. The daily generation cycle (§9.1) runs early enough ahead of the publish hour that Gate 3 + the repair loop complete before 09:00.
- Auto-publish targets the blog selected when auto-publish was enabled (§9.5) via the two-phase intent protocol (§14.3.7), with per-account draft-vs-live default (live by default; "publish as Shopify draft" available for merchants who want a last look inside Shopify instead of our review flow).
- Export mode: the article appears in the app at the same publish hour with download (Markdown + HTML + metadata block) and the **"mark as published + paste URL"** action that feeds GSC attribution (§12.2).

### 9.5 Delivery modes (consent model unchanged)

- **Export mode (default, always available):** no write scopes ever requested; full product value minus automation — deliberate per the product requirement.
- **Auto-publish mode (opt-in):** requires the *second* Shopify OAuth pass adding `write_content`, prompted only in settings or at first publish attempt — never bundled into the initial read-only grant. **Blog selection is part of this same flow:** immediately after the grant, the user must pick the target blog — select from the store's existing blogs (listed via `read_content`), or have us **create one** (a one-click "create a blog named X" using the just-granted `write_content`; no scope tension, since creation and posting need the same scope). Auto-publish cannot be enabled without a target blog resolved. Changeable later in settings; changing it never moves already-published articles. The target blog is an auto-publish concept only — no other part of the product references it.

### 9.6 Outcome measurement & learning loop (detailed)

The loop that makes this an *engine* rather than a content queue: published performance feeds back into what gets planned next. **Rule-based in v1, no ML** — but the rules, thresholds, and data flows are specified exactly, and every input is logged from day one so smarter ranking can be layered on later without a backfill.

**9.6.1 Cadence & jobs.** Two jobs, both idempotent per §14.3:

- **Monthly replenishment** (runs when the calendar's `planned` horizon drops below ~60 days): builds the candidate pool, scores it, fills empty slots. Never touches pinned or user-moved topics.
- **Weekly signal scan** (every Monday, persona-country clock — §7.5; this is the refresh scan of §9.6.5 generalised to all store pages): finds refresh candidates for our articles per §9.6.5 *and* every other §7.3 signal. Content candidates (CREATE/REFRESH) go into the *candidate pool* — not directly onto the calendar; they compete on score like everything else. Non-content opportunities (OPTIMIZE / FIX / HOLD) go to the Opportunities screen, never the pool.

**9.6.2 Performance signals (from `gsc_daily`, §12.2).** Per published article, computed over a trailing 28-day window vs. the prior 28-day window: clicks, impressions, mean position, and their deltas. Two hard rules:

- **Maturity gate: no judgment before 28 days post-publish.** SEO compounds slowly; scoring young articles measures noise. Articles younger than 28 days are `unrated` and contribute nothing to patterns.
- **Relative, not absolute, thresholds.** "Success" is defined against the store's own baseline (median clicks/impressions across its rated articles), because 30 clicks/month is a triumph for a niche Danish store and a failure for a large one. Labels: `winner` (clicks ≥ 2× store median, or position improved ≥ 5 spots with impressions above median), `neutral`, `underperformer` (clicks < 0.25× median *and* position > 30 after 90 days). Every rated article gets exactly one label, recomputed weekly.

**9.6.3 Pattern aggregation.** Labels roll up along three dimensions (a fourth, `action_type`, is added in §9.6.10): `intent_class`, `family_id`, and `keyword_cluster` (clusters = the confirmed keyword each topic descended from, plus its DataForSEO related-keyword expansion — stored at topic creation so the lineage is explicit). A pattern only becomes *active* with **n ≥ 3 rated articles** in that dimension-value — below that, it's noise, not signal. Active patterns produce a multiplier:

- Winner-dominant pattern (≥⅔ winners): ×1.25
- Underperformer-dominant (≥⅔ underperformers): ×0.8
- Mixed: ×1.0
- **Floors and ceilings: multipliers never leave [0.5, 2.0]** even when stacked across dimensions, and they're computed from the trailing 90 days of labels only, so a pattern can recover — nothing is ever permanently learned.

**9.6.4 Candidate scoring.** Every candidate topic gets:

`score = opportunity × pattern_multipliers × source_bonus`

- **Opportunity** (same inputs as Gate 1): `log(volume) × winnability`, where winnability discounts keyword difficulty against the site's demonstrated reach — the position range the site actually achieves per GSC. **GSC not connected (Limited Intelligence mode, §7.11):** winnability falls back to a conservative constant, the loop degrades to pure opportunity scoring, and the dashboard nudges GSC connection ("connect Search Console so planning can learn from your results"). The loop must function without GSC; it just learns nothing.
- **Pattern multipliers:** product of the (≤3) active pattern multipliers the candidate matches, clamped to [0.5, 2.0].
- **Source bonus:** competitor-gap candidates (keywords a §6.6 competitor ranks for, mapped to families we sell, that we haven't covered) get ×1.15 — they carry proof that ranking is achievable in this niche.

Gate 1 runs *after* scoring, on the top-ranked candidates only (cheapest ordering: score with data already on hand, spend DataForSEO/SERP checks only on likely picks).

**9.6.5 Refresh candidates (the weekly scan).** An article qualifies when: mean position in **5–15** over the trailing 28 days (config, §7.10; the store-page Striking Distance band is 4–15), impressions ≥ store median, **not refreshed in the last 60 days** (cooldown — refreshing more often than Google re-evaluates is churn, not optimization), no pending repair (§14.1 repairs run first; refreshing a broken article wastes the slot), and not override-published. Refresh candidates are scored by **expected gain**: `impressions × (CTR(target_position) − CTR(current_position))` using a standard position-CTR curve — an article at position 6 with 10k impressions beats one at position 12 with 800. **Cap: refreshes fill at most 40% of any replenishment batch**, so new coverage never stalls even when many articles hover near page one.

**9.6.6 Exploration guarantee (anti-feedback-loop).** Pure exploitation converges on writing the same kind of article forever and never discovers that, say, how-to content works for this store. Each replenishment batch reserves **at least 2 slots (or 15%, whichever is larger) for candidates from dimension-values with no active pattern** — unexplored intent classes, families never written about. These are marked `source: exploration` internally, so their performance can later be compared against exploited picks.

**9.6.7 Exclusions from all signals:** override-published articles (§8.6), articles younger than 28 days, articles with pending repairs, and export-mode articles whose published URL was never confirmed (no GSC attribution = no signal, and they must not be counted as underperformers — absence of data is not failure).

**9.6.8 User visibility.** Replenished topics appear on the calendar like any others, but each carries a one-line *why*: "similar to your best-performing guide", "your competitor ranks for this, you don't", "update: this article sits at position 7", "trying something new" (exploration). The why-line is the learning loop made legible — and it's generated from the scoring record, not by an LLM, so it's always true.

**9.6.9 Observability.** Each replenishment emits `replenishment_completed` (`candidates_scored`, `slots_filled`, `refresh_share`, `exploration_share`) and each label recompute emits `article_labeled` (`label`, `age_days`) — PostHog events per §14.7, domain-grouped. A saved insight tracks label distribution over time per store: a store whose winner share climbs is the product working; one stuck at zero winners after 6 months is a churn risk surfaced before the user says it.

**9.6.10 Per-opportunity outcomes (extends the loop to OPTIMIZE / FIX / REFRESH).** Article labels (§9.6.2) measure CREATE. Every other executed opportunity also gets an outcome, measured by the weekly scan against the same 28-day maturity rule:

- **OPTIMIZE (store page):** anchored at `applied_at` (§10.4). Outcome = deltas over the 28 days after vs. the 28 days before: mean position, CTR (vs. the store's fitted curve, so a position change doesn't masquerade as a CTR win), clicks. Labels: `improved` (position ≥ 2 better *or* CTR ≥ +20% relative with impressions not collapsed), `neutral`, `worse`. Recommendations never marked applied get `outcome = not_applied` and contribute nothing.
- **REFRESH (our article):** anchored at the refresh publish; same metrics as the article label window; label `recovered` if clicks return to ≥ 0.8× the pre-decay baseline, else `neutral`/`worse`.
- **FIX (cannibalization recommendation):** anchored at applied; outcome = share concentration on the designated primary URL (≥ 70% of cluster impressions) and cluster clicks delta.
- **Pattern aggregation** (§9.6.3) gains a fourth dimension, `action_type`, so the planner learns e.g. that OPTIMIZE on collections outperforms CREATE for this store. Same n ≥ 3 activation, same clamps, same 90-day recency window.
- Outcomes are written back to `opportunities.outcome_json` + `outcome_measured_at` and emitted as `opportunity_outcome_measured` (§14.7). Overridden articles and Limited-Intelligence proxies are excluded from patterns exactly as in §9.6.7.

---

## 10. Existing-page optimization — the OPTIMIZE execution path

The capability that separates Sortiva from a content generator. It does not need to be a full automatic rewrite engine; it needs to make Sortiva able to say, credibly, *"don't create a new page — improve this one"*, and then hand the merchant something they can apply.

> **Why V1 and not later:** if the store already ranks #6 with a collection, a new blog post on the same intent causes cannibalization. The Growth-OS positioning is only credible if the system can recognise that case and act on the existing page.

### 10.1 Minimum V1 capability (decided)

- Existing-page opportunity recognition from GSC (§7.3: Striking Distance, Low CTR, Decay, Intent Gap; Competitor Gap with an existing URL).
- **Page-type recognition:** `collection | product | page | blog_article | article_ours | other`, from the content inventory (§12.3) — page type selects the recommendation template.
- Recommended changes across five categories: title/meta, content gap (missing sections), headings/structure, internal links, intent mismatch.
- **Exportable recommendation with suggested copy** — the deliverable.
- **Auto-editing store pages is NOT in V1** (decided; Appendix B). Collections/products/pages would require `write_products` / `write_content` on entities the merchant edits by hand; recommendation-only is lower risk and faster scope. Our own published articles are the exception (§10.5).

### 10.2 Trigger & budget

On demand: the opportunity card's "Generate recommendations" action (§7.9). Never generated speculatively. Default cap of 2 generations per account per day (config, §7.10), counted in the account's daily LLM spend guard (§14.5). Regeneration on the same opportunity is allowed once the evidence has changed (new weekly scan) — otherwise the stored recommendation is served (request-cache pattern, §14.3.6).

### 10.3 Recommendation pipeline

1. **Evidence pack (deterministic assembly, no LLM):** the page's current body, title, SEO title/description, headings, outbound internal links (from `store_pages`); the page's GSC query set for 28d (queries, impressions, position, CTR); the target query cluster's SERP snapshot (§12.1) and the **top-5 ranking pages' extracted content** (same fetcher and budget as the Gate 3 judge's competitor content); the mapped families' merged fact sheets and differentiation axes (§6.4); the store's other pages mapped to adjacent intents (internal-link candidates); the brand persona (§6.5).
2. **Subtopic coverage analysis (the intent-gap detector, §7.3):** one Sonnet call, schema-validated (§14.2), that lists the subtopics each top-5 page covers, marks which are present on ours, and returns the gap set with per-subtopic evidence (which competitors, which heading). This output is also the *Existing Page Intent Gap* signal's evidence when run during the weekly scan on shortlisted pages — same call, cached by `(page_checksum, serp_snapshot_id)`.
3. **Recommendation generation:** one Sonnet call, evidence-pack-only (the same anti-hallucination rule as article writing, §8.3), producing structured JSON per page type:

```json
{
  "title_tag": {"current": "...", "suggested": "...", "rationale_key": "ctr_below_curve"},
  "meta_description": {"current": "...", "suggested": "..."},
  "headings": [{"op": "add|rewrite", "level": 2, "text": "...", "after": "existing heading or null"}],
  "sections": [{"heading": "...", "suggested_copy": "...", "facts_used": ["family:123/material", "..."], "gap_source": "serp"}],
  "faq": [{"q": "...", "a": "...", "facts_used": ["..."]}],
  "internal_links": {"add_from": ["/pages/x → this page, anchor '...'"], "add_to": ["this page → /products/y"]},
  "intent_note": "why the page currently under-serves the intent, from evidence"
}
```

4. **Lints (free):** every `facts_used` must resolve to a fact-sheet field (grounding); no suggested copy may duplicate an existing paragraph on the page (n-gram); internal-link targets must exist in the inventory; title ≤ 60 chars, meta ≤ 155; no keyword stuffing. A recommendation failing grounding is regenerated once with the lint errors appended, then marked `failed_validation` and surfaced as "we couldn't produce a safe recommendation for this page" — never a half-recommendation.
5. **Judge-lite:** the Gate 3 judge (§8.4) grades OPTIMIZE recommendations on grounding and intent-match only (two criteria, floors ≥4). Information gain isn't graded here — the recommendation is additive to a page that already ranks.

### 10.4 Output & tracking

- The recommendation renders as a card (UI spec §5.3): each field with current vs suggested, a per-field copy button, the evidence that motivated it, and a **download** (Markdown + HTML) of the full recommendation. Nothing is written to Shopify.
- **"Mark as applied"** (per task or whole): flips the opportunity to `completed`, stamps `applied_at`, and schedules outcome measurement at +28 days (§9.6.10). We also detect application heuristically at the next content-inventory sync (title/meta changed toward the suggestion, new headings present) and offer "looks like you applied this — confirm?" rather than silently assuming.
- Unapplied recommendations don't nag: the opportunity stays open with the recommendation attached until its evidence expires (§7.9).

### 10.5 Our own articles

For `article_ours` pages, OPTIMIZE and REFRESH don't use the recommendation path: they insert a `refresh` topic into the candidate pool (§9.6.5) and, when scheduled, run the full article pipeline — evidence pack → Gate 2 → draft → Gate 3 — and publish/export per the account's delivery mode, with the intent-gap analysis above included in the evidence pack. The 60-day cooldown and the "not override-published" exclusion apply.

---

## 11. Technical SEO — the V1 light layer (limited FIX)

Not a Screaming Frog / Site Audit clone. Only issues that are high-value for ecommerce organic discovery **and** explainable in one sentence are admitted, and the layer is an **input to the Opportunity Engine**, never a separate 200-issue report.

| Issue | V1 behaviour | Detection source | Prio |
|---|---|---|---|
| Broken internal product link / dead recommendation in our content | **Auto-fix** on auto-publish accounts per `auto_repair` (§14.1); action card + repaired export on export accounts | Shopify webhooks + reconciliation sweep | P0 (built) |
| Duplicate / cannibalizing pages | FIX / consolidate **recommendation**: primary-page designation, internal-link realignment, canonical suggestion; never a redirect we execute | GSC (§7.3 rule) | P0 |
| Missing / weak / duplicate title-meta on collections & products | OPTIMIZE recommendation (feeds §10) | Shopify API content inventory (§12.3) | **P0** (a DB query once the inventory exists; no LLM or SERP cost) |
| Orphan product / collection | Internal-linking recommendation | Requires the internal-link crawler (nav menus are not in the Admin API content we sync; without them orphan detection false-positives, so it waits) | P1 |
| Canonical conflict | FIX / recommendation | URL Inspection API | P1 |
| Indexability / noindex anomaly on an important URL | FIX / investigate | URL Inspection API + GSC | P1 |
| Basic product structured data issue | Flag only; deep schema automation V1.5 | Page fetch of a sample of product pages | P1 |

**Rules:**

- **Never auto-modify theme or custom code**, and never execute redirects/canonicals — recommendation only, with the reasoning shown. Auto-fix exists solely for references inside content Sortiva itself published.
- A FIX opportunity of a blocking kind on an entity blocks CREATE/OPTIMIZE on the same entity (§7.9).
- Detection reliability comes before automation: a P1 signal ships with detection + recommendation first; automation for it, if ever, is a separate decision.
- The V1 FIX/metadata set is decided (Appendix B): the three P0 rows above. Everything else is V1.x.

---

## 12. External data integrations

### 12.1 DataForSEO (keywords & competitors)

Now used in **two** places: (a) keyword enrichment and competitor auto-detection during ingestion (§6.6) and confirmation-screen edits (§6.8), and (b) the deeper analysis feeding topic admission and content planning (SERP snapshots for Gate 1/2, competitor ranked-keyword lookups for calendar replenishment, §8.7/§9.6). Implementation notes:

- Wrap it behind an internal `SeoDataProvider` interface so the vendor is swappable and mockable in tests.
- Aggressive caching (keyword metrics: 30-day TTL; SERP snapshots: 7-day) — DataForSEO bills per request and keyword metrics don't move daily.
- All calls are async job-side, never in a request/response path. The confirmation screen's hand-added keyword enrichment is the one latency-sensitive case: it still goes through the job queue but with a high-priority lane, and the UI shows a per-chip loading state rather than blocking.
- Locale-aware: pass the persona's `main_language` + `country` as the DataForSEO location/language parameters.
- The 5-competitor cap (§6.6) is the primary cost lever for planning-phase queries.

### 12.2 Google Search Console (OAuth) — intelligence input, not just reporting

- **Role (changed):** GSC is an Opportunity Engine input (§7), consulted *before* topic/opportunity discovery so the system knows where organic traction already exists and never creates a new URL for an intent an existing page can serve. The reporting below is the secondary use. Onboarding posture: soft-required (§6.7); absence = Limited Intelligence mode (§7.11).
- "Connect Google Search Console" appears as an onboarding step (§6.7) and as a card in Settings → Connections and on the dashboard. Google OAuth with the `webmasters.readonly` scope.
- After OAuth, list the user's GSC properties and require them to pick the one matching the connected domain (accept both URL-prefix and domain properties; validate the property host equals or is a subdomain of the claimed eTLD+1 — mismatches are rejected).
- Store `gsc_connected_at`. This timestamp is the anchor for the headline chart: **"Your search performance since connecting"** — clicks and impressions over time with a marker at connect date and markers at each article's publish/export date.
- Per-article performance: match GSC page-level rows (query the Search Analytics API grouped by page) against known article URLs to show "which articles are doing great" — clicks, impressions, avg position, trend arrow. Articles delivered via export mode need the user to paste/confirm the final URL so we can attribute GSC data to them; auto-published articles know their URL automatically.
- Daily sync job pulls the last N days of **page × query** rows (Search Analytics API, dimensions `page, query, device, country`, capped by `rowLimit`) into `gsc_query_daily` (§13) plus page-level totals into `gsc_daily`; a one-time 16-month backfill runs at connect (§6.7). GSC data lags ~2 days; the UI says so. The weekly scan (§7.5) reads these tables — detection never makes live GSC calls.

### 12.3 Store content inventory (Shopify Admin API — no crawler in V1)

The Opportunity Engine needs to know what pages the store *has* — their type, content, SEO fields, and links — to run the existing-target check (§7.7), page-type recognition (§10.1), intent-gap analysis (§10.3), and metadata signals (§11). For Shopify stores all of this is available through the Admin API without crawling:

- **Sources:** collections (`body_html`, `handle`, `seo.title`, `seo.description`, product membership), products (already synced; add `seo.*` fields and `handle`), pages (`read_content`), blogs and articles (`read_content`), plus our own published articles. Scope set unchanged from §6.2 — `read_content` already covers pages/blogs.
- **Persisted as `store_pages`** (§13): one row per URL with `page_type`, title/SEO fields, a compressed body reference, extracted headings, extracted outbound internal links (parsed from `body_html`), mapped family ids (via product membership for collections/products; via the same topic-mapping used for articles for blog posts), and a content checksum.
- **Sync:** in the daily reconciliation sweep (§14.1) — same budget, same checksum diffing — and on `collections/update` webhooks. **Shopify publishes no webhook topics for pages or blog posts** (checked 2026-09-12), so an edit to either reaches us on the nightly pass and not before. Changing pages update `store_pages.checksum`, which invalidates cached intent-gap analyses (§10.3) and re-scores open opportunities on that URL at the next scan.
- **Known blind spot:** theme navigation menus are not part of this inventory, so link-graph signals (orphan, internal-linking gap) are **P1** and require the light crawler; nothing in V1 draws a conclusion from the *absence* of a link.

### 12.4 Google URL Inspection API (P1)

Used for indexing and canonical signals (§7.3, §11). Same OAuth as GSC (§12.2) with the property already selected; quota is limited (~2,000 inspections/day per property), so inspections are spent only on entities with an open opportunity or in the top-seller family set, never on the whole site. Results cached 7 days. Not required for launch.

### 12.5 GA4 (V1.5/V2)

Behaviour/revenue attribution layer (§17.3). Not integrated in V1; the revenue data V1 captures comes from Shopify orders (`landing_site` aggregates), not GA4.

### 12.6 SERP competitors

SERP snapshots (§12.1) are the storage for query-level SERP competitors (§7.2.1): the ranking URLs, their domains, and — for the top 5 — a reference to fetched page content used by Gate 3 and intent-gap analysis. Never copied into `competitors`; never user-editable.

---

## 13. Data model (summary)

```
accounts        id, email, plan, stripe_customer_id, created_at
subscriptions   account_id (pk), stripe_subscription_id, price_id,
                status (active | past_due | canceled |
                incomplete_expired), current_period_end, cancel_at_period_end,
                synced_at   -- webhook-written, nightly-reconciled, §4.2
stripe_events   event_id (unique, dedupe), type, payload, received_at,
                processed_at   -- §4.2 webhooks, §14.3.8 pattern
domains         id, account_id (unique), domain_normalized (unique),
                platform (shopify | custom_unsupported), state
                (ingesting | awaiting_shopify_auth | needs_confirmation |
                 ready_for_planning | unsupported)
preview_cache   domain_normalized (pk), summary, fetched_at   -- disposable
shopify_conns   account_id, shop_handle, access_token (encrypted),
                granted_scopes[], target_blog_id?, target_blog_handle?,
                connected_at   -- blog set when auto-publish enabled (§9.5);
                null for export-only accounts
products        account_id, product_id, title, raw_body_html (quarantined),
                product_type, tags[], variants, price_range, updated_at,
                family_id, logical_product_id (split-variant merge, §6.4)
product_facts   product_id (pk), facts_json, fact_count, fluff_discarded,
                distilled_at   -- regenerated on product updated_at change
product_families
                id, account_id, name, merged_facts_json,
                differentiation_axes[], member_count,
                grouping_source (collection | split_variant | fact_cluster
                | embedding), confidence, computed_at
personas        account_id, description, language, country, audience,
                tone, richness_score, confirmed_at
top_products    account_id, product_id, title, url, revenue_90d,
                qty_90d, source (orders_api | manual), rank
keywords        account_id, term, language, country, volume, difficulty,
                cpc, source (auto | manual), enriched_at, confirmed
competitors     account_id, domain_normalized, source (auto | manual),
                added_at   -- BUSINESS competitors only (§7.2.1); hard cap 5
                -- per account (enforced in API + DB)
topics          account_id, opportunity_id (→ opportunities, §7.9),
                title, target_keyword, keyword_cluster,
                intent_class
                (buying_guide | comparison | how_to | informational),
                family_ids[], kind (new | refresh), source (auto | manual
                | exploration), score, why_line, scheduled_date, pinned,
                state (planned | generating | in_review | published |
                rejected_by_gate | vetoed), veto_reason?, created_at
                -- the calendar, §8.7; scoring lineage, §9.6
article_labels  article_id, label (winner | neutral | underperformer |
                unrated), window_start, window_end, clicks, impressions,
                mean_position, computed_at   -- weekly recompute, §9.6.2
pattern_stats   account_id, dimension (intent_class | family | keyword_cluster
                | action_type),
                dimension_value, rated_n, winner_n, underperformer_n,
                multiplier, computed_at   -- active iff rated_n >= 3, §9.6.3;
                -- action_type dimension per §9.6.10
refresh_log     article_id, refreshed_at   -- 60-day cooldown source, §9.6.5
not_interested  account_id, topic_fingerprint, vetoed_at
                -- replenishment never re-proposes these, §8.7
gate_decisions  account_id, topic_id, gate (1|2|3), outcome, scores_json,
                reason_user_facing, prompt_version, model_id,
                decided_at   -- full audit trail, §8.5 / §14.2
article_product_refs
                article_id, product_id, family_id,
                ref_type (link | recommendation | mention),
                price_at_write   -- drift policies act via this table, §14.1
webhook_events  webhook_id (unique, dedupe), topic, payload, received_at,
                processed_at, status
ingestion_jobs  account_id, run_id, status, started_at, finished_at
job_steps       job_id, step (detect | oauth_wait | catalog_sync | distill
                | family_group | persona | keywords_competitors
                | gsc_connect | awaiting_confirmation), state (pending | running |
                succeeded | failed_retryable | failed_terminal | skipped),
                idempotency_key, checkpoint (e.g. page cursor), attempts,
                last_error, updated_at   -- guarded transitions, §14.3.1
request_cache   cache_key (pk: endpoint/model + params hash), response_ref,
                created_at, ttl   -- billable-read & LLM replay cache,
                written before processing, §14.3.6
publish_intents article_external_id (unique), account_id, revision_n,
                state (pending | confirmed | abandoned), shopify_article_id,
                created_at, confirmed_at   -- two-phase publish, §14.3.7
ops_flags       scope (global | account), account_id?, flag, actor,
                reason, tripped_by (manual | auto), created_at,
                reset_at   -- kill switches, §14.5
account_settings
                account_id (pk), publish_hour (default 09:00), timezone
                (IANA, default from persona country §9.4), draft_review
                (default false), auto_repair (default true, §14.1),
                delivery (export | auto, default export),
                shopify_publish_as (live | draft, default live),
                vacation_mode (default false), ui_language,
                updated_at   -- the settings surface, see UI spec
gsc_conns       account_id, property, tokens (encrypted), connected_at
gsc_daily       account_id, date, page, clicks, impressions, position
                -- page-level totals; page × query rows live in
                -- gsc_query_daily below
articles        account_id, topic_id, title, slug, target_keyword,
                state (draft | in_review | published | rejected | discarded),
                published_via_override, delivery (auto | export),
                published_url, published_at   -- §9; referenced by gsc
                attribution, gate_decisions, article_product_refs

-- ===== Opportunity Engine (§7) =====
opportunities   id, account_id, signal_type (enum, §7.3), entity_type
                (query_cluster | url | family | article | product),
                entity_ref, evidence_json, impact (low | medium | high),
                impact_score, confidence, reason_template_key,
                reason_params_json, recommended_action (create | optimize
                | refresh | fix | hold), preconditions_json[],
                status (new | accepted | scheduled | executing | completed
                | dismissed | blocked | expired), topic_id?, article_id?,
                rules_version, detected_at, updated_at, expired_reason?,
                applied_at?, outcome_json?, outcome_measured_at?
                -- partial unique (account_id, signal_type, entity_ref)
                --   WHERE status IN (new, accepted, scheduled, executing,
                --   blocked): re-detection updates, never duplicates §7.9
opportunity_tasks
                id, opportunity_id, kind (title_rewrite | meta_rewrite |
                add_section | add_faq | internal_links | product_data |
                consolidate | primary_url | canonical_recommendation |
                schedule_topic | repair_reference), description,
                suggested_copy_ref?, evidence_refs[], state (open | applied
                | skipped), applied_at?   -- §7.5 step 6, §10.4
optimize_recommendations
                id, opportunity_id, page_url, recommendation_json (§10.3),
                judge_scores_json, prompt_version, model_id, rules_version,
                generated_at, state (valid | failed_validation | superseded)
signal_runs     account_id, run_id, kind (onboarding | weekly | event),
                rules_version, signals_evaluated, opportunities_created,
                opportunities_updated, opportunities_expired, started_at,
                finished_at   -- §7.5 cadence; idempotent per §14.3
dismissed_opportunities
                account_id, signal_type, entity_ref, dismissed_at
                -- the opportunity-level not-interested list, §7.9
rules_overrides account_id?, locale?, page_type?, key, value, updated_by,
                updated_at   -- §7.10 layered config; V1 ships global +
                locale defaults from the repo file, table exists for later

-- ===== Store content inventory (§12.3) =====
store_pages     account_id, url (unique per account), page_type
                (collection | product | page | blog_article |
                article_ours | other), handle, shopify_id?, title,
                seo_title, seo_description, headings_json, body_ref
                (compressed), outbound_internal_links[], family_ids[],
                intent_class?, checksum, last_synced_at, article_id?
                -- synced in the daily sweep + webhooks

-- ===== Search Intelligence (§12.2) =====
gsc_query_daily account_id, date, page, query, clicks, impressions,
                position, device?, country?
                -- page × query rows (rowLimit-capped per day); 16-month
                -- retention then rolled up; the input to §7.3 detection
query_clusters  account_id, cluster_id, head_query, member_queries[],
                intent_class, family_ids[], created_at
                -- the lineage object also used by topics.keyword_cluster
ctr_curve       account_id, fitted_at, curve_json (position → expected CTR),
                sample_n, branded_excluded   -- §7.3 Low-CTR; refit weekly
serp_snapshots  cache_key, query, locale, fetched_at, ttl, results_json
                (ranking urls, domains, top-5 content refs)   -- §12.1/§12.6

-- ===== Revenue capture (§17.3; display V1.5) =====
landing_revenue_daily
                account_id, date, landing_url, orders_n, revenue,
                currency   -- aggregates only, customer fields stripped
                -- at read time (same rule as top_products, §6.2/§14.6)
```

## 14. Operational stability & lifecycle

### 14.1 Catalog drift & article integrity

The catalog is alive; published articles are not. Without drift handling, articles end up recommending deleted or repriced products — wrong content ranking well, worse than thin content.

**Change detection — webhooks + reconciliation, never webhooks alone:**

- Subscribe to Shopify webhooks: `products/create`, `products/update`, `products/delete`, `collections/create`, `collections/update`, `app/uninstalled`, plus the mandatory GDPR topics (§14.6). **Not `inventory_levels/update`** (decided 2026-09-12): Shopify gates it behind `read_inventory`, a permission over a merchant's warehouse figures that a writer of articles has no business holding — a product going out of stock still reaches us through `products/update` and the nightly sweep. These topics, and the three GDPR ones, are declared in `shopify.app.toml`, which is the only place Shopify accepts compliance topics from. Handler: verify HMAC signature, dedupe on `X-Shopify-Webhook-Id`, enqueue, return `200` in <5s (slow/failed responses cause Shopify to retry and eventually drop the subscription). All processing is async.
- **Daily reconciliation sweep** (03:00 in the persona country's timezone — same clock as §9.1/§9.4, well before the generation cycle so the day's article writes against a fresh catalog): full paginated catalog fetch, diff against stored `updated_at` + a content checksum per product. Webhooks drop silently in practice; the sweep is the source of truth. Sweep diff count is a monitored metric (§14.7) — a spike means webhooks are failing.

**Reference tracking:** every generated article records which products/families it references in `article_product_refs` (article_id, product_id, family_id, ref_type ∈ {link, recommendation, mention}). Drift policies act through this table — no scanning article text at event time.

**Drift policies (exact triggers → actions):**

| Event | Trigger | Action |
|---|---|---|
| Product deleted | webhook or sweep | Within 24h, flag every article with a `recommendation`/`link` ref → repair queue |
| Out of stock | continuously OOS ≥14 days (all variants) | Repair queue; back-in-stock clears the flag |
| Price drift | current price differs ≥20% from price captured at article write time | Refresh queue (lower priority than repair) |
| Family change | membership change alters the family's differentiation axes | Recompute merged facts; affected articles → refresh queue |
| Collection deleted | webhook | Re-run family grouping for member products only |

Each row of this table also creates or updates an **opportunity** (`signal_type = product_change_impact` or `broken_product_reference`, §7.3) so repairs appear on the Opportunities screen with evidence and outcome like everything else; the repair and refresh queues are simply the FIX/REFRESH execution path for those rows.

**Repair semantics by delivery mode:** auto-publish accounts get an `auto_repair` setting (default **on** for mechanical fixes: dead link removal, swapping a deleted product for an in-family equivalent; default **off** for anything requiring rewritten prose — those queue as refresh drafts through the normal Gate 3 pipeline). Export-mode accounts never get silent edits — they get an action card: "Article X recommends a discontinued product — download the repaired version." All repairs are logged per article with before/after.

This section supplies the concrete triggers for the refresh cycle left open in §8.1.

### 14.2 LLM output contracts & prompt regression suite

- **Schema validation on every model call** (distillation, persona, seeds, judge): validate against a JSON Schema; on failure, retry **once** with the validation error appended to the prompt; on second failure, the step enters a typed `failed_validation` state (never "parse what we can"). Failure rates per call type are metrics (§14.7).
- **Pinning:** model IDs are explicit config values (never "latest" aliases); prompts live in versioned files in the repo; every `gate_decisions` row and every generated artifact is stamped with `prompt_version` + `model_id`, so any output is reproducible and drift is attributable.
- **Frozen eval sets, run in CI on any change to a prompt file or model ID — deploy blocks on failure:**
  - *Distillation eval:* ~50 real product descriptions (mixed languages, fluff-heavy and spec-heavy) with hand-written expected fact sheets. Pass: field-level F1 ≥ 0.85 and **zero** inferred-fact violations (any fabricated field value = hard fail).
  - *Judge eval:* ~20 drafts with human gold scores per criterion. Pass: per-criterion MAE ≤ 0.5 **and** no draft that humans failed is graded as passing (false-pass = hard fail, mirroring §8.5).
  - *Persona smoke set:* ~10 known stores; assert language/country detection exact-match and description non-degeneracy.
- Eval sets are append-only; production failures get minimized and added as regression cases.

### 14.3 Idempotency & resumability

Design stance: the queue delivers **at-least-once**; every worker must therefore be **effectively-once** through its own idempotency mechanics. No handler may assume it runs exactly once, first, or alone.

**14.3.1 Job & step model.** Ingestion is a state machine, not a script. One `ingestion_jobs` row per (account, run), with one child `job_steps` row per pipeline step (`detect`, `oauth_wait`, `catalog_sync`, `distill`, `family_group`, `persona`, `keywords_competitors`, `gsc_connect`, `awaiting_confirmation`). `gsc_connect` is the soft-required Search Console step (§6.7): it waits for connect or skip, ends `succeeded` (property chosen, backfill enqueued) or `skipped` (Limited Intelligence, §7.11), and never blocks `awaiting_confirmation`. Step states: `pending → running → succeeded | failed_retryable | failed_terminal | skipped`. Transitions are guarded DB updates (`UPDATE ... WHERE state = 'expected'`); a worker whose guard matches zero rows stops immediately — someone else owns the step. Steps declare their dependencies (e.g. `distill` requires `catalog_sync = succeeded`); the scheduler only dispatches steps whose dependencies are met, which is what makes resume-from-anywhere free: restarting a job just means re-dispatching non-succeeded steps.

**14.3.2 Idempotency keys — derivation, not invention.** Keys are *computed from inputs*, never random, so a retry of the same work produces the same key:
`idempotency_key = sha256(account_id ‖ step_name ‖ input_version)` where `input_version` is step-specific — `catalog_sync`: the Shopify shop ID + a monotonically increasing sync generation number; `distill`: the product's `updated_at` + body checksum (so re-running distillation for an unchanged product is a no-op by construction, per §6.3); `family_group`: the sorted set of member `product_facts.distilled_at` timestamps; `persona` / `keywords_competitors`: hash of their upstream artifacts. Completed keys are stored with their output reference; a worker seeing a completed key returns the stored output without executing. This makes the *cache the ledger*: "have I done this work" and "where is the result" are the same lookup.

**14.3.3 Concurrency: one writer per account.** All pipeline work for an account serializes through a per-account advisory lock (Postgres `pg_advisory_xact_lock(account_id)` or equivalent). This kills an entire class of races cheaply: reconciliation sweep vs. webhook burst vs. user clicking "re-sync" can all enqueue work, but only one mutator touches an account's derived data at a time. Cross-account work is fully parallel. Lock hold time is bounded per step (steps are sized to minutes, not hours — `catalog_sync` for a 500-product store at the 1 req/s budget from §14.4 is ~8 minutes worst case with page-cursor checkpointing, see below).

**14.3.4 Checkpointing inside long steps.** `catalog_sync` persists the Shopify page cursor after every page write; a crash resumes from the last cursor, not page one. `distill` and `family_group` are naturally chunked (per product / per family) and track completion per item via the key mechanism above — a crashed batch resumes at the first incomplete item. Rule: **any step that can exceed 60 seconds must checkpoint**; steps that can't checkpoint must be small enough to safely re-run whole.

**14.3.5 Retry & dead-letter policy.**
- `failed_retryable` (timeouts, 429s, 5xx, LLM `failed_validation` after its own single in-call retry per §14.2): max 3 step-level retries, exponential backoff 1m / 5m / 25m with ±20% jitter (prevents synchronized retry stampedes after a provider outage).
- `failed_terminal` (schema-invalid input, revoked token, 4xx that retrying can't fix): no retries; token errors route to `awaiting_shopify_auth` (§6.2), everything else to the DLQ.
- **DLQ entries carry the full replay context**: step, idempotency key, input refs, last error, attempt timestamps. Ops can replay a DLQ item with one action *because* idempotency makes replay safe — completed sub-work no-ops, only the failed remainder executes. DLQ depth > 0 for > 1h alerts (§14.7).

**14.3.6 External side-effects, by class.** Each external call is classified and handled accordingly:

| Class | Examples | Mechanism |
|---|---|---|
| Pure read | Shopify catalog GET, GSC query | Freely retryable; no protection needed beyond backoff |
| Billable read | Every DataForSEO request | Request-level cache keyed `(endpoint, sha256(canonical_params))`, TTL 24h, **written before the response is processed** — a crash after the API responded but before downstream processing still finds the cached response on retry and never re-bills. Canonicalization: sorted keys, normalized locale codes. Sits *under* the semantic TTLs of §12.1 |
| LLM call | distill, persona, seeds, judge | Same request-level cache pattern keyed on `(prompt_version, model_id, sha256(rendered_prompt))`; a retried step replays the stored completion rather than re-sampling — which also guarantees a retry can't get a *different* persona than the run it's resuming |
| External write | Shopify article create/update | Two-phase intent protocol, below — the only place exactly-once actually matters |

**14.3.7 Two-phase publish (external writes in full).**
1. **Intent:** insert `publish_intents` row `(article_external_id UNIQUE, account_id, state = 'pending', created_at)` in the same transaction that marks the article "publishing". The unique constraint on `article_external_id` is the global dedupe: a second worker attempting the same publish hits a conflict and stops.
2. **Execute:** call Shopify article-create with `article_external_id` embedded in the article (metafield `namespace=ours, key=external_id`; tag as fallback where metafields are unavailable). This makes the remote side *queryable for our marker*.
3. **Confirm:** on success, write `shopify_article_id`, `state = 'confirmed'`, `confirmed_at` — a plain guarded update.
4. **Recovery sweeper** (every 5 min): for each `pending` intent older than 10 min, query Shopify for an article carrying that `external_id`. Found → the create succeeded but the confirm write was lost; adopt it (write the ID, confirm). Not found → the create never landed; re-execute step 2. After 3 recovery failures → `state = 'abandoned'` + DLQ. The invariant this buys: **a crash at any instant between steps 1–3 cannot produce two live posts**, because re-execution is always preceded by a remote existence check on our own marker.
5. Article **updates** (repairs, refreshes per §14.1) use the same protocol with an intent per revision (`article_external_id ‖ revision_n`), and are additionally conditional on the stored `shopify_article_id` — an update never falls back to create (a deleted-remotely article surfaces as a user-facing card, not a silent re-post).

**14.3.8 Webhook idempotency.** `webhook_events.webhook_id` is unique; insert-or-ignore, then process from the table, never from the request body directly. Processing is a no-op if the event's `updated_at` is older than the stored product's (out-of-order delivery is normal). The daily reconciliation sweep (§14.1) is itself idempotent by construction: it diffs desired-vs-stored state, so running it twice converges to the same result.

**14.3.9 The test that keeps all this honest:** a chaos test in CI kills workers at random points during a full synthetic ingestion + publish run (including between publish steps 2 and 3) and asserts the end state: every step eventually `succeeded`, exactly one remote article per `article_external_id`, DataForSEO billable-call count equals the number of *distinct* canonical requests. This test is the specification's teeth; without it, the guarantees above rot silently.

### 14.4 Degradation ladder for external dependencies

Governing principle, the runtime version of the quality stance: **degrade to pause, never to lower quality.**

| Dependency | Detection | Behavior | User-facing |
|---|---|---|---|
| DataForSEO | >50% errors/timeouts over 10 min → circuit opens 15 min | Enrichment serves cached data stale-while-revalidate up to 60 days (staleness stamped on the record); Gate 1 decisions requiring a *fresh* SERP snapshot pause rather than run on stale competitive data | None unless a deadline slips; then "analysis delayed" |
| Anthropic API | error/timeout thresholds per call type | Generation & judging pause and queue; **never** substitute a smaller model for the judge; distillation simply waits (it's never user-blocking) | Progress UI shows "delayed", no partial output |
| Shopify Admin API | 429s / `Retry-After` | Client-side limiter: background sync budgeted at 1 req/s (half the REST leaky-bucket refill of ~2/s, burst 40) so user-triggered actions always have headroom; honor `Retry-After` exactly | None |
| Shopify token invalid | 401/403 | Account → `awaiting_shopify_auth` (§6.2); generation & publishing pause; sync stops | Reconnect banner + email |
| GSC token expired | refresh failure | Reporting sync stops; **content pipeline continues** (reporting is decoration, not a dependency) | Reconnect card on the performance page; chart shows a gap, never interpolated data |

### 14.5 Kill switches & circuit breakers

- **Manual flags**, checked at job dequeue (effective within 60s): `global.pause_all`, `global.pause_publishing`, `account.pause_generation`, `account.pause_publishing`. Global flags require a second operator to reset (four-eyes), and every flip is logged with actor + reason.
- **Auto-trip conditions (exact):**
  - Account daily LLM spend > 10× its trailing-30-day median **or** > hard dollar cap → pause that account's generation.
  - Intent-gap analysis (§10.3) and OPTIMIZE recommendation generation each have a per-account daily cap (config, §7.10); exceeding one pauses that call type only — the content pipeline is unaffected.
  - Global DataForSEO daily spend > configured cap → `global` enrichment pause.
  - **Daily preview LLM spend > its own cap → pause the preview endpoint only** (not the system): serve cache hits as normal, and answer cache misses with the graceful generic card ("sign up and we'll take a deeper look") instead of running a fresh scrape+Haiku call. The funnel stays alive at zero marginal cost. This trip firing at all means Turnstile, rate limits, or the cache are being defeated — investigate, don't just raise the cap.
  - Judge fail rate > 60% over the trailing 50 drafts (global) → `global.pause_all` generation + page ops — this pattern almost always means a prompt/model regression escaped the eval suite; auto-pausing beats mass-producing rejects or, worse, mass-publishing garbage.
  - Publish API error rate > 20% over 1h → `global.pause_publishing`.
- Every auto-trip creates an incident record and alerts; auto-trips never auto-reset.

### 14.6 Account lifecycle, deletion & GDPR

- **Vacation mode:** a settings toggle that halts topic generation and publishing while keeping catalog sync and GSC reporting alive. Cheap to build; its absence produces panicked token revocations instead.
- **Plan cancellation (real — Stripe `cancel_at_period_end` via the Customer Portal, §4.2):** published articles are never touched (they live on the user's store); generation and publishing stop at period end; the account keeps read access to its articles, calendar history, and GSC reporting. These three facts are stated wherever cancellation is offered. Single tier means no downgrade path exists; if tiers ever multiply, spec it then.
- **Account deletion:** immediate Stripe subscription cancellation (no further charges — stated on the deletion screen) and revocation of Shopify and Google tokens via their revoke endpoints; hard-delete of PII and order-derived aggregates within 30 days; domain claim released after a 7-day grace window (protects against accidental deletion freeing the domain to a squatter the same hour); preview-cache row purged. Published articles live on the user's store and are untouched — say so on the deletion screen.
- **Shopify mandatory GDPR webhooks** (required for app-store listing, not optional): `app/uninstalled` → account to `awaiting_shopify_auth`, sync stops. `shop/redact` (arrives ~48h after uninstall) → purge all store-derived data within 30 days. `customers/redact` / `customers/data_request` → by design we hold **no customer-level data**: order ingestion (§6.2) aggregates line items only and must strip all customer fields at ingestion time — assert this with a test, and answer these webhooks with a logged `200` + "no data held" response.

### 14.7 Observability & alerts — PostHog, not homegrown

We do not roll our own metrics/dashboards/alerting stack. Everything observable is emitted as **PostHog events** from the backend (server-side capture), with dashboards built from insights and alerting via PostHog's threshold alerts on those insights. One deliberate consequence: pipeline telemetry and product analytics live in the same tool, so "gate pass-rate by plan tier" or "ingestion completion vs. churn" are single queries, not cross-system joins.

**Event taxonomy (snake_case, one event per lifecycle moment, context in properties):**

- Funnel: `preview_requested`, `preview_served` (`cache_hit`), `signup_completed`, `checkout_started`, `subscription_activated`, `domain_claimed`, `shopify_oauth_granted` / `_abandoned`, `profile_confirmed` — this is the classic PostHog funnel from lure to activated account.
- Pipeline: `ingestion_step_completed` (`step`, `state`, `duration_ms`, `attempts`), `distillation_completed` (`fact_count`, `fluff_discarded`), `family_grouping_completed` (`family_count`, `grouping_source`, `confidence`), `webhook_processed` (`topic`, `lag_ms`), `reconciliation_swept` (`diff_count`).
- Quality: `gate_decision` (`gate`, `outcome`, `reason_code`, `vertical`, `prompt_version`, `model_id`, per-criterion scores as properties) — §8.5's calibration reporting is a PostHog trend on this one event, broken down by week and vertical.
- Opportunity Engine: `signal_run_completed` (`kind`, `rules_version`, `opportunities_created`, `opportunities_updated`, `opportunities_expired`, `duration_ms`), `opportunity_detected` (`signal_type`, `recommended_action`, `impact`, `confidence`, `limited_intelligence`), `opportunity_status_changed` (`from`, `to`, `actor` ∈ user | autopilot | expiry), `optimize_recommendation_generated` (`page_type`, `judge_scores`, `cache_hit`), `opportunity_outcome_measured` (`action_type`, `label`) — the §16 metrics are trends over these, broken down by `rules_version` for the weekly calibration review (§7.10).
- Cost: **all LLM calls are tracked through PostHog's built-in LLM analytics** — we wrap the Anthropic client with the PostHog SDK's LLM observability integration so every call auto-captures `$ai_generation` with model, input/output tokens, latency, and cost (`$ai_total_cost_usd`), rather than a hand-rolled event. Requirements on top of the default capture: (1) **every call site goes through one shared instrumented client wrapper** — constructing a raw Anthropic client anywhere else fails code review/lint, so no call can escape tracking; (2) each capture carries `call_type` (distill | persona | seeds | judge | preview | intent_gap | optimize_reco), `prompt_version`, and `cache_hit`; (3) replays served from `request_cache` (§14.3.6) are captured with `cache_hit: true` and **zero cost**, so cached work doesn't inflate spend numbers. **DataForSEO cost is equally visible in PostHog**, as our custom event (it's a plain HTTP API, outside the `$ai` integration): the `SeoDataProvider` wrapper (§12.1) captures `dataforseo_request` (`endpoint`, `billable`, `cache_hit`, **`usd_cost`**) on every call, where `usd_cost` comes from a config table mapping endpoint → unit price (DataForSEO bills different amounts per endpoint — SERP vs. keyword-data vs. ranked-keywords); cache hits capture `usd_cost: 0`. The price map is config, reviewed when DataForSEO changes pricing. `article_cost_finalized` (`usd_total`) stamps the all-in cost when an article ships. "True cost per domain" is therefore always LLM + DataForSEO, never LLM-only.
- **Everything is groupable by domain.** PostHog group analytics with a `domain` group type (`group key = domain_normalized`), attached to every event above — LLM captures included via the wrapper. Since an account has exactly one domain (§2), account and domain groups coincide once connected, but `domain` is the canonical group key because it's what cost questions are asked about: "how much is site X costing us" must be answerable as a single PostHog insight — `$ai_total_cost_usd` + `dataforseo_request.usd_cost`, summed, broken down by `domain` group, trended over time.
- **Preview attribution rule — property, not group.** Unregistered preview spend is fully tracked (preview LLM calls go through the same instrumented wrapper, `call_type: preview`), but the **domain group is reserved for claimed domains**: ten strangers previewing `nike.com` is not Nike-the-account costing us money. Preview events (`preview_requested`, `preview_served`, and preview `$ai_generation` captures) carry `target_domain` as a plain property instead. Consequences: (a) pre-signup spend on a domain is queryable by property, and when that domain later connects, its full history including the lure cost is visible; (b) the preview program is measured on its own economics: **total preview spend/day** (the abuse canary — Turnstile + rate limits + cache should keep it near-flat; a spike means the cache or Turnstile is being defeated), **preview cache-hit rate** (the entire §3.2 cost model assumes it's high), and **cost per acquired signup** (preview spend ÷ funnel `signup_completed` — the actual "is the lure worth it" number).
- A saved "cost per domain" dashboard (top spenders, cost per published article by domain, spend vs. plan price, LLM/DataForSEO split) and a "preview economics" dashboard (the three metrics above) are launch scope. The §14.5 budget auto-trips read spend from our own DB counters — PostHog displays cost, our code enforces caps (same control-plane boundary as below).
- Publishing & failures: `publish_intent_created` / `_confirmed` / `_abandoned`, `dlq_entry_created` (`step`, `error_class`), `kill_switch_tripped` (`flag`, `tripped_by`, `reason`).
- All events carry `account_id` and the `domain` group (see Cost above), plus `job_id` and `prompt_version` where applicable. Error tracking uses PostHog's exception capture with the same properties.

**Alerts = PostHog insight alerts, thresholds mirroring §14.5's auto-trips** so humans see what the code acts on: judge fail-rate trend > 60%, publish `_abandoned` count > 0, `dlq_entry_created` sustained > 1h, `webhook_processed` p95 `lag_ms` > 1h, `reconciliation_swept` `diff_count` > 5× median, daily `$ai_total_cost_usd` per domain over cap, **daily preview spend over its own cap** (previews have no domain group to trip on, so this is an independent alert), and daily global spend over cap. Alert delivery to the ops channel (Slack/email via PostHog destinations).

**Dashboards and alerts are provisioned as code — never clicked together by hand.** All insights, dashboards ("cost per domain", "preview economics", funnel, calibration report), alert definitions, and the `domain` group type are created and updated via the **PostHog API/admin SDK or the PostHog MCP server**, from definition files versioned in the repo, applied idempotently by a setup script that runs in CI/deploy (create-or-update by a stable key, so re-running converges instead of duplicating). Rationale: hand-built dashboards drift, can't be code-reviewed, and can't be recreated when a PostHog project is reset or a staging environment is spun up. A dashboard that isn't in the definition files doesn't officially exist; ad-hoc exploration in the PostHog UI is fine, but anything the team relies on gets promoted into the repo.

**The one boundary to respect:** PostHog is telemetry and alerting, **not** the control plane. Auto-trip *enforcement* (§14.5) runs in our code against our DB (`ops_flags`) — a kill switch must work when PostHog is down or events are sampled/delayed. PostHog observes trips; it never causes or gates them. Same for the weekly calibration review: the report is a saved PostHog insight, but threshold changes are code changes that go through the eval suite (§14.2).

**Privacy note:** events carry ids and aggregates only — never product content, article text, prompts, or anything customer-derived (consistent with §14.6's "no customer data held" posture). Turn off PostHog session replay on any view that renders store data, or mask it.

## 15. Cost & abuse controls (recap)

Preview: Turnstile + IP rate limits + 7-day cache + Haiku + tiny token budgets. Ingestion: runs once per domain claim; **Haiku** for product distillation (batched, cached per product, refreshed only on product change); family clustering is deterministic (taxonomy + fact comparison) with embeddings only as a flagged fallback; **Sonnet** for the persona call, seed-keyword derivation, article drafting, and the Gate 3 judge (judge always runs on the full-strength model — never downgraded, §14.4). Steady-state generation cost is bounded by the 1/day cap (§4.2) plus the single repair loop. DataForSEO: cached, job-side only; the 5-competitor cap bounds per-account spend. Quality gates are ordered cheapest-first so most rejections cost nothing (Gate 1 is pure data checks; the LLM judge only runs on drafts that survived everything else, with a single repair loop max). All LLM calls carry per-account daily budget guards.

**Opportunity Engine:** signal detection is SQL over data we already hold (GSC tables, content inventory, catalog) — zero marginal cost; SERP checks are spent only on top-ranked candidates (§9.6.4 ordering); the only LLM spend is intent-gap analysis on shortlisted pages (cached by page checksum × SERP snapshot, §10.3) and user-initiated OPTIMIZE recommendations (capped per day, §10.2). GSC, URL Inspection (P1), and the Admin-API content inventory are free reads.

## 16. Metrics & product analytics

All of these are PostHog insights over the event taxonomy in §14.7 (plus the opportunity events added there); none is a new system. Listed here so the product-level definition is agreed before the first dashboard is provisioned as code.

**Activation funnel:** % signup → Shopify connected; % Shopify connected → store analysis complete; % connected → GSC connected; % connected → **first opportunity viewed**; % opportunity viewed → **first action executed/approved**; time to first meaningful opportunity. (The acquisition funnel `preview → signup → checkout → domain → oauth → profile_confirmed` ends in `opportunities_ready` and `opportunity_viewed`.)

**Core product usage:** growth opportunities found / store / month; high-confidence opportunities executed / store / month; CREATE vs OPTIMIZE vs FIX vs REFRESH mix; auto-publish adoption; draft-review adoption; rejection rate and reason codes; user override rate ("publish anyway").

**Quality / SEO outcome:** % published pages indexed/visible (P1, needs URL Inspection); 28+-day winner / neutral / underperformer distribution (§9.6.2); organic clicks/impressions trend; ranking movement; **CTR improvement after OPTIMIZE** and **decay recovery after REFRESH** (§9.6.10).

**Business:** MRR/ARR; logo and revenue churn; gross margin per account; **AI + search-data cost per account** (the "cost per domain" dashboard, §14.7); organic / influenced revenue once reliable (§17); payback/CAC by channel later.

---

## 17. Roadmap: V1 → V1.5 → V2

| Phase | Scope |
|---|---|
| **V1 — Prove the loop** | Shopify read/write; store intelligence (facts, families, richness, persona); GSC soft-required with Limited Intelligence mode; SERP/search data; Growth Opportunities (P0 signals); CREATE content automation through the full gate pipeline; OPTIMIZE recommendations; limited FIX; calendar; publishing; learning; repair; billing/lifecycle. Everything in this document not marked P1/V1.5/V2. |
| **V1.5 — Become the Growth OS** | Deeper existing-page optimization (P1 signals; direct application of recommendations under a separate write grant, if merchants ask); **AI visibility tracking**; **Shopify revenue reporting**; basic schema/product-visibility checks; larger technical opportunity set (URL Inspection, internal-link crawler); improved opportunity scoring (per-store threshold overrides, effort estimates). |
| **V2 — Ecommerce organic platform** | Merchant Center; revenue-based prioritisation; technical execution; AI citation/source intelligence; off-site opportunities; agency/multi-store; additional commerce connectors (WooCommerce, Shopware). |

**17.1 AI visibility (V1.5/V2 minimum).** Not a vanity score: tracked *commercial* prompts; brand/product mention rate; citation rate and cited sources; competitor share of voice; platform breakdown (ChatGPT, Gemini, Perplexity, Google AI where measurable); multiple runs + stability logic for nondeterministic answers. It is **not a separate dashboard island** — a competitor consistently present in an important prompt creates an *opportunity* (content gap, entity/source gap, product-information gap, later off-site citation), through the same §7 object.

**17.2 Merchant Center / Google commerce (V1.5/V2).** Feed completeness/quality; title/description quality; GTIN/brand/variant/availability/price consistency; feed errors and product visibility issues; product structured-data consistency; later recommendation + execution. Positions Sortiva as a Google-commerce growth layer, not a content-SEO tool.

**17.3 Revenue layer.** Revenue means **net product sales**: the units a buyer still holds after refunds, at the price after every discount, with tax, postage and gift cards excluded (decided 2026-09-12). V1 **captures** the data (the landing page of the visit that led to each order, aggregated per store-calendar day per landing URL into `landing_revenue_daily` — aggregates only, no customer fields, consistent with §14.6) but **shows no revenue at launch** (recommended; Appendix B): measurement trust is critical and early fake precision is worse than clicks. V1.5 shows *organic revenue* and *revenue on Sortiva-created pages* labelled "influenced/attributed" — never "incremental" — and a later "estimated incremental" model is a separate, explicitly-labelled concept.

---

## 18. Explicitly out of scope for V1

| Not in V1 | Why |
|---|---|
| AI image generation (articles use catalog product images only, §9.2) | Not core growth value; extra quality and cost risk. |
| In-app article or page editor | Shopify already is the editor; review is a one-decision surface (§9.3). |
| Direct edits to collection/product/page content (OPTIMIZE auto-apply) | Recommendation-only is lower risk (§10.1); revisit in V1.5. |
| Multiple pricing tiers / usage-based pricing | Launch simplicity; single Stripe tier (§4.2). |
| WooCommerce / Wix / Magento / Shopware connectors | Shopify PMF first; internal model stays platform-neutral (§1.4). |
| Team / multi-user / agency mode, multi-store | Later distribution lever, once single-store PMF is proven. |
| Manual product-family split/merge/rename editor | Whole UI surface; "report wrong grouping" is enough (§6.4). |
| Full technical-SEO crawler / site audit | Scope explosion and a commoditised feature; only the §11 light layer. |
| Full AI-visibility suite; Merchant Center execution | V1.5/V2 (§17). |
| Precise incremental revenue attribution | Reliable *attributed* revenue first (§17.3). |
| Domain ownership verification (DNS/meta) | Shopify OAuth and GSC effectively prove it; pure-scrape accounts get no write access anyway (§5). |
| ML-based opportunity/topic scoring | V1 learning loop is rule-based (§9.6); every input is logged for later. |
| Dollar-value impact estimates on opportunities | High/Medium/Low + raw evidence numbers in V1 (§7.6). |

---

## 19. Engineering acceptance criteria (V1 is done when…)

**Store intelligence & onboarding**

1. After a Shopify read-only connect, Sortiva builds a real store/catalog profile with **no scraping fallback** (§6.2).
2. Product facts and product families exist as a layer and are shown on the review screen (§6.3–6.4, §6.8).
3. The user can connect GSC; without it, **Limited Intelligence** is clearly indicated on the Opportunities screen and dashboard (§7.11).

**Opportunity Engine**

4. The system creates structured opportunity objects for every P0 signal (§7.3), each with ≥ 1 traceable evidence source, impact, confidence, a deterministic "why", and a recommended action (§7.6).
5. Action selection is a separate logical step from signal detection; from the same signal, at least two distinct action paths are supported where the business logic warrants it (§7.8 examples 1–8 exist as passing fixtures).
6. **Before any CREATE, the existing-target / intent-overlap check runs** (§7.7) and converts to OPTIMIZE when a suitable URL exists.
7. A blocked opportunity receives HOLD status and a concrete merchant task (§7.9); after the underlying data changes, it is re-evaluated automatically.
8. An existing-page opportunity displays a true "why" based on GSC/search data (§7.1, §7.12).
9. GSC data is used in opportunity discovery, not only in reporting (§7.5, §12.2).
10. Thresholds/config/scoring parameters are centrally changeable without scattered code changes; every opportunity is stamped with `rules_version` (§7.10).
11. After execution, an outcome can be attached to the same opportunity for learning (§9.6.10).

**Content engine & publishing**

12. A CREATE opportunity enters generation only when every pre-write gate condition holds (§8.2–8.3).
13. Drafts pass through the separate blind judge; on rejection, a concrete reason is shown (§8.4, §8.6).
14. The publish quota never forces content; an empty day is a legitimate state (§8.7, §9.1).
15. Export mode works with no write permission; auto-publish works only after a separate explicit Shopify write grant (§9.5).
16. Calendar delete/drag/pin/add behave deterministically as specified (§8.7).
17. Every published article's product references are tracked for repair (§14.1).
18. Pages younger than 28 days receive no performance verdict (§9.6.2).

**Lifecycle & resilience**

19. Payment failure immediately stops costly generation; history and read access never disappear (§4.2).
20. On provider outage there is no silent model downgrade and no stale-data publish (§14.4).
21. The nightly chaos test passes: every step converges, exactly one remote article per external id, billable-call count equals distinct canonical requests (§14.3.9).

---

## 20. Anti-patterns & forbidden shortcuts

| Avoid | Correct direction |
|---|---|
| "We must publish every day." | No. Quality permitting; a gap is legitimate (§8.7). |
| "A new article for every keyword." | No. Existing URL and intent check first (§7.7). |
| "Scrape without Shopify and run the same." | Not in V1. The Shopify connector is part of trust and data quality (§6.2). |
| "GSC is just a chart on the Performance page." | No. Opportunity-discovery input (§7). |
| "An average judge score is enough." | No. Critical dimensions have separate minimums (§8.4). |
| "If a provider fails, use a weaker model." | No. Pause, never degrade (§14.4). |
| "Let's build our own editor." | Not V1. Shopify's editor is enough (§9.3). |
| "Count user-override results in our quality claims." | No. Flag and exclude (§8.6). |
| "Technical SEO = a 200-issue report." | No. Only action-oriented ecommerce opportunities (§11). |
| "Revenue = attribute all growth to Sortiva." | No. Attributed/influenced and estimated incremental are separate concepts (§17.3). |
| Every opportunity's output is automatically an article. | No. Five action types; content is one of them (§7.4). |
| Treat the signal name as the action. | No. Action selection is its own step with its own inputs (§7.5). |
| Treat cannibalization as an error without validation. | No. Validate intent, alternation, and loss first (§7.3). |
| Use one universal CTR benchmark for every query/SERP. | No. The store's own fitted curve (§7.3). |
| Hide the evidence. | No. User and support must be able to trace why an opportunity exists (§7.6). |
| Auto-fix anything risky at theme/custom-code level. | No. Recommendation only (§11). |
| Promote query-level SERP ranking domains into the competitor list automatically. | No. Suggest only; one user-managed list, separate storage (§7.2.1). |
| Scatter scoring thresholds through the code. | No. Configuration layer (§7.10). |


---

## Appendix A — Key UI copy (canonical strings)

| Surface | Wording | Why |
|---|---|---|
| Landing preview teaser | *See your organic growth opportunities →* | Don't position the product as a "content plan". |
| Pricing cap (verbatim everywhere) | *Up to 1 article per day, quality permitting* | A quality promise, not a count guarantee. |
| GSC connect | *Connect Google Search Console to unlock full Growth Intelligence* | Shows it isn't mere reporting. |
| Limited mode badge | *Limited Intelligence — connect Search Console to see real query and page opportunities* | Transparent, non-blocking. |
| Opportunity headline | *We found {N} ways to grow your store organically* | The core value proposition. |
| Existing-page action why-line | *You already rank for this. Improving the existing collection is safer than creating another page.* | Anti-cannibalization; expert behaviour. |
| Quality rejection (richness) | *We held this topic back because the store does not contain enough factual product information yet.* | The system protects the merchant's interests. |
| Outage | *Delayed — we paused this action rather than continue with lower-quality or stale data.* | Trust; no silent degradation. |
| Shopify read-only trust copy | *Read-only — we can't change anything in your store with this permission. Auto-publishing is a separate optional setting you control later.* | The main reason users hesitate (§6.2). |
| Not-Shopify parked state | *This doesn't look like a Shopify store. We currently support Shopify only — contact us for a custom solution or join the waitlist.* | Keeps the claim; leaves a way back. |
| Cancellation facts | *Your published articles stay on your store. Generation stops at the end of your billing period. You keep read access to everything.* | §14.6; stated wherever cancellation is offered. |

## Appendix B — Decisions requiring founder sign-off (with the defaults this spec assumes)

| Decision | Options | Default assumed here | Rationale |
|---|---|---|---|
| GSC at onboarding | Soft-required vs hard-required | **Soft-required + Limited Intelligence mode** (§6.7, §7.11) | Less friction; the merchant sees base value without it, and the badge makes the upgrade path obvious. |
| V1 OPTIMIZE execution | Recommendation/export vs direct Shopify edit | **Recommendation + suggested copy** (§10.1) | Lower risk, no extra write scopes on merchant-authored pages, faster scope. Direct apply is a V1.5 candidate. |
| V1 revenue display | Show organic revenue at launch or not | **Capture from day one, display in V1.5** (§17.3) | Strong ecommerce value, but measurement trust is critical. |
| Technical FIX scope in V1 | Which 3–5 issues | **Decided: broken product refs (auto), cannibalization (recommend), missing/duplicate title-meta (recommend)** (§11) | Prevents scope creep; everything else P1 with detection first. |
| Opportunity impact display | $ estimate vs High/Medium/Low | **High/Medium/Low + evidence numbers** (§7.6) | Dollar estimates are strong UX but early fake precision is dangerous. |
| Competitor model | Single list vs 5 business + SERP competitors | **Decided: one user-facing list (cap 5) with SERP-derived suggestions; SERP ranking domains stay internal** (§7.2.1) | One mental model for the merchant; the cap and cost controls are untouched. |
| OPTIMIZE generation cap | Uncapped vs N/day | **2 per account per day, config** (§10.2) | Bounds LLM spend on a user-initiated action without making it feel rationed. |
| Primary navigation | 8 screens (incl. separate Google + AI Visibility) vs 6 | **6: Dashboard, Opportunities, Content, Products, Performance, Settings**; GSC explorer is a tab inside Performance; AI Visibility appears when V1.5 ships | Fewer surfaces to build; mobile tabs stay sane. (UI spec §1) |
| Launch price | $89 vs higher | **$89/mo, annual −20%** (§4.2) | Good for PMF search; not final — with AI visibility, revenue intelligence, technical execution and Merchant Center the product belongs in a $149–$399+ band. Price IDs are config, so repricing is a Stripe change. |
