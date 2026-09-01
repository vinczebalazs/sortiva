# Sortiva Content Engine — Product & Functional Specification

**v2.0.** Replaces `content-spec.md` v1.0 in full. v1 was an editorial standard for an article
writer; this is the specification of an **execution module inside the Growth Engine**. What carried
over, what was deliberately reversed, and why, is Appendix A.

---

## How to read this document

**Authority.** `functional-spec.md` remains authoritative for the system as shipped today. This
document is authoritative for the Content Engine's target design, and where the two disagree, this
one describes where we are going and `functional-spec.md` describes where we are. On mechanics —
column names, thresholds, schema shapes — the code wins, and every number here names the file it
came from so a drift is findable.

**Status markers.** Every capability in this spec carries one. A specification that does not
distinguish between what runs and what is planned is not implementable, it is a wish.

| Marker | Meaning |
|---|---|
| **[SHIPPED]** | Exists in the codebase today, at the named file |
| **[EXTEND]** | Exists but must be widened; the current shape is named |
| **[BUILD]** | Does not exist. New table, package, or stage |
| **[BLOCKED]** | Cannot be built until an external prerequisite is met; the prerequisite is named |

The full gap register — every **[BUILD]** and **[BLOCKED]** item with its dependency — is
Appendix B. Read it before estimating anything.

**The governing principle.**

> Sortiva must never optimize for producing more content. It must optimize for producing the right
> organic growth action. And when that action is content, Sortiva must publish only evidence-backed
> ecommerce content that it can defend, measure, and maintain over time.

Every rule below is downstream of that sentence. A rule that conflicts with it is wrong.

---

## 1. Purpose

### 1.1 What the Content Engine is

The Content Engine is the **execution module for CREATE and REFRESH content actions** issued by the
Growth Opportunity Engine. It also lends its research and writing components to OPTIMIZE actions,
which modify an existing asset rather than producing a new one.

It is not an AI blog writer. The distinction is not marketing: it is a constraint on the interface.
An AI blog writer accepts a topic and returns prose. The Content Engine accepts an **opportunity
with evidence** and returns either a **defensible content asset with provenance**, or a **structured
refusal**.

### 1.2 What it optimizes for

Not traffic. Not word count. Not articles shipped.

> **Does this help a shopper make a better purchase decision, on a query where we can win, using
> facts we can defend?**

Four clauses, all load-bearing. Drop *purchase decision* and it is a content farm. Drop *can win* and
it is wasted spend. Drop *facts we can defend* and it is a liability on the merchant's own domain.

### 1.3 What it must never do

| Never | Because |
|---|---|
| Generate content without an opportunity context | Untraceable output cannot be measured, learned from, or defended |
| Create a new URL when a suitable one exists | Self-cannibalization; the merchant's own page loses to our new one, or neither ranks |
| State an unsupported numeric or factual claim | A wrong specification on a merchant's domain is a returns problem, not an SEO problem |
| Write a literal price, stock level, or product URL into prose | It is correct at publish and wrong a week later, with nothing changing on our side |
| Publish because a slot in the calendar was empty | §28 of the product brief: quality permitting. "No publish" is a successful outcome |

### 1.4 Success and failure are both outputs

The Content Engine has three terminal states, and only one produces an article:

```
PUBLISHED   — asset created, provenance stored, performance tracking armed
HOLD        — cannot produce defensible content yet; retry condition stated and machine-readable
REJECTED    — this opportunity should not produce content at all; recommendation redirected
```

`HOLD` and `REJECTED` are not errors. They do not increment failure counters, do not page anyone, and
are surfaced to the merchant as findings with a fix. A run that ends in `HOLD` because the catalogue
lacks the material data to write a buying guide has done its job correctly.

---

## 2. Role inside the Growth Engine

### 2.1 The pipeline the Content Engine sits in

```
STORE DATA ─┐
SEARCH DATA ─┤
SERP DATA   ─┼──> SIGNALS ──> EVIDENCE ──> GROWTH OPPORTUNITY ──> ACTION
CONTENT DATA ┘                                                       │
                                                                     ▼
                            ┌────────────────────────────────────────────────┐
                            │  CREATE   OPTIMIZE   REFRESH   FIX             │
                            └────────────────────────────────────────────────┘
                                 │         │          │
                                 ▼         ▼          ▼
                            ┌────────────────────────────────┐
                            │      CONTENT ENGINE            │  ◄── this document
                            │  research → write → validate   │
                            └────────────────────────────────┘
                                            │
                                            ▼
                                    TASKS ──> EXECUTION ──> OUTCOME ──> LEARNING
                                                                           │
                                            ┌──────────────────────────────┘
                                            ▼
                                   feeds SIGNALS on the next cycle
```

The Content Engine owns the boxed region only. It does not decide *whether* an opportunity deserves
content — that decision arrives as input. It does decide, and must be able to decide, that the
decision it was handed **can no longer be executed**, and to say so.

### 2.2 The four actions

| Action | Trigger | Content Engine role |
|---|---|---|
| **CREATE** | Genuine coverage gap; no suitable existing URL | Full pipeline. Produces a new asset |
| **OPTIMIZE** | A suitable URL exists and underperforms | Lends research + claim model + validation; produces an **edit plan** against an existing asset, never a new URL |
| **REFRESH** | Content that worked is decaying, or its catalogue references went stale | Diagnosis first, then a scoped rewrite. §12 |
| **FIX** | Technical or structural defect | Not the Content Engine. Named here so the boundary is explicit |

### 2.3 The CREATE gate — six checks, and who runs them

CREATE is the only action that mints a URL, and a wrongly minted URL is the most expensive mistake
this system can make: it is permanent, it competes with the merchant's own pages, and removing it
later costs more than never creating it.

So CREATE is gated by six checks. **The Growth Opportunity Engine runs them at decision time. The
Content Engine re-runs the two cheap, volatile ones at execution time**, because a plan item can sit
for days between decision and execution while the site changes underneath it.

| # | Check | Question | Run at decision | Re-run at execution |
|---|---|---|---|---|
| 1 | `existing_url_check` | Does a page on this site already serve this intent? | ✅ | ✅ **re-run** |
| 2 | `intent_overlap_check` | Does an existing page's ranked intent overlap this query? | ✅ | ✅ **re-run** |
| 3 | `cannibalization_check` | Would this new URL compete with an existing one? | ✅ | ✅ **re-run** |
| 4 | `catalog_substance_check` | Do we have enough concrete product data to say anything specific? | ✅ | ✅ **re-run** |
| 5 | `search_demand_check` | Is there real demand? | ✅ | — |
| 6 | `winnability_check` | Can this site plausibly rank here? | ✅ | — |

Checks 5 and 6 are not re-run: their inputs move on a monthly cadence and re-querying them per
article is spend without signal.

**The stop rule is absolute:**

```
if existing_url_check finds a suitable URL:
    CREATE          → STOP
    outcome         → REJECTED
    reason_code     → SUITABLE_URL_EXISTS
    recommendation  → OPTIMIZE, targeting <that URL>
```

This is the single most important rule in the document, and it is the one a content system will
violate by default, because every incentive inside a generation pipeline points at generating.

### 2.4 What "suitable" means

`existing_url_check` is not a URL-string comparison. A URL is **suitable** when all three hold:

1. **Intent match** — the existing page serves the same search intent (`gap-analysis` classifies the
   SERP's intent; the existing page's type is known from `content_inventory.source` and
   `is_commercial`).
2. **Topical proximity** — cosine similarity between the opportunity's query embedding and the
   page's `content_inventory.embedding` clears `SUITABLE_URL_SIMILARITY` (0.72 proposed; requires
   calibration against real sites before it is fixed).
3. **Not structurally disqualified** — the page is not `is_missing`, and its type can serve the
   intent. A product page cannot serve a comparison intent regardless of similarity.

**[EXTEND]** — `content_inventory` has the embeddings and the commercial flag today
(`packages/db/src/schema/tables.ts:734`). It has no page-type classification beyond `is_commercial`,
and the intent dimension has to be added for check 2 to mean anything.

### 2.5 The product narrative constraint

This is a UI and positioning rule with an architectural consequence, so it belongs in the spec
rather than in a brand document.

The Content Engine's output is never the headline of the product. A merchant does not buy "30
articles" or "an AI writer"; they buy **Growth Opportunities**, and content is one of four ways an
opportunity gets executed. The content calendar is a module view, not the home screen.

The architectural consequence: **every content asset must be reachable from its opportunity, and
every opportunity must be reachable from its outcome.** Any design that produces an article whose
originating opportunity cannot be named has broken the product, not just the data model.

---

## 3. Inputs

### 3.1 The task contract

The Content Engine accepts exactly one input shape. There is no second entry point, no "just write
about X" path. Merchant-requested topics enter through the same door with a synthesized opportunity
(§3.3).

