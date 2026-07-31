import type { EventBatchInput, InferenceEvent } from '@ollive/contracts'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TRANSPORT — the bucket
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Events are buffered and flushed in batches, never one request per event. At
 * 1,000 calls/second a request-per-event means 1,000 extra round trips spent
 * purely on logging; batching at 50 turns that into roughly 20.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 *
 *      A failure in here must never surface to the caller.
 *
 * `enqueue()` cannot throw, cannot block, and cannot await. It writes to an
 * array and returns. Everything else — HTTP, retries, backoff, serialisation —
 * happens off the caller's path. A logging library that can take down the
 * application it observes is worse than no logging library.
 *
 * ── What is deliberately given up ───────────────────────────────────────────
 * If the process dies with a full buffer, those events are gone. Worst case is
 * one flush interval's worth. That is the right trade for telemetry and the
 * wrong one for money or medical records, which would need a disk-backed
 * write-ahead log before acknowledging.
 */

export interface TransportOptions {
  endpoint: string
  apiKey: string | null
  batchSize: number
  flushMs: number
  maxQueue: number
  httpTimeoutMs: number
  /** Flush on every event instead of on a timer. Set when the runtime freezes after the response. */
  serverless: boolean
  sdkName: string
  sdkVersion: string
  /** Diagnostics sink. Never throws into the caller; wired to stderr by default. */
  onError?: (info: { stage: string; message: string; dropped: number }) => void
}

export interface TransportStats {
  enqueued: number
  sent: number
  dropped: number
  failedBatches: number
  duplicates: number
  inFlight: number
  queued: number
}

const NON_RETRYABLE = new Set([400, 401, 403, 404, 413, 422])

export class Transport {
  private queue: InferenceEvent[] = []
  private timer: NodeJS.Timeout | undefined
  private closing = false

  /** Reported on the next batch so loss is visible rather than looking like a traffic dip. */
  private droppedSinceLastBatch = 0

  /** Tripped by a 401/403 so a misconfigured key does not hammer the endpoint. */
  private circuitOpenUntil = 0

  private readonly pending = new Set<Promise<void>>()

  private readonly stats: TransportStats = {
    enqueued: 0,
    sent: 0,
    dropped: 0,
    failedBatches: 0,
    duplicates: 0,
    inFlight: 0,
    queued: 0,
  }

  constructor(private readonly opts: TransportOptions) {}

  /**
   * Hand an event to the transport.
   *
   * Synchronous and infallible by construction. The `try` is not defensive
   * politeness — it is the guarantee: if anything in here somehow throws, the
   * model call that produced the event must still succeed.
   */
  enqueue(event: InferenceEvent): void {
    if (this.closing) return

    try {
      this.stats.enqueued++

      if (this.queue.length >= this.opts.maxQueue) {
        // Drop the OLDEST, not the newest.
        //
        // During an incident the newest events describe the incident. Dropping
        // them to preserve history from before anything went wrong is exactly
        // backwards — you would discard the evidence and keep the boredom.
        this.queue.shift()
        this.droppedSinceLastBatch++
        this.stats.dropped++
      }

      this.queue.push(event)
      this.stats.queued = this.queue.length

      if (this.opts.serverless || this.queue.length >= this.opts.batchSize) {
        this.scheduleFlush(true)
      } else {
        this.scheduleFlush(false)
      }
    } catch {
      // Unreachable in practice. Swallowed anyway, because the alternative is
      // a telemetry bug becoming a user-visible chat failure.
    }
  }

  private scheduleFlush(immediate: boolean): void {
    if (immediate) {
      this.clearTimer()
      void this.flush()
      return
    }

    if (this.timer) return

    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.opts.flushMs)

