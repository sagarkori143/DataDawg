import type { InferenceEvent } from '@ollive/contracts'
import { query } from '../pool.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVENT REPOSITORY — the OLAP half
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Append-only, high volume, never read one row at a time.
 *
 * This is the file that would be rewritten to target ClickHouse if telemetry
 * volume ever justified it — roughly north of 10M events/day, where partitioned
 * Postgres starts to want more tuning attention than it is worth. Nothing above
 * this layer knows where events are stored, so that migration is a swap here
 * and nowhere else.
 */

export interface IngestResult {
  inserted: number
  duplicates: number
}

/**
 * Map the wire event onto the column names the SQL function expects.
 *
 * This function is the entire snake_case boundary. Above it, camelCase; below
 * it, SQL. `created_at` is set from `startedAt` and never from now() —
 * see the note in 002_telemetry.sql: a stable partition key is what makes the
 * ON CONFLICT dedupe actually match on a retried batch.
 */
function toRow(event: InferenceEvent): Record<string, unknown> {
  return {
    event_id: event.eventId,
    created_at: event.startedAt,
    conversation_id: event.conversationId,
    message_id: event.messageId,
    session_id: event.sessionId,
    user_id: event.userId,
    provider: event.provider,
    model: event.model,
    operation: event.operation,
    streamed: event.streamed,
    captured_by: event.capturedBy,
    status: event.status,
    finish_reason: event.finishReason,
    error_type: event.errorType,
    error_message: event.errorMessage,
    latency_ms: event.latencyMs,
    ttft_ms: event.ttftMs,
    input_tokens: event.inputTokens,
    output_tokens: event.outputTokens,
    cache_read_tokens: event.cacheReadTokens,
    cache_write_tokens: event.cacheWriteTokens,
    cost_usd: null, // priced by ingest-core before this point; see below
    pricing_version: null,
    temperature: event.temperature,
    max_tokens: event.maxTokens,
    message_count: event.messageCount,
    input_preview: event.inputPreview,
    output_preview: event.outputPreview,
    redaction_hits: event.redactionHits,
    client_ts: event.startedAt,
    sdk_version: null,
    schema_version: event.schemaVersion,
    attributes: event.attributes,
  }
}

/** An event that has been through pricing, carrying the cost the pipeline computed. */
export interface PricedEvent extends InferenceEvent {
  costUsd: string | null
  pricingVersion: string | null
  sdkVersion: string | null
}

/**
 * Persist a whole batch in one round trip.
 *
 * The heavy lifting is in the `ingest_events` SQL function (004_ingest.sql):
 * insert-if-new, then update the per-minute rollup using only the rows that
 * were genuinely new. Duplicates from an at-least-once retry contribute
 * nothing to the aggregates, so the pipeline can retry freely without a single
 * chart drifting.
 *
 * One statement per batch rather than per event: 50 events cost one network
 * hop and one transaction, not 50 of each.
 */
export async function ingestBatch(events: PricedEvent[]): Promise<IngestResult> {
  if (events.length === 0) return { inserted: 0, duplicates: 0 }

  const rows = events.map((e) => ({
    ...toRow(e),
    cost_usd: e.costUsd,
    pricing_version: e.pricingVersion,
    sdk_version: e.sdkVersion,
  }))

  const { rows: result } = await query<{ inserted: number; duplicates: number }>(
    'SELECT inserted, duplicates FROM ingest_events($1::jsonb)',
    [JSON.stringify(rows)],
  )

  return result[0] ?? { inserted: 0, duplicates: 0 }
}

/**
 * Park an event that cannot be processed.
 *
 * Retrying a poison payload forever would block everything behind it — one
 * unreadable address must not stop the round. The payload is kept verbatim so
 * it can be replayed once the cause is fixed.
 *
 * `ON CONFLICT` on event_id bumps the attempt counter instead of creating a
 * second row, so a repeatedly-failing event stays one line with a rising count
 * rather than flooding the table.
 */
export async function writeDlq(input: {
  payload: unknown
  eventId?: string | null
  stage: string
  error: string
}): Promise<void> {
  await query(
    `INSERT INTO dlq (payload, event_id, stage, error)
     VALUES ($1::jsonb, $2, $3, $4)`,
    [JSON.stringify(input.payload), input.eventId ?? null, input.stage, input.error.slice(0, 2_000)],
  )
}

/** Unreplayed poison messages, newest first. Backs the DLQ panel and the replay endpoint. */
export async function listDlq(limit = 100): Promise<
  Array<{
    id: string
    payload: unknown
    eventId: string | null
    stage: string
    error: string
    attempts: number
    firstSeenAt: Date
  }>
> {
  const { rows } = await query(
    `SELECT id,
            payload,
            event_id      AS "eventId",
            stage,
            error,
            attempts,
            first_seen_at AS "firstSeenAt"
       FROM dlq
      WHERE replayed_at IS NULL
      ORDER BY first_seen_at DESC
      LIMIT $1`,
    [Math.min(limit, 500)],
  )
  return rows as never
}

export async function markDlqReplayed(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await query('UPDATE dlq SET replayed_at = now() WHERE id = ANY($1::uuid[])', [ids])
}
