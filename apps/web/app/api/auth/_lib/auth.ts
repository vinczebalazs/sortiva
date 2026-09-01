import NextAuth, { type Session } from 'next-auth'
import { buildAuthConfig } from './config'
import { provisioningDeps } from './provisioning'

/**
 * The single Auth.js instance. `handlers` mounts `/api/auth/*`; `auth()` is how
 * the rest of the app reads the session, which is the only place a request may
 * learn which account it belongs to.
 *
 * The explicit `auth` annotation is not decoration: Auth.js's inferred type
 * names types inside `node_modules`, which `declaration: true` cannot emit. It
 * also keeps the exported surface to the two things the app uses.
 */
const nextAuth = NextAuth(buildAuthConfig({ provisioning: provisioningDeps() }))

export const handlers = nextAuth.handlers
export const auth: () => Promise<Session | null> = nextAuth.auth as () => Promise<Session | null>
