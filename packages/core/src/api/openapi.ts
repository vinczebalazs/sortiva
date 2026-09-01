import { z } from 'zod'
import {
  ENTITLEMENT_INACTIVE_CODE,
  RATE_LIMITED_CODE,
  conflictResponseSchema,
  errorResponseSchema,
} from './errors'
import { ROUTES, type RouteDefinition } from './routes'

/**
 * The OpenAPI document, generated from the route table rather than maintained
 * beside it.
 *
 * Two descriptions of the same API drift the moment one is edited without the
 * other, and the drift is invisible until a frontend built against the document
 * meets a backend built against the schemas. Generating one from the other makes
 * that impossible; `pnpm contracts:check` regenerates and diffs the committed
 * file, so a hand-edit or a stale commit fails the build.
 */

const OPENAPI_VERSION = '3.1.0'

function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  // `io: 'input'` would describe what a caller may send; responses are what the
  // server produces, so the output view is the correct one for both directions
  // here — our request schemas apply no transforms.
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>
}

function pathParametersOf(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
    name,
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))
}

/**
 * Query objects become one parameter per property. Array-valued filters (the
 * Opportunities screen's multi-select chips) are `form`-style repeats, which is
 * what `URLSearchParams.getAll` produces.
 */
function queryParametersOf(schema: z.ZodType): Record<string, unknown>[] {
  const json = jsonSchemaOf(schema)
  const properties = (json.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = new Set((json.required ?? []) as string[])

  return Object.entries(properties).map(([name, propertySchema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    ...(propertySchema.type === 'array' ? { style: 'form', explode: true } : {}),
    schema: propertySchema,
  }))
}

function operationOf(route: RouteDefinition): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    [String(route.status ?? 200)]: {
      description: route.sse ? 'Server-sent events; each event carries this payload.' : 'Success',
      content: {
        [route.sse ? 'text/event-stream' : 'application/json']: {
          schema: jsonSchemaOf(route.response),
        },
      },
    },
  }

  if (route.auth === 'session') {
    responses['401'] = {
      description: 'No session. Every authenticated route resolves account_id from the session, never from the request.',
      content: { 'application/json': { schema: jsonSchemaOf(errorResponseSchema) } },
    }
  }

  if (route.body || route.query) {
    responses['422'] = {
      description: 'Request failed schema validation.',
      content: { 'application/json': { schema: jsonSchemaOf(errorResponseSchema) } },
    }
  }

  if (route.requiresEntitlement) {
    responses['402'] = {
      description: `Billing state gates generation and publishing only; read access is never revoked. Code: ${ENTITLEMENT_INACTIVE_CODE}.`,
      content: { 'application/json': { schema: jsonSchemaOf(errorResponseSchema) } },
    }
  }

  if (route.rateLimited) {
    responses['429'] = {
      description: `Per-IP and global rate limits. Code: ${RATE_LIMITED_CODE}.`,
      content: { 'application/json': { schema: jsonSchemaOf(errorResponseSchema) } },
    }
  }

  if (route.conflicts && route.conflicts.length > 0) {
    responses['409'] = {
      description: `The state changed underneath this request. Codes: ${route.conflicts.join(', ')}.`,
      content: {
        'application/json': {
          schema: {
            ...jsonSchemaOf(conflictResponseSchema),
            'x-conflict-codes': [...route.conflicts],
          },
        },
      },
    }
  }

  const parameters = [
    ...pathParametersOf(route.path),
    ...(route.query ? queryParametersOf(route.query) : []),
  ]

  return {
    operationId: operationIdOf(route),
    summary: route.summary,
    tags: [tagOf(route.path)],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.auth === 'session' ? { security: [{ sessionCookie: [] }] } : { security: [] }),
    ...(route.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchemaOf(route.body) } },
          },
        }
      : {}),
    responses,
  }
}

export function operationIdOf(route: Pick<RouteDefinition, 'method' | 'path'>): string {
  const segments = route.path
    .replace(/^\/api\//, '')
    .split('/')
    .map((segment) =>
      segment.startsWith('{') ? `by-${segment.slice(1, -1).replace(/Id$/, '')}` : segment,
    )
  return [route.method.toLowerCase(), ...segments]
    .join('-')
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
}

function tagOf(path: string): string {
  return path.replace(/^\/api\//, '').split('/')[0] ?? 'api'
}

export function buildOpenApiDocument(routes: readonly RouteDefinition[] = ROUTES): object {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of routes) {
    paths[route.path] ??= {}
    paths[route.path]![route.method.toLowerCase()] = operationOf(route)
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Sortiva API',
      version: '0.0.0',
      description:
        'Generated from packages/core/src/api/routes.ts. Do not edit by hand — `pnpm contracts:check` fails on drift.',
    },
    servers: [{ url: '{origin}', variables: { origin: { default: 'http://localhost:3000' } } }],
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'sortiva-session' },
      },
    },
    // Sorted, so the committed file's diff reflects real changes rather than
    // iteration order.
    paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
  }
}

/** The exact bytes the committed `openapi.json` must contain. */
export function serialiseOpenApi(document: object = buildOpenApiDocument()): string {
  return `${JSON.stringify(document, null, 2)}\n`
}
