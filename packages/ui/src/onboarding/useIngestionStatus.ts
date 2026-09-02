'use client'

import { useEffect, useState } from 'react'
import type { IngestionStatus } from './steps'

/**
 * Follows the setup run as it happens.
 *
 * The server pushes each step transition down a stream, which is what makes the
 * progress list move without the merchant reloading. Streams are the first
 * thing a corporate proxy breaks, though, and a progress screen that silently
 * freezes is worse than a slow one — so a failed stream falls back to asking
 * every few seconds, and the merchant sees no difference beyond the update
 * arriving a moment later.
 *
 * The first value comes from the page's own server-side fetch, so the list is
 * correct in the very first frame rather than empty until a connection opens.
 */

/** How often the fallback asks, matching what the status endpoint is sized for. */
export const STATUS_POLL_MS = 5_000

export interface IngestionStatusOptions {
  readonly initial?: IngestionStatus | null
  readonly streamUrl?: string
  readonly statusUrl?: string
  /** Stops both the stream and the polling once there is nothing left to watch. */
  readonly enabled?: boolean
}

export function useIngestionStatus({
  initial = null,
  streamUrl = '/api/ingestion/stream',
  statusUrl = '/api/ingestion/status',
  enabled = true,
}: IngestionStatusOptions = {}): IngestionStatus | null {
  const [status, setStatus] = useState<IngestionStatus | null>(initial)

  useEffect(() => {
    if (!enabled) return
    if (typeof window === 'undefined') return

    let stopped = false
    let source: EventSource | null = null
    let timer: ReturnType<typeof setInterval> | null = null

    const poll = async () => {
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' })
        if (!response.ok) return
        const body = (await response.json()) as IngestionStatus
        if (!stopped) setStatus(body)
      } catch {
        // A single missed poll is not worth telling the merchant about; the
        // next one is five seconds away.
      }
    }

    const startPolling = () => {
      if (timer !== null) return
      void poll()
      timer = setInterval(() => void poll(), STATUS_POLL_MS)
    }

    if (typeof EventSource === 'undefined') {
      startPolling()
    } else {
      source = new EventSource(streamUrl)
      source.onmessage = (event) => {
        try {
          const body = JSON.parse(event.data) as IngestionStatus
          if (!stopped) setStatus(body)
        } catch {
          // A malformed frame leaves the last good state on screen.
        }
      }
      source.onerror = () => {
        // The browser retries a dropped stream on its own, but it cannot tell
        // us apart from a proxy that will never allow one. Polling alongside
        // costs one request every five seconds and removes the difference.
        startPolling()
      }
    }

    return () => {
      stopped = true
      source?.close()
      if (timer !== null) clearInterval(timer)
    }
  }, [enabled, statusUrl, streamUrl])

  return status
}
