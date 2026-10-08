import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const coreDir = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(coreDir, '..')

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

// Interfaces and plain data the core may lean on; everything else outside core/ is off limits.
const ALLOWED_OUTSIDE = new Set(['connectors/types.ts', 'db/pool.ts'])
const ALLOWED_PACKAGES = new Set(['zod', 'marked'])

it('core/ imports no framework, no vendor SDK, and nothing from app/, jobs/ or vendors/', () => {
  const violations: string[] = []
  const sources = files(coreDir)
  expect(sources.length).toBeGreaterThan(5)
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/^\s*import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/gm)) {
      const typeOnly = Boolean(match[1])
      const spec = match[2]!
      const where = relative(root, file)
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('.')) {
        if (!ALLOWED_PACKAGES.has(spec.split('/')[0]!)) violations.push(`${where} imports package ${spec}`)
        continue
      }
      const target = relative(root, resolve(file, '..', spec))
      if (target.startsWith('core/')) continue
      if (!ALLOWED_OUTSIDE.has(target)) violations.push(`${where} imports ${target}`)
      else if (target === 'db/pool.ts' && !typeOnly) violations.push(`${where} imports db/pool.ts for more than its types`)
    }
  }
  expect(violations).toEqual([])
})

it('the check would catch a forbidden import', () => {
  const sample = `import Anthropic from '@anthropic-ai/sdk'`
  expect(/^\s*import\s+(type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/m.exec(sample)?.[2]).toBe('@anthropic-ai/sdk')
})
