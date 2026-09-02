import { createTranslate } from '@sortiva/ui'

/**
 * The two halves of Performance, and the link between them.
 *
 * Search Console is a tab inside this destination rather than a rail entry of
 * its own: it is the same question — how is search going — asked at a different
 * grain, and the six-destination decision put it here rather than beside
 * Performance in the navigation.
 */

const t = createTranslate()

export type PerformanceTab = 'overview' | 'search-console'

export function PerformanceTabs({ current }: { current: PerformanceTab }) {
  return (
    <nav className="sortiva-content__tabs" aria-label={t('performance.tabsLabel')}>
      <a href="/performance" aria-current={current === 'overview' ? 'page' : undefined}>
        {t('performance.tab.overview')}
      </a>
      <a
        href="/performance/search-console"
        aria-current={current === 'search-console' ? 'page' : undefined}
      >
        {t('performance.tab.searchConsole')}
      </a>
    </nav>
  )
}
