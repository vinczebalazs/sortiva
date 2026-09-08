'use client'

import { useState } from 'react'
import { t as defaultTranslate, type StringKey, type Translate } from '../strings'
import { recommendationFiles, type DownloadFile } from './download'
import {
  actionLabel,
  confidenceLabel,
  entityLabel,
  factLabel,
  formatDate,
  impactLabel,
  recommendationFieldLabel,
  signalLabel,
  sourceLabel,
  statusLabel,
  windowLabel,
} from './list'
import type { OpportunityDetail, OpportunityTask } from './types'
import { renderTemplatedLine } from './why'

/**
 * Everything behind one opportunity, in the order that decides whether the
 * product is believed.
 *
 * Evidence comes before recommendation, always: every number with where it came
 * from, over what window and how fresh it is, then who else ranks for the
 * query, and only then what to change. A suggestion sits beside what the page
 * says today rather than replacing it, because the merchant is the one who will
 * type it in and has to be able to see what they are giving up.
 *
 * The three action types that end here look different because the work is
 * different: an OPTIMIZE hands over copy to paste, a FIX hands over an
 * instruction we worked out from the store's own data and will not carry out,
 * and a HOLD hands back a list of things only the merchant can supply.
 */

export interface OpportunityDrawerProps {
  readonly detail: OpportunityDetail
  readonly t?: Translate
  readonly onClose?: () => void
  /** The answer names its task; there is no way to answer for all of them at once. */
  readonly onTask?: (task: OpportunityTask, state: 'applied' | 'skipped') => void
  readonly onMarkAllApplied?: () => void
  readonly onGenerate?: () => void
  /** Regeneration waits for new evidence; until then the stored recommendation is what there is. */
  readonly canRegenerate?: boolean
  /** Called with the field name after a copy, so the screen can report it. */
  readonly onCopy?: (field: string) => void
  readonly productsHref?: string
  readonly busy?: boolean
}

