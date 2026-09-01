import { describe, expect, it } from 'vitest'
import { extractPreviewSignals, readableText } from './extract'
import { PREVIEW_MAX_INPUT_CHARS, PREVIEW_MIN_SIGNAL_CHARS } from './limits'

const SHOPIFY_HOME = `
<!doctype html><html lang="en"><head>
  <title>Alpine Trail Co. — Trail running shoes</title>
  <meta name="description" content="Trail running shoes and packs built for wet ground.">
  <meta property="og:site_name" content="Alpine Trail Co.">
  <meta property="og:title" content="Alpine Trail Co.">
  <script type="application/ld+json">
    {"@context":"https://schema.org","@type":"Organization","name":"Alpine Trail Co.","description":"Independent trail running brand in Cumbria."}
  </script>
  <script type="application/ld+json">
    [{"@type":"Product","name":"Fell Runner GTX"},{"@type":"Product","name":"Summit Pack 20L"}]
  </script>
  <script>var analytics = "should never be read";</script>
</head><body>
  <nav>Home Shop Cart</nav>
  <h1>Built for wet ground</h1>
  <p>We make trail shoes in three widths.</p>
  <style>.x{color:red}</style>
  <footer>© 2026</footer>
</body></html>`

describe('extractPreviewSignals', () => {
  it('pulls the cheap signals in main §3.3 priority order', () => {
    const { signals } = extractPreviewSignals(SHOPIFY_HOME)
    expect(signals.title).toBe('Alpine Trail Co. — Trail running shoes')
    expect(signals.description).toBe('Trail running shoes and packs built for wet ground.')
    expect(signals.siteName).toBe('Alpine Trail Co.')
    expect(signals.organization).toContain('Independent trail running brand in Cumbria.')
    expect(signals.products).toEqual(['Fell Runner GTX', 'Summit Pack 20L'])
  })

  it('never carries script or style content into the model input', () => {
    const { text } = extractPreviewSignals(SHOPIFY_HOME)
    expect(text).not.toContain('should never be read')
    expect(text).not.toContain('color:red')
  })

  it('drops an exactly repeated signal, because every repeat is input tokens we pay for', () => {
    // og:site_name and og:title are both the bare store name in this fixture;
    // only one of the two survives into the model input.
    const { text } = extractPreviewSignals(SHOPIFY_HOME)
    const lines = text.split('\n')
    expect(lines.filter((line) => line === 'Alpine Trail Co.')).toHaveLength(1)
  })

  it('reports thin pages as thin, so the about-page fallback can fire', () => {
    const thin = extractPreviewSignals('<html><head><title>Shop</title></head><body></body></html>')
    expect(thin.signalChars).toBeLessThan(PREVIEW_MIN_SIGNAL_CHARS)
  })

  it('truncates to the input token budget', () => {
    const huge = `<html><body><p>${'word '.repeat(200_000)}</p></body></html>`
    expect(extractPreviewSignals(huge).text.length).toBeLessThanOrEqual(PREVIEW_MAX_INPUT_CHARS + 1)
  })

  it('survives malformed JSON-LD rather than throwing on a hostile page', () => {
    const broken = `<html><head><title>T</title>
      <script type="application/ld+json">{ this is not json </script></head><body>x</body></html>`
    expect(() => extractPreviewSignals(broken)).not.toThrow()
    expect(extractPreviewSignals(broken).signals.title).toBe('T')
  })

  it('reads a @graph-wrapped Organization', () => {
    const graph = `<html><head><script type="application/ld+json">
      {"@graph":[{"@type":"WebSite"},{"@type":"Store","name":"Nordic Bikes"}]}
    </script></head><body></body></html>`
    expect(extractPreviewSignals(graph).signals.organization).toBe('Nordic Bikes')
  })

  it('decodes entities so the model does not read &amp;', () => {
    const html = '<html><head><title>Salt &amp; Stone</title></head><body></body></html>'
    expect(extractPreviewSignals(html).signals.title).toBe('Salt & Stone')
  })

  it('handles content-before-name meta attribute order', () => {
    const html = '<html><head><meta content="Reversed order" name="description"></head><body></body></html>'
    expect(extractPreviewSignals(html).signals.description).toBe('Reversed order')
  })

  it('is not fooled into treating an unclosed script as content', () => {
    const html = '<html><body><p>real</p><script>hidden'
    expect(readableText(html)).toContain('real')
  })
})
