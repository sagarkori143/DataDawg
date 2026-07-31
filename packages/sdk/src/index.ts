import { isServerless, telemetryConfig } from '@ollive/config'
import { instrument as instrumentClient, type InstrumentOptions } from './instrument/proxy.js'
import { NoopTransport, Transport, type AnyTransport, type TransportStats } from './transport/queue.js'

export { getContext, updateContext, withContext, type InferenceContext } from './context.js'
export { preview, redact, type RedactionResult } from './redact.js'
export { Transport, NoopTransport, type TransportStats } from './transport/queue.js'
export { SHIMS, type ProviderShim } from './instrument/shims.js'
export { Span } from './instrument/span.js'

export const SDK_NAME = '@ollive/sdk'
export const SDK_VERSION = '0.1.0'

let transport: AnyTransport | undefined
let warned = false

function log(level: 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  // JSON to stdout/stderr, never to a file. This is what every container
  // runtime and log shipper already collects, and it costs nothing to do now.
  const line = JSON.stringify({
    level,
    logger: SDK_NAME,
    msg,
    ...extra,
    ts: new Date().toISOString(),
  })
  if (level === 'error') console.error(line)
  else console.warn(line)
}

/**
 * The process-wide transport.
 *
 * Lazy so importing this module opens no sockets and reads no configuration —
 * which matters because Next.js imports route handlers at build time to analyse
 * them, and a transport constructed at import time would try to reach the
 * ingestion endpoint during `next build`.
 *
 * With no endpoint configured this returns a no-op and warns exactly once.
 * Missing telemetry configuration is a supported state, not an error: the
 * absence of logging must never break the application being logged.
 */
export function getTransport(): AnyTransport {
  if (transport) return transport

  const cfg = telemetryConfig()

  if (!cfg.enabled || !cfg.endpoint) {
    if (!warned) {
      warned = true
      log('warn', 'INGEST_ENDPOINT is not set — telemetry disabled, application unaffected')
    }
    transport = new NoopTransport()
    return transport
  }

  const serverless = isServerless()

  transport = new Transport({
    endpoint: cfg.endpoint,
    apiKey: cfg.apiKey,
    // On a platform that freezes the process the moment a response is returned,
    // a 200ms batch timer will never fire and every buffered event is lost.
    // Trading batching efficiency for actually delivering the data is the right
    // way round.
    batchSize: serverless ? 1 : cfg.batchSize,
    flushMs: cfg.flushMs,
    maxQueue: cfg.maxQueue,
    httpTimeoutMs: cfg.httpTimeoutMs,
    serverless,
    sdkName: SDK_NAME,
    sdkVersion: SDK_VERSION,
    onError: ({ stage, message, dropped }) => {
      log('error', 'telemetry delivery failed', { stage, error: message, dropped })
    },
  })

  registerShutdownHooks()
  return transport
}

/**
 * Instrument a provider client.
 *
 *     const claude = instrument(new Anthropic({ apiKey }))
 *
 * Uses the process transport unless one is supplied. Never throws: an
 * unrecognised client is returned unwrapped with a warning, because failing
 * application startup to report an instrumentation problem is the worst
 * possible behaviour for an instrumentation library.
 */
export function instrument<T extends object>(
  client: T,
  opts: Partial<InstrumentOptions> = {},
): T {
  return instrumentClient(client, {
    transport: opts.transport ?? getTransport(),
    provider: opts.provider,
    capturedBy: opts.capturedBy ?? 'proxy',
    previewChars: opts.previewChars ?? telemetryConfig().previewChars,
    sdkVersion: SDK_VERSION,
    onSkip: (reason) => log('warn', 'client not instrumented', { reason }),
  })
}

/** Force a flush. Used by serverless `after()` hooks and by tests. */
export async function flush(): Promise<void> {
  await getTransport().flush()
}

export function stats(): TransportStats {
  return getTransport().getStats()
}

/** Test-only: drop the process transport so a test can install its own. */
export function __resetTransportForTests(): void {
  transport = undefined
  warned = false
}

let hooksRegistered = false

/**
 * Flush on the way out.
 *
 * Without this, every deploy silently discards whatever was buffered — and
 * because the loss is invisible it looks like a small traffic dip rather than a
 * bug. `SIGTERM` is what a container runtime sends before `SIGKILL`, which is
 * why this is worth building before containers exist rather than after.
 */
function registerShutdownHooks(): void {
  if (hooksRegistered) return
  hooksRegistered = true

  const drain = async () => {
    try {
      await transport?.close(5_000)
    } catch {
      /* never let shutdown telemetry block shutdown */
    }
  }

  process.once('beforeExit', () => void drain())

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void drain().finally(() => {
        // Re-raise so the default behaviour still applies. Swallowing the
        // signal would leave the process unkillable by ordinary means.
        process.removeAllListeners(signal)
        process.kill(process.pid, signal)
      })
    })
  }
}