**[BUILD]** — `ContentTask` in `@sortiva/types`.

```ts
interface ContentTask {
  task_id: string;
  site_id: string;

  /** Non-null, always. There is no opportunity-free generation path. */
  opportunity: OpportunityContext;

  /** What the Growth Engine decided. The engine may downgrade it, never upgrade it. */
  action: 'CREATE' | 'OPTIMIZE' | 'REFRESH';

  /** Required for OPTIMIZE and REFRESH; must be null for CREATE. */
  target_asset: {
    url: string;
    article_id: string | null;      // null when the asset predates Sortiva
    current_body_md: string | null;
  } | null;

  locale: {
    language_code: string;           // ISO 639-1
    country_code: string;            // ISO 3166-1 alpha-2
  };

  /** Set only by REFRESH; §12. Absent means "not a refresh". */
  refresh_diagnosis: RefreshDiagnosis | null;

  /** Set only by the dedup differentiation regen. Carries the cap; see §14.4. */
  differentiation_instruction: string | null;

  constraints: {
    excluded_topics: string[];       // SHIPPED: excluded_topics table
    max_cost_cents: number;
    deadline_at: string;             // ISO 8601
  };
}
```

```ts
interface OpportunityContext {
  opportunity_id: string;
  signal_type:
    | 'coverage_gap'          // demand exists, no page serves it
    | 'striking_distance'     // an existing page sits 5–20 and could move
    | 'decay'                 // a page that worked is losing ground
    | 'catalog_change'        // products referenced by an asset changed
    | 'cannibalization'       // two pages compete for one intent
    | 'merchant_request';     // §3.3

  affected_query: string;
  affected_entity: {
    kind: 'query' | 'url' | 'product_family' | 'collection';
    id: string;
  };

  /** Why the Growth Engine believes this. Carried into the Evidence Pack unchanged. */
  evidence: OpportunitySignalEvidence[];

  impact: {
    estimated_monthly_sessions: number | null;
    commercial_weight: number;        // 0–1, how close to purchase
  };
  confidence: number;                 // 0–100
  reason: string;                     // one line, merchant-readable
  recommended_action: 'CREATE' | 'OPTIMIZE' | 'REFRESH' | 'FIX';
  decided_at: string;

  /** The six checks, as they stood at decision time. Re-verified per §2.3. */
  create_gate: CreateGateResult | null;
}
```

**[BUILD]** — none of this exists as a persisted entity. Discovery scores opportunities today
(`runOpportunityRefresh`, `packages/discovery`) but materializes them directly into `plan_items`
rather than into a first-class `opportunities` table. Appendix B.

### 3.2 The engine may downgrade, never upgrade

If execution-time re-verification (§2.3) invalidates a CREATE, the engine emits `REJECTED` with a
redirect recommendation. **It never converts a CREATE into a REFRESH, or an OPTIMIZE into a CREATE,
on its own authority.** Escalating an action is the Growth Engine's decision, made with signals the
Content Engine cannot see.

### 3.3 Merchant-requested content

A merchant can ask for a topic directly. That request is converted into a synthesized
`OpportunityContext` with `signal_type: 'merchant_request'` and `confidence: null`, and then **runs
every gate unchanged**.

Two things follow, and both need to be visible in the UI:

- A merchant request can be `REJECTED` — most often by `existing_url_check`. The correct product
  response is to show them the existing URL and offer OPTIMIZE.
- A merchant request can be `HOLD`ed for insufficient catalogue data, with the same fix instructions
  any other hold produces.

Merchant intent changes the priority of a task. It does not change the evidence bar.

---

## 4. The Evidence Pack

### 4.1 What it is

The Evidence Pack is **the writer's entire permitted knowledge base**. It is assembled before any
writing stage runs, it is persisted, and it is the closed world the draft is written against.

The rule that makes it worth building:

> If a fact is not in the Evidence Pack, it may not appear in the article — regardless of whether
> the model knows it to be true.

This is stricter than "do not hallucinate", and deliberately so. "Do not hallucinate" is an
instruction a model can follow imperfectly and nobody can audit. "Only these facts exist" is a
closed set that a validator can check mechanically, one claim at a time.

### 4.2 Structure

**[BUILD]** — `EvidencePack` in `@sortiva/types`, persisted to a new `evidence_packs` table.

```ts
interface EvidencePack {
  pack_id: string;
  task_id: string;
  assembled_at: string;

  opportunity: OpportunityContext;      // §3.1, carried unchanged

  store_facts: StoreFacts;              // §4.3
  search_evidence: SearchEvidence;      // §4.4
  site_knowledge: SiteKnowledge;        // §4.5
  external_evidence: ExternalFact[];    // §4.6, may be empty

  /** What we looked for and did not find. Drives HOLD decisions; §14. */
  gaps: EvidenceGap[];

  /** Cheap sufficiency verdict, computed in code from the four layers above. */
  sufficiency: {
    store_facts_score: number;          // 0–1
    search_evidence_score: number;
    information_gain_potential: number;
    verdict: 'sufficient' | 'thin' | 'insufficient';
  };
}
```

### 4.3 Layer 1 — Store facts

The merchant's own catalogue. **This is the highest-value layer in the pack and the one the current
system is least equipped to supply.**

```ts
interface StoreFacts {
  product_families: ProductFamily[];
  products: ProductFact[];
  collections: CollectionFact[];
  /** Facts about the business itself, from ingestion. */
  business: {
    description: string;
    brand_voice_samples: string[];      // SHIPPED: sites.brand_voice_samples
  };
}

interface ProductFact {
  product_id: string;                   // platform id, stable
  handle: string;
  title: string;
  product_type: string | null;
  vendor: string | null;
  tags: string[];

  /** Structured attributes. The whole point of this layer. */
  attributes: {
    key: string;                        // 'material', 'capacity', 'dimensions'
    value: string;
    unit: string | null;
    source: 'variant_option' | 'metafield' | 'product_type' | 'body_html_extracted';
    confidence: 'high' | 'medium' | 'low';
  }[];

  variants: {
    variant_id: string;
    option_values: Record<string, string>;
    sku: string | null;
    grams: number | null;
  }[];

  /** VOLATILE. Never written into prose. Resolved at publish; §11.3. */
  volatile: {
    price_minor_units: number | null;
    currency: string | null;
    available: boolean | null;
    url: string;
    fetched_at: string;
  };

  /** Merchant's own copy, verbatim. A verification source, never a prompt input. */
  raw_description: string | null;       // SHIPPED: offerings.description
  images: { url: string; alt: string | null }[];
}
```

**Attribute confidence is not decoration.** An attribute parsed out of marketing prose in
`body_html` is `low` confidence and cannot support a `HIGH`-confidence claim (§5.5). One read from a
structured metafield is `high`. The confidence travels with the fact into the claim.

**[BLOCKED] — this layer cannot be built as specified today.** The current Shopify integration
requests one scope, `write_content` (`scripts/shopify-oauth.ts:62`), and product data is read from
the **unauthenticated storefront `/products.json`**. That endpoint supplies title, handle,
`product_type`, vendor, tags, variant options, SKU, grams, price, `available`, and images. It supplies
**no metafields**, no inventory quantity, and no collection membership.

Consequences, stated plainly because they change what V1 can promise:

| Needed for | Requires | Status |
|---|---|---|
| `attributes` from metafields | `read_products` scope + Admin API | **[BLOCKED]** — scope expansion, app review |
| `collections` | `read_products` scope, or storefront `/collections.json` crawl | **[BUILD]** |
| Real `available` | Storefront `available` is per-variant and adequate | **[SHIPPED]** via `/products.json` |
| `attributes` fallback | Extraction from `body_html` + variant options, `confidence: low`/`medium` | **[BUILD]** |

**Until `read_products` lands, V1 runs on variant options plus extracted attributes**, and
`catalog_substance_check` must be calibrated against that weaker input — which will correctly cause
more `HOLD`s on specification-heavy topics. That is the honest behaviour, and it is better than the
alternative, which is inventing the specification.

### 4.4 Layer 2 — Search evidence

```ts
interface SearchEvidence {
  target_query: string;
  demand: {
    monthly_volume: number | null;
    trend: 'rising' | 'stable' | 'falling' | 'unknown';
    related_queries: { query: string; volume: number | null }[];
  };
  serp: {
    snapshot_id: string;                // SHIPPED: serp_snapshots
    fetched_at: string;
    dominant_intent: 'informational' | 'commercial' | 'transactional' | 'navigational';
    intent_confidence: number;
    composition: {                      // what the SERP is made of
      product_pages: number;
      category_pages: number;
      editorial: number;
      marketplaces: number;
      video: number;
      forums: number;
    };
    ranking_pages: {
      position: number;
      url: string;
      domain: string;
      title: string;
      page_type: string;
      is_confirmed_competitor: boolean; // SHIPPED
    }[];
    paa_questions: string[];            // SHIPPED
  };
  /** What the ranking pages agree on, position-weighted. SHIPPED: gap_analysis stage. */
  consensus_subtopics: { subtopic: string; weight: number; positions: number[] }[];
  /** What they all miss. The information-gain seed. */
  observed_gaps: { gap: string; why_it_matters: string }[];
  expected_depth: { min_words: number; max_words: number };
}
```

