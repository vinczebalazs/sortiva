# Kick-off prompt for the next integrator session

Written 2026-09-04, 02:20, by the integrator session that ran the night of 3–4 September.
Replaces the previous version. **Eight cards and two audits landed; the build is now blocked
on the founder, not on capacity.**

Paste everything below the line.

---

You are the integrator for a build run on the Sortiva project, in `/Users/balazs/Desktop/sortiva`. You launch lane sessions, merge what they land, run the gate, and keep the state file honest. **You do not build cards yourself.**

## Read these before doing anything, in this order

1. **`CLAUDE.md`** — the constitution. It overrides your defaults.
2. **`docs/overnight-run.md`** — operating rules, including a list of things you may never do without asking. Treat that list as absolute.
3. **`docs/overnight-state.md`** — where everything stands. Read **"Right now"** first, then the two newest entries in **"Audit findings, unactioned"** (`T6.2` and `T5.2` — between them they carry two CRITICALs), then **"Questions waiting on the founder"**. It carries a warning about being damaged by scripted edits: run `grep -n '^## '` after every edit and diff the heading list against the previous commit. That check caught a real loss once and has been run after every edit since.
4. **`docs/agent-work-plan.md`** §3 (lane ownership), §7 (audit schedule), §8 (session mechanics), §9 (standing rules).

## Where things stand

`main` is at `10c9a09`, clean. Tests **3,265**, up from 3,049. **M2, M3, M4, M8 and M9 are closed. M7 is deferred out of v1.** M5 and M6 are each one card from complete, and **both of those cards are blocked or stopped.**

**There is no card you can dispatch today without a founder answer.** That is the single most important fact here. Four lanes are idle and correctly so. Do not invent work to fill them.

## ⚠️ The gate is ELEVEN commands and TWO are deliberately red

Run them one at a time, never chained. `pnpm test` and `pnpm lint:prove` must never run simultaneously (a shared-fixture race).

`lint` · `lint:prove` · `typecheck` · `test` · `contracts:check` · `build` · `smoke:boot` · `smoke:dev` · `chaos` · `env:check` · `stubs:report` — plus `db:migrate` against a **freshly created empty database** whenever migrations changed. No migration landed tonight.

- **`pnpm eval` is red and must stay red** until founder question 6 is answered. Three eval sets refuse to grade against a stand-in and there is no Anthropic key. **A report claiming "eval passes" is false.** Confirmed tonight by reading the failure text: exactly those three sets, for exactly that reason.
- **`pnpm chaos` is NINE scenarios now, and red on ONE NAMED ONE** — `generation_cycle_killed_across_midnight`, a deliberate reproduction of a real defect (founder question 17). **The other eight pass, so a failure anywhere else in `chaos` is a genuine regression.**
- **If anyone touches `apps/web/instrumentation.ts`, the import must stay inside the `NEXT_RUNTIME === 'nodejs'` check.** Hoisting it silently restores a defect where every dev page returned 500, and only `smoke:dev` catches it.

**The concurrent-load flake is real, and this run triangulated it four more times.** Under three lane sessions, `pnpm test` failed 8, then 11, then 12 suites on 10-second hook timeouts **with zero failing tests**; quiet, the same tree passed 239/239 in 44 seconds against 110. There is a second shape too: every test passing with a non-zero exit on one Postgres `57P01` teardown error. **Re-run once before investigating — but re-running is not ignoring**, and one lane found a genuine regression underneath a flake earlier in the project. It belongs to whoever next touches `packages/db/src/testing.ts`.

## What the founder must decide before anything moves

Ordered by what they unblock.

### 1. The schedule is ONE STRING RENAME from being switchable on — and it looks fine

**This is the most valuable thing the night found, and it is in the `T5.2` audit entry.** The worker enables **no** scheduled job unless **every** scheduled entry has code registered under exactly that name; one mismatch disables the lot, with a single log line. Founder question 4 chose to wait for four named entries rather than relax that rule. **Three landed. The fourth was `T5.2`'s, and `T5.2` registered its handler as `publish_recovery_sweep` while the schedule has said `publish_intent_recovery_sweep` since M0.**

It is now the **only** mismatch — verified by diffing the whole schedule against every registered handler, including checking and discarding a false second one. **The lane's own note about it was wrong twice**: it said the schedule had no entry (it has had one since M0), and the fix it wrote down would have left two entries with one still unanswered.

The fix is renaming the constant at `packages/jobs/src/publish/tasks.ts:34`. **It is an audit finding, so it needs the founder's word.** Ask.

**And ask the second half:** today a name mismatch *disables* the schedule; it should *fail*. A reporter that cannot fail is an invariant without teeth wearing a green tick — `T10.2`'s home.

### 2. `T6.3` is STOPPED and `T5.3` is BLOCKED

- **`T6.3`** (M6 exit gate) — stopped by the `T6.2` audit. Its done-when drives an OPTIMIZE opportunity through its states, and the state graph it will read does not contain the transitions `T6.2` performs. The auditor judged **the code right and the graph wrong**. Correcting the graph is acting on a finding, and it is Lane C's file.
- **`T5.3`** (M5 exit gate) — its whole input is the `CatalogEvents` change stream, whose reader the founder deliberately left unwired to be judged together with switching the recurring schedule on. **Those two questions are now the same question** — see item 1.

### 3. Three registrations are built and wired to nothing

Each is one line in `apps/web/instrumentation-node.ts`, each held deliberately, each for a different reason. **Do not wire any of them without asking.**

