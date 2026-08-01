#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TRAFFIC GENERATOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   node examples/load/generate.mjs --events 400 --errors 0.08 --hours 6
 *
 * Posts synthetic events straight at the ingestion endpoint. Nothing calls a
 * model, so it costs nothing and runs in seconds.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A dashboard demoed with three data points proves nothing — you cannot tell a
 * working p95 from a broken one with three samples. This produces a realistic
 * distribution across a real time window so the charts have shape, percentiles
 * are meaningful, and the rollup is exercised the way production would.
 *
 * It also doubles as a pipeline test: it drives the same validate → redact →
 * price → dedupe path as real traffic, including deliberate duplicates and a
 * malformed event to prove the DLQ catches rather than drops.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

// ── args ────────────────────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1]])
    return acc
  }, []),
)

const TOTAL = Number(args.events ?? 400)
const ERROR_RATE = Number(args.errors ?? 0.06)
const CANCEL_RATE = Number(args.cancels ?? 0.04)
const HOURS = Number(args.hours ?? 6)
const BATCH = 50

// ── config from .env ────────────────────────────────────────────────────────
const env = Object.fromEntries(
  readFileSync(new URL('../../.env', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.trimStart().startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const ENDPOINT = args.endpoint ?? env.INGEST_ENDPOINT ?? 'http://localhost:3001'
const API_KEY = env.INGEST_API_KEY

const MODELS = [
  { provider: 'anthropic', model: 'claude-opus-5', weight: 5, base: 2400, spread: 1800 },
  { provider: 'anthropic', model: 'claude-haiku-4-5', weight: 3, base: 700, spread: 500 },
  { provider: 'openai', model: 'gpt-4.1', weight: 2, base: 1600, spread: 1200 },
]

const ERROR_TYPES = ['rate_limit', 'timeout', 'server_error', 'context_length', 'network']

const PROMPTS = [
  'Summarise this quarterly report in three bullets.',
  'Why is my Postgres query doing a sequential scan?',
  'Draft a polite decline to a vendor proposal.',
  'Explain the difference between p95 and p99 latency.',
  // Deliberately carries PII so the redaction panel has something to show.
  'My email is dana.reed@example.com — can you check the order?',
  'Refactor this function to remove the nested callbacks.',
]

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)]

function weightedModel() {
  const total = MODELS.reduce((s, m) => s + m.weight, 0)
  let r = Math.random() * total
  for (const m of MODELS) {
    r -= m.weight
    if (r <= 0) return m
  }
  return MODELS[0]
}

/**
 * Log-normal-ish latency.
 *
 * A uniform distribution would make p50, p95 and p99 nearly identical and the
 * percentile chart pointless. Real latency has a long right tail — a few calls
 * take many times the median — and that tail is the entire reason p95 is worth
 * measuring, so the generator has to produce one.
 */
function latencyFor(m) {
  const u = Math.random()
  const tail = u > 0.94 ? 3 + Math.random() * 5 : 1
  return Math.round((m.base + Math.random() * m.spread) * tail)
}

function makeEvent(when) {
  const m = weightedModel()
  const roll = Math.random()
  const status = roll < ERROR_RATE ? 'error' : roll < ERROR_RATE + CANCEL_RATE ? 'cancelled' : 'ok'

  const latencyMs = latencyFor(m)
  const ttftMs = Math.round(latencyMs * (0.25 + Math.random() * 0.3))
  const inputTokens = 120 + Math.floor(Math.random() * 900)
  const outputTokens = status === 'ok' ? 60 + Math.floor(Math.random() * 700) : Math.floor(Math.random() * 80)

  return {
    eventId: randomUUID(),
    schemaVersion: 1,
    conversationId: null,
    messageId: null,
    sessionId: `load-${Math.floor(Math.random() * 40)}`,
    userId: null,
    provider: m.provider,
    model: m.model,
    operation: 'chat',
    streamed: true,
    capturedBy: 'proxy',
    status,
    finishReason: status === 'ok' ? 'end_turn' : status === 'cancelled' ? 'client_abort' : null,
    errorType: status === 'error' ? pick(ERROR_TYPES) : null,
    errorMessage: status === 'error' ? 'synthetic failure from the load generator' : null,
    startedAt: new Date(when).toISOString(),
    endedAt: new Date(when + latencyMs).toISOString(),
    latencyMs,
    ttftMs: status === 'error' ? null : ttftMs,
    inputTokens,
    outputTokens,
    cacheReadTokens: Math.random() > 0.7 ? Math.floor(inputTokens * 0.6) : null,
    cacheWriteTokens: null,
    inputPreview: pick(PROMPTS),
    outputPreview: status === 'ok' ? 'Synthetic response body for dashboard shape.' : null,
    redactionHits: 0,
    temperature: null,
    maxTokens: 8192,
    messageCount: 1 + Math.floor(Math.random() * 8),
    attributes: { synthetic: true },
  }
}

async function post(events, { dropped = 0 } = {}) {
  const res = await fetch(`${ENDPOINT}/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({
      sdk: { name: 'examples/load', version: '0.1.0', runtime: 'node' },
      sentAt: new Date().toISOString(),
      events,
      droppedSinceLastBatch: dropped,
    }),
  })

  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${res.status}: ${JSON.stringify(body)}`)
  return body
}

// ── run ─────────────────────────────────────────────────────────────────────
console.log(`\nendpoint  ${ENDPOINT}`)
console.log(`events    ${TOTAL} spread over the last ${HOURS}h`)
console.log(`errors    ${(ERROR_RATE * 100).toFixed(0)}%   cancels ${(CANCEL_RATE * 100).toFixed(0)}%\n`)

const windowMs = HOURS * 60 * 60 * 1000
const now = Date.now()

const all = Array.from({ length: TOTAL }, () =>
  makeEvent(now - Math.floor(Math.random() * windowMs)),
).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))

