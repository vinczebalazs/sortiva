# Content pointers taken from the Content Engine spec

Extracted from `docs/content-spec.md` (cofounder, 2026-09-01). **Only its content substance
is used here** — how an article gets researched, written, checked and kept true. Its views on
what is built, what is blocked, and how the system should be structured are set aside; its
`[SHIPPED]` / `[BUILD]` / `[BLOCKED]` markers describe a different codebase and should not be
planned from.

Everything below is a proposal against milestone M4, which has not been built. Nothing here
changes `docs/sortiva-spec.md`, `CLAUDE.md` or the work plan yet.

---

## 1. Claims are planned before the article is written

The largest idea, and the one everything else in this document leans on.

Today's design assembles an evidence pack, writes a draft from it, then asks a judge whether
the draft is grounded. That check is a model's opinion about finished prose.

The proposal inverts it. Between assembling the evidence and writing anything, the system
**enumerates every assertion the article will make** and binds each one to the evidence that
supports it. The writer then expresses an approved list rather than producing prose that gets
policed afterwards. Fabrication stops being something to detect and becomes something the
writer has no route to.

**A claim carries:** its text; its kind; the evidence behind it (which product, which page,
which quoted passage); how confident we are; how quickly it goes stale; and which sections of
the article used it.

**Four kinds, with different rules — this distinction is the point:**

| Kind | What it is | Where it may come from |
|---|---|---|
| Merchant fact | Something about this store's own catalogue or business | The store's own data only |
| External fact | Something about the world | A named outside source, with a verbatim quote |
| Derived fact | Something that follows arithmetically from other claims | Two or more claims already in the list, plus a stated rule |
| Recommendation | A judgement about fit — "for a two-person household, the 5-litre model is usually enough" | Must name the claims it rests on, and must read as guidance |

Collapsing these is exactly how a generated article ends up stating an opinion as a
specification.

**Derived facts get re-derived in code.** "Model B holds more than Model A" is arithmetic. If
the source numbers disagree, that is caught by a comparison, not by a judge.

**Claims that fail are dropped, not softened into vagueness.** A claim with weak support is
removed and recorded as a gap — which becomes something concrete to tell the merchant.

**Provenance is internal.** It is stored and queryable; it never renders into the published
article.

## 2. How the writer cites, and why a forgotten citation must fail

The writer marks each assertion inline — `The tank holds 20 litres[[c3]]` — and the markers
are stripped before publish. That makes binding a sentence to its evidence exact: no string
matching, no second model call.

**The check does not trust the markers.** It independently scans every sentence for
checkable content — numbers, numbers with units, percentages, durations, superlatives,
absolute language, attributed statements, comparisons — and **any sentence carrying checkable
content with no marker fails.** A model that forgets to cite must fail, never pass. This is
the mechanism that makes the whole claim model hold; without it, omission is the easy way out.

## 3. The strength of a sentence must match the strength of its evidence

Checkable in code, because both halves are represented.

- Strong evidence permits a direct assertion: "The tank holds 20 litres."
- Middling evidence permits only hedged or scoped phrasing: "These models are generally
  suited to smaller batches."
- Weak evidence permits nothing. Don't write the claim; log the gap.

**Words permitted only on a strongly-supported claim, and never on a recommendation:**

> always · never · must · cannot · every · all · the best · the most · the only ·
> guarantees · eliminates · prevents · ensures

Also restricted to a supported claim: any numeric threshold ("above X kg"), any duration
("lasts X years"), any rate ("produces X%").

## 4. Structure

**The answer goes in the first paragraph, before any heading.** Every article, every shape.
It serves the reader, the featured snippet, and passage-level retrieval at once, and it costs
nothing.

Our design already picks a shape from the query's intent and builds the sections of guides and
comparisons out of the product family's own differentiating axes. What this adds is **three
more shapes and, more usefully, a named failure mode for each** — the thing that makes a shape
checkable rather than decorative:

| Shape | Sections | It has failed when |
|---|---|---|
| Comparison | verdict → table → who should choose each → decision factors → products → edge cases | It refuses to recommend. "It depends on your needs" is a non-answer |
| Buying guide | the decision → selection criteria → recommended types → common mistakes → products | Criteria are missing, so the recommendation is arbitrary |
| Sizing | direct answer → size table → how to calculate → worked examples → edge cases → products | The answer is not in the first paragraph |
| How-to | outcome → prerequisites → steps → common errors → products where relevant | Steps generic enough to apply to anything; "done" is never defined |
| Troubleshooting | symptom → probable causes → diagnosis → solutions → prevention | Causes not ordered by likelihood |
| Informational-commercial | direct answer → explanation → decision implications → relevant products | It never reaches the decision |
| Category explainer | what the category is → how options differ → how to choose → the range | It becomes a catalogue listing |