- **`T6.2`'s OPTIMIZE job.** Held because wiring it makes its own CRITICAL *reachable*: pressing the button marks the opportunity busy before queueing, the daily allowance counts busy rows as spent, and the state guard blocks retry — so **two presses permanently disable OPTIMIZE for that account**, recoverable only by editing the database. A refusal or crash mid-generation leaves the identical state, so **that defect survives fixing the wiring.**
- **`R-INTENTGAP-JOB`'s pass.** Held because the line needs an Anthropic client and the only one in the process is private to another lane's config. Either that factory is exported, or the composition root builds one and hands it to both. **The lane deliberately declined to build a second one** — the right instinct.
- **`T5.2`'s recovery sweep** — already registered; it is item 1's rename that it waits on.

### 4. Three contract divergences, and nothing can detect any of them

`T6.2` built four routes, `T5.1` one, `T5.2` five — **ten endpoints at addresses the frozen route table does not know about**, while the table declares several with no implementation. `pnpm contracts:check` passes throughout, because it compares the schema table to the generated OpenAPI document and **never to the routes on disk.**

The root cause is structural: the contract's addresses live under `apps/web/app/api/settings`, **a directory no lane owns and no card builds**, so each lane builds in its own ground and the gap widens. **Three cards have now deferred it.** It is a question of which lane gets that ground, not a coding question.

**It blocks Lane F.** Its mock server is generated from that table, so the Settings screen would 404 on five endpoints, and its "grant posting permission" button points at the **read-only install flow** — which would loop for ever without ever granting write access.

### 5. Question 6, the Anthropic key — costed, and the founder already chose to do it

**About 40 cents a run**, on its own gate rather than every commit. **The action is the founder's alone:** a real key on the blank `ANTHROPIC_API_KEY=` line in `.env` (line 33). Never ask them to paste it into a session; never write one into `.env.example`. Once it exists, run `pnpm eval` and report the accuracy figure, whether anything was fabricated, and which languages are weakest in plain terms. A failure is the more useful outcome.

### 6. Everything else

**Fifteen open questions** in the state file. New tonight, from the two audits: whether every posted article should carry a visible `sortiva-<id>` tag in the merchant's own Shopify admin; whether a republish may overwrite the merchant's own edits, tags and their choice to unpublish; whether auto-published articles ship with no images; whether the grader's verdict is final with no second chance; whether a recommendation may be grounded **entirely in what competitors say**; and where model prose may reach a merchant at all. Question 13's second half is still open.

## Traps that have already cost time — carry all of them

- **Do not take a lane's report at face value, and do not take an audit's either.** Tonight one lane's note about the schedule was wrong twice, and one audit claimed a mismatch was the only one when a first check suggested two — **the audit was right and the check was scoped too narrowly.** Verify anything whose truth would change what you do next; reading the diff and re-running the assertion takes minutes and has caught something nearly every time.
- **A lane will edit integrator-resolved files even when told not to.** `T5.1` edited `crontab.ts` and `instrumentation-node.ts` after being told to write the lines into its report instead. Both edits were correct and were kept **after line-by-line review**. Tell the next lane in that lane explicitly, as this session did — `T5.2` then obeyed.
- **Two cards can independently create the same export or edit the same file.** `R-ARTICLES` and `R-DELIVER` collided on `packages/db/src/repositories/articles.ts`; the resolution was the import line only, and both sides' work was verified present **by name** before the gate was re-run.
- **A lockfile or workspace-dependency change needs `pnpm install` after merge**, and in each lane worktree — two lanes hit a missing `@sortiva/rules` link tonight.
- **`packages/ui/strings/en.json` is not union-merged.** Keep additions contiguous and insert mid-file.
- **`packages/rules` changes `rules_version` for every lane**, because it is a hash of the file.
- **`.env` is gitignored and per-worktree.** Refresh a lane's copy only once its branch also carries the matching `.env.example`.
- **Rate limits end runs.** Schedule a wake-up for the reset time. **The machine sleeps and kills sessions** — `caffeinate -dimsu -t 21600`, and check `pgrep -fl caffeinate`.

## The pattern that keeps recurring: reporters fail towards "fine"

Now with four more instances from tonight, and it is worth stating as a class rather than a list. **The mechanism that tells you whether something is finished keeps being the broken thing, and it always fails reassuringly:**

- **A name mismatch *disables* the schedule instead of failing.** Green everywhere.
- **`contracts:check` never compares the contract to the routes on disk.** Ten endpoints diverged; it passed every time.
- **`seams-wired.test.ts` only covers class-shaped stand-ins**, so the two stubs removed tonight were outside it entirely.
- **The chaos suite discards `result.kills`**, so a scenario whose kill never fires looks exactly like one that passes.

Two counter-examples worth copying, both from tonight: `R-INTENTGAP-SCAN`'s guard file **asserts up front that it found files to check** before forbidding anything, and its end-to-end test **measures** that the search provider recorded zero calls rather than asserting it. **`T10.2`'s done-when is already "zero invariants without teeth" — this is its work.**

## The loop, per lane

Launch → it reports → **inspect the branch yourself** → merge into `main` → run the full gate one command at a time → rewrite `docs/overnight-state.md` → dispatch that lane's next card.

## In the morning, report

What landed with test counts. What each audit found, unactioned. Which lanes stopped and the exact question that stopped them. What is still running. Anything you assumed. **Report nothing as done that is not merged and green — and "green" means nine of eleven commands, with `eval` and one named `chaos` scenario red for documented reasons.**
