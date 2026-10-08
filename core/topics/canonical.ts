import type { Language } from '../config.ts'

const STOP_WORDS: Record<Language, Set<string>> = {
  en: new Set(
    'a an the and or of for to in on at by with from your you my our is are be how what which why when where who best vs versus do does can should guide tips'.split(' '),
  ),
  hu: new Set(
    'a az és vagy is egy hogy mi mit milyen melyik hogyan miért mikor hol ki kell lehet legjobb vs mint nem meg el be ki fel le tippek útmutató'.split(' '),
  ),
}

// Longest first, so "-ból" is tried before "-ba". Case endings and plurals only; the overlap check carries Hungarian dedup.
const HU_SUFFIXES = ['ságok', 'ségek', 'ának', 'ének', 'ban', 'ben', 'ból', 'ből', 'hoz', 'hez', 'höz', 'nak', 'nek', 'val', 'vel', 'ról', 'ről', 'tól', 'től', 'ért', 'ok', 'ek', 'ök', 'ak', 'ba', 'be', 'ra', 're', 'on', 'en', 'ön', 'k']

function stem(word: string, language: Language): string {
  if (language === 'en') {
    if (word.length > 4 && word.endsWith('ies')) return word.slice(0, -3) + 'y'
    if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3)
    if (word.length > 4 && /(ss|us)$/.test(word)) return word
    if (word.length > 4 && /(ches|shes|xes|sses)$/.test(word)) return word.slice(0, -2)
    if (word.length > 3 && word.endsWith('s')) return word.slice(0, -1)
    if (word.length > 4 && word.endsWith('e')) return word.slice(0, -1)
    return word
  }
  let stemmed = word
  for (const suffix of HU_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      stemmed = word.slice(0, -suffix.length)
      break
    }
  }
  // The accusative "-t" after a vowel, then a final vowel, which Hungarian lengthens before endings (lámpa, lámpát).
  if (stemmed === word && /[aeiouáéíóöőúüű]t$/.test(stemmed) && stemmed.length >= 5) stemmed = stemmed.slice(0, -1)
  if (/[aeáé]$/.test(stemmed) && stemmed.length >= 5) stemmed = stemmed.slice(0, -1)
  return stemmed
}

/** Content words of a phrase, lower-cased and stemmed, without stop words. */
export function contentWords(text: string, language: Language): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !STOP_WORDS[language].has(w))
    .map((w) => stem(w, language))
}

/**
 * The topic's identity within a store: content words, stemmed, sorted. Unique per store in the
 * database, so the same phrasing proposed twice is refused rather than queued twice.
 */
export function canonicalKey(query: string, language: Language): string {
  return [...new Set(contentWords(query, language))].sort().join(' ')
}

/** For comparing against URL slugs, which drop accents. */
export function foldAccents(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '')
}