**The results pages inform depth, never shape.** Copying the structure of what already ranks
guarantees an article with nothing new in it, which the information-gain bar then correctly
rejects.

**No word-count target.** Padding to reach a length is a validation failure, not a style
problem — and it is the most reliable symptom of an article that should not have been written.

**An FAQ is conditional, never a default block.** It exists when the research turned up
questions the body doesn't naturally answer. Appending six entries to every article restates
the body, trips the duplicate-prose check, and dilutes the page. Where an FAQ does appear, the
question must be the heading **verbatim** and the first paragraph beneath it must be a
complete, self-contained answer — a heading followed by "There are three things to consider:"
produces structured data that answers nothing.

## 5. Passage-level writing rules

These are language-model-independent and reader-driven, which is why they are worth fixing in
writing rather than leaving to a prompt.

1. **Self-containment.** Every section names its subject. No pronoun whose antecedent is in
   another section, no "as mentioned above". Retrieval chunks at heading boundaries; a section
   that only parses in sequence loses.
2. **Answer first, at section level too.** Extraction quotes the opening of a matched passage.
3. **One claim per sentence**, plainly stated.
4. **One name per thing.** Rotating synonyms dilutes the association between a thing and what
   was said about it.
5. **Define before use.** Every acronym expanded where it first appears.
6. **Specifics early.** Numbers, thresholds and procedures before framing — or instead of it.
7. **Survive the quote.** If one sentence is lifted with the merchant's name on it and nothing
   else, is it still true and still defensible?

## 6. Language that is banned outright

**Openings:** "In this article we'll explore…", "In today's fast-paced world", "Whether you're
a beginner or a seasoned pro", "Let's dive in".

**Filler:** "It's important to note that", "At the end of the day", "When it comes to", "That
being said".

**Vocabulary:** delve, unlock, elevate, harness, leverage (as a verb), seamless, robust,
cutting-edge, game-changer, revolutionise, supercharge, effortlessly, best-in-class, holistic,
synergy, empower, unleash.

**Structure:** restating a heading as the section's first sentence; a summary paragraph that
repeats the section above it; everything arriving in threes; uniform section lengths; a
"Conclusion" heading; rhetorical questions as transitions.

**Empty claims:** "may vary depending on your needs", "there's no one-size-fits-all answer",
"results will differ". These occupy the place where the answer goes. When something genuinely
depends on a condition, **name the condition and give the threshold.**

**Register:** no exclamation marks, no emoji, no second-person hype.

**One thing to fix before use:** the source document's filler list is half Hungarian, because
that is what it was tested against. A banned-phrase list only works in the language it was
written for, and we publish in the store's own language. This needs a per-locale list, and the
list for each new language is real work — not a translation of the English one, because the
tells differ.

## 7. Checks, cheapest first

The ordering is the substance: a draft with a broken table should never cost a model call.

**Free and exact, run first:**

- Every sentence with checkable content carries a citation (§2)
- Each cited claim actually matches its evidence; derived facts re-derived arithmetically;
  external facts have their quote present verbatim
- Assertion strength matches evidence strength (§3)
- Malformed markdown; ragged table rows; duplicate headings; skipped heading levels; broken
  links; unresolvable or duplicated product references; invalid structured data; unclosed
  inline markup
- No internal metadata — provenance, quality results, link reasoning — leaked into the body
- Volatile values (§9) appearing as literal text
- The checks we already have: near-duplicate prose against the store's other articles,
  duplicate topics, excluded topics, metadata length budgets

**Then the paid checks**, on what survives.

**One repair attempt, then stop.** A second repair on a draft that failed grounding twice is
not converging on truth; it is searching for phrasing that evades the check.

## 8. Two things worth judging that we don't judge today

**Does the document contradict itself?** An article that says "above 300 kg" in the
introduction and "above 200 kg" in section four passes every sentence-level check, because
each sentence is individually fine. Catching it means extracting every number, threshold,
recommendation and absolute statement, grouping them by what they are about, and requiring
agreement — deterministically. Only genuine candidate conflicts go to a model, to decide
whether two statements are scoped differently or actually disagree. This is the failure that
embarrasses a merchant most, and we have no check for it.

**Does this help someone decide what to buy?** Distinct from "is it accurate" and from "is it
new". It asks whether the decision is identifiable, whether the attributes that matter are
covered, whether trade-offs are stated, whether products are matched to situations, whether
the next step is obvious — and whether it has quietly become a sales pitch.

The document's other four judging criteria are ours already.

## 9. Keeping an article true after it is published

**Volatile values never appear as literal text — decided, see §11.** Price, stock, sale status
and product URL are stored as a reference and resolved at the moment of publish, against the
platform rather than against research. The reader still sees a real figure; it is simply always
the current one. The prose is stable; the values are not; separating them in storage is
what makes commerce content maintainable at all.

