# Overnight run — operating rules

Founder asleep. These are the rules I am running under, written down so the
morning report can be checked against them rather than taken on trust.

## What I will do

- Run **four building sessions at most**, never five. Wave 1 stalled all five at
  once on a 12-core machine.
- **Merge each card into `main` as it lands**, run the full gate, and only then
  start the next card in that lane. A lane never runs two cards at once.
- **Run the audits the plan schedules** (`docs/agent-work-plan.md` §7) as their
  cards land. Audits are read-only. I will **hold their findings for the morning**
  rather than acting on them, unless a finding blocks the next card in that lane,
  in which case I stop the lane and say so.
- **Recover stalled sessions.** A killed session's work survives in its worktree;
  I check `git status` before restarting anything.

## What I will not do

- **Decide anything with no documented default.** If a card hits a genuine
  product choice that `docs/founder-decisions.md` does not already answer, I stop
  that lane, leave it clean, and move to another. I do not guess.
- **Act on an audit finding**, beyond stopping a lane.
- **Add a database migration outside a schema-wave card**, change a frozen
  contract, or touch another lane's directories.
- **Deploy anything**, or touch the Railway project.

## Where a default is assumed

`docs/founder-decisions.md` §C records nine defaults the spec assumed and flagged
for sign-off. Where a card needs one, I take the documented default, journal it in
`DECISIONS.md`, and list it at the top of the morning report under **"I assumed
these — say if any is wrong."** Every such assumption is one line, with the card
that depended on it, so it can be reversed before more is built on top.

## Order

The citation sweep runs **last**, not first — the reverse of the standing advice
in `handoff-wave2.md`, and deliberately. It needs a tree with nothing in flight;
tonight that moment is at the end rather than the start, and sweeping last also
cleans whatever tonight's cards write. Every card prompt states the no-citations
rule explicitly, so nothing new should need much cleaning.

## The morning report will say

What landed, with test counts. What I assumed and where. What each audit found,
unactioned. Which lanes stopped and why. What is still running. Nothing will be
reported as done that is not merged and green.