let accepted = 0
let duplicates = 0

for (let i = 0; i < all.length; i += BATCH) {
  const chunk = all.slice(i, i + BATCH)
  const ack = await post(chunk)
  accepted += ack.accepted
  duplicates += ack.duplicates
  process.stdout.write(`\r  sent ${Math.min(i + BATCH, all.length)}/${all.length}`)
}
console.log()

// ── prove the guarantees, don't just claim them ─────────────────────────────

// 1. Idempotency: resend a batch verbatim.
//
//    Where the evidence lives depends on the sink, and getting this wrong is an
//    easy way to write a test that fails for the wrong reason:
//
//      direct  the endpoint has already done the insert, so it can report
//              accepted=0 duplicates=N.
//      pgmq    the endpoint only queued the batch. It cannot know they are
//              duplicates yet, so accepted=N is CORRECT — the dedupe happens
//              in the worker, and the proof is the row count.
//
//    That difference is why the endpoint returns 202 rather than 200.
const replayCount = Math.min(BATCH, all.length)
const replay = await post(all.slice(0, replayCount))

if (replay.deferred) {
  // Let the worker drain, then check the database rather than the ack.
  await new Promise((r) => setTimeout(r, 4000))
  const stats = await fetch(`${ENDPOINT}/v1/queue`, {
    headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)

  const dupes = stats?.worker?.duplicates ?? 0
  console.log(
    `\n  idempotency : sink=${replay.sink} (deferred) → queued ${replay.accepted}, ` +
      `worker absorbed ${dupes} duplicate(s)` +
      (dupes >= replayCount ? '  OK' : '  ** check the worker **'),
  )
  console.log(`                queue depth now ${stats?.queue?.queueLength ?? '?'}`)
} else {
  console.log(
    `\n  idempotency : sink=${replay.sink} → accepted=${replay.accepted} duplicates=${replay.duplicates}` +
      (replay.accepted === 0 ? '  OK' : '  ** LEAK **'),
  )
}

// 2. DLQ: one deliberately malformed event. It must be parked, and the valid
//    event beside it must still land — a bad event cannot fail a good batch.
const bad = await post([
  { ...makeEvent(now), latencyMs: 'not-a-number' },
  makeEvent(now),
])
console.log(
  `  dlq         : 1 malformed + 1 valid → accepted=${bad.accepted} deadLettered=${bad.deadLettered}` +
    (bad.accepted === 1 && bad.deadLettered === 1 ? '  OK' : '  ** unexpected **'),
)

console.log(`\n  total accepted ${accepted}, duplicates ${duplicates}`)
console.log('  open http://localhost:3000/dashboard\n')