**[SHIPPED]** in substance — steps 1–3 of the existing pipeline produce almost exactly this
(`packages/pipeline/src/serp.ts`, `fetch-pages.ts`, `research.ts`). What changes is that
`research_brief` becomes one **layer of** the Evidence Pack rather than the whole brief.

**One rule carries over unchanged from v1 and must not be softened:** the SERP layer is a
*measurement*. The gap-analysis stage may describe only what is in the pages it read. It may not add
subtopics from the model's own knowledge, however correct. A measurement with extra readings in it
is not a measurement.

### 4.5 Layer 3 — Site knowledge

```ts
interface SiteKnowledge {
  existing_urls: {
    url: string;
    title: string;
    source: 'platform_existing' | 'sortiva_generated' | 'product' | 'collection';
    is_commercial: boolean;             // SHIPPED
    similarity_to_target: number;
    /** Per-query GSC. See the [BLOCKED] note. */
    ranks_for_target: { position: number; impressions: number; clicks: number } | null;
  }[];
  internal_link_candidates: LinkCandidate[];   // SHIPPED: links.ts, pgvector top-10
  overlap_risks: {
    url: string;
    risk: 'cannibalization' | 'partial_overlap' | 'supersedes';
    similarity: number;
  }[];
  /** Prose already published on this site; feeds the reuse check. SHIPPED. */
  published_bodies_digest: string[];
}
```

**[BLOCKED] — `ranks_for_target` cannot be populated today.** `@sortiva/search-console` queries
Search Analytics with `dimensions: ['date']` only, deliberately, to produce a per-site aggregate
(`packages/search-console/src/client.ts`). There is **no per-query, per-page data in the system.**

That single limitation disables, or degrades to guesswork, all of the following:

- `existing_url_check` beyond embedding similarity
- `cannibalization_check` in its real form
- `striking_distance` opportunities entirely
- `decay` diagnosis in §12
- The learning loop's per-query verdicts in §13

**This is the highest-leverage unblock in the entire specification.** It requires adding a
`dimensions: ['query', 'page']` sync and a `search_console_query_metrics` table. Nothing else in
Appendix B unlocks as much.

Until it lands, `existing_url_check` runs on embedding similarity plus intent classification alone,
and the spec's §2.4 threshold must be set conservatively — **a false "suitable URL exists" costs one
skipped article; a false "no suitable URL" costs a permanent cannibalizing page.** Bias toward
REJECTED.

### 4.6 Layer 4 — External evidence

Optional, off by default in V1, and never a substitute for the first three layers.

```ts
interface ExternalFact {
  fact_id: string;
  claim_text: string;          // the exact assertion, not a summary
  source_name: string;
  source_url: string;
  source_tier: 'standards_body' | 'manufacturer' | 'academic' | 'trade_publication' | 'other';
  fetched_at: string;
  confidence: 'high' | 'medium' | 'low';
  quote: string;               // verbatim supporting passage
}
```

Rules:

- **A competitor page ranking in the SERP is not a source.** It is a measurement of what competitors
  say. Copying a competitor's opinion as fact is explicitly banned (§7.6), and it is the most common
  way a research-driven writer launders an unsupported claim.
- `source_tier: 'other'` supports `LOW` confidence only, which per §5.5 means the claim should
  usually not be written.
- Every external fact carries a verbatim `quote`. A fact without one cannot be verified later, and
  §12's staleness check has nothing to re-verify against.

### 4.7 Evidence gaps

```ts
interface EvidenceGap {
  needed_for: string;                   // 'material comparison', 'sizing guidance'
  missing: 'product_attribute' | 'external_fact' | 'search_data' | 'site_page';
  detail: string;
  blocks_content: boolean;              // true → HOLD candidate
  merchant_fix: string | null;          // actionable, specific
}
```

Gaps are first-class output. A pack that reports "we needed material data for 6 of these 14
products and have it for 2" produces a better merchant experience than one that quietly writes
around the hole — and it is the input to the `INSUFFICIENT_PRODUCT_DATA` hold in §14.

---

## 5. The claim model

### 5.1 Why claims are a data structure

v1 protected against fabrication with a regex backstop over the finished prose: scan for
number-shaped tokens, check each against the fetched pages, strip what fails
(`packages/pipeline/src/fabrication.ts`, `quality-gate.ts`). That works, and it should stay as a
final net. But it is a **detector**, and a detector has two structural weaknesses: it cannot see a
fabricated claim that contains no number, and it can only ever delete, never fix.

The claim model inverts it. **Claims are planned before the draft exists**, each bound to its
evidence. The writer's job becomes expressing an approved set of claims well, rather than producing
prose that is then policed. Fabrication is prevented by construction, and the backstop catches what
slips through the construction.

### 5.2 Claim types

| Type | Definition | Example | Permitted source |
|---|---|---|---|
| `merchant_fact` | A fact about the merchant's own catalogue or business | "The tank is stainless steel." | `StoreFacts` only |
| `external_fact` | A fact about the world | "Stainless steel resists acidic ingredients better than aluminium." | `ExternalFact` only |
| `derived_fact` | A fact that follows **deterministically** from other facts in the pack | "Model B holds more than Model A." | Two or more pack facts + a stated derivation |
| `recommendation` | A judgement about fit | "For a two-person household, the 5-litre model is usually enough." | Must cite the facts it rests on; must be phrased as guidance |

The four are not stylistic labels. They have **different validation rules and different permitted
language**, and conflating them is exactly how a generated article ends up asserting an opinion as a
specification.

### 5.3 The claim record

**[BUILD]** — `Claim` in `@sortiva/types`, persisted to `article_claims`.

```ts
interface Claim {
  claim_id: string;                     // 'c1', 'c2' … stable within an article
  claim_text: string;                   // the assertion, in the article's language
  claim_type: 'merchant_fact' | 'external_fact' | 'derived_fact' | 'recommendation';

  evidence: {
    source: 'shopify_product' | 'shopify_variant' | 'metafield' | 'site_page'
          | 'external' | 'serp_research' | 'derivation';
    source_entity: string;              // product_id, url, fact_id
    source_url: string | null;
    quote: string | null;               // verbatim support where one exists
  }[];

  /** For derived_fact only: which claims it follows from, and how. */
  derivation: {
    from_claim_ids: string[];
    rule: 'numeric_comparison' | 'set_membership' | 'unit_conversion' | 'attribute_presence';
  } | null;

  confidence: 'high' | 'medium' | 'low';
  volatility: 'none' | 'low' | 'medium' | 'high';
  last_verified_at: string;

  /** Set by the writer: where this claim landed. Enables §8's binding check. */
  used_in_sections: string[];
}
```

Provenance is **internal**. It never renders into the published body. But it is stored, it is
queryable, and it is what makes §12's staleness detection and §14's audit possible.

### 5.4 Volatility drives maintenance

| Volatility | Examples | Handling |
|---|---|---|
| `none` | "Stainless steel is corrosion-resistant." | Written as text. Never re-checked |
| `low` | Material, dimensions, capacity | Written as text. Re-verified on catalogue change (§12.3) |
| `medium` | Product range composition, "we carry N models" | Written as text. Re-verified on every refresh |
| `high` | Price, stock, product URL, sale status | **Never written as text.** Product reference only (§11.2) |

The `high` row is the rule that replaces v1's outright ban on prices. Appendix A.2 explains the
reversal.

### 5.5 Confidence governs the language

The strength of an assertion must match the strength of its evidence. This is enforceable because
both sides are represented: the claim carries `confidence`, and the language carries markers a
validator can find.

| Confidence | Permitted phrasing | Example |
|---|---|---|
| `high` | Direct assertion | "The tank holds 20 litres." |
| `medium` | Hedged, scoped, or typical-case | "These models are generally suited to smaller batches." |
| `low` | **Do not write the claim.** Log the gap instead | — |

**Absolute-language allowlist.** The following may appear only in a sentence bound to a `high`
confidence claim, and never in one bound to a `recommendation`:

```
always · never · must · cannot · every · all · the best · the most · the only
guarantees · eliminates · prevents · ensures
```

Also restricted: any numeric threshold ("above X kg"), any duration ("lasts X years"), any rate
("produces X%"). Each requires a `high` or `medium` claim binding and fails validation without one.

### 5.6 The claim plan

Produced **before** drafting, from the Evidence Pack and the outline.

