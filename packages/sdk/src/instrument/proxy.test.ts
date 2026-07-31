import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { InferenceEvent } from '@ollive/contracts'
import { instrument } from './proxy.js'
import type { AnyTransport, TransportStats } from '../transport/queue.js'

/**
 * The properties worth guaranteeing, in priority order:
 *
 *   1. The application still gets every token. Instrumentation that eats the
 *      stream is worse than none.
 *   2. The application never sees a telemetry failure.
 *   3. The numbers are right.
 */

class CaptureTransport implements AnyTransport {
  events: InferenceEvent[] = []
  enqueue(e: unknown): void {
    this.events.push(e as InferenceEvent)
  }
  async flush(): Promise<void> {}
  async close(): Promise<TransportStats> {
    return this.getStats()
  }
  getStats(): TransportStats {
    return {
      enqueued: this.events.length,
      sent: 0,
      dropped: 0,
      failedBatches: 0,
      duplicates: 0,
      inFlight: 0,
      queued: 0,
    }
  }
}

/** A stand-in for the Anthropic client, shaped exactly like the real one. */
function fakeAnthropic(opts: {
  chunks?: unknown[]
  message?: unknown
  throwOn?: 'call' | 'chunk'
  error?: unknown
} = {}) {
  const chunks = opts.chunks ?? []

  return {
    messages: {
      create(_params: unknown) {
        if (opts.throwOn === 'call') return Promise.reject(opts.error)
        return Promise.resolve(opts.message)
      },
      stream(_params: unknown) {
        if (opts.throwOn === 'call') throw opts.error

        return {
          extraProperty: 'passes through',
          abort() {
            return 'aborted'
          },
          async *[Symbol.asyncIterator]() {
            for (const c of chunks) {
              if (opts.throwOn === 'chunk' && c === chunks[1]) throw opts.error
              yield c
            }
          },
        }
      },
    },
  }
}

const STREAM_CHUNKS = [
  { type: 'message_start', message: { usage: { input_tokens: 42, cache_read_input_tokens: 7 } } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } },
  { type: 'message_delta', usage: { output_tokens: 5 }, delta: { stop_reason: 'end_turn' } },
]

describe('instrument() — streaming', () => {
  it('passes every chunk through untouched', async () => {
    const transport = new CaptureTransport()
    const client = instrument(fakeAnthropic({ chunks: STREAM_CHUNKS }), { transport })

    const seen: unknown[] = []
    for await (const chunk of client.messages.stream({ model: 'claude-opus-5', messages: [] })) {
      seen.push(chunk)
    }

    // The whole point: counting must not consume.
    assert.equal(seen.length, STREAM_CHUNKS.length)
    assert.deepEqual(seen, STREAM_CHUNKS)
  })

  it('records usage from both ends of the stream', async () => {
    const transport = new CaptureTransport()
    const client = instrument(fakeAnthropic({ chunks: STREAM_CHUNKS }), { transport })

    for await (const _ of client.messages.stream({ model: 'claude-opus-5', messages: [] })) {
      /* drain */
    }

    const [event] = transport.events
    assert.ok(event)
    // Input tokens come from message_start, output from message_delta. Reading
    // only at the end would leave inputTokens null on every call.
    assert.equal(event.inputTokens, 42)
    assert.equal(event.outputTokens, 5)
    assert.equal(event.cacheReadTokens, 7)
    assert.equal(event.status, 'ok')
    assert.equal(event.finishReason, 'end_turn')
    assert.equal(event.streamed, false) // stream() helper, not stream:true param
  })

  it('captures TTFT on the first text chunk, not the first event', async () => {
    const transport = new CaptureTransport()
    const client = instrument(fakeAnthropic({ chunks: STREAM_CHUNKS }), { transport })

    for await (const _ of client.messages.stream({ model: 'claude-opus-5', messages: [] })) {
      /* drain */
    }

    const [event] = transport.events
    assert.ok(event!.ttftMs !== null, 'ttft must be recorded')
    assert.ok(event!.ttftMs! <= event!.latencyMs, 'ttft cannot exceed total latency')
  })

  it('emits a cancelled event when the consumer breaks out early', async () => {
    const transport = new CaptureTransport()
    const client = instrument(fakeAnthropic({ chunks: STREAM_CHUNKS }), { transport })

    for await (const chunk of client.messages.stream({ model: 'claude-opus-5', messages: [] })) {
      if ((chunk as { type: string }).type === 'content_block_delta') break
    }

    const [event] = transport.events
    assert.equal(event!.status, 'cancelled')
    // Partial data is real data — it is what the user actually saw.
    assert.equal(event!.inputTokens, 42)
    assert.equal(event!.errorType, null, 'a cancellation is not an error')
  })

  it('passes non-iterator properties through to the real stream', async () => {
    const transport = new CaptureTransport()
    const client = instrument(fakeAnthropic({ chunks: STREAM_CHUNKS }), { transport })

    const stream = client.messages.stream({ model: 'claude-opus-5', messages: [] })
    assert.equal((stream as { extraProperty: string }).extraProperty, 'passes through')
    assert.equal((stream as { abort(): string }).abort(), 'aborted')
  })
})