/** Hands the file to the browser. Nothing is uploaded and nothing is generated here. */
function saveFile(file: DownloadFile): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function OpportunityDrawer({
  detail,
  t = defaultTranslate,
  onClose,
  onTask,
  onMarkAllApplied,
  onGenerate,
  canRegenerate = false,
  onCopy,
  productsHref = '/products',
  busy = false,
}: OpportunityDrawerProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const { opportunity, tasks, serpSnapshot, recommendation, history, outcome } = detail
  const why = renderTemplatedLine(opportunity.why, t)
  const files = recommendationFiles(detail, t)

  async function copy(field: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(field)
    } catch {
      // A browser that refuses the clipboard leaves the text on screen to
      // select by hand, which is what it was before there was a button.
    }
    onCopy?.(field)
  }

  return (
    <aside
      className="sortiva-drawer"
      role="dialog"
      aria-label={t('opportunities.drawer.label')}
      data-opportunity-drawer={opportunity.id}
      data-drawer-action={opportunity.recommendedAction}
    >
      <button type="button" className="sortiva-drawer__close" onClick={onClose}>
        {t('opportunities.drawer.close')}
      </button>

      <header className="sortiva-drawer__summary" data-drawer-section="summary">
        <div className="sortiva-opp__pills">
          <span className="sortiva-opp__badge" data-opp-badge={opportunity.recommendedAction}>
            {actionLabel(opportunity.recommendedAction, t)}
          </span>
          <span className="sortiva-opp__pill">{impactLabel(opportunity.impact, t)}</span>
          <span className="sortiva-opp__pill">{confidenceLabel(opportunity.confidence, t)}</span>
          <span className="sortiva-opp__tag">{signalLabel(opportunity.signalType, t)}</span>
        </div>
        <h2 className="sortiva-drawer__heading">{opportunity.entityRef.label}</h2>
        <p className="sortiva-drawer__note">
          {t('opportunities.drawer.entityLine', {
            entity: entityLabel(opportunity.entityRef.kind, t),
            id: opportunity.entityRef.id,
          })}
        </p>
        <p className="sortiva-drawer__note">
          {t('opportunities.drawer.found', { date: formatDate(opportunity.detectedAt) })}
        </p>
        <p className="sortiva-opp__why">{why.text}</p>
      </header>

      <section className="sortiva-drawer__section" data-drawer-section="evidence">
        <h3 className="sortiva-drawer__heading">{t('opportunities.drawer.evidence')}</h3>
        <table className="sortiva-drawer__table">
          <thead>
            <tr>
              <th>{t('opportunities.drawer.evidenceFact')}</th>
              <th>{t('opportunities.drawer.evidenceSource')}</th>
              <th>{t('opportunities.drawer.evidenceWindow')}</th>
              <th>{t('opportunities.drawer.evidenceFetched')}</th>
            </tr>
          </thead>
          <tbody>
            {opportunity.evidence.map((fact) => (
              <tr key={`${fact.key}-${fact.source}`} data-evidence-key={fact.key}>
                <td>{factLabel(fact, t)}</td>
                <td>{sourceLabel(fact.source, t)}</td>
                <td>{windowLabel(fact.window, t)}</td>
                <td>{formatDate(fact.fetchedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {opportunity.limitedIntelligence ? (
          <p className="sortiva-drawer__note">{t('opportunities.estimatedRanking')}</p>
        ) : null}
      </section>

      {serpSnapshot && serpSnapshot.length > 0 ? (
        <section className="sortiva-drawer__section" data-drawer-section="serp">
          <h3 className="sortiva-drawer__heading">{t('opportunities.drawer.serp')}</h3>
          <table className="sortiva-drawer__table">
            <thead>
              <tr>
                <th>{t('opportunities.drawer.serpPosition')}</th>
                <th>{t('opportunities.drawer.serpDomain')}</th>
              </tr>
            </thead>
            <tbody>
              {serpSnapshot.map((row) => (
                <tr key={row.url}>
                  <td>{row.position}</td>
                  <td>{row.domain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {opportunity.recommendedAction === 'HOLD' ? (
        <section className="sortiva-drawer__section" data-drawer-section="hold">
          <h3 className="sortiva-drawer__heading">{t('opportunities.hold.heading')}</h3>
          {opportunity.preconditions.map((precondition) => (
            <p key={precondition.code} className="sortiva-opp__ribbon">
              {renderTemplatedLine(precondition.whatToDo, t).text}
            </p>
          ))}
          <ul className="sortiva-drawer__tasks">
            {tasks.map((task) => (
              <li key={task.id} className="sortiva-drawer__task" data-hold-task={task.id}>
                <span>{task.label}</span>
                <span className="sortiva-drawer__task-state">
                  {t(`opportunities.drawer.${task.state === 'open' ? 'markApplied' : task.state}` as StringKey)}
                </span>
              </li>
            ))}
          </ul>
          <p className="sortiva-drawer__note">{t('opportunities.hold.recheck')}</p>
          <a className="sortiva-opp__primary" href={productsHref}>
            {t('opportunities.hold.openProducts')}
          </a>
        </section>
      ) : null}

      {opportunity.recommendedAction === 'FIX' ? (
        <section className="sortiva-drawer__section" data-drawer-section="fix">
          <h3 className="sortiva-drawer__heading">{t('opportunities.fix.heading')}</h3>
          <p className="sortiva-drawer__note">{t('opportunities.fix.deterministic')}</p>
          {recommendation?.state === 'failed_validation' ? (
            <p className="sortiva-drawer__failed">{t('opportunities.rec.failed')}</p>
          ) : (
            <ol className="sortiva-drawer__tasks">
              {(recommendation?.fields ?? []).map((field) => (
                <li key={field.field} data-fix-step={field.field}>
                  <strong>{recommendationFieldLabel(field.field, t)}</strong>
                  <span> {field.suggested}</span>
                </li>
              ))}
            </ol>
          )}
          {/* The one sentence this view exists to make unmissable: we found the
              problem, and we are not going to touch the shop to fix it. */}
          <p className="sortiva-drawer__note">{t('opportunities.fix.noThemeChanges')}</p>
        </section>
      ) : null}

      {opportunity.recommendedAction === 'OPTIMIZE' ? (
        <section className="sortiva-drawer__section" data-drawer-section="recommendation">
          <h3 className="sortiva-drawer__heading">{t('opportunities.rec.heading')}</h3>

          {recommendation === null || recommendation.state === 'none' ? (
            <button
              type="button"
              className="sortiva-opp__primary"
              data-rec-action="generate"
              disabled={busy}
              onClick={onGenerate}
            >
              {t('opportunities.primary.generate')}
            </button>
          ) : recommendation.state === 'generating' ? (
            <p className="sortiva-drawer__note">{t('opportunities.rec.generating')}</p>
          ) : recommendation.state === 'failed_validation' ? (
            <div className="sortiva-drawer__failed" data-rec-state="failed_validation">
              <p>{t('opportunities.rec.failed')}</p>
              {recommendation.failureReason ? (
                <p>{renderTemplatedLine(recommendation.failureReason, t).text}</p>
              ) : null}
            </div>
          ) : (
            <>
              {recommendation.fields.map((field) => (
                <div className="sortiva-rec__field" key={field.field} data-rec-field={field.field}>
                  <div className="sortiva-rec__field-head">
                    <span className="sortiva-rec__field-name">
                      {recommendationFieldLabel(field.field, t)}
                    </span>
                    {/* The one sentence on this card the model wrote itself and
                        nobody checked, so it says so where it is read. */}
                    {field.evidence ? (
                      <span className="sortiva-rec__evidence" data-rec-model-written={field.field}>
                        <span className="sortiva-rec__model-written">
                          {t('opportunities.rec.modelWritten')}
                        </span>{' '}
                        {field.evidence}
                      </span>
                    ) : null}
                  </div>
                  <div className="sortiva-rec__pair">
                    <div className="sortiva-rec__side" data-rec-side="current">
                      <span className="sortiva-rec__side-label">{t('opportunities.rec.current')}</span>
                      {field.current ?? t('opportunities.rec.currentEmpty')}
                    </div>
                    <div className="sortiva-rec__side" data-rec-side="suggested">
                      <span className="sortiva-rec__side-label">
                        {t('opportunities.rec.suggested')}
                      </span>
                      {field.suggested}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sortiva-rec__copy"
                    data-rec-copy={field.field}
                    aria-label={t('opportunities.rec.copyLabel')}
                    onClick={() => void copy(field.field, field.suggested)}
                  >
                    {copied === field.field ? t('opportunities.rec.copied') : t('opportunities.rec.copy')}
                  </button>
                </div>
              ))}

              {recommendation.internalLinksIn.length > 0 ? (
                <div data-rec-links="in">
                  <h4 className="sortiva-drawer__heading">{t('opportunities.rec.linksIn')}</h4>
                  <ul className="sortiva-drawer__links">
                    {recommendation.internalLinksIn.map((link) => (
                      <li key={link.fromUrl}>{link.fromUrl}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {recommendation.internalLinksOut.length > 0 ? (
                <div data-rec-links="out">
                  <h4 className="sortiva-drawer__heading">{t('opportunities.rec.linksOut')}</h4>
                  <ul className="sortiva-drawer__links">
                    {recommendation.internalLinksOut.map((link) => (
                      <li key={link.toUrl}>{link.toUrl}</li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {recommendation.intentNote ? (
                <div data-rec-intent="true">
                  <h4 className="sortiva-drawer__heading">{t('opportunities.rec.intentNote')}</h4>
                  <p className="sortiva-drawer__note">{recommendation.intentNote}</p>
                </div>
              ) : null}

              <div className="sortiva-rec__footer">
                {files.map((file, index) => (
                  <button
                    key={file.filename}
                    type="button"
                    className="sortiva-opp__secondary"
                    data-rec-download={index === 0 ? 'markdown' : 'html'}
                    onClick={() => saveFile(file)}
                  >
                    {index === 0
                      ? t('opportunities.rec.downloadMarkdown')
                      : t('opportunities.rec.downloadHtml')}
                  </button>
                ))}
                <button
                  type="button"
                  className="sortiva-opp__primary"
                  data-rec-action="mark_all_applied"
                  disabled={busy}
                  onClick={onMarkAllApplied}
                >
                  {t('opportunities.rec.markAllApplied')}
                </button>
                <button
                  type="button"
                  className="sortiva-opp__secondary"
                  data-rec-action="regenerate"
                  disabled={!canRegenerate}
                  title={canRegenerate ? undefined : t('opportunities.rec.regenerateUnavailable')}
                  onClick={onGenerate}
                >
                  {t('opportunities.rec.regenerate')}
                </button>
              </div>
              <p className="sortiva-drawer__note">{t('opportunities.rec.neverApplies')}</p>
            </>
          )}
        </section>
      ) : null}

      <section className="sortiva-drawer__section" data-drawer-section="tasks">
        <h3 className="sortiva-drawer__heading">{t('opportunities.drawer.tasks')}</h3>
        {tasks.length === 0 ? (
          <p className="sortiva-drawer__note">{t('opportunities.drawer.noTasks')}</p>
        ) : (
          <ul className="sortiva-drawer__tasks">
            {tasks.map((task) => (
              <li key={task.id} className="sortiva-drawer__task" data-task-id={task.id}>
                <span>{task.label}</span>
                {task.state === 'open' ? (
                  // Both answers are per task and neither is offered in bulk.
                  // Declining is a separate act with a separate record: it must
                  // never travel as an application, because the row it writes is
                  // what outcome measurement later reads.
                  <>
                    <button
                      type="button"
                      className="sortiva-opp__secondary"
                      data-task-action="applied"
                      disabled={busy}
                      onClick={() => onTask?.(task, 'applied')}
                    >
                      {t('opportunities.drawer.markApplied')}
                    </button>
                    <button
                      type="button"
                      className="sortiva-opp__secondary"
                      data-task-action="skipped"
                      disabled={busy}
                      onClick={() => onTask?.(task, 'skipped')}
                    >
                      {t('opportunities.drawer.skip')}
                    </button>
                  </>
                ) : (
                  <span className="sortiva-drawer__task-state" data-task-state={task.state}>
                    {t(`opportunities.drawer.${task.state}` as StringKey)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sortiva-drawer__section" data-drawer-section="history">
        <h3 className="sortiva-drawer__heading">{t('opportunities.drawer.history')}</h3>
        <ul className="sortiva-drawer__history">
          {history.map((entry) => (
            <li key={`${entry.at}-${entry.to}`} data-history-to={entry.to}>
              <span>
                {t('opportunities.drawer.historyEntry', {
                  status: statusLabel(entry.to, t),
                  actor: t(`opportunities.drawer.historyActor.${entry.actor}` as StringKey),
                })}
              </span>
              <span className="sortiva-drawer__task-state">{formatDate(entry.at)}</span>
              {entry.reason ? <p>{renderTemplatedLine(entry.reason, t).text}</p> : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="sortiva-drawer__section" data-drawer-section="outcome">
        <h3 className="sortiva-drawer__heading">{t('opportunities.drawer.outcome')}</h3>
        {outcome === null ? (
          // Nothing measurable exists before the 28 days are up, and a number
          // put here early would be noise read as a result.
          <p className="sortiva-drawer__note">{t('opportunities.drawer.outcomePending')}</p>
        ) : (
          <>
            <p className="sortiva-drawer__note">
              {t('opportunities.drawer.outcomeMeasured', {
                label: outcome.label,
                date: formatDate(outcome.measuredAt),
              })}
            </p>
            <p className="sortiva-drawer__note">
              {t('opportunities.drawer.outcomeNumbers', {
                before: outcome.before,
                after: outcome.after,
              })}
            </p>
          </>
        )}
      </section>
    </aside>
  )
}
