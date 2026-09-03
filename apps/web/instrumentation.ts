/**
 * Next calls `register()` once per server process — the only start-up hook the
 * App Router offers. Everything the process actually needs built lives in
 * `instrumentation-node.ts`, and is reached from here by an import inside a
 * positive check on the runtime.
 *
 * **That shape is load-bearing, not tidiness.** Next compiles this file for the
 * Edge runtime as well as Node, and the Edge build has no filesystem. The job
 * worker's own vendor config reader asks for `fs/promises`, so while its import
 * sat in this file it was compiled for Edge too and could not resolve — which
 * made every page in `next dev` answer 500 while `pnpm build` stayed green.
 * `NEXT_RUNTIME` is replaced at build time, so the branch below is removed
 * outright from the Edge bundle and the worker is never compiled for a runtime
 * that could not run it.
 *
 * Keep the import inside the check. Hoisting it back to the top of the module
 * restores the defect, and no test will tell you.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startServerRuntime } = await import('./instrumentation-node')
    await startServerRuntime()
  }
}

/**
 * **Where an unhandled error in any route ends up.** Next calls this for every
 * server-side error it catches, so no route has to remember to report its own,
 * and the ones with no session — the webhooks, the OAuth callbacks, the public
 * preview — are covered exactly like the rest.
 *
 * Before this, an unhandled error printed to stdout and stopped there: nothing
 * alerted, and two hundred copies of one fault stayed two hundred separate
 * lines nobody counted.
 *
 * The query string is dropped and no header is forwarded: this reports where it
 * broke, never what the caller sent.
 */
export async function onRequestError(
  error: unknown,
  request: { path?: string; method?: string },
  context?: { routerKind?: string; routePath?: string; routeType?: string },
): Promise<void> {
  const { reportCrash } = await import('@sortiva/core/observability/crash')
  reportCrash(error, {
    properties: {
      source: 'route',
      method: request.method ?? null,
      path: request.path?.split('?')[0] ?? null,
      route_path: context?.routePath ?? null,
      route_type: context?.routeType ?? null,
      router_kind: context?.routerKind ?? null,
    },
  })
}
