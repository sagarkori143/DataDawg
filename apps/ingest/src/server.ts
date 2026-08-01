import { ingestServerConfig, runtimeConfig, telemetryConfig } from '@ollive/config'
import { closePool, events, ping, queue } from '@ollive/db'
import { checkAuth, handleBatch } from '@ollive/ingest-core'
import Fastify from 'fastify'
import { QueueWorker } from './worker.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INGESTION SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A real, separate process listening on its own port. That matters for the
 * demo: it proves the SDK genuinely serialises events and sends them over the
 * network, rather than calling a function in the same process and calling it a
 * pipeline.
 *
 * All the logic lives in @ollive/ingest-core. This file is transport, auth,
 * lifecycle, and nothing else.
 */

const cfg = ingestServerConfig()
const runtime = runtimeConfig()
const telemetry = telemetryConfig()

const app = Fastify({
  logger: {
    level: runtime.logLevel === 'silent' ? 'silent' : runtime.logLevel,
    // Structured JSON to stdout. Never a file — this is what every container
    // runtime and log shipper already collects, and it costs nothing now.
    ...(runtime.isProduction ? {} : { transport: undefined }),
  },
  bodyLimit: cfg.maxBodyBytes,
  // Trust the proxy's forwarded headers when deployed behind one.
  trustProxy: true,
})

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Liveness: is this process alive?
 *
 * Deliberately does NOT touch the database. Wiring liveness to a dependency is
 * the classic way to turn a brief database blip into a restart loop — the
 * orchestrator kills every replica for being "unhealthy" when the process was
 * fine and the database was the problem.
 */
app.get('/healthz', async () => ({ status: 'ok', uptime: process.uptime() }))

/**
 * Readiness: can this process serve traffic?
 *
 * Checks the database, because an instance that cannot write is useless as an
 * ingestion endpoint — and, when this instance owns the worker, checks consumer
 * lag too.
 *
 * ── Why lag belongs in readiness, not liveness ──────────────────────────────
 * A wedged worker answers `/healthz` perfectly: the process is alive, HTTP
 * responds, and the queue grows silently while the instance reports itself
 * healthy. Liveness cannot catch it, because restarting is the wrong response —
 * the process is fine. Readiness can: pull the instance from rotation, traffic
 * moves to a peer whose worker is draining, nothing is lost because the queue
 * holds the backlog.
 *
 * ── Why only when this instance runs the worker ─────────────────────────────
 * Readiness answers "can *I* serve", not "is the system healthy". An
 * ingest-only instance behind a lagging worker fleet is still perfectly able to
 * accept and enqueue; failing it would take the whole tier out over a problem
 * it cannot fix, turning a slow consumer into a total outage.
 *
 * Lag is still reported in the body either way, so it is observable without
 * being load-bearing.
 */
