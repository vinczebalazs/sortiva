import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { reviewPage, type Grade } from '../evals/review-page.ts'
import { writeCases } from '../evals/run.ts'

/**
 * Checkpoint 3: the first ten articles, five per language, from the two rich fixture shops, with their
 * gate reports and the agent's grade. Same cases as the writer eval's first five per language.
 * npx tsx scripts/checkpoint-3.ts [--record]   (--record needs Anthropic credit)
 */
const cases = JSON.parse(readFileSync('evals/writer/cases.json', 'utf8')).filter((c: { fixture: string }) => c.fixture === 'rich-en' || c.fixture === 'rich-hu')
const { rows, articles } = await writeCases(cases)
const gradesFile = 'evals/writer/grades.json'
const grades: Record<string, Grade> = existsSync(gradesFile) ? JSON.parse(readFileSync(gradesFile, 'utf8')) : {}
const missing = rows.filter((r) => r.outcome === 'not recorded').map((r) => `${r.id} (“${r.query}”)`)
const intro = `<p class="lede">The first articles Sortiva writes, from the English and Hungarian rich fixture shops' top five topics each, with what the gate found. The articles are from version 2 of the writer's instructions (9 October) and are not yet graded by anyone; the build plan's bar is seven of ten publishable before phase 4.</p>
${missing.length ? `<p class="lede"><strong>Not written yet (${missing.length} of ${cases.length}):</strong> ${missing.join(', ')}. The Anthropic account ran out of credit during the build; these are written by re-running this page with <code>--record</code> once it is topped up.</p>` : ''}`
writeFileSync('docs/checkpoints/checkpoint-3-articles.html', reviewPage('Checkpoint 3 Articles', articles, grades, intro))
console.log(rows)
