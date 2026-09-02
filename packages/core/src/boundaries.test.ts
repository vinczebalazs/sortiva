import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

/**
 * CLAUDE.md code-structure rules: `packages/core` holds domain logic and
 * "cannot import Next, React, or any provider SDK — a test proves it".
 * This is that test.
 */

const here = fileURLToPath(new URL('.', import.meta.url))
const packageRoot = join(here, '..')
const srcRoot = join(packageRoot, 'src')

const BANNED_EXACT = new Set([
  'next',
  'react',
  'react-dom',
  '@anthropic-ai/sdk',
  'resend',
  'stripe',
  'posthog-node',
  'posthog-js',
  'googleapis',
  'google-auth-library',
  'graphile-worker',
  'pg',
])

const BANNED_PREFIXES = [
  'next/',
  'react/',
  'react-dom/',
  '@shopify/',
  '@anthropic-ai/',
  'googleapis/',
  // The email templates are React Email components and live in
  // `packages/providers`. This package decides what an email says, as copy keys;
  // it must not learn how one is drawn.
  '@react-email/',
]

function isBanned(specifier: string): boolean {
  if (BANNED_EXACT.has(specifier)) return true
  return BANNED_PREFIXES.some((prefix) => specifier.startsWith(prefix))
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/** `preProcessFile` reports every static import, dynamic import and require in one pass. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const info = ts.preProcessFile(text, /* readImportFiles */ true, /* detectJavaScriptImports */ true)
  return info.importedFiles.map((f) => f.fileName)
}

describe('packages/core boundaries', () => {
  const files = sourceFiles(srcRoot)

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('imports no Next, React, or provider SDK', () => {
    const violations: string[] = []
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (isBanned(specifier)) {
          violations.push(`${relative(packageRoot, file)} -> ${specifier}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('declares no Next, React, or provider SDK dependency', () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }
    const declared = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]
    expect(declared.filter(isBanned)).toEqual([])
  })

  it('flags a banned specifier when one is present (rule is not vacuous)', () => {
    expect(isBanned('next/server')).toBe(true)
    expect(isBanned('@anthropic-ai/sdk')).toBe(true)
    expect(isBanned('@sortiva/rules')).toBe(false)
  })
})
