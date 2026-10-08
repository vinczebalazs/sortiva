import { PassThrough } from 'node:stream'
import { createReadableStreamFromReadable } from '@react-router/node'
import { isbot } from 'isbot'
import { renderToPipeableStream } from 'react-dom/server'
import { ServerRouter, type EntryContext } from 'react-router'

export const streamTimeout = 5000

/** The embedded pages may be framed only by the merchant's own admin. */
function frameAncestors(request: Request): string {
  const shop = new URL(request.url).searchParams.get('shop')
  const own = shop && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? ` https://${shop}` : ''
  return `frame-ancestors https://admin.shopify.com${own};`
}

export default function handleRequest(request: Request, status: number, headers: Headers, context: EntryContext) {
  headers.set('Content-Security-Policy', frameAncestors(request))
  const ready = isbot(request.headers.get('user-agent') ?? '') ? 'onAllReady' : 'onShellReady'
  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(<ServerRouter context={context} url={request.url} />, {
      [ready]: () => {
        const body = new PassThrough()
        headers.set('Content-Type', 'text/html')
        resolve(new Response(createReadableStreamFromReadable(body), { headers, status }))
        pipe(body)
      },
      onShellError: reject,
      onError: (error: unknown) => {
        status = 500
        console.error(error)
      },
    })
    setTimeout(abort, streamTimeout + 1000)
  })
}
