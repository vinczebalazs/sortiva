import { describe, expect, it } from 'vitest'
import { OutboundScrapeCap, PreviewRateLimiter } from './ratelimit'

describe('PreviewRateLimiter — main §3.2 "5/min, 20/day" per IP', () => {
  function at(start: number) {
    const clock = { now: start }
    const limiter = new PreviewRateLimiter({ now: () => clock.now })
    return { clock, limiter }
  }

  it('allows five in a minute and refuses the sixth', () => {
    const { limiter } = at(0)
    for (let i = 0; i < 5; i += 1) expect(limiter.check('1.1.1.1').allowed).toBe(true)
    expect(limiter.check('1.1.1.1')).toMatchObject({ allowed: false, scope: 'ip_minute' })
  })

  it('frees a slot as the minute window slides, not on a fixed boundary', () => {
    const { clock, limiter } = at(0)
    for (let i = 0; i < 5; i += 1) limiter.check('1.1.1.1')
    clock.now = 59_000
    expect(limiter.check('1.1.1.1').allowed).toBe(false)
    clock.now = 60_001
    expect(limiter.check('1.1.1.1').allowed).toBe(true)
  })

  it('enforces the daily cap once the per-minute cap stops biting', () => {
    const { clock, limiter } = at(0)
    for (let i = 0; i < 20; i += 1) {
      clock.now = i * 61_000
      expect(limiter.check('1.1.1.1').allowed).toBe(true)
    }
    clock.now = 21 * 61_000
    expect(limiter.check('1.1.1.1')).toMatchObject({ allowed: false, scope: 'ip_day' })
  })

  it('frees the daily budget 24h after the oldest request', () => {
    const { clock, limiter } = at(0)
    for (let i = 0; i < 20; i += 1) {
      clock.now = i * 61_000
      limiter.check('1.1.1.1')
    }
    clock.now = 24 * 60 * 60 * 1000 + 1000
    expect(limiter.check('1.1.1.1').allowed).toBe(true)
  })

  it('reports a Retry-After that actually frees a slot', () => {
    const { clock, limiter } = at(0)
    for (let i = 0; i < 5; i += 1) limiter.check('1.1.1.1')
    clock.now = 10_000
    const refused = limiter.check('1.1.1.1')
    expect(refused.retryAfterSeconds).toBe(50)
    clock.now = 10_000 + refused.retryAfterSeconds! * 1000
    expect(limiter.check('1.1.1.1').allowed).toBe(true)
  })

  it('counts each IP separately', () => {
    const { limiter } = at(0)
    for (let i = 0; i < 5; i += 1) limiter.check('1.1.1.1')
    expect(limiter.check('2.2.2.2').allowed).toBe(true)
  })

  it('does not record a refused request, so a hammering client cannot extend its own ban', () => {
    const { clock, limiter } = at(0)
    for (let i = 0; i < 5; i += 1) limiter.check('1.1.1.1')
    for (let i = 0; i < 100; i += 1) limiter.check('1.1.1.1')
    clock.now = 60_001
    expect(limiter.check('1.1.1.1').allowed).toBe(true)
  })

  it('forgets an IP once its day has passed, so memory does not grow without bound', () => {
    const { clock, limiter } = at(0)
    for (let i = 0; i < 10_050; i += 1) limiter.check(`10.0.${Math.floor(i / 250)}.${i % 250}`)
    clock.now = 25 * 60 * 60 * 1000
    limiter.check('9.9.9.9')
    expect(limiter.trackedIps).toBeLessThan(100)
  })
})

describe('OutboundScrapeCap — main §3.2 global concurrency cap', () => {
  it('hands out at most `limit` slots at once', () => {
    const cap = new OutboundScrapeCap(2)
    expect(cap.acquire()).toBeDefined()
    expect(cap.acquire()).toBeDefined()
    expect(cap.acquire()).toBeUndefined()
  })

  it('frees a slot on release', () => {
    const cap = new OutboundScrapeCap(1)
    const release = cap.acquire()!
    expect(cap.acquire()).toBeUndefined()
    release()
    expect(cap.acquire()).toBeDefined()
  })

  it('is idempotent on release, so a double-release cannot inflate the pool', () => {
    const cap = new OutboundScrapeCap(1)
    const release = cap.acquire()!
    release()
    release()
    expect(cap.active).toBe(0)
    expect(cap.acquire()).toBeDefined()
    expect(cap.acquire()).toBeUndefined()
  })
})
