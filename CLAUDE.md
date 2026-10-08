# Sortiva

An app a merchant installs on their Shopify store. It reads the catalogue, works out what the store can credibly write about, writes at most one article a day when it has something worth writing, and publishes it to the store's blog or hands it over as files. Google Search Console shows what worked. DataForSEO supplies demand and rankings. English and Hungarian.

The brief is in `docs/`: `mvp-plan.md` (what and why), `mvp-ui.md` (every screen), `mvp-build-plan.md` (order and checkpoints). Decisions go in `DECISIONS.md`, dated, one plain paragraph each.

**The scenario suite is the source of truth.** A stage is done when its scenarios pass, not when its code exists.

## Eight rules

Each one maps to a way this product can silently harm a merchant or us.

1. The writer only ever sees fact sheets, never raw product descriptions.
2. Every product claim and every number in an article cites a fact, and the check is mechanical.
3. No link in an article leaves the store's domain.
4. At most one article per store per day, keyed on the store's own calendar day.
5. Publishing is two-phase, and an update never falls back to create.
6. We never overwrite anything the merchant edited or wrote.
7. Every external call is cached and priced before it is made, and every store has a daily cap.
8. Nothing degrades to a smaller model, stale data or a forced publish. It pauses and says why.

## Layout

```
app/         embedded screens and routes — thin: parse, call core, render
core/        pipeline stages as plain functions; imports no framework and no vendor SDK (a test proves it)
connectors/  StoreConnector interface; shopify/ is its first implementation
vendors/     dataforseo/, google-search-console/, anthropic/ — each with a cache and a cost ledger
db/          one schema file until launch; the test-database helper
jobs/        Graphile Worker tasks, one per stage, plus sweepers
fakes/       fake-shopify/, fake-dataforseo/, fake-google/, fake-anthropic/ — HTTP servers with recordings/
scenarios/   fixture stores and the pipeline suite
evals/       graded cases, English and Hungarian halves, and runners
docs/        the brief, DECISIONS.md
```

## Working rules

- `/Users/balazs/Desktop/sortiva-old` is the previous build. Read it for behaviour and for the cases its tests enumerate. Copy nothing from it: no code, no prompts, no test cases, no copy strings.
- No fake response is written from memory. Every fake response descends from a recording or from the vendor's published schema (`docs/mvp-plan.md` §6.6).
- Comments say what the code cannot: intent, a constraint from outside the file, a tradeoff. No narration.
- Commit messages say what changed, in words. Commit when a scenario goes green, not before.