app.get('/readyz', async (_req, reply) => {
  const dbOk = await ping()
  if (!dbOk) {
    return reply
      .code(503)
      .send({ status: 'degraded', database: false, reason: 'database unreachable' })
  }

  if (cfg.sink !== 'pgmq') return { status: 'ok', database: true }

  let lag = 0
  try {
    lag = (await queue.health()).oldestAgeSec
  } catch {
    // Queue metrics are diagnostics. Failing to read them is not itself a
    // reason to take an otherwise healthy instance out of rotation.
  }

  const owned = worker !== null

  if (owned && lag > cfg.maxQueueLagSec) {
    return reply.code(503).send({
      status: 'degraded',
      database: true,
      queueLagSec: lag,
      worker: 'in-process',
      reason: `consumer lag ${lag}s exceeds ${cfg.maxQueueLagSec}s — this worker is not keeping up`,
    })
  }

  return {
    status: 'ok',
    database: true,
    queueLagSec: lag,
    worker: owned ? 'in-process' : 'external',
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion
// ─────────────────────────────────────────────────────────────────────────────

app.post('/v1/events', async (req, reply) => {
  if (!checkAuth(req.headers.authorization, cfg.apiKey)) {
    // 401 is non-retryable by design — the SDK trips a circuit breaker rather
    // than hammering the endpoint with a key that will still be wrong later.
    return reply.code(401).send({ error: 'invalid or missing credentials' })
  }

  try {
    const result = await handleBatch(req.body, {
      redactionMode: telemetry.redaction,
      previewChars: telemetry.previewChars,
      sink: cfg.sink,
    })

    // 202, not 200. 200 claims the write is complete; 202 says "received, and
    // it is my responsibility now" — which stays true if an event bus is
    // inserted behind this later.
    return reply.code(202).send(result)
  } catch (err) {
    // A persistence failure is transient and affects the whole batch. 503 tells
    // the SDK to retry with backoff, which its idempotency key makes safe.
    req.log.error({ err }, 'batch persistence failed')
    return reply.code(503).send({ error: 'temporarily unable to persist' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Dead letter queue
// ─────────────────────────────────────────────────────────────────────────────

app.get('/v1/dlq', async (req, reply) => {
  if (!checkAuth(req.headers.authorization, cfg.apiKey)) {
    return reply.code(401).send({ error: 'invalid or missing credentials' })
  }
  return { items: await events.listDlq(100) }
})

app.post('/v1/dlq/replay', async (req, reply) => {
  if (!checkAuth(req.headers.authorization, cfg.apiKey)) {
    return reply.code(401).send({ error: 'invalid or missing credentials' })
  }

  // Replay re-drives parked events through the same path that rejected them.
  // Worth building rather than deferring: without it the DLQ is a graveyard,
  // and "we keep the bad ones" is only meaningful if you can act on them.
  const items = await events.listDlq(100)
  const replayed: string[] = []

  for (const item of items) {
    try {
      const payload = item.payload as { events?: unknown[] }
      const body = Array.isArray(payload?.events)
        ? payload
        : { sdk: { name: 'replay', version: '0' }, sentAt: new Date().toISOString(), events: [item.payload] }

      const out = await handleBatch(body, {
        redactionMode: telemetry.redaction,
        previewChars: telemetry.previewChars,
        // Replay always writes directly: a message that already failed the
        // queue path should not be put back on the queue.
        sink: 'direct',
      })
      if (out.accepted > 0 || out.duplicates > 0) replayed.push(item.id)
    } catch {
      // Still broken. Leave it parked rather than looping.
    }
  }

  await events.markDlqReplayed(replayed)
  return { attempted: items.length, replayed: replayed.length }
})

app.get('/v1/queue', async (req, reply) => {
  if (!checkAuth(req.headers.authorization, cfg.apiKey)) {
    return reply.code(401).send({ error: 'invalid or missing credentials' })
  }
  return { sink: cfg.sink, worker: worker ? worker.stats : null, queue: await queue.health() }
})

// ─────────────────────────────────────────────────────────────────────────────
// Worker
// ─────────────────────────────────────────────────────────────────────────────

// Runs in-process by default: one fewer thing to deploy, and the workload is
// I/O-bound so it does not compete for CPU. Set INGEST_WORKER=false to scale it
// out separately — a deployment change, not a code change.
const worker =
  cfg.sink === 'pgmq' && cfg.runWorker
    ? new QueueWorker((level, msg, extra) =>
        level === 'error' ? app.log.error(extra, msg) : app.log.warn(extra, msg),
      )
    : null

worker?.start()

// A queue with no consumer strands every message in it, silently. This happens
// most often by switching INGEST_SINK back to `direct` while messages are still
// enqueued — nothing errors, the events simply stop arriving and the queue sits
// there. Warn loudly rather than let it be discovered from a gap in a chart.
if (cfg.sink === 'pgmq' && !cfg.runWorker) {
  app.log.warn(
    'INGEST_SINK=pgmq with INGEST_WORKER=false — this instance will NOT drain the queue. ' +
      'Ensure a worker runs elsewhere, or enqueued events will never be persisted.',
  )
}

if (cfg.sink !== 'pgmq') {
  void queue
    .health()
    .then((h) => {
      if (h.queueLength > 0) {
        app.log.warn(
          { queued: h.queueLength, oldestAgeSec: h.oldestAgeSec },
          `INGEST_SINK=${cfg.sink} but ${h.queueLength} message(s) are stranded in the pgmq queue. ` +
            'Set INGEST_SINK=pgmq to drain them.',
        )
      }
    })
    .catch(() => {
      // pgmq may not be installed. Not an error when the sink is not pgmq.
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Graceful shutdown.
 *
 * SIGTERM is what a container runtime sends before SIGKILL. Stop accepting new
 * connections, let in-flight requests finish, close the pool, exit. Without
 * this, every deploy drops whatever was mid-write — invisible loss that looks
 * like a small traffic dip rather than a bug.
 *
 * Bounded, because a shutdown that hangs waiting on a dead dependency is worse
 * than an abrupt one: the orchestrator SIGKILLs it anyway, just later.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down')

    const forceExit = setTimeout(() => {
      app.log.warn('grace period elapsed, forcing exit')
      process.exit(1)
    }, cfg.shutdownGraceMs)
    forceExit.unref()

    void app
      .close()
      // Stop the worker before the pool: it is mid-query, and closing the pool
      // underneath it would fail the batch it is about to acknowledge.
      .then(() => worker?.stop())
      .then(() => closePool())
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  })
}

try {
  await app.listen({ port: cfg.port, host: cfg.host })
  app.log.info({ port: cfg.port }, 'ingestion service ready')
} catch (err) {
  app.log.error({ err }, 'failed to start')
  process.exit(1)
}
