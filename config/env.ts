import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../.env', import.meta.url))
if (existsSync(envFile)) process.loadEnvFile(envFile)

export function env(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; see .env.example`)
  return value
}

export function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined
}
