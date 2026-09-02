import type { IngestionStatus } from './steps'

/**
 * How the setup progress list keeps up with a run that is still going.
 *
 * The server pushes each step transition down a stream, which is what makes
 * the list move without the merchant reloading. Streams are also the first
 * thing a corporate proxy or an over-eager antivirus breaks, and a progress
 * screen that silently freezes is worse than a slow one — the merchant
 * concludes the product is broken and leaves. So a stream that errors starts a
 * poll alongside it, and the two are interchangeable: both carry whole status
 * bodies, so whichever arrives first is correct on its own.
 *
 * The mechanism is a plain function with its browser pieces passed in, so the
 * behaviour that matters — falls back on error, falls back where there is no
 * stream at all, stops cleanly — is provable without a browser.
 */

export interface StreamSource {
  /** Called with each whole status body the stream delivers. */
  onMessage: (handler: (status: IngestionStatus) => void) => void
  /** Called when the stream fails or is refused. */
  onError: (handler: () => void) => void
  close: () => void
}

export interface FollowDependencies {
  /** Opens the stream, or answers null where the browser has no such thing. */
  readonly openStream: (url: string) => StreamSource | null
  /** One read of the status route. Null on any failure — a missed read is not news. */
  readonly readStatus: (url: string) => Promise<IngestionStatus | null>
  /** Starts a repeating timer and hands back the way to stop it. */
  readonly schedule: (run: () => void, everyMs: number) => () => void
}

export interface FollowOptions {
  readonly streamUrl: string
  readonly statusUrl: string
  readonly pollMs: number
}

/** Starts following, and hands back the way to stop. */
export function followIngestion(
  options: FollowOptions,
  onStatus: (status: IngestionStatus) => void,
  deps: FollowDependencies,
): () => void {
  let stopped = false
  let cancelPolling: (() => void) | null = null

  const read = () => {
    void deps.readStatus(options.statusUrl).then((status) => {
      if (status !== null && !stopped) onStatus(status)
    })
  }

  const startPolling = () => {
    if (cancelPolling !== null || stopped) return
    read()
    cancelPolling = deps.schedule(read, options.pollMs)
  }

  const stream = deps.openStream(options.streamUrl)

  if (stream === null) {
    startPolling()
  } else {
    stream.onMessage((status) => {
      if (!stopped) onStatus(status)
    })
    // The browser retries a dropped stream on its own, but it cannot tell us
    // apart from a proxy that will never allow one. Polling alongside costs one
    // request every few seconds and removes the difference.
    stream.onError(startPolling)
  }

  return () => {
    stopped = true
    stream?.close()
    cancelPolling?.()
  }
}