```ts
interface ClaimPlan {
  plan_id: string;
  task_id: string;
  claims: Claim[];
  /** Facts the writer may use for colour but that carry no assertion weight. */
  context_facts: string[];
  /** Claims considered and rejected, with the reason. Feeds the merchant's gap report. */
  rejected_claims: { claim_text: string; reason: 'no_evidence' | 'low_confidence' | 'volatile' }[];
}
```

**The writer may assert nothing outside this plan.** Descriptive prose, transitions, and framing are
free; assertions are not.

### 5.7 Claim binding in the draft

The mechanism that makes §8's grounding check deterministic rather than fuzzy.

The writer emits claim markers inline. They are stripped before render and never reach the reader:

```markdown
The tank holds 20 litres[[c3]], which is enough for a single household batch[[c7]].
```

The render step removes `[[cN]]`. The validator uses them to bind sentence → claim exactly, with no
string matching and no second model call.

**The escape hatch is the check, not the marker.** A model will sometimes forget a marker. So the
factual-grounding validator does not trust markers alone: it independently scans for checkable
content — numbers, units, superlatives, absolute language, attributed statements — and **any
sentence containing checkable content with no marker is a failure**. Forgetting a marker fails
closed, which is the only acceptable direction.

---

## 6. Research pipeline

Six stages. R1–R3 are cheap and mostly shipped; R4–R6 are new and are where the design's value sits.

| Stage | Name | Model? | Status | Output |
|---|---|---|---|---|
| R1 | `action_reverification` | no | **[BUILD]** | Re-run checks 1–4 (§2.3) |
| R2 | `serp_acquisition` | no | **[SHIPPED]** `serp.ts` | `serp_snapshot` |
| R3 | `competitor_fetch` | no | **[SHIPPED]** `fetch-pages.ts` | `fetched_pages` |
| R4 | `search_synthesis` | cheap | **[EXTEND]** `research.ts` | `SearchEvidence` |
| R5 | `store_facts_assembly` | no | **[BUILD]** | `StoreFacts` |
| R6 | `evidence_pack_assembly` | no | **[BUILD]** | `EvidencePack` + sufficiency verdict |

### 6.1 R1 — Action re-verification

Runs first, before any spend. Cheapest possible stop.

```
1. Re-run existing_url_check against current content_inventory
2. Re-run intent_overlap_check
3. Re-run cannibalization_check against articles published since decided_at
4. Re-run catalog_substance_check against current StoreFacts

if any check now blocks CREATE:
    emit REJECTED with reason_code and redirect recommendation
    cost: one embedding query. No SERP call, no model call.
```

The ordering is the point. A pipeline that fetches a SERP and then discovers the article should not
exist has spent real money to learn something a vector query knew.

### 6.2 R5 — Store facts assembly

Deterministic. No model.

```
1. Resolve product_families for the opportunity's affected_entity
2. Load products for those families
3. Extract attributes, in descending confidence order:
     a. metafields              → high     [BLOCKED on read_products]
     b. variant option names    → high
     c. structured product_type → medium
     d. body_html extraction    → low
4. Snapshot volatile fields with fetched_at
5. Load collection membership  [BUILD]
6. Score catalog_substance:
     products_with_usable_attributes / products_in_scope
```

**Attribute extraction from `body_html` is a parser, never a model.** A model asked to read a
product description and report its material will report one whether or not the description mentions
it — which reintroduces exactly the fabrication the whole design exists to prevent, one layer
earlier and harder to see.

### 6.3 R6 — Sufficiency verdict

The pack scores itself, in code, before anything expensive runs.

| Verdict | Condition | Next |
|---|---|---|
| `sufficient` | Store facts and search evidence both clear their floors | Proceed |
| `thin` | One layer weak but the other strong | Proceed, flagged; information-gain gate (§9.4) is likely to be decisive |
| `insufficient` | `catalog_substance` below floor, or no usable gaps and no store facts | **HOLD** — `INSUFFICIENT_EVIDENCE` |

`insufficient` stops the run before the writing pipeline. Per §1.4 this is a success.

---

## 7. Writing pipeline

Five stages. **No stage in this pipeline may reach for a fact.** The Evidence Pack is closed by the
time W1 starts, and a writing stage that needs a fact it does not have must fail rather than supply
one.

| Stage | Name | Model | Status | Output |
|---|---|---|---|---|
| W1 | `content_strategy` | cheap | **[BUILD]** | Structure type + section plan |
| W2 | `claim_plan` | cheap | **[BUILD]** | `ClaimPlan` |
| W3 | `outline` | cheap | **[EXTEND]** | Sections, claim assignments, link placements |
| W4 | `draft` | frontier | **[EXTEND]** | Body with claim markers + product references |
| W5 | `self_revision` | frontier | **[EXTEND]** | One pass against W1–W3 |

### 7.1 W1 — Structure follows intent, not a template

**There is no universal article template.** The v1 recipes-per-article-type table is withdrawn; it
was a template catalogue wearing a taxonomy's clothes.

Structure is selected from the **dominant search intent** in the Evidence Pack, and the SERP informs
*depth*, never *shape*. Copying the ranking pages' H2 structure guarantees a page with no
information gain, which §9.4 then correctly rejects.

```ts
type StructureType =
  | 'comparison' | 'buying_guide' | 'sizing' | 'how_to'
  | 'troubleshooting' | 'informational_commercial' | 'category_explainer';
```

| Structure | Section sequence | Fails when |
|---|---|---|
| `comparison` | verdict → comparison table → who should choose each → decision factors → products → edge cases | It refuses to recommend. "It depends on your needs" is a non-answer |
| `buying_guide` | the decision → selection criteria → recommended types → common mistakes → products | Criteria are missing, so the recommendation is arbitrary |
| `sizing` | direct answer → size table → how to calculate → worked examples → edge cases → products | The answer is not in the first paragraph |
| `how_to` | outcome → prerequisites → steps → common errors → products where relevant | Steps generic enough to apply to anything; "done" never defined |
| `troubleshooting` | symptom → probable causes → diagnosis → solutions → prevention | Causes not ordered by likelihood |
| `informational_commercial` | direct answer → explanation → decision implications → relevant products | It never reaches the decision |
| `category_explainer` | what the category is → how options differ → how to choose → the merchant's range | It becomes a catalogue listing |

**The verdict-first rule applies to every structure.** The answer goes in the first paragraph, before
any heading. This serves the reader, the featured snippet, and passage-level retrieval at once, and
it costs nothing.

### 7.2 W2 — The claim plan

```
1. For each planned section, enumerate the assertions it needs
2. For each assertion, search the Evidence Pack for support
3. Classify: merchant_fact | external_fact | derived_fact | recommendation
4. Assign confidence from the weakest supporting evidence
5. Drop LOW-confidence claims into rejected_claims with a reason
6. For derived_fact, record the derivation rule and validate it in code
7. Emit the ClaimPlan
```

Step 7 has a deterministic post-check: **every `derived_fact` is re-derived in code** from its
`from_claim_ids`. A numeric comparison is arithmetic, not an opinion, and a model that asserts
"Model B holds more" when the source numbers say otherwise is caught here rather than by a judge.

### 7.3 W4 — Draft

Inputs: outline, claim plan, brand voice samples, planned links, product references, excluded
topics. **Not** the Evidence Pack in full — the writer sees claims, not raw evidence, which removes
the temptation to assert something from the pack that no claim covers.

Writing rules — these carry over from v1 §4 substantially unchanged, because they were right and are
about passage-level quality, which is language-model-independent:

1. **Self-containment.** Every section names its subject. No pronoun whose antecedent is in another
   section, no "as mentioned above". Retrieval systems chunk at heading boundaries; a section that
   only parses in sequence loses.
2. **Answer first.** Inverted pyramid at section level. Extraction takes the opening of a matched
   passage, so an answer in the fourth sentence is an answer that does not get quoted.
3. **One claim per sentence, stated plainly.** Clear subject, predicate, object.
4. **One name per thing.** Synonym rotation dilutes the association between an entity and what was
   said about it. Same name, every time.
5. **Define before use.** Every acronym expanded in the sentence that first uses it.
6. **Front-load the specific.** Numbers, thresholds, procedures early; framing after, or not at all.
7. **Survive the quote.** If a single sentence is quoted with the merchant's name on it and nothing
   else from the page, is it still true and still defensible?

### 7.4 Length

There is no word-count target. Depth comes from intent, topic complexity, `expected_depth` in the
Evidence Pack, and how much defensible material actually exists.

**Padding to reach a length is a validation failure, not a style issue** — it is caught by §9.4
(information gain) and §9.6 (language quality), and it is the single most reliable symptom of a task
that should have been a HOLD.

### 7.5 FAQ

FAQ is conditional, never a template section. It exists when the Evidence Pack's
`paa_questions` and `related_queries` contain questions the body does not naturally answer.

