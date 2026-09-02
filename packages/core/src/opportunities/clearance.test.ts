import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rules } from '@sortiva/rules'
import type { QueryCluster } from '../contracts/opportunities'
import {
  MissingExistingTargetCheckError,
  assertClearedToCreate,
  isCreateClearance,
  type CreateClearance,
} from './clearance'
import { findExistingTarget } from './existing-target'
import type { ExistingTargetInput } from './ports'

/**
 * Nothing writes a new page without the check having run first, and this is the
 * half of that rule a review cannot forget.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** Every production source file in `packages/core`, tests excluded. */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full)
  }
  return out.sort()
}

const cluster: QueryCluster = {
  head: 'best trail running shoes',
  members: [],
  intentClass: 'buying_guide',
  familyIds: ['11111111-1111-4111-8111-111111111111'],
}

function input(overrides: Partial<ExistingTargetInput> = {}): ExistingTargetInput {
  return {
    cluster,
    rankedPages: [],
    pages: [],
    proxyRankings: [],
    limitedIntelligence: false,
    config: rules().defaults.gates.existing_target_check,
    fetchedAt: '2026-03-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('clearance to write a new page', () => {
  it('is issued when the check found nothing to improve', () => {
    const { clearance } = findExistingTarget(input())

    expect(isCreateClearance(clearance)).toBe(true)
    expect(() => assertClearedToCreate(clearance, cluster.head)).not.toThrow()
  })

  it('is withheld when a page of ours already covers the intent', () => {
    const { clearance } = findExistingTarget(
      input({
        pages: [
          {
            url: 'https://shop.example/collections/trail-running',
            pageType: 'collection',
            intentClass: 'buying_guide',
            familyIds: cluster.familyIds,
            presence: 'unknown',
          },
        ],
      }),
    )

    expect(clearance).toBeNull()
    expect(() => assertClearedToCreate(clearance, cluster.head)).toThrow(
      MissingExistingTargetCheckError,
    )
  })

  it('cannot be forged by an object that merely looks like one', () => {
    const forged = {
      clusterHead: cluster.head,
      checkedAt: '2026-03-01T00:00:00.000Z',
      weakExistingTarget: null,
      linkTasks: [],
    } as unknown as CreateClearance

    expect(isCreateClearance(forged)).toBe(false)
    expect(() => assertClearedToCreate(forged, cluster.head)).toThrow(
      MissingExistingTargetCheckError,
    )
  })

  it('cannot be carried across from a different topic', () => {
    const { clearance } = findExistingTarget(input())

    expect(() => assertClearedToCreate(clearance, 'waterproof hiking boots')).toThrow(
      MissingExistingTargetCheckError,
    )
  })

  it('carries the link back to a page too weak to take the work over', () => {
    const { clearance } = findExistingTarget(
      input({
        rankedPages: [
          { url: 'https://shop.example/collections/trail-running', impressions: 900, position: 61 },
        ],
        pages: [
          {
            url: 'https://shop.example/collections/trail-running',
            pageType: 'collection',
            intentClass: null,
            familyIds: [],
            presence: 'unknown',
          },
        ],
      }),
    )

    expect(clearance?.linkTasks).toEqual([
      {
        existingUrl: 'https://shop.example/collections/trail-running',
        reasonTemplateKey: 'existing_target_weak_match_link',
      },
    ])
  })

  it('is minted in exactly one place, so no second route to a new page can open', () => {
    const importers = sourceFiles(join(HERE, '..')).filter((file) =>
      readFileSync(file, 'utf8').includes('mintCreateClearance'),
    )

    expect(importers.map((file) => relative(join(HERE, '..'), file).split(sep).join('/'))).toEqual([
      'opportunities/clearance.ts',
      'opportunities/existing-target.ts',
    ])
  })
})
