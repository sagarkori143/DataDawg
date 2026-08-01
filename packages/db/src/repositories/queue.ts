import { query } from '../pool.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUEUE — a typed wrapper over pgmq
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * pgmq gives SQS semantics inside Postgres: send, read-with-visibility-timeout,
 * delete on success, archive on give-up. This file is the only place that
 * speaks its SQL, so swapping it for Kafka is one adapter rather than a hunt
 * through the codebase.
 */

export const QUEUE_NAME = 'inference_events'

/**
 * Visibility timeout, in seconds.
 *
 * How long a message stays hidden after being read. Too short and a slow batch
 * gets redelivered while still being processed — doing the work twice (safe
 * here, because the insert is idempotent, but wasteful). Too long and a
 * crashed worker's messages sit invisible until it expires, adding latency to
 * a recovery that is otherwise instant.
 *
 * 30s comfortably covers a 50-event batch insert with headroom for a slow
 * database, and bounds recovery from a hard crash to half a minute.
 */
const VISIBILITY_TIMEOUT_SEC = 30

/**
 * Attempts before a message is archived as poison.
 *
 * Something that has failed five times will fail a sixth. Retrying forever
 * blocks everything behind it — one bad parcel must not stop the round.
 */
export const MAX_ATTEMPTS = 5

export interface QueuedMessage<T = unknown> {
  msgId: string
  /** How many times this has been read. The poison-message counter. */
  readCount: number
  enqueuedAt: Date
  message: T
}

/**
 * Enqueue a batch in one statement.
 *
 * `send_batch` rather than N sends: 50 events cost one round trip, which is the
 * same reason the SDK batches in the first place.
 */
export async function send(messages: unknown[]): Promise<string[]> {
  if (messages.length === 0) return []

  const { rows } = await query<{ msg_id: string }>(
    `SELECT pgmq.send_batch($1, $2::jsonb[]) AS msg_id`,
    [QUEUE_NAME, messages.map((m) => JSON.stringify(m))],
  )

  return rows.map((r) => r.msg_id)
}

/**
 * Read up to `qty` messages, hiding them for the visibility timeout.
 *
 * `read_with_poll` blocks server-side until messages arrive or the poll window
 * closes. That is meaningfully better than a client-side `setInterval`: an idle
 * worker costs one held connection instead of a query every 200ms, and a
 * message is picked up the instant it lands rather than on the next tick.
 */
export async function read<T = unknown>(qty = 10, maxPollSeconds = 5): Promise<QueuedMessage<T>[]> {
  const { rows } = await query<{
    msg_id: string
    read_ct: number
    enqueued_at: Date
    message: T
  }>(
    `SELECT msg_id, read_ct, enqueued_at, message
       FROM pgmq.read_with_poll($1, $2, $3, $4, 100)`,
    [QUEUE_NAME, VISIBILITY_TIMEOUT_SEC, qty, maxPollSeconds],
  )

  return rows.map((r) => ({
    msgId: r.msg_id,
    readCount: r.read_ct,
    enqueuedAt: r.enqueued_at,
    message: r.message,
  }))
}

/** Acknowledge. Removes the message permanently — call only after the work is durable. */
export async function ack(msgIds: string[]): Promise<void> {
  if (msgIds.length === 0) return
  await query('SELECT pgmq.delete($1, $2::bigint[])', [QUEUE_NAME, msgIds])
}

/**
 * Give up on a message, keeping the payload.
 *
 * `archive` moves it to `pgmq.a_inference_events` rather than deleting it, so a
 * poison message stays inspectable and replayable. Parked, not lost — the whole
 * point of a dead-letter path.
 */
export async function archive(msgIds: string[]): Promise<void> {
  if (msgIds.length === 0) return
  await query('SELECT pgmq.archive($1, $2::bigint[])', [QUEUE_NAME, msgIds])
}

export interface QueueHealth {
  queueLength: number
  totalMessages: number
  /** Seconds the oldest unread message has waited. This is consumer lag. */
  oldestAgeSec: number
  archived: number
}

/**
 * Queue health.
 *
 * Depth on its own is not a problem — a deep queue draining fast is fine. The
 * age of the oldest unread message is the number that says the worker has
 * stopped keeping up.
 */
export async function health(): Promise<QueueHealth> {
  const [metrics, archived] = await Promise.all([
    query<{ queue_length: string; total_messages: string; oldest_msg_age_sec: number | null }>(
      `SELECT queue_length, total_messages, oldest_msg_age_sec FROM pgmq.metrics($1)`,
      [QUEUE_NAME],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n FROM pgmq.a_inference_events`).catch(() => ({
      rows: [{ n: 0 }],
    })),
  ])

  const m = metrics.rows[0]

  return {
    queueLength: Number(m?.queue_length ?? 0),
    totalMessages: Number(m?.total_messages ?? 0),
    oldestAgeSec: m?.oldest_msg_age_sec ?? 0,
    archived: archived.rows[0]?.n ?? 0,
  }
}

/** Archived (poison) messages, for the DLQ panel and replay. */
export async function listArchived(limit = 50): Promise<QueuedMessage[]> {
  const { rows } = await query<{
    msg_id: string
    read_ct: number
    enqueued_at: Date
    message: unknown
  }>(
    `SELECT msg_id, read_ct, enqueued_at, message
       FROM pgmq.a_inference_events
      ORDER BY archived_at DESC LIMIT $1`,
    [limit],
  )

  return rows.map((r) => ({
    msgId: r.msg_id,
    readCount: r.read_ct,
    enqueuedAt: r.enqueued_at,
    message: r.message,
  }))
}
