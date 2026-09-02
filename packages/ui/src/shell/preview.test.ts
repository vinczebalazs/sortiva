import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BannerStackPreview } from './BannerStack.preview'
import { BANNERS } from './banners'

/**
 * The gallery is the card's deliverable, so it is asserted to render rather
 * than merely to compile — a page that throws on one of its ten cases is worse
 * than no page.
 */
describe('the component gallery', () => {
  const html = renderToStaticMarkup(createElement(BannerStackPreview))

  it('renders every notice at least once across its cases', () => {
    for (const banner of BANNERS) {
      expect(html).toContain(`data-banner="${banner.id}"`)
    }
  })

  it('shows the two-at-a-time rule holding when everything is raised', () => {
    // Five raised: two shown and three counted. Dismissing the two that can be
    // dismissed leaves four raised, so two are still shown and two counted.
    expect(html).toContain('data-banner-overflow="3"')
    expect(html).toContain('data-banner-overflow="2"')
    expect(html.match(/data-visible-banners="2"/g)).toHaveLength(2)
  })

  it('shows all three states of the navigation rail', () => {
    expect(html.match(/data-testid="nav-rail"/g)).toHaveLength(3)
    expect(html).toContain('data-nav-pending="true"')
    expect(html).toContain('aria-disabled="true"')
  })

  it('shows the badge in both its forms', () => {
    expect(html.match(/data-testid="limited-intelligence-badge"/g)).toHaveLength(2)
  })
})