describe('instrument() — non-streaming', () => {
  it('records usage from a complete message', async () => {
    const transport = new CaptureTransport()
    const client = instrument(
      fakeAnthropic({
        message: {
          type: 'message',
          content: [{ type: 'text', text: 'Hi there' }],
          usage: { input_tokens: 10, output_tokens: 3 },
          stop_reason: 'end_turn',
        },
      }),
      { transport },
    )

    const res = await client.messages.create({ model: 'claude-opus-5', messages: [] })

    assert.equal((res as { type: string }).type, 'message')
    const [event] = transport.events
    assert.equal(event!.inputTokens, 10)
    assert.equal(event!.outputTokens, 3)
    assert.equal(event!.ttftMs, null, 'no TTFT without streaming')
  })
})

describe('instrument() — failure handling', () => {
  it('classifies a provider error and rethrows it unchanged', async () => {
    const transport = new CaptureTransport()
    const original = Object.assign(new Error('rate limited'), { status: 429 })
    const client = instrument(fakeAnthropic({ throwOn: 'call', error: original }), { transport })

    await assert.rejects(
      () => client.messages.create({ model: 'claude-opus-5', messages: [] }),
      // The caller must receive the vendor's own error, not a wrapped one.
      (err) => err === original,
    )

    const [event] = transport.events
    assert.equal(event!.status, 'error')
    assert.equal(event!.errorType, 'rate_limit')
  })

  it('records a mid-stream failure and rethrows', async () => {
    const transport = new CaptureTransport()
    const boom = Object.assign(new Error('connection reset'), { name: 'APIConnectionError' })
    const client = instrument(
      fakeAnthropic({ chunks: STREAM_CHUNKS, throwOn: 'chunk', error: boom }),
      { transport },
    )

    await assert.rejects(async () => {
      for await (const _ of client.messages.stream({ model: 'claude-opus-5', messages: [] })) {
        /* drain */
      }
    })

    const [event] = transport.events
    assert.equal(event!.status, 'error')
    assert.equal(event!.errorType, 'network')
    // The tokens seen before the failure are still recorded.
    assert.equal(event!.inputTokens, 42)
  })

  it('treats a user abort as cancelled, not as an error', async () => {
    const transport = new CaptureTransport()
    const abort = Object.assign(new Error('aborted'), { name: 'APIUserAbortError' })
    const client = instrument(fakeAnthropic({ throwOn: 'call', error: abort }), { transport })

    await assert.rejects(() => client.messages.create({ model: 'claude-opus-5', messages: [] }))

    const [event] = transport.events
    assert.equal(event!.status, 'cancelled')
    assert.equal(event!.errorType, null)
  })

  it('returns the client unchanged when the shape is unrecognised', () => {
    const transport = new CaptureTransport()
    const weird = { somethingElse() {} }
    let skipped = ''

    const result = instrument(weird, {
      transport,
      onSkip: (r) => {
        skipped = r
      },
    })

    assert.equal(result, weird, 'must not break an unknown client')
    assert.match(skipped, /identify provider/)
  })

  it('is idempotent — double instrumentation does not double count', async () => {
    const transport = new CaptureTransport()
    const once = instrument(fakeAnthropic({ chunks: STREAM_CHUNKS }), { transport })
    const twice = instrument(once, { transport })

    for await (const _ of twice.messages.stream({ model: 'claude-opus-5', messages: [] })) {
      /* drain */
    }

    assert.equal(transport.events.length, 1)
  })
})
