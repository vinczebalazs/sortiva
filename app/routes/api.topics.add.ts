import type { ActionFunctionArgs } from 'react-router'
import { BudgetExceededError } from '../../core/errors.ts'
import { DemandUnavailableError } from '../../core/demand.ts'
import { addManualTopic } from '../../core/topics/manual.ts'
import { recordBudgetPause } from '../../core/status.ts'
import { db, requireStore, topics } from '../server/context.server.ts'

export async function action({ request }: ActionFunctionArgs) {
  const storeId = requireStore(request)
  const { phrase } = (await request.json()) as { phrase?: string }
  if (!phrase?.trim()) return Response.json({ error: 'empty' }, { status: 422 })
  try {
    return Response.json(await addManualTopic(topics(), storeId, phrase.trim().slice(0, 200)))
  } catch (error) {
    if (error instanceof BudgetExceededError) {
      await recordBudgetPause(db(), storeId)
      return Response.json({ kind: 'budget' }, { status: 409 })
    }
    if (error instanceof DemandUnavailableError) return Response.json({ kind: 'unavailable' }, { status: 503 })
    // A refusal, a malformed answer twice, or anything unexpected: the merchant gets a plain message, we get the log.
    console.error('add topic failed', { storeId, error })
    return Response.json({ kind: 'error' }, { status: 500 })
  }
}
