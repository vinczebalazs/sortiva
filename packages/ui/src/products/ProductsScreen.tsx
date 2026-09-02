'use client'

import { useState } from 'react'
import { useUiAnalytics } from '../analytics'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { formatDate } from '../opportunities/list'
import { FamiliesSection } from '../onboarding/ConfirmationSections'
import { MerchantTaskCard } from './MerchantTaskCard'
import {
  filterProducts,
  missingSummary,
  richnessLabel,
  splitTasks,
  type ProductFilter,
} from './products'
import type { FamiliesResponse, MerchantTask, ProductsResponse } from './types'

/**
 * Products — the store intelligence layer made visible, and the home of the work
 * only the merchant can do.
 *
 * The screen exists because the honest answer to some opportunities is "we can't
 * write this yet". A guide comparing six shoes by lug depth needs six shoes that
 * state a lug depth, and where they don't, the opportunity waits and this page
 * says what it is waiting for — naming the opportunity being held up and what it
 * is worth, so the work arrives with a reason attached.
 *
 * Nothing on this page is typed into Sortiva. Every product links into Shopify
 * admin, because their catalogue is the one copy of these facts and a field
 * entered here would be a second, quietly diverging one.
 *
 * Families are read-only, with the same list and the same "report wrong
 * grouping" modal as the confirmation screen — literally the same component, so
 * the two cannot drift.
 */

export interface ProductsScreenProps {
  readonly data: ProductsResponse
  readonly families: FamiliesResponse
  readonly t?: Translate
  readonly opportunitiesHref?: string
}

export function ProductsScreen({
  data,
  families,
  t = defaultTranslate,
  opportunitiesHref = '/opportunities',
}: ProductsScreenProps) {
  const analytics = useUiAnalytics()
  const [filter, setFilter] = useState<ProductFilter>('all')
  const tasks = splitTasks(data.merchantTasks)
  const rows = filterProducts(data.products, filter)

  /**
   * What a task click reports: which opportunity, and how many fields were
   * missing. Not the product's name and not the opportunity's title — both are
   * the merchant's own catalogue described back to them, and the event table has
   * no property that could carry either.
   */
  function reportOpened(task: MerchantTask) {
    analytics.capture('merchant_task_opened', {
      opportunity_id: task.opportunityId,
      missing_field_count: task.products.reduce(
        (total, product) => total + product.missingFields.length,
        0,
      ),
    })
  }

  return (
    <section className="sortiva-products">
      <header className="sortiva-products__head">
        <div>
          <h1>{t('products.heading')}</h1>
          <p className="sortiva-products__intro">{t('products.intro')}</p>
        </div>
        <dl className="sortiva-products__counts" data-products-counts>
          <Count label={t('products.count.products')} value={data.counts.products} />
          <Count label={t('products.count.families')} value={data.counts.families} />
          <Count
            label={t('products.count.missingDetails')}
            value={data.richness.productsMissingDetails}
          />
        </dl>
      </header>

      <section className="sortiva-products__richness" data-products-richness={data.richness.band}>
        <h2>{t('products.richness.heading')}</h2>
        <p className="sortiva-products__richness-band">{richnessLabel(data.richness.band, t)}</p>
        <p className="sortiva-products__richness-note">
          {t(`products.richness.note.${data.richness.band}` as StringKey)}
        </p>
      </section>

      {tasks.open.length > 0 ? (
        <section className="sortiva-products__section" data-products-section="tasks">
          <h2>{t('products.tasks.heading')}</h2>
          <p className="sortiva-products__section-note">{t('products.tasks.intro')}</p>
          {tasks.open.map((task) => (
            <MerchantTaskCard
              key={task.opportunityId}
              task={task}
              t={t}
              opportunitiesHref={opportunitiesHref}
              onOpened={reportOpened}
            />
          ))}
        </section>
      ) : null}

      {tasks.completed.length > 0 ? (
        <details className="sortiva-products__completed" data-products-completed-tasks>
          <summary>{t('products.tasks.completed', { count: tasks.completed.length })}</summary>
          <ul>
            {tasks.completed.map((task) => (
              <li key={task.opportunityId} data-completed-task={task.opportunityId}>
                <span>{task.blockingTitle}</span>
                <span className="sortiva-products__completed-date">
                  {task.completedAt ? formatDate(task.completedAt) : null}
                </span>
                <a href={`${opportunitiesHref}#${task.opportunityId}`}>
                  {t('products.tasks.whatItBecame')}
                </a>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <FamiliesSection families={families.families} t={t} />

      <section className="sortiva-products__section" data-products-section="table">
        <div className="sortiva-products__table-head">
          <h2>{t('products.table.heading')}</h2>
          <div role="group" aria-label={t('products.table.filterLabel')}>
            <button
              type="button"
              data-products-filter="all"
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              {t('products.table.filter.all')}
            </button>
            <button
              type="button"
              data-products-filter="sparse"
              aria-pressed={filter === 'sparse'}
              onClick={() => setFilter('sparse')}
            >
              {t('products.table.filter.sparse')}
            </button>
          </div>
        </div>

        <table className="sortiva-products__table">
          <thead>
            <tr>
              <th>{t('products.table.col.product')}</th>
              <th>{t('products.table.col.family')}</th>
              <th>{t('products.table.col.facts')}</th>
              <th>{t('products.table.col.richness')}</th>
              <th>{t('products.table.col.lastSynced')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((product) => {
              const missing = missingSummary(product, t)
              const family = families.families.find((entry) => entry.id === product.familyId)
              return (
                <tr key={product.id} data-product-row={product.id}>
                  <td>
                    <span className="sortiva-products__title">{product.title}</span>
                    {missing ? (
                      <span className="sortiva-products__missing" data-product-missing>
                        {missing}
                      </span>
                    ) : null}
                  </td>
                  <td>{family ? family.label : t('products.table.noFamily')}</td>
                  <td>{product.factCount}</td>
                  <td>
                    <span
                      className="sortiva-products__band"
                      data-product-richness={product.richnessBand}
                    >
                      {richnessLabel(product.richnessBand, t)}
                    </span>
                  </td>
                  <td>{formatDate(product.lastSyncedAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </section>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="sortiva-products__count">
      <dt>{label}</dt>
      <dd>{value.toLocaleString('en-GB')}</dd>
    </div>
  )
}
