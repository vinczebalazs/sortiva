import { createTranslate } from '@sortiva/ui'

/**
 * The two halves of the Content module, and the link between them.
 *
 * Calendar and Articles are the same body of work seen twice — what is going to
 * happen, and what did — so they are one destination in the rail with a tab
 * strip inside it rather than two rail entries competing for the same idea.
 */

const t = createTranslate()

export type ContentTab = 'calendar' | 'articles'

export function ContentTabs({ current }: { current: ContentTab }) {
  return (
    <nav className="sortiva-content__tabs" aria-label={t('content.tabsLabel')}>
      <a href="/content" aria-current={current === 'calendar' ? 'page' : undefined}>
        {t('content.tab.calendar')}
      </a>
      <a href="/content/articles" aria-current={current === 'articles' ? 'page' : undefined}>
        {t('content.tab.articles')}
      </a>
    </nav>
  )
}