**Never** append six FAQ entries to every article. An FAQ restating what the body already said is
padding, it duplicates prose in a way the reuse check can see, and it dilutes the page.

The mechanical contract with schema generation is unchanged from v1 and is **[SHIPPED]** in
`packages/pipeline/src/structured-data.ts`:

1. The FAQ question is the heading, **verbatim**. `extractFaq` matches body headings against the
   outline's validated questions after normalisation — lowercase, punctuation stripped, whitespace
   collapsed. Case and punctuation may differ; **wording may not**. A rephrased heading produces no
   FAQ entry, silently.
2. **The first paragraph under the heading is the schema answer** — `toPlainAnswer` takes the first
   block only. It must be a complete, self-contained answer. A first paragraph reading "There are
   three things to consider:" emits an FAQ answer that answers nothing.
3. A heading with nothing under it is skipped.
4. Only outline questions become entries; a rhetorical heading ending in "?" is not an FAQ item.

### 7.6 Banned writer behaviour

Absolute. Each maps to a validator in §8.

| Never | Validator |
|---|---|
| Invent a product specification, capacity, dimension, or material | V2 factual grounding |
| Invent a price, stock level, or availability | V2 + V9 commerce freshness |
| Invent search volume or ranking data | V2 |
| Invent a statistic, percentage, study, survey, or expert consensus | V2 |
| Invent a customer review, testimonial, or user opinion | V2 |
| Invent a date, lifespan, or duration | V2 |
| Claim first-hand experience — "we tested", "in our experience" — without merchant evidence | V2 + V6 |
| State a competitor page's opinion as fact | V2 (a ranking page is not a source; §4.6) |
| Make a categorical claim on `medium`/`low` evidence | V3 confidence-language |
| Contradict another passage in the same document | V4 internal consistency |
| Write a volatile value as literal text | V9 |

When evidence is missing the writer has exactly three moves, in order: **remove the claim**, **soften
it to its supported form**, or **signal HOLD**. Inventing a fourth is the failure this whole
specification exists to prevent.

### 7.7 Language quality

Ecommerce content should read as if a knowledgeable person wrote it for someone about to spend
money. Concrete, unhurried, not selling.

**Banned openings.** "Ebben a cikkben bemutatjuk…", "In this article we'll explore…", "In today's
fast-paced world", "Whether you're a beginner or a seasoned pro", "Let's dive in".

**Banned filler.** "Fontos megjegyezni…", "It's important to note that", "Összességében
elmondható…", "At the end of the day", "When it comes to", "A megfelelő választás
kulcsfontosságú…", "That being said".

**Banned vocabulary.** delve, unlock, elevate, harness, leverage (verb), seamless, robust,
cutting-edge, game-changer, revolutionise, supercharge, effortlessly, best-in-class, holistic,
synergy, empower, unleash.

**Banned structure.** Restating a heading as its section's first sentence. A summary paragraph that
repeats the section above. Everything arriving in threes. Uniform section lengths. A "Conclusion"
heading. Rhetorical questions as transitions.

**Banned empty claims.** "may vary depending on your needs", "there's no one-size-fits-all answer",
"results will differ" — hedges occupying the place where the answer goes. When something genuinely
depends on a condition, **name the condition and give the threshold**.

**Register.** No exclamation marks, no emoji, no second-person hype, no "you'll love".

---

## 8. Validation pipeline

Seventeen stages. **Deterministic validators run before model judges** — they are free, they are
exact, and a draft with a broken table should never consume a judge call.

| # | Stage | Kind | Gate | Status |
|---|---|---|---|---|
| V1 | Opportunity validation | deterministic | critical | **[BUILD]** |
| V2 | Factual grounding | hybrid | **critical** | **[EXTEND]** |
| V3 | Confidence-language match | deterministic | critical | **[BUILD]** |
| V4 | Internal consistency | hybrid | **critical** | **[BUILD]** |
| V5 | Search-intent match | judge | critical | **[BUILD]** |
| V6 | Information gain | judge | **critical** | **[BUILD]** |
| V7 | Ecommerce usefulness | judge | critical | **[BUILD]** |
| V8 | Language quality | judge | warning | **[EXTEND]** |
| V9 | Commerce freshness | deterministic | critical | **[BUILD]** |
| V10 | Internal link validation | deterministic | warning | **[EXTEND]** |
| V11 | Markdown / HTML validity | deterministic | critical | **[BUILD]** |
| V12 | Schema validity | deterministic | critical | **[EXTEND]** |
| V13 | Prose reuse | deterministic | warning/critical | **[SHIPPED]** |
| V14 | Topic dedup | deterministic | critical | **[SHIPPED]** |
| V15 | Excluded topics | hybrid | critical | **[SHIPPED]** |
| V16 | Metadata constraints | deterministic | critical | **[SHIPPED]** |
| V17 | Publish eligibility | deterministic | terminal | **[BUILD]** |

### 8.1 V2 — Factual grounding

The core validator. Three passes, cheapest first.

```
Pass A — binding (deterministic)
  Scan every sentence for checkable content:
    numbers, numbers with units, percentages, durations,
    superlatives, absolute language, attributed statements,
    comparative assertions
  Every such sentence must carry a claim marker.
  Unmarked checkable content → FAIL.

Pass B — evidence check (deterministic)
  For each marker, load the Claim.
  merchant_fact  → value must match StoreFacts exactly
  derived_fact   → re-derive in code from from_claim_ids
  external_fact  → quote must exist and be verbatim in the source record
  recommendation → must cite ≥1 supporting claim
  Mismatch → FAIL.

Pass C — residual scan (existing backstop)
  Run scanForRiskPatterns + isSupportedByResearch over the rendered body.
  Catches anything that slipped both passes.
```

Pass C is `packages/pipeline/src/fabrication.ts` and `quality-gate.ts`, **kept unchanged**. It is the
net under the net. Passes A and B prevent; Pass C detects; and the reason both exist is that
prevention depends on a model cooperating and detection does not.

### 8.2 V3 — Confidence-language match

Deterministic. For each claim-bound sentence, the language markers must be permitted by the claim's
confidence (§5.5).

```
high        → any phrasing
medium      → absolute-language allowlist forbidden
low         → the claim should not be present at all → FAIL
recommendation → absolute language forbidden; must read as guidance
```

### 8.3 V4 — Internal consistency

The check v1 had no equivalent of, and the one that catches the most embarrassing failures.

**This is cross-document, not sentence-level.** Sentence-level fact checking passes a document that
says "above 300 kg" in the introduction and "above 200 kg" in section four — both sentences are
individually supported by nothing, or worse, individually plausible.

```
Extract every: number · threshold · dimension · percentage · duration
               recommendation · decision rule · absolute statement

Group by subject entity + attribute.

For each group:
  numeric      → must agree within tolerance, or be explicitly scoped to different conditions
  threshold    → must not conflict
  recommendation → must not contradict
  absolute     → must not be contradicted anywhere in the document

Any unreconciled conflict → FAIL → revision required.
```

Extraction and grouping are deterministic; adjudicating whether two scoped statements genuinely
conflict is a small model call, run only on candidate conflicts.

### 8.4 V9 — Commerce freshness

```
For each product_reference in the body:
  product exists              → else FAIL
  URL resolves (HEAD)         → else FAIL
  title matches snapshot      → else re-resolve
  price changed               → re-render
  availability changed        → re-render
For each literal volatile value found in prose:
  FAIL — must be a reference (§11.2)
```

### 8.5 V11 — Markdown / HTML validity

Purely deterministic, no model, no exceptions:

```
malformed markdown · broken tables (ragged rows) · duplicate headings
heading hierarchy violations (H2/H3 only, no skipped levels)
broken links · missing href · non-resolving product reference
duplicate product reference · invalid JSON-LD · unclosed inline markup
```

### 8.6 Revision budget

```
Run V1–V17.
If any critical FAILs:
    → ONE revision pass, given the exact violations
    → re-run the full validation pipeline
    If any critical still FAILs:
        → HOLD (evidence-shaped failure) or REJECT (structural failure)
        → never publish
        → surface both attempts to the merchant
```

**One revision, not three.** A second repair on a draft that failed grounding twice is not
converging on truth, it is searching for phrasing that evades the check — and the better of the two
attempts is kept by the existing `isBetterAttempt` rule (fewer criticals, then fewer violations).

---

## 9. Quality gates

Six judges. **Separate concerns, separate calls, PASS/FAIL each. No composite score, no average.**

An averaged score lets a strong pass on language quality carry a failed factual grounding, which is
precisely the trade this system must never make.

### 9.1 Judge 1 — Factual grounding
**Question:** Is every material claim supported by the Evidence Pack?
**Input:** body, claim plan, evidence pack. **Output:** PASS/FAIL + unsupported claims.
**Critical.** Mostly deterministic (V2); the judge adjudicates borderline attributions only.

