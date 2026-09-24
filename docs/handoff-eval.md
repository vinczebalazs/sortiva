# Kick-off prompt — make the quality gate usable

Written 2026-09-24, after the first ever run of `pnpm eval`. **This batch comes before Batch 2 of `docs/handoff-remediation.md`**, which is about publishing an article correctly. Nothing gets that far: the gate rejects every article it can grade.

Paste everything under the line into a fresh session.

---

You are working on the Sortiva project, in `/Users/balazs/Desktop/sortiva`. The founder is away. Work the cards in order, one at a time.

## What happened, and why you are here

`pnpm eval` ran for the first time in this project's history on 2026-09-24. It is the only check on what this product writes into a merchant's store. Two of three sets failed. The full write-up is in `DECISIONS.md` under **REMEDIATION card 0** — read it before anything else, it is the brief for this batch.

The headline: **as it stands, no article would ever be published.** The gate passes an article only if grounding and information gain are 4 or better and the rest 3 or better. Across all eighteen gradeable cases the judge returned reject, including all seven the human graders considered good, almost always by scoring grounding at 3 or below where gold says 5.

| Set | Pass mark | Measured |
|---|---|---|
| distillation | F1 ≥ 0.85 | 0.811 |
| distillation | zero fabricated values | 34 of 50 flagged |
| judge | per-criterion error ≤ 0.5 | fails on four of six; grounding 1.44 |
| judge | no false passes | passes |
| persona | all ten exact | passes |

Two of the twenty judge cases produced no score at all, because the model's answer failed the shape check twice.

## The two decisions the founder has now taken

Both were open questions in `DECISIONS.md`. Record each as answered, with the date and the reasoning below, as your first act on the card that implements it.

**1. The model is shown the answer shape centrally, in the wrapper.** Not per prompt. The failure is that every prompt is told to "match the schema" and nothing gives it the means to. A central fix covers every call type at once and makes it impossible to write a new prompt that forgets. The stamping worry raised in the open question does not apply: the cache key is computed from the prompt version, the model id, the system text and the messages, so appending the schema changes the key by construction and stale answers cannot be replayed.

**2. Grounding applies to product claims, not to general statements about a category.** "Wider lasts suit wide feet" is knowledge and does not need a fact behind it. "This shoe is built on a wider last" is a claim about a product and must trace to the store's recorded facts. This is a clarification of where the line sits, delivered as a new judge prompt version. **It is not a lower bar, and you may not lower one.** The gate catching unsupported product claims is the product working: it is exactly the failure documented in every competitor in `docs/competitior_analysis.md`.

The founder has **not** decided whether the expected scores need replacing. Card 4 exists to tell them. If after card 5 the grounding gap is still wide, that question goes back to them and you stop.

## Rules you may not break

- **Gold cases are append-only.** main §14.2. Never edit or delete an expected answer to make a set green. Nothing in CI enforces this, which is why it matters.
- **The six pass marks are spec text**, in main §14.2. Lowering one is amending the spec and is not yours.
- **A prompt change is a new version file**, never an edit in place (`packages/llm/prompts/README.md`), because the version stamped on an article a year ago must keep meaning what it said.
- **Record before and after scores in `DECISIONS.md` for every prompt change.** A change that does not improve the measured score does not land.

## The order, and why it is this order

Cards 1 to 3 repair the instruments. Card 4 reads the evidence. Cards 5 and 6 change behaviour. That order is the point: this project's defining failure has been trusting a reporter that fails towards "fine", and three of the numbers above are partly artefacts of the measuring code rather than of the model.

---

### 1 — The wrapper shows the model the shape it must answer in · `packages/llm`

Every model call is validated against a JSON schema after the fact and the schema is never sent to the model: not as a tool, not as a response format, not in the prompt text. `packages/llm/prompts/judge.v2.md:56` says "Return JSON only, matching the schema exactly" without saying what the schema is, so the model guesses. When it guesses a flat object rather than scores nested under `scores`, validation fails, the one permitted repair fails the same way, and the step ends in `failed_validation`. In production that is an article paused with no score and nobody told why.

The two sets that never failed validation, distillation and persona, are the two whose prompt files print their JSON shape inline. Eleven other prompts use the judge's wording with no shape printed, including drafting, the optimise recommendation, the claim plan, the intent gap and topic classification. None of those is covered by an eval set, so the same exposure is there and unmeasured.

Inject the schema centrally, where the request is assembled in `packages/llm/src/client.ts`. Confirm as you go that `llmCacheKey` still covers whatever you add, so a cached answer from before the change cannot be replayed against the new request.

*Done when:* a call whose prompt does not print its shape still returns a valid answer, the judge set grades all twenty cases rather than eighteen, and a test proves the schema reaches the model.

### 2 — `pnpm eval` can finish, and says what it measured · `packages/llm`

Two things stop the suite being usable by anyone but its author.

It cannot finish. Each test is allowed 300 seconds (`vitest.eval.config.ts:15`) and the judge's twenty cases took 369 seconds of model time. Even with every score fixed, that set is killed by its own timeout.

