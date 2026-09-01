import type { AddressCategory, FetchPolicy } from './guard'

/**
 * The integration tests need a real HTTP server to redirect *from*, and a real
 * server on this machine can only listen on loopback, on whatever ephemeral
 * port the OS hands out. Production policy blocks both, correctly.
 *
 * So the tests run with a policy identical to production except that `loopback`
 * is an admissible address category and one extra port is permitted. Every
 * other category — private (10/8, 172.16/12, 192.168/16), link-local and cloud
 * metadata (169.254/16), CGNAT, unique-local, multicast, reserved, the tunnel
 * ranges — is still refused by the same code production runs, and every other
 * port is still refused. That is what makes "a real server redirecting to
 * 169.254.169.254 is blocked" a real test rather than a rehearsal.
 *
 * `fetch.test.ts` additionally asserts that the **production** policy refuses
 * the same loopback server, so the carve-out is provably the only difference.
 *
 * Nothing in `apps/*` or in production code imports this file.
 */
export function loopbackAllowedPolicy(port: number): FetchPolicy {
  return {
    name: 'test-loopback-allowed',
    allowedCategories: new Set<AddressCategory>(['public', 'loopback']),
    allowedPorts: new Set<number>([80, 443, port]),
  }
}
