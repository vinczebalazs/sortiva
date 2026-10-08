import { CONFIG, type Language } from '../config.ts'
import { numbersIn } from '../learn/text.ts'
import { blocks, cardRefs, linkTargets, plainText, sentences, type Sentence } from './markup.ts'
import type { EvidencePack } from './pack.ts'

export type CheckId =
  | 'claims_cited'
  | 'numbers_cited'
  | 'links_internal'
  | 'no_experience'
  | 'no_price'
  | 'never_say'
  | 'language'
  | 'length'
  | 'fact_floor'
  | 'title_and_meta'

export type Problem = { sentence?: string; detail: string }
export type CheckResult = { id: CheckId; ok: boolean; problems: Problem[] }

export type Draft = { title: string; metaDescription: string; slug: string; markdown: string }

/** A number the writer marked as general knowledge; the judge must accept each one. */
export type GeneralNumber = { sentence: string; numbers: string[] }

export type MechanicalReport = { checks: CheckResult[]; generalNumbers: GeneralNumber[]; factsCited: string[] }

// Unicode-aware whole-word match: \b only knows ASCII letters, and Hungarian words end in accented ones.
function words(alternatives: string, flags = 'iu'): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, flags)
}

const EXPERIENCE: Record<Language, RegExp[]> = {
  en: [
    words("I|I'm|I've|I'd|I'll", 'u'),
    words('me|my|mine|myself'),
    words("we(?:'ve| have)?(?: personally)? (?:tested|tried|found|noticed|used|loved|discovered|experimented|compared|brewed|tasted|ran)"),
    words('(?:in|from) our (?:own )?experience'),
    words('our (?:favourite|favorite|go-to|top pick|testers?)'),
    words('(?:our )?customers (?:say|tell us|told us|love|report|rave|swear)'),
    words('our team (?:tested|tried|loves|uses|swears)'),
    words('hands-on|in our tests?|we put .{1,30} to the test'),
  ],
  hu: [
    words('kipróbáltuk|kipróbáltam|teszteltük|teszteltem|tapasztaltuk|tapasztaltam|megfigyeltük|összehasonlítottuk'),
    words('tapasztalatunk szerint|tapasztalatom szerint|saját tapasztalat\\p{L}*'),
    words('kedvencünk|kedvencem|kedvenceink|kedvenc\\p{L}* (?:a )?csapat\\p{L}*'),
    words('vásárlóink (?:szerint|imádják|mondják|visszajelzései)|vevőink (?:szerint|imádják|mondják)'),
    words('szerintem|én|nekem|nálam|engem|velem'),
    words('a tesztjeink|tesztünk\\p{L}*'),
  ],
}

const PRICE = [
  /[$€£¥]\s?\d/u,
  words('\\d[\\d\\s.,]*\\s?(?:ft|huf|usd|eur|gbp|forint\\p{L}*|dollars?|euros?|pounds?|pence)'),
  words('priced at|costs? (?:only |just )?(?:around |about )?\\d|ára \\d|áron'),
]

const STOP_WORDS: Record<Language, string[]> = {
  // No word in both lists: "a" and "is" are common in both languages and would blur the count.
  en: 'the and of to in it you that for with on are as this be your or can by at from not have more when which will if their than its also they but all'.split(' '),
  hu: 'az és hogy egy nem van meg de ez azt ha mint már csak vagy még kell lehet amikor mert ezt ami akkor után így pedig sok nagyon jó vagyis'.split(' '),
}

export function detectLanguage(text: string): { language: Language | null; share: number } {
  const tokens = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean)
  const count = (l: Language) => tokens.filter((t) => STOP_WORDS[l].includes(t)).length
  const en = count('en')
  const hu = count('hu')
  if (en + hu < 20) return { language: null, share: 0 }
  return en > hu ? { language: 'en', share: en / (en + hu) } : { language: 'hu', share: hu / (en + hu) }
}

export function wordCount(markdown: string): number {
  return plainText(markdown).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
}

