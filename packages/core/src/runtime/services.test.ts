import { afterEach, describe, expect, it } from 'vitest'
import { UnrecordedCapture } from '@sortiva/providers'
import {
  appServices,
  appServicesInitialised,
  initAppServices,
  resetAppServices,
  type AppServices,
} from './services'

afterEach(() => {
  resetAppServices()
})

describe('the process service bundle (main §14.7 — one analytics client per process)', () => {
  it('runs the factory once, however many times the entry point is called', () => {
    let built = 0
    const create = (): AppServices => {
      built += 1
      return { analytics: new UnrecordedCapture() }
    }

    const first = initAppServices(create)
    const second = initAppServices(create)

    // A second client is a second event batch, and the shutdown drain flushes
    // only the one it was handed.
    expect(built).toBe(1)
    expect(second).toBe(first)
    expect(appServices()).toBe(first)
  })

  it('throws, rather than handing back a silent no-op, when nothing initialised it', () => {
    expect(appServicesInitialised()).toBe(false)
    expect(() => appServices()).toThrow(/initAppServices/)
  })
})
