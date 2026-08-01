import { events, queue } from '@ollive/db'
import type { PricedEvent } from '@ollive/db'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EVENT SINK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Where validated, priced events go. Three implementations, one interface, so
 * the choice is a config value rather than a rewrite.
 *
 *   DirectSink   awaits the insert. Ingest latency IS database latency.
 *   PgmqSink     enqueues and returns. A database blip queues rather than 503s.
 *   KafkaSink    unimplemented — the shape is here so the migration path is
 *                checkable rather than asserted. See the note on it below.
 *
 * ── What changes semantically when you go async ─────────────────────────────
 * `DirectSink` can report how many rows were inserted and how many were
 * duplicates, because it has already done the work. `PgmqSink` cannot — the
 * insert has not happened yet.
 *
 * That is not a flaw to paper over. It is why the endpoint returns **202
 * Accepted** rather than 200 OK: "received, and it is my responsibility now"
 * stays true either way, whereas "the write is complete" would become a lie the
 * moment a queue appeared. The response shape reflects the honest difference.
 */

export interface SinkResult {
  /** Events this sink took responsibility for. */
  accepted: number
  /** Known duplicates. Always 0 for async sinks — they cannot know yet. */
  duplicates: number
  /** True when acceptance means "queued", not "persisted". */
  deferred: boolean
}

export interface EventSink {
  readonly name: string
  deliver(events: PricedEvent[]): Promise<SinkResult>
}

/**
 * Write straight to Postgres.
 *
 * Simplest thing that works, and correct for low volume: one round trip, and
 * the caller learns the true insert/duplicate split. The cost is that a slow
 * database is a slow ingest endpoint, and an unavailable one is a 503.
 */
export class DirectSink implements EventSink {
  readonly name = 'direct'

  async deliver(batch: PricedEvent[]): Promise<SinkResult> {
    const { inserted, duplicates } = await events.ingestBatch(batch)
    return { accepted: inserted, duplicates, deferred: false }
  }
}

/**
 * Enqueue for a worker to persist.
 *
 * Ingest latency becomes queue-write latency — one small insert instead of a
 * partitioned insert plus a rollup upsert. A database blip means work piles up
 * rather than being rejected, and the SDK never sees a 503 it has to retry.
 *
 * Safe because the persist path is idempotent: pgmq guarantees at-least-once
 * delivery, and `ingest_events()` de-duplicates on `event_id`. Without that
 * property this would double-count on every redelivery.
 */
export class PgmqSink implements EventSink {
  readonly name = 'pgmq'

  async deliver(batch: PricedEvent[]): Promise<SinkResult> {
    // One message per batch, not per event. The worker's unit of work is then a
    // batch insert, which is what the persist path is optimised for — and it
    // keeps queue depth proportional to requests rather than to events.
    const ids = await queue.send([{ events: batch }])
    return { accepted: ids.length > 0 ? batch.length : 0, duplicates: 0, deferred: true }
  }
}

/**
 * NOT IMPLEMENTED — deliberately.
 *
 * The interface is satisfied so the migration path is visible in code rather
 * than described in a README, and so the compiler proves nothing else would
 * need to change. Throwing is the honest body: a stub that silently dropped
 * events would be worse than no stub.
 *
 * ── When this stops being a stub ────────────────────────────────────────────
 * Not "when we add another consumer" — batch and scheduled consumers read
 * `inference_events` directly, and real-time ones can take a logical
 * replication slot (`wal_level` is already `logical`). Kafka earns its cost at:
 *
 *   • sustained throughput past ~20-50k events/sec, where queue writes start
 *     competing with dashboard reads on the same database
 *   • 4+ independent real-time consumers, where replication slots become a
 *     liability (a dead consumer's slot pins WAL until the disk fills)
 *   • partitioned ordering per key — "every event for conversation X in order,
 *     across N consumers", which Postgres cannot route
 *   • consumers in other teams who should not hold database credentials
 *
 * Below that line, Kafka buys brokers, a schema registry, partition tuning and
 * a lag dashboard to solve a problem an indexed table already solves.
 */
export class KafkaSink implements EventSink {
  readonly name = 'kafka'

  async deliver(_batch: PricedEvent[]): Promise<SinkResult> {
    throw new Error(
      'KafkaSink is not implemented. See the thresholds in packages/ingest-core/src/sink.ts — ' +
        'pgmq handles this workload without additional infrastructure.',
    )
  }
}

export type SinkKind = 'direct' | 'pgmq' | 'kafka'

export function createSink(kind: SinkKind): EventSink {
  switch (kind) {
    case 'pgmq':
      return new PgmqSink()
    case 'kafka':
      return new KafkaSink()
    default:
      return new DirectSink()
  }
}