function digitsIn(text: string): string[] {
  return numbersIn(text)
}

// Digits only: a spelled-out "two reasons" is the article's own structure far more often than a claim, and a
// spelled-out number about a product is still caught, since the sentence must cite a fact the judge reads it against.
function numbersOf(text: string): string[] {
  return digitsIn(text)
}

function normaliseName(s: string): string {
  return s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

// A number inside a product's own name ("size 02") is part of the name, not a claim.
function withoutNames(text: string, pack: EvidencePack): string {
  let out = text
  for (const p of [...pack.products].sort((a, b) => b.title.length - a.title.length)) {
    for (const name of [p.title, p.title.split(/[,(–—|]/)[0]!.trim()]) if (name) out = out.split(name).join(' ')
  }
  return out
}

/**
 * Which of our products a sentence names: by its full title, its title before any comma, or a link to it.
 * The short form is skipped when it is only the topic's own words or the product's kind ("rosehip tea").
 */
export function productsNamed(sentence: Sentence, pack: EvidencePack): string[] {
  const text = ` ${normaliseName(sentence.text)} `
  const generic = ` ${normaliseName(`${pack.topic.targetQuery} ${pack.topic.workingTitle}`)} `
  return pack.products
    .filter((p) => {
      const short = normaliseName(p.title.split(/[,(–—|]/)[0]!)
      const shortIsGeneric = generic.includes(` ${short} `) || short === normaliseName(p.productType)
      const names = [normaliseName(p.title), ...(shortIsGeneric ? [] : [short])].filter((n) => n.split(' ').length >= 2 || n.length >= 6)
      return sentence.links.includes(p.ref) || names.some((n) => text.includes(` ${n} `))
    })
    .map((p) => p.ref)
}

/** The deterministic half of the gate (rules 2 and 3, D6, and the plan's §3.5 list). Free, and run first. */
export function mechanicalChecks(draft: Draft, pack: EvidencePack): MechanicalReport {
  const language = pack.language
  const all = sentences(draft.markdown)
  const factText = new Map(pack.facts.map((f) => [f.ref, f.text]))
  const productTitle = new Map(pack.products.map((p) => [p.ref, p.title]))

  const claims: Problem[] = []
  const numbers: Problem[] = []
  const generalNumbers: GeneralNumber[] = []
  const cited = new Set<string>()

  for (const s of all.filter((x) => !x.heading)) {
    const unknown = s.facts.filter((f) => !factText.has(f))
    if (unknown.length) claims.push({ sentence: s.text, detail: `cites facts that do not exist: ${unknown.join(', ')}` })
    const known = s.facts.filter((f) => factText.has(f))
    known.forEach((f) => cited.add(f))
    const named = productsNamed(s, pack)

    if (named.length && s.general) claims.push({ sentence: s.text, detail: 'names one of our products but is marked as general knowledge' })
    else if (named.length && !known.length) claims.push({ sentence: s.text, detail: `names ${named.map((r) => productTitle.get(r)).join(', ')} without citing a fact` })

    const found = numbersOf(withoutNames(s.text, pack))
    if (found.length) {
      const backed = new Set(known.flatMap((f) => numbersOf(factText.get(f)!)))
      const loose = found.filter((n) => !backed.has(n))
      if (loose.length && s.general && !named.length) generalNumbers.push({ sentence: s.text, numbers: [...new Set(loose)] })
      else if (loose.length) numbers.push({ sentence: s.text, detail: `${[...new Set(loose)].join(', ')} ${known.length ? 'not in its cited facts' : 'without a fact or a general-knowledge mark'}` })
    }
  }

  // Headings and the title cannot carry markers: a number there must be backed by a fact the article cites, or count the article's own sections or list items.
  const counts = new Set<string>()
  const bs = blocks(draft.markdown)
  for (const level of [2, 3]) counts.add(String(bs.filter((b) => b.kind === 'heading' && b.level === level).length))
  let run = 0
  for (const b of bs) {
    if (b.kind === 'list_item') run++
    else if (run) {
      counts.add(String(run))
      run = 0
    }
  }
  if (run) counts.add(String(run))
  const citedNumbers = new Set([...cited].flatMap((f) => numbersOf(factText.get(f)!)))
  for (const text of [draft.title, ...all.filter((s) => s.heading).map((s) => s.text)]) {
    const loose = numbersOf(withoutNames(text, pack)).filter((n) => !citedNumbers.has(n) && !counts.has(n))
    if (loose.length) numbers.push({ sentence: text, detail: `heading or title number ${loose.join(', ')} is not backed by a cited fact` })
  }

  const links: Problem[] = []
  const knownUrls = new Set(pack.links.map((l) => l.url))
  const knownRefs = new Set(pack.links.map((l) => l.ref))
  for (const target of linkTargets(draft.markdown)) {
    if (knownRefs.has(target) || knownUrls.has(target)) continue
    let host = ''
    try {
      host = new URL(target.startsWith('www.') ? `https://${target}` : target).hostname.toLowerCase()
    } catch {
      host = ''
    }
    links.push({ detail: pack.hosts.includes(host) ? `${target} is on the store's domain but is not a page we know` : `${target} leaves the store's domain` })
  }
  for (const ref of cardRefs(draft.markdown)) {
    if (!pack.products.some((p) => p.ref === ref)) links.push({ detail: `product card for ${ref}, which is not one of the products` })
  }

  const scan = (patterns: RegExp[]) =>
    [...all.map((s) => s.text), draft.title, draft.metaDescription].flatMap((text) => {
      const hit = patterns.map((p) => text.match(p)).find(Boolean)
      return hit ? [{ sentence: text, detail: `"${hit[0]}"` }] : []
    })
  const experience = scan(EXPERIENCE[language])
  const price = scan(PRICE)
  const banned = pack.profile.neverSay
    .split(/[\n,;]+/)
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length >= 3)
  const neverSay = [...all.map((s) => s.text), draft.title, draft.metaDescription].flatMap((text) => {
    const hit = banned.find((b) => text.toLowerCase().includes(b))
    return hit ? [{ sentence: text, detail: `"${hit}" is on the owner's never-say list` }] : []
  })

  const detected = detectLanguage(plainText(draft.markdown))
  const words = wordCount(draft.markdown)
  const range = CONFIG.write.words[language]
  const meta = CONFIG.write.metaDescriptionChars
  const titleMeta: Problem[] = []
  if (draft.title.trim().length < 15 || draft.title.trim().length > 90) titleMeta.push({ detail: `title is ${draft.title.trim().length} characters` })
  if (draft.metaDescription.length < meta.min || draft.metaDescription.length > meta.max) titleMeta.push({ detail: `meta description is ${draft.metaDescription.length} characters; ${meta.min} to ${meta.max} expected` })
  if (/^#\s/m.test(draft.markdown)) titleMeta.push({ detail: 'the body has its own top-level heading; the title is set separately' })

  const check = (id: CheckId, problems: Problem[]): CheckResult => ({ id, ok: problems.length === 0, problems })
  return {
    // In the order a held article names its reason: the most basic and most serious failure first.
    checks: [
      check('language', detected.language === language && detected.share >= 0.75 ? [] : [{ detail: `reads as ${detected.language ?? 'unknown'} (${Math.round(detected.share * 100)}%), the store writes in ${language}` }]),
      check('links_internal', links),
      check('no_price', price),
      check('no_experience', experience),
      check('never_say', neverSay),
      check('claims_cited', claims),
      check('numbers_cited', numbers),
      check('fact_floor', cited.size >= CONFIG.minDistinctFactsPerArticle ? [] : [{ detail: `cites ${cited.size} different facts; at least ${CONFIG.minDistinctFactsPerArticle} needed` }]),
      check('length', words >= range.min && words <= range.max ? [] : [{ detail: `${words} words; ${range.min} to ${range.max} expected` }]),
      check('title_and_meta', titleMeta),
    ],
    generalNumbers,
    factsCited: [...cited].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
  }
}
