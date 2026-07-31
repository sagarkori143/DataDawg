import { randomUUID } from 'node:crypto'
import type { CaptureLayer, ErrorType, InferenceEventInput, InferenceStatus } from '@ollive/contracts'
import { getContext } from '../context.js'
import { preview } from '../redact.js'
import type { AnyTransport } from '../transport/queue.js'
import type { RequestMeta, UsageDelta } from './shims.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SPAN — one observed model call
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Holds the stopwatch and the running totals for a single call, and emits
 * exactly one event when it ends — however it ends.
 *
 * Every method is failure-tolerant on purpose. A span is bookkeeping attached
 * to somebody else's request; if the bookkeeping breaks, the request must not.
 */

const PREVIEW_CHARS_DEFAULT = 300

export interface SpanOptions {
  provider: string
  capturedBy: CaptureLayer
  transport: AnyTransport
  previewChars?: number
  sdkVersion?: string
}

export class Span {
  readonly eventId = randomUUID()
  private readonly startedAt = new Date()

  /**
   * Monotonic clock for durations, wall clock for timestamps.
   *
   * `Date.now()` can jump backwards (NTP correction, VM migration) and produce
   * a negative latency. `performance.now()` cannot, so it measures the interval
   * while `Date` records when it happened.
   */
  private readonly t0 = performance.now()

  private ttftMs: number | null = null
  private outputText = ''
  private finishReason: string | null = null
  private ended = false

  private usage: Required<UsageDelta> = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  }

  constructor(
    private readonly req: RequestMeta,
    private readonly opts: SpanOptions,
  ) {}

  /**
   * Record the first token.
   *
   * TTFT is what the user actually experiences in a streaming UI: total latency
   * describes the request, TTFT describes the wait. Only the first call counts —
   * subsequent chunks must not overwrite it.
   */
  markFirstToken(): void {
    if (this.ttftMs === null) this.ttftMs = Math.round(performance.now() - this.t0)
  }

  appendText(text: string): void {
    // Bounded so a runaway generation cannot grow this buffer without limit.
    // Only a preview is ever stored, so there is nothing to gain past the cap.
    if (this.outputText.length < 8_192) this.outputText += text
  }

  mergeUsage(delta: UsageDelta): void {
    for (const k of Object.keys(delta) as (keyof UsageDelta)[]) {
      const v = delta[k]
      // Only overwrite with a real number. A later chunk reporting `null` must
      // not erase a value an earlier chunk already established — Anthropic sends
      // input tokens once at the start and never repeats them.
      if (typeof v === 'number') this.usage[k] = v
    }
  }

  setFinishReason(reason: string | null | undefined): void {
    if (reason) this.finishReason = reason
  }

  /** Successful completion. */
  end(): void {
    this.emit('ok', null, null)
  }

  /** The caller stopped listening. Not a failure — partial numbers are real and kept. */
  cancel(): void {
    this.emit('cancelled', null, null)
    }

  fail(errorType: ErrorType | 'cancelled', message: string): void {
    // A user abort surfaces as an SDK error but is a deliberate action, not a
    // fault. Recording it as an error would inflate the error-rate panel with
    // people pressing Stop, and a dashboard that cries wolf gets ignored.
    if (errorType === 'cancelled') {
      this.emit('cancelled', null, message)
      return
    }
    this.emit('error', errorType, message)
  }

  private emit(status: InferenceStatus, errorType: ErrorType | null, errorMessage: string | null): void {
    if (this.ended) return
    this.ended = true

    try {
      const latencyMs = Math.round(performance.now() - this.t0)
      const ctx = getContext()
      const chars = this.opts.previewChars ?? PREVIEW_CHARS_DEFAULT

      const input = preview(this.req.inputText, chars)
      const output = preview(this.outputText, chars)

      const outTokens = this.usage.outputTokens
      const tokensPerSec =
        outTokens && latencyMs > 0 ? Number(((outTokens / latencyMs) * 1000).toFixed(2)) : null

      const event: InferenceEventInput = {
        eventId: this.eventId,
        schemaVersion: 1,

        conversationId: ctx.conversationId ?? null,
        messageId: ctx.messageId ?? null,
        sessionId: ctx.sessionId ?? null,
        userId: ctx.userId ?? null,

        provider: this.opts.provider,
        model: this.req.model,
        operation: 'chat',
        streamed: this.req.streamed,
        capturedBy: this.opts.capturedBy,

        status,
        finishReason: this.finishReason,
        errorType,
        errorMessage: errorMessage?.slice(0, 2_000) ?? null,

        startedAt: this.startedAt.toISOString(),
        endedAt: new Date(this.startedAt.getTime() + latencyMs).toISOString(),
        latencyMs,
        // Guarded: a clock oddity that put TTFT past the total would fail the
        // schema's cross-field check and send the whole batch to the DLQ.
        ttftMs: this.ttftMs === null ? null : Math.min(this.ttftMs, latencyMs),

        inputTokens: this.usage.inputTokens,
        outputTokens: this.usage.outputTokens,
        cacheReadTokens: this.usage.cacheReadTokens,
        cacheWriteTokens: this.usage.cacheWriteTokens,

        inputPreview: input.text,
        outputPreview: output.text,
        redactionHits: input.hits + output.hits,

        temperature: this.req.temperature,
        maxTokens: this.req.maxTokens,
        messageCount: this.req.messageCount,

        attributes: {
          ...ctx.attributes,
          ...(tokensPerSec !== null ? { tokens_per_sec: tokensPerSec } : {}),
          ...(this.opts.sdkVersion ? { sdk_version: this.opts.sdkVersion } : {}),
        },
      }

      this.opts.transport.enqueue(event as never)
    } catch {
      // Telemetry construction failed. Nothing to do but not propagate: the
      // model call this describes already succeeded, and failing it now to
      // report a logging bug would be exactly backwards.
    }
  }
}
