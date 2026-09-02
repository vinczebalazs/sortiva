import { notFound } from 'next/navigation'
import { ArticleDetail, type ArticleDetailResponse } from '@sortiva/ui'
import '@sortiva/ui/styles/opportunities.css'
import '@sortiva/ui/styles/content.css'
import { getJson, requestContext } from '../../../_lib/api'
import { loadShellState } from '../../../_lib/shell-state'
import { ContentTabs } from '../../_lib/nav'

/**
 * One article, read-only.
 *
 * There is no editor and there is no route to one. A merchant who wants
 * different wording changes it in their store after publishing, or in their own
 * tools after exporting; review here is one decision rather than a writing
 * surface.
 *
 * An article that cannot be read is a missing page rather than an empty one:
 * unlike the calendar, there is no useful half of this screen to draw without
 * its subject.
 */

export const dynamic = 'force-dynamic'

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ articleId: string }>
}) {
  const { articleId } = await params
  const request = await requestContext()
  const [detail, shell] = await Promise.all([
    getJson<ArticleDetailResponse>(`/api/articles/${articleId}`, request),
    loadShellState(),
  ])

  if (!detail) notFound()

  return (
    <>
      <ContentTabs current="articles" />
      <ArticleDetail detail={detail} claimedDomain={shell.account.domain?.normalized ?? ''} />
    </>
  )
}
