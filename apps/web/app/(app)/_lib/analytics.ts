/**
 * Where the browser gets the analytics project's address from.
 *
 * The key is the project's *public* key — it is meant to be in the page, which
 * is how the browser reports directly to the vendor at all. It has its own
 * variable rather than sharing the server's, so nothing that looks like a
 * secret can end up in a page because two names happened to hold one value.
 *
 * Both may be absent. A deployment with no analytics project reports nothing
 * and works exactly as it otherwise would.
 */

export interface BrowserAnalyticsConfig {
  readonly projectKey: string | null
  readonly host: string | null
}

export function browserAnalyticsConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserAnalyticsConfig {
  return {
    projectKey: env.NEXT_PUBLIC_POSTHOG_KEY || null,
    host: env.POSTHOG_HOST || null,
  }
}