It prints nothing useful. A passing set prints nothing at all and a failing one prints only the numbers that breached, which is why the first run had to be done through a throwaway script calling `runEvalSet` directly. The scores are the output; they should be visible on a pass.

*Done when:* `pnpm eval` runs all three sets to completion and prints every measured score whether it passed or failed.

### 3 — The fabrication check stops reporting things that are not fabrications · `packages/llm`

Distillation's hard fail is "zero fabricated field values" and it fired on 34 of 50 cases. Much of that is the scorer, not the model. It compares `field=value` pairs after lower-casing and reports any predicted pair absent from the expected sheet as a fabrication, which produces three false alarms that were all observed:

- a list field is joined into one string, so an answer with four of five items right is one whole fabrication rather than four hits and a miss;
- a trailing full stop makes an otherwise correct value a fabrication;
- an **empty** list where the expected sheet has items is reported as a fabrication, when nothing was invented and the model declined to answer. Three of the thirty-four are this.

Fixing the scorer is a repair, not a spec change, and not a gold change. It does not make the set easier: it makes the number mean what it says.

Once it is honest, re-run distillation and report the real figure. The substantive disagreements the first run identified, which should survive: the model repeats a fact in two fields, and sometimes reads the product title as a stated use case. Both are things the prompt already forbids in as many words, so if they remain they are a prompt problem for a later card, not a scorer one.

*Done when:* a case with an empty list and a case with a trailing full stop are no longer reported as fabrications, list fields are compared item by item, and the re-run figure is in `DECISIONS.md`.

### 4 — Why the judge and the gold disagree about grounding · no code change

The first run read one case in depth. Read every gradeable case and classify each grounding disagreement into one of three kinds:

- the judge marked down a **general statement about a category**, which under the founder's decision it should not;
- the judge marked down a **claim about a specific product** that the store's facts do not carry, which is correct and means the expected score is generous;
- something else, which you name.

Report the counts and name the cases in each. This decides whether card 5 can close the gap at all. If most disagreements are the second kind, a prompt clarification will not fix it and the expected answers are the problem, which is the founder's call and not yours.

*Done when:* every gradeable case is classified with a one-line reason, and `DECISIONS.md` says which kind dominates.

### 5 — The judge knows what a product claim is · `packages/llm/prompts`

Write `judge.v3` implementing the founder's decision: grounding asks whether every claim **about a product** traces to the store's recorded facts, and a general statement about a category is not a product claim. Say it in the prompt's own terms with an example of each, in the voice of the existing file. Move `JUDGE_PROMPT_MAJOR_VERSION` and the eval set's `promptVersion`.

Do not touch the floors and do not touch a gold file.

Re-run the judge set and record before and after. **If grounding error is still above the pass mark, stop.** Report which cases still disagree and what card 4 classified them as, and leave the gold question to the founder. Do not iterate towards a passing number: that is how a gate gets quietly weakened.

*Done when:* the judge set is re-run, the scores are recorded, and either it passes or the remaining disagreements are named for the founder.

### 6 — The writer stops claiming what the facts do not carry · `packages/llm/prompts`

The other half of card 4's second kind. If an article asserts a product specific the fact sheet does not contain, the gate is right to reject it and the writer is the thing to fix. Write `draft.v3` tightening that, and move `DRAFT_PROMPT_MAJOR_VERSION`.

**Know what you cannot measure.** The judge eval grades twenty fixed, pre-written articles, so changing the writer does not move its scores. No eval set covers the writer at all. Its effect is visible only when a real article is written and graded. Say so plainly in `DECISIONS.md` rather than implying the change was verified.

Do this card last, and only if card 4 found that kind of disagreement.

*Done when:* `draft.v3` exists, the version constant moves, the gate is green, and the journal records that its effect is unmeasured by design.

---

## How you work

**Git.** One commit per card, in the repository's style: a title saying what changed in words, a body explaining why in plain language, no spec section lists. Push as you go. End every commit message with the co-author line the session gives you.

**The gate.** Eleven commands, one at a time, never chained. `pnpm test` and `pnpm lint:prove` share a fixture and must not run together.

```
lint · lint:prove · typecheck · test · contracts:check · build · smoke:boot · smoke:dev · chaos · env:check · stubs:report
```

Plus `db:migrate` against a freshly created empty database whenever migrations change. If Postgres is unreachable, `pnpm db:up`; if Docker is not running, start it.

`pnpm eval` is separate and costs real money: about 80 model calls per full run. You will run it several times in this batch. That is expected and is the point.

**When you are blocked.** If a card needs a decision beyond the two above, write the question into `DECISIONS.md` in plain terms, skip that card, and move to the next. Do not stop the session, and do not guess at something that changes what reaches a merchant's storefront.

**Your report.** Per card: what changed, the measured before and after where there is one, and what you could not measure. For card 4, the classification and which kind dominates. Written for someone who has not read the code.

## After this batch

`docs/handoff-remediation.md` Batch 2, which is fourteen findings about the article being right and published exactly once. Do not start it in this session.
