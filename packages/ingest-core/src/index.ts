import {
  EventBatchEnvelopeSchema,
  InferenceEventSchema,
  type IngestAck,
  type InferenceEvent,
} from '@ollive/contracts'
import { events } from '@ollive/db'
import { createSink, type EventSink, type SinkKind } from './sink.js'
import { priceCall } from '@ollive/providers'
import { preview } from '@ollive/sdk'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INGEST CORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four jobs, in order: authenticate, validate, enrich, persist.
 *
 * ── Why this is framework-free ──────────────────────────────────────────────
 * It exports a function that takes a parsed body and returns a result. No
 * Request, no Response, no router. That lets the identical code run behind a
 * standalone Fastify service (which proves the SDK→network→ingestion boundary
 * is real rather than a function call) and behind a Next.js route handler
 * (which is what deploys, because serverless platforms have no long-lived
 * processes). Same logic, two entry points, no duplication.
 */

export interface IngestOptions {
  /** Re-scan previews for PII even though the SDK already did. Defence in depth. */
  redactionMode: 'sdk' | 'ingest' | 'both' | 'off'
  previewChars: number
  /** Where accepted events go. Defaults to writing straight to Postgres. */
  sink?: EventSink | SinkKind
}

export interface IngestOutcome extends IngestAck {
  /** Events parked in the DLQ rather than dropped. */
  deadLettered: number
  /** Which sink took the events. */
  sink: string
  /** True when `accepted` means queued rather than persisted. */
  deferred: boolean
}

/**
 * Handle one batch.
 *
 * Never throws for a per-event problem: one malformed event must not fail an
 * otherwise good batch of fifty, or a single bad SDK build takes down telemetry
 * for every healthy one. Bad events go to the DLQ with the payload intact so
 * they can be replayed once the cause is fixed.
 */
export async function handleBatch(
  rawBody: unknown,
  opts: IngestOptions,
): Promise<IngestOutcome> {
  // ── 1. Validate the envelope only ────────────────────────────────────────
  //
  // Events are left as `unknown` here and validated one at a time below. Zod
  // rejects an array all-or-nothing, so parsing them inline would let a single
  // malformed event reject the batch and discard forty-nine healthy ones — one
  // bad SDK build blanking the dashboards for every well-behaved client.
  const parsed = EventBatchEnvelopeSchema.safeParse(rawBody)

  if (!parsed.success) {
    // The envelope itself is wrong, so there are no individual events to
    // salvage. Park the whole thing — the payload is the only evidence of what
    // the sender actually did.
    await events
      .writeDlq({
        payload: rawBody,
        stage: 'envelope',
        error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      })
      .catch(() => {
        /* DLQ write failed too — nothing further to try */
      })

    return {
      accepted: 0,
      duplicates: 0,
      rejected: 1,
      deadLettered: 1,
      sink: 'none',
      deferred: false,
      errors: [{ eventId: null, reason: 'invalid batch envelope' }],
    }
  }

  const batch = parsed.data

  // ── 2. Enrich ────────────────────────────────────────────────────────────
  const priced = []
  const errors: IngestAck['errors'] = []
  let deadLettered = 0

  for (const candidate of batch.events) {
    // Per-event validation. This is what keeps one bad event from costing the
    // other forty-nine.
    const one = InferenceEventSchema.safeParse(candidate)

    if (!one.success) {
      const reason = one.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
      const eventId =
        typeof (candidate as { eventId?: unknown })?.eventId === 'string'
          ? ((candidate as { eventId: string }).eventId)
          : null

      errors.push({ eventId, reason })
      deadLettered++
      await events
        .writeDlq({ payload: candidate, eventId, stage: 'validate', error: reason })
        .catch(() => {})
      continue
    }

    const event = one.data

    try {
      priced.push(enrich(event, batch.sdk.version, opts))
    } catch (err) {
      errors.push({ eventId: event.eventId, reason: (err as Error).message })
      deadLettered++
      await events
        .writeDlq({
          payload: event,
          eventId: event.eventId,
          stage: 'enrich',
          error: (err as Error).message,
        })
        .catch(() => {})
    }
  }

  const sink = typeof opts.sink === 'object' ? opts.sink : createSink(opts.sink ?? 'direct')

  if (priced.length === 0) {
    return {
      accepted: 0, duplicates: 0, rejected: errors.length, deadLettered,
      sink: sink.name, deferred: false, errors,
    }
  }

  // ── 3. Persist ───────────────────────────────────────────────────────────
  try {
    const result = await sink.deliver(priced)

    return {
      accepted: result.accepted,
      duplicates: result.duplicates,
      rejected: errors.length,
      deadLettered,
      sink: sink.name,
      deferred: result.deferred,
      errors,
    }
  } catch (err) {
    // A database failure is transient and affects the whole batch. Do NOT
    // dead-letter here — that would turn a five-second outage into thousands of
    // rows needing manual replay. Signal failure so the SDK retries with
    // backoff, which is exactly what its idempotency key exists for.
    throw new Error(`sink "${sink.name}" failed: ${(err as Error).message}`, { cause: err })
  }
}

/**
 * Add everything the server knows that the client could not.
 *
 * Cost is computed here rather than in the SDK deliberately: pricing changes
 * would otherwise require redeploying every instrumented application, and
 * different SDK versions in flight would price the same call differently.
 */
function enrich(event: InferenceEvent, sdkVersion: string, opts: IngestOptions) {
  const { costUsd, pricingVersion } = priceCall(event.model, {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    cacheReadTokens: event.cacheReadTokens,
    cacheWriteTokens: event.cacheWriteTokens,
  })

  // Second redaction pass. The SDK already ran one, but an older SDK build
  // carries an older policy — this is the layer that can be updated centrally
  // without redeploying every application. Re-running over already-redacted
  // text is a no-op, so the cost is only paid where it is needed.
  let inputPreview = event.inputPreview
  let outputPreview = event.outputPreview
  let redactionHits = event.redactionHits

  if (opts.redactionMode === 'ingest' || opts.redactionMode === 'both') {
    const i = preview(inputPreview, opts.previewChars)
    const o = preview(outputPreview, opts.previewChars)
    inputPreview = i.text
    outputPreview = o.text
    redactionHits += i.hits + o.hits
  }

  return {
    ...event,
    inputPreview,
    outputPreview,
    redactionHits,
    costUsd,
    pricingVersion,
    sdkVersion,
  }
}

/**
 * Constant-time bearer-token check.
 *
 * A naive `===` leaks key length and prefix through timing. The comparison is
 * cheap and the failure mode of getting it wrong is a silently guessable key.
 */
export * from './sink.js'

export function checkAuth(header: string | undefined, expected: string): boolean {
  if (!header) return false

  const token = header.startsWith('Bearer ') ? header.slice(7) : header
  if (token.length !== expected.length) return false

  let diff = 0
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}
