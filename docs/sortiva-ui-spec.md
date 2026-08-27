# Sortiva — UI Spec

Companion to `sortiva-spec.md` ("main spec"; plain §-references point there) and `sortiva-tech-spec.md` (which owns the notification system's mechanics — this doc defines only how notifications render). This document defines every surface, its states, and the interaction rules. It does not restate business logic — where a behaviour is specced in the main doc, this doc says which screen owns it and how it renders.

Design principles carried from the main spec: transparency over polish (rejections, skipped days, and blocked opportunities are shown, never hidden — §8.6, §7.9); one decision per surface (no in-app editor — §9.3; OPTIMIZE is a recommendation the merchant applies in Shopify — §10); nothing publishes that the user couldn't have seen coming (§8.7); read-only trust posture during onboarding (§6.2); every why is true (§7.1, §9.6.8); action over dashboard (§1.4).

**UI language:** independent of the store's content language. Default from browser locale, overridable in Settings (`account_settings.ui_language`). Article and recommendation content always follows the persona language (§6.5). V1 UI languages: English only, all strings externalised from day one. Canonical copy strings live in main-spec Appendix A and are referenced here by name.

---

## 1. Navigation & information architecture

Authenticated app shell — left sidebar (desktop) / bottom tabs (mobile web; the last two collapse under "More"):

1. **Dashboard** — business overview, top opportunities, progress, connection health
2. **Opportunities** — the central product surface: CREATE / OPTIMIZE / REFRESH / FIX / HOLD (§7)
3. **Content** — Calendar (§8.7), Articles library, drafts, published/rejected, refreshes
4. **Products** — families, data richness, knowledge gaps / merchant tasks (§6.3–6.4, §7.4 HOLD)
5. **Performance** — GSC results, per-page/article outcomes, Search Console explorer (§9.6, §12.2); revenue tab arrives in V1.5 (§17.3)
6. **Settings** — connections, permissions, store profile, competitors, market/language, publishing, billing link

Decided (main Appendix B): six screens, not eight — the strategy document's separate "Google" screen is a tab inside Performance (§8.2 below), and "AI Visibility" appears as a seventh item only when V1.5 ships it.

Global elements on every authenticated screen:

- **Notification bell** → notification list (§10 below).
- **Status banners** (stacked, dismissible only where noted): Shopify reconnect (§6.2 — not dismissible), GSC reconnect (dismissible), **Limited Intelligence** (dismissible per session; re-appears on Opportunities and Dashboard as a badge, §5.5), vacation mode active (not dismissible while on), kill-switch/service pause ("Article generation is temporarily paused on our side — nothing is wrong with your account"), **payment failed** (non-dismissible: "Payment failed — update your card to keep articles coming" → Stripe Customer Portal link, §4.2 dunning).
- Sidebar items Opportunities/Content/Products/Performance render in a **locked state** (visible but non-interactive, lock icon + tooltip "Available after your store is connected") until `domains.state = ready_for_planning`; Opportunities additionally shows a "finding opportunities…" spinner until the onboarding run completes (§3.8).

Account-level parked states override the shell's content area entirely (§3.4, §3.5).

---

## 2. Public surfaces

### 2.1 Landing page with preview (§3 main)

- Hero: single URL input + CTA button ("Analyze my site"). Turnstile widget renders inline (invisible mode preferred; fall back to checkbox on challenge).
- **States:** idle → loading (skeleton card, 2–8s, playful copy "Reading your site…") → result card | generic-fallback card.
- **Result card:** the Haiku 2–3 sentence business summary, styled as "Here's what we understood about {domain}", followed by the teaser link **"See your organic growth opportunities →"** (Appendix A; never "content plan"). Teaser click → signup modal (§2.2).
- **Generic fallback** (scrape failed or preview endpoint cost-tripped, §14.5): "We couldn't read this site automatically — sign up and we'll take a deeper look." Same teaser CTA. Never an error state.
- Rate-limited response (429): "Too many requests — try again in a minute." No Turnstile re-challenge loop.
- Below the fold: how it works (framed as find → act → learn, with the four action types), pricing preview matching §4.2 wording verbatim: "up to 1 article per day, quality permitting".

### 2.2 Signup / login

- Email + Google OAuth (§4.1). Standard flows; no invention here.
- If arrived via the preview teaser, carry the previewed domain in state and pre-fill it later at Connect Domain (§3.1) — pre-fill only, never auto-claim.

### 2.3 Plan selection (Stripe — §4.2 main)

- Single Pro card: price, monthly/annual toggle (−20%), the cap line **verbatim**: "Up to 1 article per day, quality permitting", inclusions list (growth opportunities across all action types, export + auto-publish, Search Console intelligence, full calendar), and "Cancel anytime." One button: "Subscribe" → **Stripe Checkout** (subscription mode). We render no card form, ever.
- Return states: success → onboarding continues (§3.1); canceled Checkout → back here with a neutral "no charge was made" note. Checkout webhook lag is handled by an optimistic "setting up your account…" interstitial that polls entitlement for up to 30s before a "taking longer than expected" fallback.

---

## 3. Onboarding flow (after auth)

The dashboard is the container for all onboarding states; there is no separate wizard route. The account moves through `domains.state` and the dashboard renders accordingly.

### 3.1 Empty state — no domain (§4.3 main)

Centered card: "Connect your domain" + URL input (pre-filled from preview if available) + button. Error states inline: already-claimed ("This domain is already connected to another account. If you believe this is a mistake, contact support." + support link), invalid/unresolvable domain.

### 3.2 Ingestion progress (§5, §6 main)

Full-width stepper reflecting `job_steps` live (SSE, fallback poll):
**Detecting platform → Connect your store → Reading your store → Building your business profile → Finding keywords & competitors → Connect Search Console → Review**

- Each step: pending / active (spinner + friendly line) / done (check) / skipped (GSC only — grey check with "skipped — limited intelligence"). Durations are minutes; show elapsed time on the active step after 60s ("still working — large catalogs take a few minutes").
- Failures surface as a retry card on the failed step ("Something went wrong reading your store. We'll retry automatically." — retries are automatic per §14.3.5; the card is informational, with a "contact support" link if the step dead-letters).

### 3.3 Shopify OAuth blocking state (§6.2 main)

Replaces the stepper's "Connect your store" step with a blocking card:
- Headline: "Connect your Shopify store to continue."
- Body **must include** the trust copy (Appendix A): "Read-only — we can't change anything in your store with this permission. Auto-publishing is a separate optional setting you control later."
- Primary button → Shopify OAuth. Abandon → the card persists on every dashboard visit; reminder email at 24h (§10 below).

### 3.4 Parked state — not a Shopify store (§6.1 main)

Dashboard content area replaced by a single card with the Appendix A copy: "This doesn't look like a Shopify store. We currently support Shopify only — contact us for a custom solution or join the waitlist." + contact CTA + waitlist email capture. Sidebar stays locked. Persists until support intervenes; no self-serve exit in V1.

### 3.5 Parked state — Shopify disconnected (token revoked, §6.2/§14.4)

Non-dismissible banner on all screens + dashboard card: "Your Shopify connection was lost — reconnect to resume." Opportunities/Content/Products/Performance remain **viewable** (read-only history) but generation and scans are paused; the calendar and the Opportunities list show a paused ribbon.

### 3.6 Search Console step — soft-required (§6.7 main) *(new)*

A stepper card, not a blocker:
- Headline (Appendix A): "Connect Google Search Console to unlock full Growth Intelligence."
- Body: what it unlocks in one line each — real query and page performance, click-through opportunities on pages that already rank, decay detection, cannibalization checks. Then the consequence, plainly: "Without it, Sortiva runs in Limited Intelligence mode and can only find opportunities from your catalog and the market."
- Primary: "Connect Search Console" → Google OAuth → **property picker** (list of the user's properties; inline validation errors for host mismatch with the claimed domain, §12.2; accept URL-prefix and domain properties). Secondary, always visible, equal weight in text not in colour: **"Skip for now"**.
- After connect: a "importing your Search Console history (up to 16 months)…" line on the step; the stepper advances without waiting for the backfill.
- After skip: step renders as skipped; the Limited Intelligence badge appears from here on (§5.5).

### 3.7 Confirmation review screen (§6.8 main)

One long scrollable page, sections in order, sticky footer with **"Confirm profile"** (disabled until required fields valid):

1. **Business profile:** description textarea, language + country dropdowns, audience + tone text fields. All pre-filled from ingestion.
2. **Top products:** ranked list rows (image thumb, title, 90d revenue/qty badges when from `orders_api`), drag to reorder, × to remove, pin icon. "Source" badge per row.
3. **Keywords:** chip list. Each chip: term + volume/difficulty once enriched (skeleton shimmer while pending — confirmable before enrichment returns). × to remove; "Add keyword" input appends a chip in loading state.
4. **Competitors (§7.2.1):** up to 5 rows, `auto`/`manual` badge, × to remove. Below the rows, SERP-derived **suggestions** ("appears in 8 of your top queries") each with an "Add" button (disabled at 5). "Add competitor" domain input with inline validation (own-domain rejection, blocklist warning with "add anyway"). Control disabled at 5 with tooltip: "Limited to 5 — competitor analysis is the most expensive thing we run."
5. **Product families (collapsed accordion, read-only):** family name, member count, differentiation axes as tags, grouping-source badge. "Report wrong grouping" link per family → short feedback modal → support/feedback record + PostHog event `family_grouping_reported`. No editing (§6.4). Same component reused on the Products screen (§7).
6. **Data richness (informational panel):** 3-band meter (rich / okay / sparse) + the plain-language note and the missing-details product list when low (§6.3), with the line "these will show up as tasks on your Products page".
7. **Search Console status line:** connected (property name) / skipped (with an inline "connect now" link). Informational; not a blocker.

Post-confirmation, this screen becomes **Settings → Store profile** (§9.2 below) with identical components.

### 3.8 Finding opportunities → activation (§6.9 main) *(new)*

After "Confirm profile": the dashboard shows a compact progress card — "Finding your growth opportunities…" with sub-lines that reflect `signal_runs` progress ("Checking pages that already rank… / Comparing you to competitors… / Mapping your product families to search demand…"), SSE-driven like the stepper, typically a few minutes. On completion the app **navigates to Opportunities** (not Dashboard) with the headline (Appendix A) **"We found {N} ways to grow your store organically"** and a one-time explainer strip: the four action types in one sentence each, dismissible. This is the activation moment; `opportunities_ready` notification + email fire here.

If GSC was skipped, the headline carries the Limited Intelligence badge and the explainer strip's last card is the GSC connect nudge.

---

## 4. Dashboard (steady state)

Once `ready_for_planning` and the onboarding run has completed, in this order — **opportunities first, content second** (§7.12):

- **Growth headline card:** "Sortiva found **{N}** ways to grow your store organically" → counts by action type (CREATE / OPTIMIZE / REFRESH / FIX / HOLD as small chips) → **Next best actions:** the top 3 open opportunities by `impact_score` as compact cards (§5.2 anatomy, condensed) → "View all opportunities". Limited Intelligence badge inline when applicable.
- **Next up card (content):** the next scheduled topic (title, date, why-line, originating opportunity chip) + "View calendar". If today's slot already ran: today's outcome (published link / held-for-quality card / in-review prompt).
- **This month strip:** articles published, OPTIMIZE recommendations generated / applied, repairs, topics held by quality bar (links to their cards), next replenishment date. **No denominators, no targets** (§8.6 — never render "x of y").
- **Performance snapshot:** the §12.2 headline chart, compact (clicks/impressions since GSC connect). If GSC not connected: the connect card with Appendix A copy ("Connect Google Search Console to unlock full Growth Intelligence") and the concrete list of signal types currently unavailable (§7.11).
- **Attention list** (a live query, tech spec §1.1): pending review drafts (if draft review on), repair action cards for export-mode accounts (§14.1), unconfirmed export URLs (§9.4), **HOLD merchant tasks** (§7.4) with a link to Products, OPTIMIZE recommendations generated but not marked applied for > 14 days (soft; one line, not a nag).
- **Connection health row:** Shopify (read / read+write), Search Console (connected / limited), last scan time.

---

## 5. Growth Opportunities (§7 main) *(new — the central surface)*

### 5.1 List

Header: the headline count + Limited Intelligence badge when applicable + "last scan: {date} · next: Monday".

Filters (chips, multi-select): **Action** (CREATE / OPTIMIZE / REFRESH / FIX / HOLD), **Impact** (high / medium / low), **Status** (open [default: new + accepted + blocked] / scheduled / in progress / completed / dismissed / expired), **Entity** (collections / products / pages / our articles / queries), **Signal type**. Sort: impact (default) / confidence / newest. Empty state: "No open opportunities right now — the next scan runs Monday" (never "nothing to do" — the calendar is still running).

Grouping: default flat list sorted by impact; a "group by action" toggle renders five columns/sections in the fixed order CREATE, OPTIMIZE, REFRESH, FIX, HOLD.

### 5.2 Opportunity card anatomy (required fields, §7.12)

- **Action badge** (colour-coded, first thing on the card): CREATE / OPTIMIZE / REFRESH / FIX / HOLD.
- **Impact** (high / medium / low pill) and **Confidence** (band pill + tooltip listing what raised or lowered it: "GSC data ✓ · 28-day window ✓ · limited intelligence −" — deterministic from §7.6).
- **Title:** the affected entity, humanised: query cluster head term in quotes, or the page ("Collection: Trail running shoes"), or the family ("Family: Wide-fit trail shoes"), or the article title.
- **Evidence line:** the 2–3 key numbers with source and window — "8,400 impressions · avg. position 8.6 · 14 matching products · Search Console, last 28 days".
- **Why-line:** rendered from `reason_template_key` (§7.6), e.g. "You already rank on page 1, but the collection does not fully match the query intent."
- **Signal type** as a small grey tag (Striking distance / Low CTR / Decay / Cannibalization / …).
- **Primary action button** by action type: CREATE → "Schedule" (already scheduled ⇒ "On calendar {date}" link); OPTIMIZE → "Generate recommendations"; REFRESH (our article) → "Schedule refresh"; FIX → "View recommendation"; HOLD → "See what to add".
- **Secondary:** "Dismiss" (goes to the dismissed list; undo toast 5s); "Details".
- **Preconditions ribbon** when blocked: "Blocked: {precondition} — {what to do}", e.g. "Blocked: missing product details — add materials and dimensions for 6 products on the Products page."
- Status chips for non-open states: scheduled (date), in progress, completed (date, outcome label once measured), expired (reason, e.g. "page moved to position 2").

Card example (from the strategy document, canonical): *High impact — Optimize collection · "Trail running shoes for wide feet" — 8,400 impressions, avg. position 8.6, 14 matching products · Why: you already rank on page 1, but the collection does not fully match the query intent · Action: Generate recommendations.*

### 5.3 Detail drawer

Opens from "Details" or the title. Sections:

1. **Summary:** the card, expanded.
2. **Evidence:** every fact in `evidence_json` as a row — value, source, window, fetched-at. For query-based evidence: the SERP snapshot's top results (the query-level SERP competitors, §7.2.1) with domain and position. For page-based evidence: the page's GSC query table (28d).
3. **Tasks:** the `opportunity_tasks` list with state (open / applied / skipped) and per-task "mark applied".
4. **OPTIMIZE recommendation view** (after generation, §10.3): per field, *current* vs *suggested* side by side with a copy button; sections and FAQ rendered as they'd appear; internal-link suggestions as two lists (link from → this page; this page → link to); the intent note; the evidence chip per suggestion ("3 of top 5 results cover this"). Footer: **Download (Markdown / HTML)**, **Mark all as applied**, "Regenerate" (disabled until new evidence: tooltip "available after the next scan"). Failed-validation state: "We couldn't produce a safe recommendation for this page" + reason, no partial output.
5. **FIX recommendation view:** the deterministic recommendation (e.g. cannibalization: candidate primary URL with the reason, internal links to realign, canonical suggestion) with the explicit line "Sortiva does not change your theme or redirects — apply these in Shopify."
6. **HOLD view:** the merchant task — the product list with missing fields as a checklist, deep links to each product in Shopify admin, and "We'll re-check automatically after your next catalog sync."
7. **History:** status changes with actor (you / autopilot / expired), outcome once measured (§9.6.10) with the before/after numbers.

### 5.4 Actions & state feedback

- Schedule (CREATE/REFRESH): picks the next open calendar day by default; a date picker allows any future day; then the topic chip appears on the calendar and the card shows "On calendar {date}". Under the V1 autopilot policy CREATE/REFRESH opportunities are auto-accepted and scheduled at replenishment (§7.9), so "Schedule" mainly exists to pull an opportunity forward — the calendar's veto/move/pin still govern.
- Generate recommendations (OPTIMIZE): button → in-progress state on the card ("generating… ~1 min") → drawer opens on completion; notification `optimize_recommendation_ready`. Daily cap reached ⇒ button disabled with "2 per day — available tomorrow" (config).
- Dismiss: undo toast; a "Dismissed" filter shows them with "restore".
- Guarded transitions return 409 (tech spec §3) → toast "this opportunity was updated by the latest scan — refreshed".

### 5.5 Limited Intelligence mode (§7.11)

A persistent badge in the list header and on the dashboard headline: "Limited Intelligence — connect Search Console to see real query and page opportunities" (Appendix A), linking to the connect flow. Under it, on first render, a collapsible list of the signal types not evaluated. Opportunities produced via the DataForSEO proxy show "estimated ranking (no Search Console data)" in their evidence rows.

---

## 6. Content

Sub-navigation: **Calendar** · **Articles**. The Content module is the CREATE/REFRESH execution surface (§8–§9).

### 6.1 Calendar (§8.7 main)

**Layout:** month grid (default) + week list toggle. Each day cell holds at most one topic chip (1/day cap). Past days show outcomes; future days show plans.

**Topic chip anatomy:** title (truncated), intent-class icon, `new`/`refresh` tag, pin icon if pinned, source dot (`auto` / `manual` / `exploration` — exploration renders its why-line as "trying something new"), and a small **opportunity chip** (signal type) linking to the originating opportunity. Click → topic detail popover: full title, target keyword + volume, mapped families, why-line, originating opportunity, state, and the action row.

**Actions (per §8.7, all inline):**
- **Veto/delete:** on `planned` chips — one click + undo toast (5s), then the day becomes an intentional gap ("open day — will be filled at next replenishment" on hover). If the topic is `generating`: the action reads "Cancel publication" with a confirm dialog explaining the draft will be discarded (cost is ours). Vetoing also dismisses the originating opportunity (with the same undo).
- **Drag** to any future date. Drop on an occupied day swaps the two topics (visual preview during drag). Pinned topics don't move on swap — drop is rejected with a shake + tooltip.
- **Pin/unpin** toggle in the popover.
- **Add topic:** every empty future day has a ghost "+" → inline form (topic title / keyword, optional date pin). Submits to Gate 1 async; the chip renders in `checking` state, then resolves to `planned`, `planned + warning` ("~0 search volume"), a **converted** state ("You already rank for this with {page} — we've created an Optimize opportunity instead", linking to it, §7.7), or a rejection card with the standard reason.

**Past-day outcomes:** published (green, links to article), held-for-quality (amber, click → the §8.6 rejection card: gate, plain-language reason, actionable fix), vetoed (grey), no-topic (blank — rendered as nothing, per the no-denominator rule).

**In-review days** (draft review on): purple chip "Ready for review" → §6.3 review surface.

**Paused ribbons:** vacation mode / disconnected / kill-switch states render a full-width ribbon over future weeks: "Generation paused — your calendar will resume where it left off."

**Empty state pre-replenishment:** "Your plan is being built from your growth opportunities" (linking to Opportunities).

### 6.2 Articles library (list)

Table/card list of all articles, newest first. Columns: title, state (`draft`/`in_review`/`published`/`rejected`/`discarded`), delivery mode, published date, and — when GSC-attributed — clicks (28d), position, trend arrow, label chip. Badges: `override` (visible but low-key), `repaired` (links to repair log), `refreshed ×n`. Filters: state, has-performance, needs-attention.

**Export-mode rows** add the delivery affordances: download buttons (Markdown / HTML / metadata), and the **"Mark as published"** action → URL paste field with validation (must be on the claimed domain) → feeds GSC attribution (§9.4/§12.2). Unconfirmed exported articles show a subtle "waiting for your URL" tag (and surface in the Dashboard attention list).

### 6.3 Article detail (read-only — no editor, §9.3)

Rendered article preview (exactly as it will publish: images, links, comparison tables) + metadata sidebar: target keyword, slug, meta description, mapped families, originating opportunity, evidence-pack summary (list of products referenced), gate scores (collapsed "Quality report": per-criterion judge scores + justifications), repair/refresh history, GSC sparkline once attributed.

**State-dependent action bar:**
- `in_review`: **Approve & publish** (primary) / **Discard** (confirm dialog). No edit affordance anywhere.
- `rejected`: the rejection card (which criteria failed, judge's plain-language justifications) + **"Publish anyway"** — the §8.6 override: confirm dialog restates the failing criteria ("This draft scored low on: information gain. Publishing content below our quality bar can hurt rather than help your rankings. Publish anyway?"), destructive-styled confirm. Post-override the article carries the `override` badge.
- `published` (auto mode): link to live URL, "Request refresh" (inserts a refresh opportunity/topic into the candidate pool, subject to the §9.6.5 cooldown — within cooldown the button is disabled with "refreshed recently").
- `published` (export mode): downloads + the URL confirm/edit field.

---

## 7. Products (§6.3–6.4, §7.4 HOLD) *(new)*

The Store Intelligence layer made visible, and the home of merchant tasks.

- **Header:** data richness meter (the §3.7 component) with the plain-language note; counts: products, families, products missing key details.
- **Knowledge gaps / merchant tasks (first section when non-empty):** every open HOLD opportunity rendered as a task card: the blocked opportunity's title and impact ("Blocking: *Best trail shoes for wide feet* — high impact"), the products and the missing fields as a checklist, deep links to Shopify admin for each product, and "we re-check after your next catalog sync (daily)". Completed tasks collapse with the date and, once the opportunity proceeds, a link to what it became.
- **Families:** the read-only family list (name, member count, differentiation axes as tags, grouping-source badge, confidence flag when `embedding`/low), expandable to members with per-product fact counts. "Report wrong grouping" per family (same modal as §3.7). No split/merge (§6.4).
- **Products table:** title, family, fact count, richness band, "missing: material, dimensions" summary, last synced. Filter: sparse only.
- Empty/locked states as per §1.

---

## 8. Performance (§9.6, §12.2 main)

### 8.1 Overview

- **Not connected:** full-page connect card (Appendix A GSC copy + value framing: "See exactly which pages and articles bring you traffic — and where you can win more").
- **Connected:** headline chart — clicks + impressions since `gsc_connected_at`, markers at connect date, each article publish date, and each **OPTIMIZE applied** date (§10.4). Data-lag note fixed under the chart: "Search Console data arrives with ~2 days delay." Gaps render as gaps (never interpolated, §14.4).
- **Results table:** per attributed article *and* per store page with a completed opportunity — clicks, impressions, avg position, trend arrow, label chip (winner/neutral/underperformer for articles; improved/neutral/worse for OPTIMIZE outcomes, §9.6.10; `unrated` shows "too new to judge — we wait 28 days"). Override-published articles appear in a separate collapsed section ("Published against recommendation"), per §8.6 segmentation.
- Export-mode articles without a confirmed URL are listed greyed with the "confirm URL" inline action.

### 8.2 Search Console tab *(new — the strategy document's "Google" screen, folded here)*

- **Queries** and **Pages** tables from `gsc_query_daily` (28d default; 3m / 12m toggles): clicks, impressions, CTR, position, deltas vs prior period. Each row shows **signal badges** where an open opportunity exists (striking distance / low CTR / decay / cannibalization) linking to the opportunity — the table is an entry point into §5, not a reporting island.
- Page rows show page type (collection / product / page / blog / our article) from the content inventory (§12.3).
- Cannibalization view: query clusters with ≥ 2 competing store URLs, share of impressions per URL over time (the §7.3 validation evidence, visualised).

### 8.3 Revenue tab (V1.5, §17.3)

Placeholder not rendered in V1. When it ships: organic revenue and revenue on Sortiva-created pages, labelled "influenced/attributed".

---

## 9. Settings

Single settings area, left sub-nav. **Every setting maps to `account_settings` or an existing spec surface — this list is exhaustive; if a control isn't here, it doesn't exist.**

### 9.1 Publishing
- Delivery mode: Export (default) / Auto-publish. Switching to Auto triggers the §9.5 flow inline: write-scope OAuth → blog picker (existing blogs list, or "create a blog named ___" one-click) → enabled. The blog picker never appears anywhere else.
- Target blog (visible only when auto-publish on; change = dropdown + note "already-published articles stay where they are").
- Publish as: Live (default) / Shopify draft.
- Publish hour + timezone (defaults per §9.4; timezone = IANA picker pre-filtered to the persona country's zones, override allowed).
- Draft review toggle (default off) with one-line explanation.
- Auto-repair toggle (default on) — auto-publish accounts only (§14.1).
- *(Informational, not a toggle):* "Optimize recommendations are never applied automatically — you apply them in Shopify." (§10.1)

### 9.2 Store profile
The §3.7 confirmation screen, permanently editable (§6.8: edits never re-trigger full ingestion; keyword/competitor edits trigger their own enrichment only).

### 9.3 Connections
- Shopify: status (read-only / read+write via granted scopes), connected store handle, reconnect button when broken. No disconnect button in V1 (disconnect = uninstall from Shopify admin; say so).
- Google Search Console: connect/reconnect (property picker as §3.6), disconnect. When not connected, the Limited Intelligence explanation and the list of unavailable signal types.

### 9.4 Account
- Vacation mode toggle (§14.6) with explanation: "Pauses new articles and publishing. Your data, opportunities, calendar, and reporting stay live."
- Billing: current plan card (status incl. active / past_due, next billing date), **"Manage billing" → Stripe Customer Portal**. The three cancellation facts (Appendix A) render on the card itself.
- Email preferences (the opt-in rows of §10).
- UI language dropdown.
- **Delete account:** danger zone, type-to-confirm modal stating the §14.6 facts: tokens revoked immediately, data deleted within 30 days, "your published articles live on your store and are not touched", domain released after 7 days.

---

## 10. Notifications — channel matrix

| Event | In-app (bell + surface) | Email | Notes |
|---|---|---|---|
| Shopify OAuth abandoned 24h (§6.2) | dashboard card persists | ✔ once | |
| Ingestion complete → review ready | ✔ | ✔ | |
| **Opportunities ready (first set, §6.9)** | ✔ + navigates to Opportunities | ✔ | **the activation moment**; not toggleable |
| **New opportunities found (weekly scan)** | ✔ (bell) | in monthly summary only | per-week email would be noise; the bell carries it |
| **Optimize recommendation ready** | ✔ (bell + card state) | — | user-initiated, so no email |
| **Merchant task created (HOLD)** | ✔ (attention list + Products) | in monthly summary only | |
| Article published | ✔ | opt-in digest | daily cadence makes per-article email spammy; default off |
| Draft ready for review (§9.3) | ✔ | ✔ | only when draft review on |
| Topic held by quality bar | ✔ (calendar card) | in monthly summary only | per-rejection email would feel like failure spam |
| Monthly summary (§8.6) | ✔ | ✔ | the flagship retention email: results, what Sortiva did across action types, what it held back, next opportunities; no denominators |
| Repair action needed (export mode, §14.1) | ✔ (attention list) | ✔ | actionable, so email-worthy |
| Shopify/GSC connection lost | banner | ✔ | pipeline-stopping → email |
| Payment failed (`past_due`, §4.2) | banner (non-dismissible) | ✔ (ours, on top of Stripe receipts) | not toggleable |
| Export URL unconfirmed 7d | attention list | ✔ once | needed for their own reporting |

Email default ON: setup complete / activation, opportunities ready, draft ready for review, monthly summary, repair needed, connection lost, payment failed. Email default OFF: each published article, each quality rejection, each weekly opportunity batch. Preferences for the opt-in rows live in Settings → Account; transactional/pipeline-stopping emails are not toggleable.

---

## 11. Component & state inventory (build checklist)

- Opportunity card (5 action variants × open / scheduled / in-progress / completed / blocked / expired / dismissed states) and its condensed dashboard variant
- Opportunity detail drawer with evidence table, task list, OPTIMIZE recommendation view (current-vs-suggested rows), FIX recommendation view, HOLD task view, history
- Action badge, impact pill, confidence pill (with deterministic tooltip)
- Limited Intelligence badge + unavailable-signals list
- Merchant task card (Products) with product/field checklist
- Signal badge (Search Console tab rows)
- Topic chip (8 states: planned / checking / warning / converted / generating / in_review / outcome variants / vetoed-ghost) with opportunity chip
- Rejection reason card (§8.6) — shared by calendar, article detail, notification list
- Why-line renderer (template strings from the scoring/evidence record, §7.6 / §9.6.8 — never LLM-generated); shared by opportunity cards and calendar chips
- Enrichable chip (keyword: loading → enriched)
- Source badges (auto / manual / exploration / orders_api)
- Confirmation stepper (live `job_steps` mirror) incl. skipped-state; "finding opportunities" progress card (live `signal_runs` mirror)
- Banner stack (priority-ordered; max 2 visible, rest collapse into bell)
- Undo toast (veto, dismiss), destructive confirm modal (override, discard, delete account, cancel-mid-generation)
- Empty states: no-domain dashboard, empty calendar pre-replenishment ("your plan is being built from your growth opportunities"), articles-zero ("your first article generates on {date}"), opportunities-zero-open ("next scan runs Monday"), performance-unconnected, products-no-tasks
- Locked-nav treatment (pre-`ready_for_planning`)

All interactive surfaces emit their PostHog events per main-spec §14.7; UI-only events (veto clicked, override confirmed, calendar drag, `opportunity_viewed`, `opportunity_action_clicked` (`action`), `recommendation_copied` (`field`), `merchant_task_opened`) use the same snake_case taxonomy and domain grouping.