### 9.2 Judge 2 — Internal consistency
**Question:** Does the document contradict itself?
**Critical.** Candidate conflicts from V4; the judge decides whether scoping resolves them.

### 9.3 Judge 3 — Intent match
**Question:** Does this content solve what the query is actually asking?
**Input:** body, target query, `dominant_intent`, SERP composition.
**Critical.** A sizing query answered with a buying guide fails, however good the buying guide.

### 9.4 Judge 4 — Information gain
**Question:** Does a reader get something here they would not get from the top five results?

Qualifying gain — at least one required:

- Merchant-specific product data unavailable elsewhere
- A real comparison across the merchant's actual range
- Concrete decision rules with stated thresholds
- Catalogue structure that clarifies the choice
- Merchant-provided expertise
- Product relationships or combinations only this catalogue reveals
- The merchant's own images
- Questions answered that the ranking pages leave open

**Critical.** A draft that only rephrases what every ranking page says is REJECTED — no revision,
because the deficiency is in the evidence, not the prose.

### 9.5 Judge 5 — Ecommerce usefulness
**Question:** Does this help a shopper make a better purchase decision?

Checks: the decision is identifiable; the attributes that matter are covered; trade-offs are stated;
product families are matched to shopper situations; the next step is obvious; **it has not become a
sales pitch**.

**Critical.**

### 9.6 Judge 6 — Language quality
**Question:** Natural, specific, not AI-slop?

Checks §7.7's banned inventory, plus rhythm, register, and padding.
**Warning**, not critical — a language failure is repairable by revision and rarely indicates a bad
asset. It becomes critical if it survives revision.

### 9.7 Gate summary

| Judge | Severity | Failure route |
|---|---|---|
| Factual grounding | critical | revise once → HOLD |
| Internal consistency | critical | revise once → HOLD |
| Intent match | critical | REJECT (wrong structure ⇒ wrong task) |
| Information gain | critical | **REJECT, no revision** |
| Ecommerce usefulness | critical | revise once → HOLD |
| Language quality | warning → critical after revision | revise once → HOLD |

Information gain is the one gate with no revision path. Everything else can be fixed by writing
better; information gain can only be fixed by having more to say.

---

## 10. Output objects

**The Content Engine does not return a markdown string.** It returns a structured result, of which
exactly one field is publishable.

**[BUILD]** — `ContentResult` in `@sortiva/types`.

```ts
interface ContentResult {
  task_id: string;
  opportunity_id: string;
  outcome: 'PUBLISHED' | 'HOLD' | 'REJECTED';

  /** The ONLY field that may reach the platform's article body. */
  article_body: {
    format: 'markdown';
    content: string;              // claim markers stripped, references unresolved
    language_code: string;
    word_count: number;
  } | null;

  seo_metadata: {
    seo_title: string;            // ≤60 chars (×0.5 CJK) — config.ts
    meta_description: string;     // ≤155 chars (×0.5 CJK)
    slug: string;
    primary_query: string;
    secondary_queries: string[];
    search_intent: string;
    content_type: StructureType;
  } | null;

  internal_link_plan: {
    source_url: string | null;    // null until published
    target_url: string;
    anchor: string;
    reason: string;               // why this link, in one line
    link_type: 'product' | 'collection' | 'sibling_content' | 'pillar';
  }[];

  product_references: {
    reference_token: string;      // '{{product:123}}'
    product_id: string;
    display_fields: ('title' | 'url' | 'current_price' | 'availability' | 'image')[];
    resolved_at: string | null;   // set by the publisher
  }[];

  external_source_references: ExternalFact[];

  claim_provenance: Claim[];      // internal, never rendered

  schema: StructuredData | null;  // separate object, NOT embedded in article_body

  recommended_images: {
    product_id: string;
    image_url: string;
    reason: string;
    placement: 'hero' | 'inline' | 'comparison';
  }[];

  publish_checks: {
    check: string;
    pass: boolean;
    detail: string;
  }[];

  quality_results: {
    judge: string;
    verdict: 'PASS' | 'FAIL';
    severity: 'critical' | 'warning';
    detail: string;
    attempt: number;
  }[];

  /** Populated when outcome ≠ PUBLISHED. §14. */
  rejection: RejectionReason | null;
}
```

### 10.1 The separation rule

| Object | Reaches the merchant's site? |
|---|---|
| `article_body` | **Yes** — rendered into the platform's article body |
| `schema` | Yes, but as a **separate** `<script type="application/ld+json">`, never inside the body |
| `seo_metadata` | Yes, into platform metadata fields |
| Everything else | **No.** Internal |

Provenance, quality results, link reasoning, publish checks, and source lists are Sortiva's audit
trail. Leaking any of them into the published body is a defect, and V11 checks for it.

### 10.2 Images

**V1 uses the merchant's own images only.** No AI-generated imagery.

The reason is the same one that governs claims: a generated image of a product that is not the
product is a visual fabrication, and on a commerce page it is worse than a textual one, because
readers trust photographs more than sentences.

The writer *recommends* placements; the publisher selects and inserts assets. The existing
image-generation stage (`packages/pipeline/src/image.ts`) is **retired for commerce content**; its
non-blocking failure design carries over to image *selection*, which likewise must never block an
article.

---

## 11. Publishing contract

### 11.1 Preconditions

```
outcome === 'PUBLISHED'
∧ zero critical FAILs in quality_results
∧ every publish_check passes
∧ every product_reference resolves
∧ schema validates or is absent
∧ V17 publish eligibility PASS
```

All five. Nothing publishes on a partial.

### 11.2 Product references

Volatile commerce data never exists as literal text in a stored body. It exists as a reference,
resolved at render.

```
{{product:<product_id>|<field>[,<field>...]}}

{{product:7412...|title,url}}
{{product:7412...|title,url,current_price}}
```

Resolution at publish:

```
1. Fetch current product state
2. Product missing        → FAIL publish; open a FIX opportunity
3. URL changed            → use the new URL
4. Price/availability     → render current values
5. Title changed          → render current title
6. Render, then store the resolved snapshot alongside the body
```

**Never** resolve from the model's output or from the Evidence Pack snapshot. The snapshot is
research; the platform is truth.

### 11.3 Freshness re-check

Immediately before publish, and again on every republish:

```
price · sale price · inventory · availability · product URL · product status
```

Changed values trigger a **re-render of the affected passage**, not a rewrite of the article. This is
the distinction that makes commerce content maintainable at all: the prose is stable, the values are
not, and they are separated in storage precisely so that a price change costs a render rather than a
generation.

### 11.4 Post-publish registration

```
article.opportunity_id        = task.opportunity.opportunity_id
article.referenced_products   = [product_id …]
article.referenced_families   = [family_id …]
article.referenced_claims     = [claim_id …]
article.target_queries        = [primary, ...secondary]
article.structure_type        = StructureType
article.published_at          = now()
```

**[BUILD]** — these columns do not exist on `articles` today. Without them §12 and §13 are both
impossible: nothing can detect that a referenced product was deleted, and nothing can attribute
performance to a structure choice.

---

## 12. Refresh logic

### 12.1 Diagnose before writing

A refresh that starts by rewriting is guessing. **Diagnosis is a required stage and produces a
typed cause.**

```ts
interface RefreshDiagnosis {
  article_id: string;
  detected_at: string;
  cause:
    | 'serp_changed'            // the result set turned over
    | 'intent_shifted'          // the query now wants something else
    | 'competitors_improved'    // same intent, better pages
    | 'catalog_changed'         // referenced products moved
    | 'content_stale'           // claims aged out
    | 'internal_links_weakened' // lost inbound links
    | 'references_outdated'     // volatile data drifted
    | 'ranking_lost';           // fell out entirely
  evidence: string[];
  recommended_scope: 'references_only' | 'section_rewrite' | 'restructure' | 'full_rewrite';
}
```

### 12.2 Scope follows cause

| Cause | Scope | Cost |
|---|---|---|
| `references_outdated` | Re-resolve references | No model call |
| `catalog_changed` | Update affected passages + references | One cheap call |
| `content_stale` | Re-verify claims; rewrite what lost support | Cheap + targeted |
| `competitors_improved` | Add depth where competitors gained | Targeted |
| `serp_changed` | Re-run research; restructure if intent moved | Full research |
| `intent_shifted` | Restructure, possibly **REJECT and redirect to a new asset** | Full |
| `ranking_lost` | Full diagnosis; consider consolidation | Full |

**`references_outdated` — by far the most common cause in commerce — costs no model call at all.**
That is the payoff for §11.2's reference design, and it is why the design is worth its complexity.

### 12.3 Catalogue change repair loop

Every published asset stores what it depends on (§11.4). Catalogue events are matched against those
dependencies.

