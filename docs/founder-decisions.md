# Decisions needed before Sortiva goes live

> ## This document is a launch gate
>
> **Sortiva is not finished — and must not be presented as finished, launched,
> or shown to a paying merchant — while any item marked ▲ below is unresolved.**
>
> "All the code is written and every test passes" is not the same as "ready".
> Every ▲ item is something no amount of engineering can settle: a price nobody
> has set, a vendor rate nobody has confirmed, an account nobody has created, a
> policy nobody has written. A build that is complete in every other respect
> still cannot take a real merchant's money or read a real merchant's store
> until these are answered.
>
> The unmarked items are real but softer — they shape the product rather than
> gate it.
>
> See **Definition of done** at the end for the checklist.

Everything on this list is **currently unblocking**. Development continues at
full speed without any of it. Each item names the point at which it stops being
optional.

Written to be read without opening the code or the specs. Where a spec section is
cited it is evidence you can check, not the explanation.

Four sources feed this list: numbers the specs required but never stated,
defaults the specs assumed and flagged for your sign-off, accounts and
credentials nobody but you can create, and a few process choices.

---

## How to use this

Each item has a **recommendation**. If you agree with all of them, the fastest
useful reply is "all recommendations accepted except N, M — here's what I want
instead."

Items are ordered by when they start to hurt, soonest first.

---

# A. Needed within the next few weeks

## A1. ▲ Credentials and accounts

Nothing here is a judgement call — it's provisioning only you can do. But three
lanes are about to need them, so this is the most time-sensitive item on the
page.

Each becomes blocking at the card named. The agents never see live keys; they
work against test modes and fake vendors.

| What | Needed for | Blocking at | Notes |
|---|---|---|---|
| **Stripe** test mode + test clocks | Billing, plan screen | Lane A, now | Live keys only in production, much later |
| **Cloudflare Turnstile** site + secret key | The public preview's abuse protection | Lane A, now | Free tier |
| **Anthropic API key** | Every AI call | Lane A, now | The preview card is the first real usage |
| **Shopify Partner dev store** | Connecting a store, reading a catalog | Lane B, ~1 week | A test store with realistic products |
| **PostHog project** + personal API key | Cost tracking, dashboards | Lane B, ~1 week | Free tier covers early volume |
| **DataForSEO account** | Keyword volumes, search results | Lane B, ~3 weeks | Dev and staging use a fake; real spend only in production |
| **Google Search Console** test property | Reading real search performance | Lane C, wave 2 | Needs a site you control with real history |
| **Resend account** + verified sending domain | All outbound email | Lane G, later | SPF, DKIM and DMARC verified before the first production send |
| **Railway project** | Hosting | Deployment | See A4 |

**Recommendation:** provision the first three this week, the next two next week.
The rest can follow the lanes.

## A2. ▲ The domain Sortiva itself runs on

Not a merchant's domain — ours. Three things need it and two of them are slow to
change once set.

- **The app's address**, which every OAuth redirect is registered against.
  Changing it later means re-registering with Shopify, Google and Stripe.
- **A dedicated sending subdomain for email** (something like
  `mail.sortiva.com`). The spec is specific about this: product email goes out
  from a subdomain so its reputation is isolated from the root domain. If a batch
  of our email gets marked as spam, it must not poison ordinary mail from the
  main domain. (tech §1.4)
- **A support address and a waitlist address.** Two screens the merchant actually
  sees need real addresses behind them: the "this domain is already connected to
  another account — contact support" error, and the "we only support Shopify —
  contact us or join the waitlist" parked state. Right now they point at a
  placeholder.

**Recommendation:** decide the domain now even if the marketing site isn't ready.
Everything else can be a redirect later; these three cannot.

## A3. ▲ What DataForSEO actually charges us

DataForSEO is the vendor we buy keyword volumes and search-results data from.
They bill per request at different rates per endpoint.

I put three prices in the code as **guesses**, clearly marked: 5¢ per
keyword-volume lookup, 0.2¢ per search-results check, and 1.1¢ plus a per-row
charge for looking up a competitor's ranked keywords. An endpoint with no price
fails loudly rather than reporting zero.

Two things depend on these being right: the daily spend cap that pauses work when
something runs away, and the "what is this store costing us" reporting that the
whole unit-economics picture rests on. **If they're wrong by 10×, the cap is
wrong by 10× and nobody notices until the bill arrives.**

**Blocking at:** the first real DataForSEO spend, which is production only.

**What I need:** the real per-endpoint rates from your account.