Resolution rules: if the product is gone, the publish fails and a repair is raised. If the URL
changed, use the new one. Price, availability and title render from current values. **Never
resolve from the research snapshot — the snapshot is research, the platform is truth.**

This has a product consequence, flagged in §11.

**Diagnose before rewriting.** A refresh that starts by rewriting is guessing. Requiring a
typed cause makes the scope of work follow from the diagnosis:

| Cause | What actually needs doing | Cost |
|---|---|---|
| References went stale | Re-resolve them | No model call |
| Catalogue changed | Update the affected passages | One cheap call |
| Claims aged out | Re-verify claims; rewrite what lost support | Cheap, targeted |
| Competitors improved | Add depth where they gained | Targeted |
| The results page turned over | Re-run research; restructure if intent moved | Full research |
| The query now wants something else | Restructure, or abandon and redirect | Full |
| Ranking lost entirely | Full diagnosis; consider consolidation | Full |

**On refresh, every claim is re-checked**: still supported → keep; support weakened → soften
to what is supported; support gone → remove and rewrite the passage; contradicted by new data
→ that section must be rewritten.

**Among catalogue changes, a changed specification is the urgent one** — it is the only event
that can make a published claim *false*. Everything else merely makes one stale.

## 10. Refusing well

A refusal should be as structured as a success. Each one carries a code, a plain-language
message for the merchant, a specific fix where one exists, and — the part we don't have — a
**retry condition**: retry automatically when the catalogue updates, or when the results are
re-checked, or never.

That last field is what turns "we held this back" into something that resolves itself when the
merchant acts, instead of a dead end they have to remember to revisit.

The codes worth having: a suitable page already exists · would compete with an existing page ·
intent mismatch · not enough product data · not enough evidence · nothing new to say · claims
couldn't be grounded · the article contradicts itself · too little search demand · not
winnable · duplicate topic · product references won't resolve.

A worked example of the tone, which is the part that matters:

> **We don't yet have enough concrete information about these products to write this
> comparison reliably.** Add material, dimensions and capacity to these 11 products — we'll
> retry automatically once they're updated.

Two rules that go with it, and match how we already work: a hold is not a failure — it pages
nobody and counts against no retry budget; and every merchant-facing message renders from a
template over the stored record, never written by a model, so it is always true.

## 11. Where this cuts against a decision already made

**A price change used to cost a day's article. Decided 2026-09-01: it no longer does.**
Under §9's reference model the article is never wrong in the first place — a price change costs
a re-render of one passage and no slot at all, and that day goes to new content instead. The
price-drift trigger that fed the refresh queue is retired. Journalled in `DECISIONS.md`; it
contradicts the drift table in the main spec as written, and is taken on founder authority.

Two things travel with that decision. **Prose may not build an argument on a price** — "the
cheapest in the range", "the best option under €100" — because a figure rendering correctly
does not make a sentence reasoning about it true; those articles would still go stale, and
would still cost a day. And **the out-of-stock trigger is unchanged**: a product unavailable
long enough that the recommendation itself is wrong is a prose problem, not a value problem,
and still earns a refresh.

**Still open — an article with nothing new to say gets a repair attempt it cannot use.** Today every
quality failure gets exactly one repair attempt. The proposal is that "nothing new to say" is
rejected outright with no attempt, because the deficiency is in the evidence, not the writing
— you cannot rewrite your way into having something to say. I'd take it. It is a narrow change
to one criterion, not to the repair rule, and it saves a wasted expensive call on every
article that was never going to be worth publishing.

Everything else here is additive.

## 12. Where each piece lands

Content generation is milestone M4 and has not been built, so these can shape the cards rather
than be retrofitted.

| Piece | Card |
|---|---|
| Claim records with provenance; product reference tokens | **T4.0** — schema wave 3 |
| Claim planning before drafting; structure shapes; answer-first; FAQ conditionality | **T4.3** |
| Citation binding, strength-vs-evidence, contradiction check, expanded free checks | **T4.4** |
| Reason codes with retry conditions | **T4.1** (admission) and **T4.4** (draft failures) |
| Typed refresh diagnosis and scope | **T5.3**, **T7.2** |
| Publish-time reference resolution and freshness re-check | **T5.1**, **T5.2** |

**T4.0 is the deadline.** Migrations are only added by schema-wave cards, so if the claim
model and the reference tokens are wanted, that has to be settled before that card is written,
not after.

Every number that arrives with these ideas — similarity cut-offs, how much of a product range
must carry an attribute before a comparison is defensible — belongs in `packages/rules` with a
plain note saying what it decides, like every other threshold.
