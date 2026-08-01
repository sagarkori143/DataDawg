#!/usr/bin/env node
/**
 * Watch the queue fill and drain, live.
 *
 *   node examples/load/watch-queue.mjs --url https://…  --key … --events 200
 *
 * Posts a burst of events at the ingestion service, then polls `/v1/queue`
 * several times a second and draws the depth as a bar.
 *
 * Why this exists: `accepted: 1` proves the service replied, not that anything
 * was queued or drained. A queue that silently never drains looks identical
 * from the outside — until the dashboard is flat and nobody knows why. This
 * makes the middle of the pipeline visible.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const URL_BASE = (arg('url', process.env.INGEST_ENDPOINT ?? 'http://localhost:3001')).replace(/\/$/, '')
const KEY = arg('key', process.env.INGEST_API_KEY ?? '')
const TOTAL = Number(arg('events', '200'))
const BATCH = Number(arg('batch', '25'))
/** `--watch` observes only: no events are sent. Run it in a second terminal. */
const WATCH_ONLY = process.argv.includes('--watch')

const MODELS = [
  ['anthropic', 'claude-opus-5'],
  ['anthropic', 'claude-sonnet-5'],
  ['openai', 'gpt-4.1'],
]

/** UUIDv7-shaped, unique per run so replays stay idempotent rather than colliding. */
let seq = 0
function eventId() {
  const ms = Date.now().toString(16).padStart(12, '0')
  const tail = (process.pid * 1e6 + seq++).toString(16).padStart(12, '0').slice(-12)
  const r = () => Math.floor(Math.random() * 65536).toString(16).padStart(4, '0')
  return `${ms.slice(0, 8)}-${ms.slice(8, 12)}-7${r().slice(1)}-8${r().slice(1)}-${tail}`
}

function makeEvent() {
  const [provider, model] = MODELS[Math.floor(Math.random() * MODELS.length)]
  const started = new Date(Date.now() - Math.floor(Math.random() * 3000))
  const latency = 200 + Math.floor(Math.random() * 4000)
  // ~7% errors, so the error-rate panel has something to show.
  const failed = Math.random() < 0.07
  return {
    eventId: eventId(),
    schemaVersion: 1,
    provider,
    model,
    status: failed ? 'error' : 'ok',
    startedAt: started.toISOString(),
    endedAt: new Date(started.getTime() + latency).toISOString(),
    latencyMs: latency,
    ttftMs: failed ? undefined : Math.floor(latency * 0.3),
    inputTokens: 50 + Math.floor(Math.random() * 500),
    outputTokens: failed ? 0 : 100 + Math.floor(Math.random() * 900),
    ...(failed ? { errorType: 'rate_limit', errorMessage: 'simulated' } : {}),
  }
}

const headers = {
  'Content-Type': 'application/json',
  ...(KEY ? { Authorization: `Bearer ${KEY}` } : {}),
}