| Event | Opportunity | Priority |
|---|---|---|
| Product deleted | **FIX** — dead reference | Immediate |
| Product URL changed | **FIX** — reference update | Immediate |
| Out of stock ≥14 days | **REFRESH** — recommendation may be wrong | Normal |
| Price change ≥20% | **REFRESH** — reference re-render | Low |
| Specification changed | **REFRESH** — a claim may now be false | **High** |
| New product in a referenced family | **REFRESH** — coverage may be incomplete | Low |

A specification change is high priority because it is the only event on this list that can make a
**published claim false**. Everything else makes it stale.

### 12.4 Claim re-verification

On refresh, every claim on the asset is re-checked against current evidence:

```
still supported          → keep
support weakened         → soften to the supported form
support gone             → remove; rewrite the passage
contradicted by new data → FAIL → mandatory rewrite of that section
```

---

## 13. Learning loop

### 13.1 What is measured

Every published asset is joined to its opportunity, queries, product families, structure type, and
publish date. Performance is read from GSC.

**[BLOCKED]** — this requires the per-query GSC sync described in §4.5. With per-site aggregates
only, an individual asset's performance is not observable at all, and the learning loop cannot start.

### 13.2 Verdicts

```
too_new_to_judge   — <28 days since publish
winner             — meaningful impressions/clicks on target queries
neutral            — indexed, low traction
underperformer     — indexed, negligible traction after 28+ days
failed             — not indexed, or lost ranking entirely
```

**28 days minimum.** A verdict before that measures indexing latency, not content quality — and a
learning loop trained on indexing latency will optimize for it.

### 13.3 What is learned

Correlations, tracked per site and across the fleet:

```
structure_type      × intent            → performance
content_type        × product_family    → performance
evidence_density    × performance
information_gain    × performance
claim_count         × performance
opportunity_confidence × outcome         → calibration of the scorer itself
```

The last row is the most valuable: it tells the Growth Opportunity Engine whether its confidence
scores mean anything.

### 13.4 Exploration is mandatory

Learning must not collapse onto past winners.

```
≥20% of tasks ignore learned preferences
Never disable a structure type on <10 observations
Per-site learning requires ≥15 published assets before it outweighs fleet priors
```

A system that only repeats what worked stops discovering, converges on a local maximum, and — for a
content system specifically — produces a site where every page has the same shape, which is itself a
quality signal in the wrong direction.

---

## 14. Failure and HOLD conditions

### 14.1 The rejection object

**[BUILD]** — every non-publish outcome is machine-readable and merchant-actionable.

```ts
interface RejectionReason {
  outcome: 'HOLD' | 'REJECTED';
  reason_code: RejectionCode;
  explanation: string;          // internal, precise
  merchant_message: string;     // merchant-facing, plain language
  merchant_fix: string | null;  // specific action, or null if none exists
  retry_condition:
    | { kind: 'automatic'; on: 'catalog_update' | 'serp_refresh' | 'gsc_sync' }
    | { kind: 'manual' }
    | { kind: 'never' };
  redirect: { action: 'OPTIMIZE' | 'REFRESH' | 'FIX'; target_url: string } | null;
  evidence_gaps: EvidenceGap[];
}
```

### 14.2 Codes

| Code | Outcome | Retry |
|---|---|---|
| `SUITABLE_URL_EXISTS` | REJECTED | never — redirect to OPTIMIZE |
| `CANNIBALIZATION_RISK` | REJECTED | never — redirect to OPTIMIZE |
| `INTENT_MISMATCH` | REJECTED | on `serp_refresh` |
| `INSUFFICIENT_PRODUCT_DATA` | HOLD | on `catalog_update` |
| `INSUFFICIENT_EVIDENCE` | HOLD | on `catalog_update` |
| `NO_INFORMATION_GAIN` | REJECTED | never |
| `UNGROUNDED_CLAIMS` | HOLD | manual |
| `INTERNAL_CONTRADICTION` | HOLD | manual |
| `THIN_SEARCH_DEMAND` | REJECTED | on `serp_refresh` |
| `NOT_WINNABLE` | REJECTED | on `serp_refresh` |
| `DUPLICATE_TOPIC` | REJECTED | never |
| `PRODUCT_REFERENCES_UNRESOLVABLE` | HOLD | on `catalog_update` |

### 14.3 A worked rejection

```yaml
outcome: HOLD
reason_code: INSUFFICIENT_PRODUCT_DATA
explanation: >
  catalog_substance_check scored 0.21. 3 of 14 in-scope products carry a usable
  material attribute; a comparison structure needs material on ≥60% of compared
  products to make a defensible recommendation.
merchant_message: >
  We don't yet have enough concrete information about these products to write
  this comparison reliably.
merchant_fix: >
  Add material, dimensions and capacity to these 11 products — Sortiva will
  retry automatically once they're updated.
retry_condition: { kind: automatic, on: catalog_update }
redirect: null
evidence_gaps:
  - needed_for: material comparison
    missing: product_attribute
    detail: "11 of 14 products have no material attribute"
    blocks_content: true
    merchant_fix: "Add a 'material' metafield or state it in the description"
```

### 14.4 Global rules

- A `HOLD` is **not** a job failure. It does not increment `generation_attempts`, page anyone, or
  count against the retry budget.
- A `REJECTED` opportunity is closed with its reason and does not return until its retry condition
  fires.
- The differentiation regen cap is unchanged and stays a property of the payload, not a counter: a
  task carrying `differentiation_instruction` **is** the regen, so a second dedup flag stops and
  surfaces both versions rather than looping.
- **Nothing publishes past a critical gate.** Autopilot included. There is no override path in the
  engine; a merchant override is a UI action recorded on the article, and it stays visible.

---

## 15. Examples

### 15.1 CREATE proceeds

```yaml
input:
  query: "best trail running shoes for wide feet"
  gsc: no ranking page for this intent
  demand: strong, rising
  catalog: 14 relevant products, 4 families, width data on 12
  serp: buying-guide intent, 7/10 editorial
  cannibalization: none
  opportunity_confidence: 86

action: CREATE

flow:
  R1 re-verification:       PASS
  R5 catalog_substance:     0.86
  R6 sufficiency:           sufficient
  W1 structure:             buying_guide
  W2 claim plan:            23 claims (17 merchant_fact, 2 external, 3 derived, 1 recommendation)
  W4 draft:                 1,340 words, 6 sections, 4 product references
  V2 grounding:             PASS — 23/23 bound
  V4 consistency:           PASS
  Judge 4 information gain: PASS — width data across 4 families, unavailable elsewhere
  Judge 5 ecommerce:        PASS

outcome: PUBLISHED
```

### 15.2 CREATE stopped — the important case

```yaml
input:
  query: "trail running shoes"
  existing_url: /collections/trail-running
  gsc: position 7.2, 9,800 impressions/28d, same intent
  catalog: strong

action_requested: CREATE

flow:
  R1 existing_url_check:   FAIL — suitable URL exists
    intent match:          commercial category = commercial category  ✓
    similarity:            0.81 > 0.72                                ✓
    not disqualified:      collection page serves commercial intent   ✓
  cost incurred:           one embedding query. No SERP, no model.

outcome: REJECTED
reason_code: SUITABLE_URL_EXISTS
merchant_message: >
  Your Trail Running collection already ranks 7th for this search. Improving it
  will beat publishing a competing article.
redirect: { action: OPTIMIZE, target_url: /collections/trail-running }
```

**A "Best Trail Running Shoes" article here would have competed with the merchant's own collection
page for the same intent.** Both would have lost. This is the failure the entire CREATE gate exists
to prevent, and it is the outcome a naive content pipeline produces every single time.

### 15.3 HOLD on evidence

```yaml
input:
  query: "stainless steel vs aluminium cookware"
  catalog: 22 products, material on 3
action: CREATE
flow:
  R5 catalog_substance:  0.14
  R6 sufficiency:        insufficient
  writing pipeline:      never runs
  cost:                  one SERP call + assembly. No frontier model call.
outcome: HOLD
reason_code: INSUFFICIENT_PRODUCT_DATA
retry_condition: { kind: automatic, on: catalog_update }
```

### 15.4 REJECT on information gain

```yaml
input:
  query: "how to clean a coffee grinder"
  catalog: 8 grinders, no cleaning-specific attributes
flow:
  R6 sufficiency:            thin — search evidence strong, store facts weak
  W4 draft:                  produced, 900 words
  V2 grounding:              PASS (nothing unsupported — but nothing specific either)
  Judge 4 information gain:  FAIL
    detail: >
      Every claim restates consensus already present in results 1–5. No merchant
      product data differentiates the guidance. No decision rules, no thresholds.
outcome: REJECTED
reason_code: NO_INFORMATION_GAIN
retry_condition: { kind: never }
```

