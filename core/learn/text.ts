const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' }

/** Plain text of product or page HTML, with block boundaries kept as line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div|\/tr)\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, code: string) => {
      if (code.startsWith('#x')) return String.fromCodePoint(parseInt(code.slice(2), 16))
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)))
      return ENTITIES[code.toLowerCase()] ?? m
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Folds case, whitespace, quote styles and dash styles, so a faithful quote still matches. */
export function normaliseForMatch(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, '-')
    .replace(/×/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Digit runs, with thousands separators inside a number removed: "1,900" and "1 900" both give "1900". */
export function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[ ,. ]\d{3})*(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/[ ,. ](?=\d{3}\b)/g, '').replace(',', '.'))
}