## A4. ▲ Authorising the hosting spend

Railway is the hosting provider. Your account is authenticated but I have never
deployed, because deploying creates real infrastructure that bills you and you
asked me to leave it.

The configuration is written and committed: one application service with memory
capped so a leak crashes loudly instead of quietly inflating the bill, a health
check, and no scale-to-zero (the public preview page is the top of the funnel and
a cold start would kill it). The database comes from Railway's own template
because Railway can't declare databases in repository config.

Expected cost at early scale is **$10–15/month total**.

**Blocking at:** the first deploy — which also unblocks the browser test suite
running against something real, and staging environments for review.

**Recommendation:** authorise it now. It is small, it is reversible, and several
things get easier the moment a deployed environment exists.

---

# B. The numbers I invented

The specs say "there is a configurable threshold here" and never say what it
should be. The cards required the settings to exist, so I picked starting values
and marked every one `UNSIGNED` in the config file.

**None of them is read by anything yet.** Each is a one-line edit until the
feature that consumes it is built. They live in one file so the product's
standards are reviewable in one place rather than scattered through the code.

## B1. ▲ Demand floor — the one worth actually thinking about

**What it does:** the minimum monthly Google search volume a keyword needs before
Sortiva will write an article about it. Below the floor, the topic is held back.

This directly decides which topics get admitted, so it is visible to the
merchant — they see "we held this back" and the reason. Set too high, a Danish
store gets almost nothing. Set too low, we write articles nobody searches for.

The spec requires it to vary by language — "50/mo in Danish ≠ 50/mo in English" —
and gives no table. I set English at 100/month and scaled down roughly by market
size:

| Monthly searches | Languages |
|---|---|
| 100 | English |
| 60 | German, French, Spanish |
| 50 | Italian, Portuguese |
| 40 | Dutch, Polish |
| 20 | Swedish, Danish, Norwegian, Finnish, Czech, Hungarian, Romanian, Greek |
| 15 | Slovak |
| 10 | Slovenian, Estonian, Latvian, Lithuanian |

**Blocking at:** the first topic admission gate, wave 2.

**Recommendation:** these are reasonable starting points, but they're my
judgement about markets you know better than I do. If you have a view on which
markets Sortiva sells into first, that view should set these.

## B2. The other eight

| Setting | What it decides | My value |
|---|---|---|
| **Winnability fallback** | How likely we assume a store is to rank when Search Console isn't connected and we have no evidence. Scale 0 (hopeless) to 1 (certain). The spec says "a conservative constant". | 0.25 |
| **Substance floor** | How much concrete product information a topic needs behind it before we'll write about it — the guard against thin, padded articles. | 8 distinct facts, from ≥3 products, each with ≥4 populated fields |
| ▲ **AI spend cap, per store per day** | Pauses that store's generation. A loud-failure ceiling, not a budget — a $89/mo plan earns about $2.90/day, so $5 means something has gone badly wrong. | $5 |
| ▲ **Keyword-data spend cap, all stores per day** | Pauses enrichment globally. | $50 |
| ▲ **Preview spend cap per day** | Pauses the public preview only. Deliberately tight: the spec says this tripping at all means the anti-abuse measures are being defeated, so investigate rather than raise it. | $10 |
| **Intent-gap analyses per store per day** | Caps an AI analysis the spec requires be capped without saying at what. | 10 |
| **"Impressions not collapsed"** | When judging whether a page improvement worked, don't credit a click-rate gain if impressions halved. | 0.5 |

**Blocking at:** each becomes real when its feature ships — waves 2 to 4.

**Recommendation:** accept as starting values. The three spend caps are the ones
to revisit once you see a month of real usage; they're set to catch runaway
failure, not to ration normal work.

---

# C. Defaults the spec assumed, awaiting your sign-off

The main spec's Appendix B lists nine decisions it made on your behalf and
flagged for confirmation. The build plan's own kickoff checklist says these
should be signed off before the first agent session — that already slipped, but
harmlessly: M0 built infrastructure and touched none of them.

**They start mattering in wave 2.** Six specific cards assume them.

