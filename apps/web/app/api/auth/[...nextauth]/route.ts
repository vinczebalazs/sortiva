import { handlers } from '../_lib/auth'

/**
 * Auth.js owns `/api/auth/*` and defines those shapes itself, which
 * is why the frozen route table in `packages/core` deliberately omits them
 * (DECISIONS 2026-08-31 T0.7).
 */
export const { GET, POST } = handlers
