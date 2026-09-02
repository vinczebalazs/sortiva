'use client'

import { useState } from 'react'
import { t as defaultTranslate, type Translate } from '../strings'
import { SearchConsoleTable } from './SearchConsoleTable'
import { SEARCH_CONSOLE_WINDOWS, windowOptionLabel } from './performance'
import type { SearchConsoleResponse, SearchConsoleWindow } from './types'

/**
 * The Search Console tab: queries and pages, with a way into the opportunity on
 * any row that has one.
 *
 * The window buttons re-read both tables together rather than one at a time, so
 * the queries and the pages on screen always cover the same stretch of time —
 * two tables over different periods sitting side by side would invite a
 * comparison that means nothing.
 *
 * A read that fails leaves the tables as they were and says the change did not
 * take, rather than blanking a screen that was showing something true.
 */

/** The one request this screen makes, as a port, so the window change is testable without a browser. */
export interface SearchConsoleApi {
  read(
    dimension: 'query' | 'page',
    window: SearchConsoleWindow,
  ): Promise<SearchConsoleResponse | null>
}

export function httpSearchConsoleApi(): SearchConsoleApi {
  return {
    async read(dimension, window) {
      try {
        const response = await fetch(
          `/api/performance/search-console?dimension=${dimension}&window=${window}`,
          { headers: { accept: 'application/json' } },
        )
        if (!response.ok) return null
        return (await response.json()) as SearchConsoleResponse
      } catch {
        return null
      }
    },
  }
}

export interface SearchConsoleScreenProps {
  readonly queries: SearchConsoleResponse
  readonly pages: SearchConsoleResponse
  readonly t?: Translate
  readonly initialWindow?: SearchConsoleWindow
  readonly api?: SearchConsoleApi
  readonly opportunitiesHref?: string
}

export function SearchConsoleScreen({
  queries,
  pages,
  t = defaultTranslate,
  initialWindow = '28d',
  api,
  opportunitiesHref = '/opportunities',
}: SearchConsoleScreenProps) {
  const [window, setWindow] = useState<SearchConsoleWindow>(initialWindow)
  const [data, setData] = useState({ queries, pages })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function changeWindow(next: SearchConsoleWindow) {
    if (next === window || busy) return
    const client = api ?? httpSearchConsoleApi()
    setBusy(true)
    setFailed(false)
    const [nextQueries, nextPages] = await Promise.all([
      client.read('query', next),
      client.read('page', next),
    ])
    setBusy(false)
    if (!nextQueries || !nextPages) {
      setFailed(true)
      return
    }
    setData({ queries: nextQueries, pages: nextPages })
    setWindow(next)
  }

  return (
    <section className="sortiva-perf" data-sc-screen>
      <header className="sortiva-perf__head">
        <h1>{t('performance.searchConsole.heading')}</h1>
        <p className="sortiva-perf__since">{t('performance.searchConsole.intro')}</p>
      </header>

      <div
        className="sortiva-perf__windows"
        role="group"
        aria-label={t('performance.searchConsole.windowLabel')}
      >
        {SEARCH_CONSOLE_WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            data-sc-window={option}
            aria-pressed={option === window}
            disabled={busy}
            onClick={() => void changeWindow(option)}
          >
            {windowOptionLabel(option, t)}
          </button>
        ))}
      </div>

      {failed ? (
        <p className="sortiva-perf__note" role="status" data-sc-failed>
          {t('performance.searchConsole.readFailed')}
        </p>
      ) : null}

      <section className="sortiva-perf__section" data-perf-section="queries">
        <h2>{t('performance.searchConsole.queries')}</h2>
        <SearchConsoleTable
          rows={data.queries.rows}
          dimension="query"
          t={t}
          opportunitiesHref={opportunitiesHref}
        />
      </section>

      <section className="sortiva-perf__section" data-perf-section="pages">
        <h2>{t('performance.searchConsole.pages')}</h2>
        <p className="sortiva-perf__note">{t('performance.searchConsole.pageTypeNote')}</p>
        <SearchConsoleTable
          rows={data.pages.rows}
          dimension="page"
          t={t}
          opportunitiesHref={opportunitiesHref}
        />
      </section>

      <p className="sortiva-perf__note" data-sc-lag-note>
        {t('performance.searchConsole.dataNote')}
      </p>
    </section>
  )
}