| # | Decision | The default | What changing it would cost |
|---|---|---|---|
| C1 | **Search Console at onboarding** | Soft-required. A merchant can skip it and the product runs in "Limited Intelligence" mode with a visible badge. | Making it mandatory is a smaller build but loses merchants at the door. Affects Lane C. |
| C2 | **How page improvements are delivered** | We write the recommendation and the merchant applies it in Shopify. We never edit their pages. | Editing directly needs write permission on merchant-authored pages — a much harder trust conversation. Deliberately deferred. |
| C3 | **Showing revenue** | Capture the data from day one, display it in a later version. | Displaying at launch risks attributing revenue we can't yet defend. |
| C4 | **Which technical problems we fix** | Three: broken product references (fixed automatically), keyword cannibalisation (recommended), and missing or duplicate titles (recommended). Everything else is detected but not acted on. | Widening this is the classic scope creep on an SEO product. |
| C5 | **How opportunity size is shown** | High / Medium / Low, with the actual numbers beside it. | A dollar estimate is stronger UX but early fake precision is dangerous — and hard to walk back once shown. |
| C6 | **Competitor model** | One list the merchant sees, capped at 5. Competitors found in search results are *suggested*, never added automatically. | The cap is the main cost lever on the most expensive thing the product runs. |
| C7 | **Page-improvement generation cap** | 2 per store per day. | Bounds AI spend on a user-initiated action without feeling rationed. |
| C8 | **Navigation** | Six screens: Dashboard, Opportunities, Content, Products, Performance, Settings. | The alternative was eight. Fewer screens, saner mobile. Affects Lane F, now. |
| C9 ▲ | **Launch price** | $89/month, 20% off annual. | The spec itself says this isn't final — it argues the product belongs in a $149–$399 band once AI visibility, revenue intelligence and technical execution ship. Price IDs are configuration, so repricing is a Stripe change, not a code change. |

**Blocking at:** C8 is live now (Lane F is building navigation this week). C1,
C4, C5, C6 land in wave 2. C9 blocks the first real charge.

**Recommendation:** confirm all nine as they stand. They're internally consistent
and each one's rationale holds. **C9 is the one to revisit before launch, not
now** — the price is a configuration value and the spec's own argument for a
higher band is worth taking seriously once the product is real.

---

# D. Process decisions

Two of these are mine to flag rather than yours to design — but bending a process
rule quietly is how the rule stops meaning anything.

## D1. A database table added outside the process that governs them

Only designated "schema wave" cards may change the database structure — the rule
exists so parallel agents never collide on the schema. Card T0.3 was the schema
wave. Card T0.4 was not, and it added a table anyway.

The table is `job_dlq`, a **dead-letter queue**: where permanently-failed
background jobs land so a human can see them and re-run them. Without it, a
catalog sync that fails at 2am simply stops, the merchant's onboarding hangs, and
the only symptom is that nothing happens. The spec describes this behaviour in
detail but its data-model chapter never lists a table for it, and T0.4's
completion criteria explicitly required one.

It landed minutes after the schema wave, in the same milestone, by the same
session — so no other agent could have been affected.

**Needed from you:** nothing, really. This is for whoever plays integrator to
either fold into wave 1 or accept as a small extra wave. **No code changes either
way.** It's here because the rule matters more than this instance of it.

## D2. Four quality-bar numbers in a file my card didn't authorise

Before Sortiva publishes an article, a separate AI grades the draft on several
criteria, 1–5 each. Two are hard floors at 4 — *does this say anything the search
results don't already say*, and *is every product claim traceable to real catalog
facts*. The others need 3. The writer gets exactly one revision attempt.

**Those four numbers are the quality bar.** The house rule is that every
threshold lives in one config file, never hardcoded.

My card listed which spec sections' numbers to move into that file, and the
draft-grading section wasn't on the list. But there is no other home for them, and
the automated check that catches stray thresholds only recognises search-related
field names — not judge scores. Leaving them out would have let the content
engine hardcode them invisibly.

**Needed from you:** keep or revert. Reverting is deleting one block from the
config and one from its schema; nothing reads them yet.

**Recommendation:** keep. The alternative is the quality bar being invisible.

## D3. Who plays integrator

At each milestone boundary someone merges the lane branches in order, runs the
exit gate, runs the invariant sweep, and triages the decision journal. The build
plan recommends **a founder for the first two milestones**, then an agent session
once the pattern is established.

**Blocking at:** the end of wave 1, a few weeks out.

**Recommendation:** you take M1 and M2. The judgement calls at a merge boundary
are exactly the ones an agent shouldn't be making unsupervised, and after two
rounds the pattern is mechanical enough to hand over.

---

# E. Before the first real merchant

Not decisions so much as work nobody has scheduled yet. Flagging them now because
each has a lead time.

## E1. ▲ Shopify app listing

