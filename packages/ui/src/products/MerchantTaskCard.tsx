import { t as defaultTranslate, type Translate } from '../strings'
import { impactLabel } from '../opportunities/list'
import { fieldLabel, isShopifyAdminUrl } from './products'
import type { MerchantTask, TaskProduct } from './types'

/**
 * One opportunity we cannot act on yet, and the work that would unblock it.
 *
 * The card leads with what is being held up and what it is worth, because a
 * list of products missing a "material" field is a chore, and "this is what
 * stands between you and a high-impact guide" is a reason. Each product links
 * straight into Shopify admin rather than asking the merchant to retype facts
 * into us: their catalogue is the one copy, and we hold a read-only view of it.
 *
 * Nothing here is submitted. The next catalogue sync notices the fields arrived
 * and the opportunity proceeds on its own, which the card says plainly — a
 * screen with no submit button and no explanation reads as broken.
 */

export interface MerchantTaskCardProps {
  readonly task: MerchantTask
  readonly t?: Translate
  readonly opportunitiesHref?: string
  /** Reported when the merchant follows a task into Shopify. */
  readonly onOpened?: (task: MerchantTask) => void
}

export function MerchantTaskCard({
  task,
  t = defaultTranslate,
  opportunitiesHref = '/opportunities',
  onOpened,
}: MerchantTaskCardProps) {
  const linkable = task.products.filter((product) => isShopifyAdminUrl(product.shopifyAdminUrl))

  return (
    <article className="sortiva-products__task" data-merchant-task={task.opportunityId}>
      <header className="sortiva-products__task-head">
        <span className="sortiva-products__task-badge" data-task-impact={task.impact}>
          {t('products.tasks.badge')}
        </span>
        <p className="sortiva-products__task-blocking" data-task-blocking>
          {t('products.tasks.blocking', {
            title: task.blockingTitle,
            impact: impactLabel(task.impact, t),
          })}
        </p>
        <a href={`${opportunitiesHref}#${task.opportunityId}`} data-task-opportunity-link>
          {t('products.tasks.seeOpportunity')}
        </a>
      </header>

      <ul className="sortiva-products__task-products">
        {task.products.map((product) => (
          <TaskRow key={product.id} product={product} task={task} t={t} onOpened={onOpened} />
        ))}
      </ul>

      <footer className="sortiva-products__task-foot">
        {linkable.length > 0 ? (
          <a
            className="sortiva-products__task-open-all"
            href={linkable[0]!.shopifyAdminUrl}
            target="_blank"
            rel="noreferrer noopener"
            data-task-open-first
            onClick={onOpened ? () => onOpened(task) : undefined}
          >
            {t('products.tasks.openInShopify')}
          </a>
        ) : null}
        <p className="sortiva-products__task-note" data-task-recheck>
          {t('products.tasks.recheck')}
        </p>
      </footer>
    </article>
  )
}

function TaskRow({
  product,
  task,
  t,
  onOpened,
}: {
  product: TaskProduct
  task: MerchantTask
  t: Translate
  onOpened?: (task: MerchantTask) => void
}) {
  const missing = product.missingFields.map((field) => fieldLabel(field, t)).join(' · ')
  const safe = isShopifyAdminUrl(product.shopifyAdminUrl)

  return (
    <li data-task-product={product.id}>
      {safe ? (
        <a
          href={product.shopifyAdminUrl}
          target="_blank"
          rel="noreferrer noopener"
          data-task-product-link={product.id}
          onClick={onOpened ? () => onOpened(task) : undefined}
        >
          {product.title}
        </a>
      ) : (
        <span data-task-product-unlinked={product.id}>{product.title}</span>
      )}
      {missing === '' ? null : (
        <span className="sortiva-products__task-missing" data-task-missing>
          {missing}
        </span>
      )}
    </li>
  )
}
