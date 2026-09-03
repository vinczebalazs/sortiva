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
(T2.5), `seeds` (T2.6), `preview` (T1.3), `judge` (T4.4), `intent_gap` and
`optimize_reco` (T6.x), `topic-classify` (T4.2), `claim-plan` and `draft`
(T4.3). M0 ships the loader, not the prompts.
