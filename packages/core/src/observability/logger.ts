import { scrub } from './scrub'

/**
 * The scrubber is only a guarantee if everything that writes a log goes through
 * it (tech §4). This is that path: a minimal structured logger whose sink is
 * injectable, so the scrubber's test can assert on the exact bytes written.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly time: string
  readonly [key: string]: unknown
}

export type LogSink = (line: string) => void

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LoggerOptions {
  sink?: LogSink
  minLevel?: LogLevel
  base?: Record<string, unknown>
  now?: () => Date
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? ((line: string) => process.stdout.write(`${line}\n`))
  const minLevel = options.minLevel ?? 'info'
  const base = options.base ?? {}
  const now = options.now ?? (() => new Date())

  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return
    // Scrubbed as one record, so a secret in a nested field or inside the
    // message text is caught by the same pass.
    const record = scrub({ level, time: now().toISOString(), msg, ...base, ...fields })
    sink(JSON.stringify(record))
  }

  return {
    debug: (msg, fields) => write('debug', msg, fields),
    info: (msg, fields) => write('info', msg, fields),
    warn: (msg, fields) => write('warn', msg, fields),
    error: (msg, fields) => write('error', msg, fields),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  }
}

/** A logger that discards output. For tests that only care a call did not throw. */
export const silentLogger: Logger = createLogger({ sink: () => {}, minLevel: 'error' })
