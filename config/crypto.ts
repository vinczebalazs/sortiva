import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from './env.ts'

function key(): Buffer {
  const k = Buffer.from(env('TOKEN_ENCRYPTION_KEY'), 'base64')
  if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded')
  return k
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), body.toString('base64')].join(':')
}

export function decrypt(sealed: string): string {
  const [version, iv, tag, body] = sealed.split(':')
  if (version !== 'v1' || !iv || !tag || !body) throw new Error('unrecognised encrypted token format')
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64')), decipher.final()]).toString('utf8')
}
