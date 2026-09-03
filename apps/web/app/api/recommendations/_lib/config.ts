import { db } from '@sortiva/db'
import type { RecommendationLabels } from '@sortiva/core'
// The string catalogue, not the component barrel: `@sortiva/ui`'s index pulls
// React components into a route bundle that renders none of them.
import { t } from '@sortiva/ui/strings/index'
import type { RecommendationsDeps } from './handlers'

/**
 * Every word in the downloaded document, read from the one catalogue all
 * user-facing copy lives in. The renderer in `packages/core` takes them as an
 * argument precisely so that it holds no copy of its own.
 */
function downloadLabels(): RecommendationLabels {
  return {
    documentTitle: t('optimize.download.title'),
    page: t('optimize.download.page'),
    search: t('optimize.download.search'),
    intentNote: t('optimize.download.intentNote'),
    titleTag: t('optimize.download.titleTag'),
    metaDescription: t('optimize.download.metaDescription'),
    headings: t('optimize.download.headings'),
    sections: t('optimize.download.sections'),
    faq: t('optimize.download.faq'),
    internalLinks: t('optimize.download.internalLinks'),
    linksFrom: t('optimize.download.linksFrom'),
    linksTo: t('optimize.download.linksTo'),
    current: t('optimize.download.current'),
    suggested: t('optimize.download.suggested'),
    basedOn: t('optimize.download.basedOn'),
    notSet: t('optimize.download.notSet'),
    headingAdd: t('optimize.download.headingAdd'),
    headingRewrite: t('optimize.download.headingRewrite'),
    trustLine: t('optimize.download.trustLine'),
  }
}

export function recommendationsDeps(): RecommendationsDeps {
  return { db: db(), labels: downloadLabels() }
}