Connecting to a real merchant's store means a listed Shopify app, which means
meeting Shopify's requirements: the privacy webhooks (already specified and
scheduled for a later card), a privacy policy, support contact, screenshots,
and review. **Shopify review takes weeks, not days.**

**Blocking at:** the first merchant who isn't you.

**Recommendation:** start the listing paperwork when Lane B's Shopify connection
works against the dev store — roughly two to three weeks out. Don't wait until
the product is finished.

## E2. ▲ Privacy policy and terms

The product holds a Shopify access token and a Google token on the merchant's
behalf, and reads their store's order data. It deliberately holds **no customer
personal data at all** — customer fields are stripped at read time before
anything is stored, which is why the privacy webhooks can honestly answer "no
data held".

That's an unusually clean position and worth stating plainly in the policy rather
than burying it.

**Blocking at:** the Shopify listing.

## E3. Whether the canonical copy is right

About a dozen exact sentences are load-bearing — they're used verbatim, held by
snapshot tests, and repeated across screens. The pricing line ("Up to 1 article
per day, quality permitting"), the Shopify read-only reassurance, the outage
message, the cancellation facts.

They're written to do specific jobs: the pricing line promises quality rather
than a count, the read-only line addresses the single biggest reason merchants
hesitate.

**Blocking at:** nothing — but they're cheap to change now and annoying to change
after Lane F has snapshot-tested every screen against them.

**Recommendation:** read the main spec's Appendix A once, in one sitting. Twelve
rows. If any sentence makes you wince, now is the moment.

---

## Summary: what actually needs an answer soon

Everything above is unblocking today. In practical order:

1. **This week** — Stripe test keys, Turnstile keys, Anthropic key (A1).
2. **This week** — the domain Sortiva runs on (A2).
3. **This week** — authorise the Railway spend, or say no (A4).
4. **Next week** — Shopify dev store, PostHog project (A1).
5. **Before wave 2** — confirm the nine assumed defaults (C), or say which change.
6. **Before the first real spend** — DataForSEO's actual rates (A3).
7. **Whenever** — a nod on the invented numbers (B), and keep-or-revert on D2.

The two genuinely reversible-but-annoying ones are the domain (A2) and the
canonical copy (E3). Everything else can move later without much cost.

---

# Definition of done

The build plan's final milestone (M10) has four exit gates — the nightly
crash-injection test, the invariant sweep, the decision-journal audit, and the
Shopify dev-store smoke suite. Those prove the *software* is correct.

**They do not prove the product can launch.** This section is the fifth gate.

Tick every line before Sortiva is described as finished, shown to a paying
merchant, or listed on the Shopify app store. An unticked line is not a
nice-to-have deferred — it is a product that cannot legally, financially or
technically operate.

**Money**
- [ ] Launch price set and Stripe price IDs created for monthly and annual (C9)
- [ ] Stripe live keys in the production secret store, webhook endpoint registered
- [ ] DataForSEO real per-endpoint rates in the price map, replacing my guesses (A3)
- [ ] The three daily spend caps set against those real rates (B2)

**Identity and access**
- [ ] The domain Sortiva runs on, decided and live (A2)
- [ ] Sending subdomain verified with SPF, DKIM and DMARC — before the first
      production email, not after (A2)
- [ ] Real support address and waitlist address behind the two screens that
      promise them (A2)
- [ ] Production accounts provisioned: Shopify app, Google OAuth client,
      DataForSEO, Resend, PostHog, Anthropic (A1)
- [ ] Encryption master key generated and stored in the deploy secrets — the
      merchant tokens are unreadable without it, and unprotected without it

**Infrastructure**
- [ ] Railway spend authorised and production deployed (A4)
- [ ] Railway spend alert set at 2× the expected bill

**Legal and platform**
- [ ] Privacy policy and terms published (E2)
- [ ] Shopify app listing submitted **and approved** — weeks of lead time, not
      days (E1)
- [ ] Shopify privacy webhooks verified against the real listing

**Product judgement**
- [ ] Per-language demand floors signed off, or replaced (B1)
- [ ] The nine assumed defaults in Appendix B confirmed or changed (C)
- [ ] The canonical copy strings read once and approved (E3)

**Note for whoever plays integrator:** this checklist belongs alongside M10's
other exit gates. It is currently a document rather than a card in
`docs/agent-work-plan.md`, which means nothing mechanical enforces it — adding it
as `T10.5` would give it the same standing as the other four. That is a change to
the build plan, so it is the integrator's call, not mine.