    // Do not hold the process open for a pending flush. Without this a
    // short-lived script would hang for the flush interval on every exit, which
    // makes the SDK feel broken even though it is working.
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Send everything currently buffered.
   *
   * Returns a promise so shutdown can await it. Callers on the hot path never
   * do — they call `enqueue` and move on.
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0) return
    if (Date.now() < this.circuitOpenUntil) return

    const events = this.queue.splice(0, this.opts.batchSize)
    const dropped = this.droppedSinceLastBatch
    this.droppedSinceLastBatch = 0
    this.stats.queued = this.queue.length

    const batch: EventBatchInput = {
      sdk: { name: this.opts.sdkName, version: this.opts.sdkVersion, runtime: 'node' },
      sentAt: new Date().toISOString(),
      events,
      droppedSinceLastBatch: dropped,
    }

    const task = this.send(batch, events, dropped)
    this.pending.add(task)
    this.stats.inFlight = this.pending.size
    void task.finally(() => {
      this.pending.delete(task)
      this.stats.inFlight = this.pending.size
    })

    await task

    // More arrived while that was in flight — keep draining rather than waiting
    // for the next timer tick, which would let the queue grow under load.
    if (this.queue.length >= this.opts.batchSize) await this.flush()
  }

  private async send(
    batch: EventBatchInput,
    events: InferenceEvent[],
    dropped: number,
    attempt = 0,
  ): Promise<void> {
    const maxAttempts = 4

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), this.opts.httpTimeoutMs)

      const res = await fetch(`${this.opts.endpoint}/v1/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.opts.apiKey ? { Authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout))

      if (res.ok) {
        this.stats.sent += events.length
        const ack = (await res.json().catch(() => null)) as { duplicates?: number } | null
        if (ack?.duplicates) this.stats.duplicates += ack.duplicates
        return
      }

      // A bad key will still be bad in eight seconds. Retrying turns a clear
      // configuration error into a slow mysterious one and floods the endpoint,
      // so trip a breaker and let the next window re-test it.
      if (res.status === 401 || res.status === 403) {
        this.circuitOpenUntil = Date.now() + 60_000
        this.fail('auth', `ingest rejected credentials (${res.status})`, dropped)
        return
      }

      if (NON_RETRYABLE.has(res.status)) {
        this.fail('reject', `ingest rejected batch (${res.status}) — dropping`, dropped)
        return
      }

      throw new Error(`ingest returned ${res.status}`)
    } catch (err) {
      if (attempt + 1 >= maxAttempts) {
        this.stats.failedBatches++
        this.stats.dropped += events.length
        this.fail('send', (err as Error).message, dropped + events.length)
        return
      }

      // Exponential backoff with jitter. Without jitter every instance retries
      // on the same schedule and re-kills the endpoint the instant it recovers
      // — a thundering herd that turns a blip into an outage.
      const base = 2 ** attempt * 500
      const delay = base + Math.random() * base
      await new Promise((r) => setTimeout(r, delay))

      return this.send(batch, events, dropped, attempt + 1)
    }
  }

  private fail(stage: string, message: string, dropped: number): void {
    try {
      this.opts.onError?.({ stage, message, dropped })
    } catch {
      // A broken error handler must not become a second failure.
    }
  }

  /**
   * Drain before exit.
   *
   * Bounded, because a shutdown that hangs waiting for a dead endpoint is worse
   * than losing the tail of the buffer. The grace period is the same number a
   * container runtime allows between SIGTERM and SIGKILL, which is why graceful
   * shutdown is worth building before containers exist rather than after.
   */
  async close(graceMs = 5_000): Promise<TransportStats> {
    this.closing = true
    this.clearTimer()

    const deadline = Date.now() + graceMs
    while ((this.queue.length > 0 || this.pending.size > 0) && Date.now() < deadline) {
      if (this.queue.length > 0) {
        await this.flush().catch(() => {})
      } else {
        await Promise.race([
          Promise.allSettled([...this.pending]),
          new Promise((r) => setTimeout(r, 100)),
        ])
      }
    }

    if (this.queue.length > 0) {
      this.stats.dropped += this.queue.length
      this.fail('shutdown', `exited with ${this.queue.length} unflushed events`, this.queue.length)
      this.queue = []
    }

    return { ...this.stats }
  }

  getStats(): TransportStats {
    return { ...this.stats, queued: this.queue.length, inFlight: this.pending.size }
  }
}

/**
 * A transport that does nothing.
 *
 * Used when no endpoint is configured. The absence of telemetry configuration
 * must never break the application being instrumented — this is the first thing
 * a reviewer hits when they clone the repo and run it without reading the
 * README, and it should be a warning at startup, not a crash.
 */
const ZERO_STATS: TransportStats = {
  enqueued: 0,
  sent: 0,
  dropped: 0,
  failedBatches: 0,
  duplicates: 0,
  inFlight: 0,
  queued: 0,
}

export class NoopTransport {
  enqueue(): void {}
  async flush(): Promise<void> {}
  async close(): Promise<TransportStats> {
    return { ...ZERO_STATS }
  }
  getStats(): TransportStats {
    return { ...ZERO_STATS }
  }
}

/** What the instrumentation depends on. Lets Noop and Transport be interchangeable. */
export type AnyTransport = Pick<Transport, 'enqueue' | 'flush' | 'close' | 'getStats'>