Note the sequence: grounding **passed**. The article was true. It was rejected for being true and
worthless — which is the distinction v1's quality gate could not draw, and the reason Judge 4 exists.

### 15.5 REFRESH, cheap path

```yaml
trigger: price change ≥20% on 2 referenced products
diagnosis:
  cause: references_outdated
  recommended_scope: references_only
flow:
  re-resolve product references
  re-render affected passages
  V9 commerce freshness: PASS
  model calls: 0
outcome: PUBLISHED (updated)
```

---

## 16. Acceptance criteria

The Content Engine v2 is complete when every row passes. Each maps to the mechanism that makes it
true — a criterion with no named mechanism is a hope.

| # | Criterion | Mechanism |
|---|---|---|
| 1 | The writer cannot publish an unsupported numeric claim | V2 Pass A binding + Pass B evidence + Pass C backstop |
| 2 | Every material claim has stored provenance | `article_claims`, written at W2 |
| 3 | Merchant facts and external facts are distinguishable | `Claim.claim_type` + separate validation rules |
| 4 | Volatile commerce data is re-resolved before publish | §11.2 references + V9 |
| 5 | Internal contradictions are detected | V4 cross-document consistency |
| 6 | `existing_url_check` runs before every CREATE | R1, gated pre-spend |
| 7 | Structure is determined by intent | W1 `StructureType`; no template catalogue |
| 8 | No universal blog template exists in the system | v1 recipe table withdrawn |
| 9 | Information gain is its own gate | Judge 4, critical, **no revision path** |
| 10 | Ecommerce usefulness is its own gate | Judge 5, critical |
| 11 | Markdown/HTML/schema validated deterministically | V11, V12 — no model |
| 12 | Internal metadata never reaches the published body | §10.1 + V11 leak check |
| 13 | Every asset traces to a Growth Opportunity | `ContentTask.opportunity` non-null; `articles.opportunity_id` |
| 14 | Rejected content never auto-publishes | §11.1 preconditions; no override path in the engine |
| 15 | "No publish" is a successful outcome | `HOLD`/`REJECTED` terminal states; no failure counters |
| 16 | Performance is attributable to the opportunity | §11.4 registration + §13 — **[BLOCKED]** on per-query GSC |
| 17 | Architecture accepts OPTIMIZE, REFRESH, and AI-visibility inputs | `action` union; `EvidencePack` layer list is open |

### 16.1 AI visibility — deliberately deferred

The Evidence Pack's layer list is designed to take a fifth layer later:

```ts
interface AiVisibilityEvidence {
  tracked_prompts: { prompt: string; brand_mentioned: boolean; competitors_mentioned: string[] }[];
  citation_sources: { url: string; cited_by: string[] }[];
  missing_entities: string[];
}
```

**V1 generates no GEO rules.** Writing speculative "AI search optimization" instructions today would
produce prompt content with no evidence behind it — which is the exact failure this specification
exists to prevent, committed by the specification itself.

What V1 *does* do is write in a way that happens to be well-formed for retrieval — §7.3's passage
rules, verdict-first structure, self-contained sections, tables — because those are justified on
reader and passage-ranking grounds independently. That is the honest position: **build the structure
that is defensible now, leave the socket for the data that is not yet measurable.**

---

## Appendix A — What carried over from v1, and what was reversed

### A.1 Carried over unchanged

| v1 section | Now | Why it survived |
|---|---|---|
| §4 Passage rules | §7.3 | Passage-level quality is reader-driven and model-independent |
| §15 Banned writing | §7.7 | Correct, concrete, and checkable |
| §3.4 FAQ contract | §7.5 | It describes shipped code (`structured-data.ts`) |
| §16 Fabrication constraints | §8.1 Pass C | Kept as the net under the claim model |
| §10 Metadata budgets | §10 | Measured in code (`config.ts`) |
| §9 Internal link rules | §10 `internal_link_plan` | Now carries a `reason` per link |
| §8 No keyword density | §7 | Still true, still the most common wrong instinct |
| §14 Prose reuse gate | V13 | Shipped, calibrated, correct |
| §20 No word-count target | §7.4 | Now enforced by a gate rather than requested in prose |

### A.2 Deliberately reversed

**1. Prices: from banned to referenced.**
v1 §16 banned prices, shipping, stock, and availability outright, reasoning that they are
unverifiable from our sources and go stale. That reasoning was correct **for a system with no live
commerce connection**. It is wrong for one that has Shopify as a source of truth and re-resolves at
publish. §11.2 replaces the ban with a reference mechanism.

The ban survives in one narrower and stricter form: **a volatile value written as literal prose is a
critical failure**, because it is exactly the thing that silently rots. The old rule was right about
the danger and wrong about the remedy.

**2. Article-type recipes: withdrawn.**
v1 §12 gave a required shape per `ARTICLE_TYPES` value. That is a template catalogue, and §7.1
replaces it with intent-derived structure. `ARTICLE_TYPES` remains as a taxonomy for filing and
learning; it no longer dictates shape.

**3. "Every article must earn its existence": promoted and made checkable.**
v1 §1 said this and could not enforce it — the only mechanism was a prompt asking the model to lead
with the gap. It is now Judge 4, critical, with no revision path.

**4. The generation trigger: from plan item to opportunity.**
v1 assumed a plan item becomes an article. v2 makes that a decision with six gates and three
possible outcomes. This is the largest change in the document and the reason for the rewrite.

**5. "Forbid rather than verify": scoped, not abandoned.**
v1's §3.8 principle — *where a claim cannot be checked cheaply, forbid the claim* — still governs
external and unverifiable claims. It no longer governs **merchant facts**, because the claim model
made those cheap to check. The principle was never "forbid things"; it was "do not build expensive
verification machinery". Where verification became cheap, the forbidding should stop.

---

## Appendix B — Implementation gap register

Ordered by unblocking leverage, not by size.

| # | Item | Kind | Blocks | Prerequisite |
|---|---|---|---|---|
| 1 | **Per-query GSC sync** — `dimensions: ['query','page']` + `search_console_query_metrics` | [BUILD] | `existing_url_check`, cannibalization, striking-distance, decay diagnosis, the entire learning loop | None. Existing OAuth scope covers it |
| 2 | `opportunities` table + `OpportunityContext` | [BUILD] | Every traceability criterion (13, 16) | None |
| 3 | `EvidencePack` + `evidence_packs` table | [BUILD] | The whole claim model | 2 |
| 4 | `Claim` + `article_claims` table | [BUILD] | V2, V3, V4, §12.4 | 3 |
| 5 | `articles` columns: `opportunity_id`, `referenced_products`, `referenced_families`, `referenced_claims`, `target_queries`, `structure_type` | [BUILD] | §12.3 repair loop, §13 | 2 |
| 6 | Product reference tokens + publish-time resolution | [BUILD] | A.2's price reversal; §12.2's cheap path | None |
| 7 | Judges 3–6 as separate stages | [BUILD] | Gates 9.3–9.6 | 3 |
| 8 | V4 internal consistency | [BUILD] | Acceptance 5 | 4 |
| 9 | V11 deterministic markdown/HTML validation | [BUILD] | Acceptance 11 | None |
| 10 | `StructureType` + W1 strategy stage | [BUILD] | Acceptance 7, 8 | None |
| 11 | Attribute extraction from variant options + `body_html` | [BUILD] | `catalog_substance_check` | None |
| 12 | **Shopify `read_products` scope** → metafields, collections | [BLOCKED] | High-confidence `StoreFacts` | Scope expansion + app review |
| 13 | Collection membership | [BUILD] | Category-level recommendations | 12, or a `/collections.json` crawl |
| 14 | `ContentResult` output separation | [BUILD] | Acceptance 12 | None |
| 15 | `RejectionReason` + merchant-facing rejection UX | [BUILD] | Acceptance 14, 15 | None |
| 16 | Retire AI image generation for commerce content | [BUILD] | §10.2 | None |

**Items 1 and 12 are the two external-facing unblocks.** Item 1 needs no permission and unlocks
five capabilities; it should be first. Item 12 needs Shopify app review and gates the quality of
every claim the system makes about a merchant's own products — start it early, because its latency
is not ours to control.

---

## Changelog

- **v2.0** — Complete rewrite. Content Engine repositioned from article writer to Growth Engine
  execution module. Introduces the Evidence Pack, the claim model with provenance, the CREATE gate,
  intent-derived structure, the six-judge architecture, output object separation, product references
  with publish-time resolution, the catalogue repair loop, and the learning loop. Reverses v1's
  outright price ban in favour of references (Appendix A.2). Written against `packages/pipeline`,
  `packages/discovery`, `packages/search-console`, `packages/ingestion` and
  `packages/db/src/schema/tables.ts` at `b4f3c81`.
- **v1.0** — Editorial standard for the article writer. Superseded. Its surviving rules are
  Appendix A.1.
