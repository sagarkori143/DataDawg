import { events, queue } from '@ollive/db'
import type { PricedEvent } from '@ollive/db'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * QUEUE WORKER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Drains the pgmq queue into `inference_events`.
 *
 * Runs in-process alongside the HTTP server by default — one fewer thing to
 * deploy, and the workload is I/O-bound so it does not compete for CPU. It is
 * written as a standalone loop so pulling it into its own process is a
 * deployment change rather than a code change, which is what you would do once
 * ingest and persistence need to scale at different rates.
 *
 * ── Delivery semantics ──────────────────────────────────────────────────────
 * At-least-once. A message is deleted only after the insert commits, so a crash
 * mid-batch means redelivery. That is safe because `ingest_events()`
 * de-duplicates on `event_id` — the same property that lets the SDK retry.
 *
 * Without idempotent inserts this design would double-count on every crash, and
 * the correct choice would be a much more expensive two-phase commit.
 */

const BATCH_SIZE = 10
const POLL_SECONDS = 5

export interface WorkerStats {
  processed: number
  eventsWritten: number
  duplicates: number
  archived: number
  errors: number
}

export class QueueWorker {
  private running = false
  private stopped: Promise<void> = Promise.resolve()

  readonly stats: WorkerStats = {
    processed: 0,
    eventsWritten: 0,
    duplicates: 0,
    archived: 0,
    errors: 0,
  }

  constructor(private readonly log: (level: string, msg: string, extra?: object) => void) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.stopped = this.loop()
  }

  /** Stop after the current batch. Called from the SIGTERM handler. */
  async stop(): Promise<void> {
    this.running = false
    await this.stopped
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        // Long-polls server-side: an idle worker holds one connection rather
        // than issuing a query every few hundred milliseconds, and a message is
        // picked up the moment it lands instead of on the next tick.
        const messages = await queue.read<{ events: PricedEvent[] }>(BATCH_SIZE, POLL_SECONDS)
        if (messages.length === 0) continue

        for (const msg of messages) {
          if (!this.running) break
          await this.handle(msg)
        }
      } catch (err) {
        this.stats.errors++
        this.log('error', 'worker loop failed', { error: (err as Error).message })

        // Back off before retrying. Without this, a database outage becomes a
        // hot loop hammering a server that is already struggling.
        await new Promise((r) => setTimeout(r, 2_000))
      }
    }
  }

  private async handle(msg: queue.QueuedMessage<{ events: PricedEvent[] }>): Promise<void> {
    // Poison check comes first. Something that has failed five times will fail
    // a sixth, and retrying forever blocks everything behind it.
    if (msg.readCount > queue.MAX_ATTEMPTS) {
      await queue.archive([msg.msgId])
      this.stats.archived++
      this.log('warn', 'archived poison message', {
        msgId: msg.msgId,
        attempts: msg.readCount,
      })
      return
    }

    try {
      const batch = msg.message?.events ?? []
      const { inserted, duplicates } = await events.ingestBatch(batch)

      // ACK only after the insert commits. Deleting first would lose the batch
      // on a crash between the two — the classic "acknowledge then process"
      // bug, which silently drops data under exactly the conditions you most
      // need it not to.
      await queue.ack([msg.msgId])

      this.stats.processed++
      this.stats.eventsWritten += inserted
      this.stats.duplicates += duplicates
    } catch (err) {
      // Do NOT ack. The visibility timeout expires and pgmq redelivers, with
      // read_ct incremented — which is what eventually trips the poison check
      // above. No explicit retry logic needed; the queue is the retry.
      this.stats.errors++
      this.log('warn', 'batch failed, will be redelivered', {
        msgId: msg.msgId,
        attempt: msg.readCount,
        error: (err as Error).message,
      })
    }
  }
}
