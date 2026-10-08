import type { Language } from '../core/config.ts'
import type { GateReport } from '../core/write/write.ts'

export type WrittenArticle = {
  id: string
  fixture: string
  language: Language
  query: string
  searches: number | null
  title: string
  html: string | null
  markdown: string | null
  report: GateReport
}

/** The agent's reading of one article, until the founders grade it themselves. */
export type Grade = { publishable: boolean; note: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function article(a: WrittenArticle, grade: Grade | undefined): string {
  const last = a.report.attempts.at(-1)
  const s = last?.judge?.scores
  const failed = last?.mechanical.checks.filter((c) => !c.ok) ?? []
  const repaired = a.report.attempts.length > 1
  const firstProblems = repaired
    ? [
        ...a.report.attempts[0]!.mechanical.checks.flatMap((c) => c.problems.map((p) => `${c.id}: ${p.sentence ? `“${p.sentence}” — ` : ''}${p.detail}`)),
        ...(a.report.attempts[0]!.judge && !a.report.attempts[0]!.judge.passed ? a.report.attempts[0]!.judge.problems.map((p) => `review: ${p.sentence ? `“${p.sentence}” — ` : ''}${p.detail}`) : []),
      ]
    : []
  const general = last?.judge?.generalNumbers ?? []
  const notes = last?.judge?.problems ?? []
  return `
<article class="case" id="${esc(a.id)}">
  <header>
    <p class="meta">${esc(a.id)} · ${esc(a.fixture)} · ${a.language === 'hu' ? 'Hungarian' : 'English'} · search “${esc(a.query)}”${a.searches !== null ? ` · ${a.searches.toLocaleString('en-GB')} a month` : ''}</p>
    <h2>${esc(a.title)}</h2>
    <p class="badges">
      <span class="badge ${a.report.outcome === 'passed' ? 'ok' : 'bad'}">${a.report.outcome === 'passed' ? 'Passed the gate' : `Held: ${esc(a.report.heldReason ?? '')}`}</span>
      ${repaired ? '<span class="badge">Repaired once</span>' : '<span class="badge">First draft</span>'}
      ${s ? `<span class="badge">Review ${s.grounding}/${s.informationGain}/${s.structure}/${s.fit}</span>` : ''}
      ${grade ? `<span class="badge ${grade.publishable ? 'ok' : 'bad'}">Agent's grade: ${grade.publishable ? 'would publish' : 'would not publish'}</span>` : ''}
    </p>
    ${grade ? `<p class="grade">${esc(grade.note)}</p>` : ''}
  </header>
  <div class="cols">
    <div class="body">${a.html ?? '<p class="muted">No text was kept for this article.</p>'}</div>
    <aside>
      ${a.report.outcome === 'held' && a.report.heldProblem ? `<h3>Why it was held</h3><p>${a.report.heldProblem.sentence ? `“${esc(a.report.heldProblem.sentence)}” — ` : ''}${esc(a.report.heldProblem.detail)}</p>` : ''}
      ${failed.length ? `<h3>Failed checks</h3><ul>${failed.map((c) => `<li>${esc(c.id)}: ${esc(c.problems[0]?.detail ?? '')}</li>`).join('')}</ul>` : ''}
      ${repaired ? `<h3>What the repair was asked to fix</h3><ul>${firstProblems.slice(0, 8).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : ''}
      ${s && last?.judge ? `<h3>Review notes</h3><dl>${(Object.keys(s) as (keyof typeof s)[]).map((k) => `<dt>${k} ${s[k]}/5</dt><dd>${esc(last.judge!.notes[k])}</dd>`).join('')}</dl>` : ''}
      ${notes.length ? `<h3>Reviewer's remarks</h3><ul>${notes.slice(0, 6).map((p) => `<li>${p.sentence ? `“${esc(p.sentence)}” — ` : ''}${esc(p.detail)}</li>`).join('')}</ul>` : ''}
      ${general.length ? `<h3>General-knowledge figures</h3><ul>${general.map((g) => `<li class="${g.accepted ? '' : 'no'}">${esc(g.sentence)} <em>${g.accepted ? 'accepted' : 'refused'}: ${esc(g.reason)}</em></li>`).join('')}</ul>` : ''}
      <h3>Facts cited</h3><p>${last?.mechanical.factsCited.length ?? 0} different facts</p>
    </aside>
  </div>
</article>`
}

export function reviewPage(title: string, articles: WrittenArticle[], grades: Record<string, Grade> = {}, intro = ''): string {
  const passed = articles.filter((a) => a.report.outcome === 'passed').length
  const publishable = articles.filter((a) => grades[a.id]?.publishable).length
  return `<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
:root { --bg: #f6f5f1; --card: #ffffff; --fg: #1d1c1a; --muted: #6b6860; --line: #e4e1d8; --ok: #1d7a46; --ok-bg: #e3f3e9; --bad: #a3332c; --bad-bg: #f8e4e2; --accent: #2a4f8f; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #161614; --card: #201f1c; --fg: #ecebe6; --muted: #a29f95; --line: #34322d; --ok: #6fd39a; --ok-bg: #18342a; --bad: #f19a92; --bad-bg: #3d1f1c; --accent: #9dbcf2; color-scheme: dark } }
:root[data-theme="dark"] { --bg: #161614; --card: #201f1c; --fg: #ecebe6; --muted: #a29f95; --line: #34322d; --ok: #6fd39a; --ok-bg: #18342a; --bad: #f19a92; --bad-bg: #3d1f1c; --accent: #9dbcf2; color-scheme: dark }
body { background: var(--bg); color: var(--fg); font: 15px/1.6 Inter, system-ui, sans-serif; margin: 0; padding-inline: 16px; }
main { max-width: 1180px; margin: 0 auto; padding-block: 32px 64px; }
h1 { font: 600 30px/1.2 'Source Serif 4', Georgia, serif; text-wrap: balance; margin: 0 0 8px; }
.lede { color: var(--muted); max-width: 70ch; }
.summary { display: flex; gap: 24px; flex-wrap: wrap; margin: 20px 0 32px; font-variant-numeric: tabular-nums; }
.summary b { display: block; font-size: 26px; }
.case { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 24px; margin-bottom: 28px; }
.meta { color: var(--muted); font-size: 12.5px; letter-spacing: .02em; margin: 0; }
.case h2 { font: 600 23px/1.25 'Source Serif 4', Georgia, serif; margin: 6px 0 10px; text-wrap: balance; }
.badges { display: flex; gap: 8px; flex-wrap: wrap; margin: 0; }
.badge { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 99px; background: var(--bg); border: 1px solid var(--line); }
.badge.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.badge.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.grade { margin: 10px 0 0; font-style: italic; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 340px); gap: 28px; margin-top: 20px; }
@media (max-width: 860px) { .cols { grid-template-columns: minmax(0, 1fr); } }
.body { font: 17px/1.7 'Source Serif 4', Georgia, serif; max-width: 68ch; min-width: 0; }
.body h2 { font-size: 21px; margin-top: 1.6em; }
.body table { border-collapse: collapse; display: block; overflow-x: auto; }
.body td, .body th { border: 1px solid var(--line); padding: 6px 10px; }
.body a { color: var(--accent); }
.body img { max-width: 100%; }
aside { font-size: 13.5px; min-width: 0; }
aside h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 18px 0 6px; }
aside h3:first-child { margin-top: 0; }
aside ul { padding-left: 18px; margin: 0; }
aside li { margin-bottom: 6px; }
aside li.no { color: var(--bad); }
aside em { color: var(--muted); }
dt { font-weight: 600; } dd { margin: 0 0 8px; color: var(--muted); }
.muted { color: var(--muted); }
</style>
<main>
  <h1>${esc(title)}</h1>
  ${intro}
  <div class="summary">
    <div><b>${articles.length}</b>articles</div>
    <div><b>${passed}</b>passed the gate</div>
    <div><b>${articles.filter((a) => a.report.attempts.length > 1).length}</b>needed the repair</div>
    ${Object.keys(grades).length ? `<div><b>${publishable} of ${articles.length}</b>the agent would publish</div>` : ''}
  </div>
  ${articles.map((a) => article(a, grades[a.id])).join('\n')}
</main>
`
}