async function stats() {
  try {
    const res = await fetch(`${URL_BASE}/v1/queue`, { headers })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

const bar = (n, max = 40) => '█'.repeat(Math.min(n, max)) + (n > max ? `+${n - max}` : '')

console.log(`\n  target   ${URL_BASE}`)
console.log(WATCH_ONLY ? '  mode     watch only — sending nothing. Ctrl+C to stop.\n' : `  sending  ${TOTAL} events in batches of ${BATCH}\n`)

const before = await stats()
if (!before) {
  console.error('  cannot read /v1/queue — check the URL and the API key\n')
  process.exit(1)
}
if (before.sink !== 'pgmq') {
  console.log(`  note: sink is "${before.sink}", not pgmq — nothing will queue\n`)
}

let sent = 0
let polling = true
/** Mutable so a container restart mid-run can re-baseline the worker counters. */
let baseline = { ...(before.worker ?? {}) }
let restarted = false

// Poll while the sender runs, so the depth is visible rather than inferred.
const watcher = (async () => {
  let peak = 0
  while (polling) {
    const s = await stats()
    if (s) {
      const depth = s.queue?.queueLength ?? 0
      peak = Math.max(peak, depth)
      // Deltas, not absolutes. The worker's counters run from container start,
      // so showing them raw makes "sent 9, written 21" — which reads like a
      // bug rather than an earlier run.
      //
      // A counter going *backwards* means the container restarted (a redeploy,
      // or a crash) and its counters reset. Re-baseline to zero rather than
      // clamping: clamping silently under-reports for the rest of the run,
      // which looks exactly like the data loss this tool exists to rule out.
      const w = s.worker ?? {}
      if ((w.eventsWritten ?? 0) < (baseline.eventsWritten ?? 0)) {
        restarted = true
        baseline = { eventsWritten: 0, duplicates: 0, errors: 0 }
      }
      const b = baseline
      const d = (k) => Math.max(0, (w[k] ?? 0) - (b[k] ?? 0))
      process.stdout.write(
        `\r  sent ${String(sent).padStart(4)}  depth ${String(depth).padStart(3)} ${bar(depth).padEnd(42)}` +
          ` written ${d('eventsWritten')}  dup ${d('duplicates')}  err ${d('errors')}   `,
      )
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  return peak
})()

if (WATCH_ONLY) {
  // Nothing to send. Poll until the user stops it.
  await new Promise(() => {})
}

for (let i = 0; i < TOTAL; i += BATCH) {
  const events = Array.from({ length: Math.min(BATCH, TOTAL - i) }, makeEvent)
  await fetch(`${URL_BASE}/v1/events`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ sdk: { name: 'watch-queue', version: '0.1.0' }, sentAt: new Date().toISOString(), events }),
  }).catch(() => {})
  sent += events.length
}

// Wait for the worker to catch up.
//
// An empty queue is NOT the finish line: the worker reads a message, then
// commits, so depth returns to 0 several times mid-run. Exiting on depth === 0
// stopped the count early and under-reported writes — 165 of 400, which reads
// like data loss when nothing was lost. Wait for the write count to reach what
// was sent, and give up only when it genuinely stops moving.
const baseWritten = baseline.eventsWritten ?? 0
let lastWritten = -1
let stalledFor = 0
while (stalledFor < 12_000) {
  const s = await stats()
  const done = (s?.worker?.eventsWritten ?? 0) - (restarted ? 0 : baseWritten)
  if (done >= sent) break
  stalledFor = done === lastWritten ? stalledFor + 400 : 0
  lastWritten = done
  await new Promise((r) => setTimeout(r, 400))
}

polling = false
const peak = await watcher
const after = await stats()

console.log('\n')
console.log(`  peak queue depth      ${peak}`)
console.log(`  messages through queue ${(after?.queue?.totalMessages ?? 0) - (before.queue?.totalMessages ?? 0)}`)
console.log(`  written by the worker  ${Math.max(0, (after?.worker?.eventsWritten ?? 0) - (baseline.eventsWritten ?? 0))}`)
console.log(`  duplicates skipped     ${Math.max(0, (after?.worker?.duplicates ?? 0) - (baseline.duplicates ?? 0))}`)
console.log(`  worker errors          ${Math.max(0, (after?.worker?.errors ?? 0) - (baseline.errors ?? 0))}`)
if (restarted) {
  console.log('\n  NOTE: the worker container restarted mid-run, so its counters reset.')
  console.log('  Counts above are from the restart onward. Query inference_events for the truth.')
}
console.log(`  depth now              ${after?.queue?.queueLength ?? 0}`)

// The worker's counters live in the process, so a redeploy or crash resets
// them and the delta above under-reports. `messages through queue` comes from
// pgmq's own monotonic counter and is trustworthy; the write count is not.
// Point at the authoritative check rather than letting a low number read as
// data loss — it usually isn't, and guessing wasted an hour proving it.
console.log(`
  The write count is the worker's in-process counter and resets on redeploy.
  For the authoritative number, count the rows:

    SELECT count(*) FROM inference_events WHERE created_at > now() - interval '10 minutes';
`)

// A queue that never showed depth is a queue that was never exercised — worth
// saying out loud rather than letting a clean run imply more than it proved.
if (peak === 0) {
  console.log('  peak depth was 0 — the worker kept up, so nothing ever backed up.')
  console.log('  Raise --events or lower --batch to actually see it fill.\n')
}
