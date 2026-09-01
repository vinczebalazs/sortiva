# The design canvas

The sixteen screens of the product, as designed. This file is the **visual source of
truth** for Lane F; `docs/sortiva-ui-spec.md` remains the source of truth for behaviour,
states and copy. Where the two disagree, say so rather than picking one.

`sortiva-ui-mockups.html` is the canvas exported from Claude Design and unpacked from its
self-contained bundle (2,303 lines). It is plain markup with inline styles — readable as
text, and openable in a browser. Each screen is a `<section class="scr" id="sN">`.

The export also contained the canvas editor's own runtime, React, and font files. None of
that is design content and none of it was kept.

## Screens

| id | screen | realises |
|---|---|---|
| `s1` | Landing page with preview | product §2 · UI §2.1 |
| `s2` | Plan selection → Stripe Checkout | product §3.2 · UI §2.3 |
| `s3` | Connect domain, ingestion progress, and the two connection steps | product §5, §6.2, §6.7 · UI §3.1–3.6 |
| `s4` | Confirmation review — the last step before the first scan | product §6.8 · UI §3.7 |
| `s5` | Finding opportunities → activation | product §6.9 · UI §3.8 |
| `s6` | Growth Opportunities — the central surface | product §7 · UI §5.1–5.2 |
| `s7` | Opportunity detail — Optimize recommendation, and the Fix view | product §7.6, §10 · UI §5.3 |
| `s8` | Dashboard — steady state | UI §4 |
| `s9` | Products — families, richness, and merchant tasks | product §6.3–6.4, §7.4 · UI §7 |
| `s10` | S10 | product §8.7 · UI §6.1 |
| `s11` | S11 | UI §6.2 |
| `s12` | S12 | product §8.4, §8.6 · UI §6.3 |
| `s13` | S13 | product §9.6, §12.2 · UI §8.1 |
| `s14` | S14 | product §12.2, §12.3 · UI §8.2 |
| `s15` | S15 | UI §9 |
| `s16` | S16 | product §6.1, §6.2, §4.2 · UI §1, §3.4, §3.5 |

## Tokens

Lifted verbatim from the canvas. These are what `packages/ui` should be built from —
not values re-derived by eye from a screenshot.

| token | value |
|---|---|
| `--amb` | `#e8890c` |
| `--amb-s` | `#fdf3e4` |
| `--card` | `#fff` |
| `--cy` | `#0e9bb8` |
| `--cy-s` | `#e5f6fa` |
| `--faint` | `#878da0` |
| `--grn` | `#12a150` |
| `--grn-s` | `#e7f7ee` |
| `--ground` | `#e8e9f0` |
| `--ink` | `#191b23` |
| `--ink2` | `#454a5c` |
| `--line` | `#edeef3` |
| `--line2` | `#e2e4ec` |
| `--mut` | `#6f7488` |
| `--pri` | `#6470f3` |
| `--pri-s` | `#eeeffe` |
| `--pur` | `#8b5cf6` |
| `--pur-s` | `#f3eefe` |
| `--r` | `18px` |
| `--r2` | `14px` |
| `--red` | `#e5484d` |
| `--red-s` | `#fdecee` |
| `--sh` | `0 1px 2px rgba(21,25,42,.04),0 8px 24px -6px rgba(21,25,42,.08)` |
| `--shl` | `0 2px 4px rgba(21,25,42,.04),0 18px 40px -10px rgba(21,25,42,.14)` |
| `--soft` | `#f5f6fa` |

Typeface: **Plus Jakarta Sans, Poppins**.

Naming is abbreviated in the canvas (`--pri` primary, `--amb` amber, `--grn` green,
`--mut` muted, `--r` radius, `--sh` shadow; a `-s` suffix is that colour's soft/tint
variant). Expand them into readable names when building the real token set, and record
the mapping so a designer can still find their way around.
