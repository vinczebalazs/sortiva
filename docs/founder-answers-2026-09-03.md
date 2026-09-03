# Founder answers, 2026-09-03 12:40

**Read this alongside `docs/overnight-state.md`, not instead of it.** It exists as a
separate file for one reason: another integrator session was rewriting
`overnight-state.md` at the moment these answers came in, and two sessions editing the
same file is how work gets silently dropped. **Fold this into `overnight-state.md`'s
"Questions waiting on the founder" section once nothing is writing to it, then delete
this file.**

Four questions were put to the founder and all four were answered. Each is journalled in
`DECISIONS.md` under `2026-09-03 — FOUNDER`. **Five of the original eight questions
remain open — 2, 3, 5, 6 and 7 — and none of them blocks a card today.**

## Question 8, the competitor-gap contradiction — ANSWERED. Changed, gated, committed.

The product calls it a gap when a store's competitors rank well for a search the store
sells into. It used to stay silent if the store already held any position better than
20 — so a store at #18 produced nothing, though the spec's own worked example uses that
exact case to show the signal firing. **The threshold moves from 20 to 10**, opening
positions 11–30, and every one of those lands in the "improve the page you already have"
band configured beside it, which under the old number could only be reached at 21–30.

Config only (`our_absent_position_max` in `packages/rules/signals.config.yaml`); the
detector already read the number. `rules_version` moved with it — `9fb26ae9…` →
`2bd23161…` — because it is a hash of the config and is stamped on every opportunity and
gate decision. Nothing in the repository pinned the old hash, checked by grep. The
committed config snapshot is regenerated; `packages/rules` (152 tests) and the signals
suite (108 tests) are green, and `packages/rules` typechecks.

**`T3.6` is unblocked and its done-when stands exactly as written** — the #18 fixture it
names is now producible.

## Question 1, the deleted-page marker — ANSWERED: a status field. Carded, not built.

When a merchant deletes a page, the row stays and nothing says the page is gone, so the
product can recommend improving a page that no longer exists. The founder chose a status
field naming which condition the row is in — live or gone, with room for "moved" or
"unreachable" later — over a single deleted-at date, and rejected inferring it from "not
seen by the last completed walk" (that needs something to record that a walk *finished*,
or an interrupted walk marks live pages as gone).

Schema wave 3 closed without it and a feature card may not add its own migration, so
**a new card exists: `T4.0a`, a schema mini-wave**, in the build plan directly after the
remediation cards. Migration only, unassigned. Two follow-ups it deliberately does not
do, neither a founder question: the producer that sets the value, and teaching `T3.5`'s
existing-target check to skip a page that is gone — which is the whole reason the field
exists.

## Question 4, the recurring job schedule — ANSWERED: wait. Nothing changed.

The crontab stays off and the worker's refuse-to-start-without-every-handler rule is not
relaxed. The four missing handlers belong to Lanes C and D, whose cards are next anyway.
**What stays dormant is unchanged** and is listed in full in `overnight-state.md`'s
`T8.4` section: nothing reads the spend meter so spend is unbounded, the preview cap —
the one paid path a stranger can trigger — has no brake, no deleted account is ever
erased and nothing is pruned, and no scheduled mail goes out. The manual kill switches
do work.

## `R-PRIVACY` — AUTHORISED. Queued, not started.

The founder said fix it now rather than hold it until Shopify credentials exist. Its
only stated blocker had expired — Lane G finished M8 and left that territory. **It is
not started for a different reason: Lane B was mid-`T2.7` in the same directories.**
`T2.7` has since merged (`49506ea`), so **`R-PRIVACY` is dispatchable to Lane B now.**
The card is unchanged in build plan §7.

## What the next session should do, in order

1. **Dispatch `R-PRIVACY` to Lane B.** Authorised, unblocked as of `T2.7`'s merge.
2. **`T4.1` — start the content engine.** `T4.0` cleared it, M4 has not begun, and it is
   the largest thing waiting on nobody's desk.
3. **`T3.6` in Lane C** — unblocked by the threshold change above.
4. **`T9.8`**, the M9 exit gate, is Lane F's next and needs nothing.
5. `T4.0a` and `R-STREAM` are unassigned. `R-DEV` still needs the founder, because its
   obvious fix is the option the founder explicitly rejected on `T-BOOT`.
