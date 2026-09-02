import { pingDatabase } from '@sortiva/db'
import { checkHealth, type HealthProbes } from '@sortiva/core/observability/health'

/**
 * The platform's health check, and the only automatic recovery this deployment
 * has: a container whose health check fails is restarted, and one whose health
 * check cannot fail never is.
 *
 * Kept out of `route.ts` so a test can drive the identical function with
 * probes it controls, rather than needing a broken database to prove the
 * broken case.
 *
 * The healthy body stays exactly `{ "ok": true }` — the shape the API contract
 * has always described for this route. Failure answers 503 with the error
 * envelope every other route shares, naming each probe that failed, so an
 * operator who curls it learns which half is down without reading a log.
 */
export function makeHealthHandler(probes?: HealthProbes): () => Promise<Response> {
  const resolved: HealthProbes = probes ?? { pingDatabase: () => pingDatabase() }
  return async () => {
    const report = await checkHealth(resolved)
    if (report.ok) return Response.json({ ok: true })

    const failed = report.checks.filter((check) => !check.ok)
    return Response.json(
      {
        error: {
          code: 'unhealthy',
          message: `This instance cannot do its work: ${failed.map((check) => check.name).join(', ')}.`,
          details: failed.map((check) => ({ path: check.name, message: check.detail })),
        },
      },
      // 503 rather than 500: the process is up and answering, it just cannot
      // serve. That is also what the platform reads as "restart me".
      { status: 503, headers: { 'cache-control': 'no-store' } },
    )
  }
}

export const healthHandler = makeHealthHandler()
