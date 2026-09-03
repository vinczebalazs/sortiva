# Prompts

One file per prompt version: `<name>.v<N>.md`.

**Versions are never edited in place.** A change to a prompt is a new file at the
next version. That is what makes the `prompt_version` stamped on a stored
artefact mean something a year later, and what lets the eval suite run the old
and the new side by side.

Load one with `loadPrompt(name, majorVersion)` and fill its `{{placeholders}}`
with `renderPrompt`. An unfilled placeholder is an error, not an empty string —
silently rendering `""` is how a fact sheet gets built from nothing.

Every call made with a prompt is stamped with both `prompt_version` and
`model_id`, so any output is reproducible and drift is attributable.

Prompt files land with the cards that need them: `distill` (T2.3), `persona`
(T2.5), `seeds` (T2.6), `preview` (T1.3), `judge`, `contradiction` and `revise`
(T4.4), `intent_gap` and `optimize_reco` (T6.x), `topic-classify` (T4.2),
`claim-plan` and `draft` (T4.3). M0 ships the loader, not the prompts.

`contradiction` and `revise` have no call type of their own: the frozen
contract in `packages/core/src/contracts/llm.ts` names neither, and only a
re-freeze may add one. They run as `judge` and `draft` respectively — which is
what each of them is — and are told apart in stored artefacts and in spend
reporting by their prompt version. See DECISIONS 2026-09-03 T4.4.
