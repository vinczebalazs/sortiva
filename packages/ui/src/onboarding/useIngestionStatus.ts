'use client'

import { useEffect, useState } from 'react'
import { followIngestion, type FollowDependencies, type StreamSource } from './follow'
import type { IngestionStatus } from './steps'

/**
 * Follows the setup run as it happens.
 *
 * The first value comes from the page's own server-side read, so the progress
 * list is correct in the very first frame rather than empty until a connection
 * opens. Everything about how the following works — the stream, and the poll
 * that takes over when the stream is refused — is in `follow.ts`, which is
 * where it can be tested; this is only the browser's half of it.
 */

/** How often the fallback asks, matching what the status route is sized for. */
export const STATUS_POLL_MS = 5_000

export interface IngestionStatusOptions {
  readonly initial?: IngestionStatus | null
  readonly streamUrl?: string
  readonly statusUrl?: string
  /** Stops both the stream and the polling once there is nothing left to watch. */
  readonly enabled?: boolean
}

/** The browser's half: a real event stream, a real fetch, a real timer. */
export function browserFollowDependencies(): FollowDependencies {
  return {
    openStream: (url) => {
      if (typeof EventSource === 'undefined') return null
      const source = new EventSource(url)
      const wrapper: StreamSource = {
        onMessage: (handler) => {
          source.onmessage = (event) => {
            try {
              handler(JSON.parse(event.data) as IngestionStatus)
            } catch {
              // A malformed frame leaves the last good state on screen.
            }
          }
        },
        onError: (handler) => {
          source.onerror = () => handler()
        },
        close: () => source.close(),
      }
      return wrapper
    },
    readStatus: async (url) => {
      try {
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) return null
        return (await response.json()) as IngestionStatus
      } catch {
        return null
      }
    },
    schedule: (run, everyMs) => {
      const timer = setInterval(run, everyMs)
      return () => clearInterval(timer)
    },
  }
}

export function useIngestionStatus({
  initial = null,
  streamUrl = '/api/ingestion/stream',
  statusUrl = '/api/ingestion/status',
  enabled = true,
}: IngestionStatusOptions = {}): IngestionStatus | null {
  const [status, setStatus] = useState<IngestionStatus | null>(initial)

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    return followIngestion(
      { streamUrl, statusUrl, pollMs: STATUS_POLL_MS },
      setStatus,
      browserFollowDependencies(),
    )
  }, [enabled, statusUrl, streamUrl])

  return status
}
