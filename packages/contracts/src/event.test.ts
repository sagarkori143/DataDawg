import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventBatchSchema, InferenceEventSchema } from './event.js'
import type { InferenceEventInput } from './event.js'

/**
 * The wire contract is the one thing in this system that two independently
 * deployed processes both depend on, so its edge cases are worth pinning down.
 * Everything here is a rule the ingestion pipeline relies on being true.
 */

const baseEvent = (): InferenceEventInput => ({
  eventId: '0193b5e0-1c4a-7000-8000-000000000001',
  schemaVersion: 1,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  status: 'ok',
  startedAt: '2026-07-31T14:22:01.100Z',
  endedAt: '2026-07-31T14:22:04.200Z',
  latencyMs: 3100,
})

describe('InferenceEventSchema', () => {
  it('accepts a minimal valid event and applies defaults', () => {
    const parsed = InferenceEventSchema.parse(baseEvent())

    assert.equal(parsed.status, 'ok')
    assert.equal(parsed.operation, 'chat')
    assert.equal(parsed.streamed, false)
    assert.equal(parsed.capturedBy, 'proxy')
    assert.equal(parsed.redactionHits, 0)
    assert.deepEqual(parsed.attributes, {})
    // Correlation is optional: instrumenting a bare script must work.
    assert.equal(parsed.conversationId, null)
    assert.equal(parsed.ttftMs, null)
    // Absent usage stays null, never 0 — a 0 would silently corrupt cost aggregates.
    assert.equal(parsed.inputTokens, null)
  })

  it('rejects an error event that does not say why it failed', () => {
    const result = InferenceEventSchema.safeParse({ ...baseEvent(), status: 'error' })

    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /errorType is required/)
  })

  it('rejects a successful event that also carries an error type', () => {
    const result = InferenceEventSchema.safeParse({
      ...baseEvent(),
      status: 'ok',
      errorType: 'rate_limit',
    })

    assert.equal(result.success, false)
  })

  it('rejects a first token that arrives after the last one', () => {
    const result = InferenceEventSchema.safeParse({
      ...baseEvent(),
      latencyMs: 1000,
      ttftMs: 2000,
    })

    assert.equal(result.success, false)
    assert.match(result.error!.issues[0]!.message, /cannot exceed latencyMs/)
  })

  it('rejects an event that ended before it started', () => {
    const result = InferenceEventSchema.safeParse({
      ...baseEvent(),
      startedAt: '2026-07-31T14:22:04.200Z',
      endedAt: '2026-07-31T14:22:01.100Z',
    })

    assert.equal(result.success, false)
  })

  it('accepts a cancelled event carrying partial data', () => {
    // Hitting Stop mid-stream is not a failure, and the partial numbers are real.
    const parsed = InferenceEventSchema.parse({
      ...baseEvent(),
      status: 'cancelled',
      streamed: true,
      ttftMs: 640,
      latencyMs: 1200,
      outputTokens: 95,
      finishReason: 'client_abort',
    })

    assert.equal(parsed.status, 'cancelled')
    assert.equal(parsed.errorType, null)
    assert.equal(parsed.outputTokens, 95)
  })

  it('rejects unknown fields rather than silently dropping them', () => {
    // .strict() matters: a typo'd field name should fail loudly at the edge,
    // not vanish and leave someone hunting for missing data in a chart.
    const result = InferenceEventSchema.safeParse({ ...baseEvent(), latencyMS: 3100 })

    assert.equal(result.success, false)
  })

  it('rejects a naive timestamp with no offset', () => {
    const result = InferenceEventSchema.safeParse({
      ...baseEvent(),
      startedAt: '2026-07-31T14:22:01.100',
    })

    assert.equal(result.success, false)
  })

  it('caps preview length so a buggy client cannot ship megabytes per event', () => {
    const result = InferenceEventSchema.safeParse({
      ...baseEvent(),
      inputPreview: 'x'.repeat(2_001),
    })

    assert.equal(result.success, false)
  })
})

describe('EventBatchSchema', () => {
  it('accepts a batch and defaults the drop counter to zero', () => {
    const parsed = EventBatchSchema.parse({
      sdk: { name: '@ollive/sdk', version: '0.1.0' },
      sentAt: '2026-07-31T14:22:04.500Z',
      events: [baseEvent()],
    })

    assert.equal(parsed.events.length, 1)
    assert.equal(parsed.droppedSinceLastBatch, 0)
    assert.equal(parsed.sdk.runtime, 'node')
  })

  it('rejects an empty batch', () => {
    const result = EventBatchSchema.safeParse({
      sdk: { name: '@ollive/sdk', version: '0.1.0' },
      sentAt: '2026-07-31T14:22:04.500Z',
      events: [],
    })

    assert.equal(result.success, false)
  })

  it('rejects an oversized batch', () => {
    const result = EventBatchSchema.safeParse({
      sdk: { name: '@ollive/sdk', version: '0.1.0' },
      sentAt: '2026-07-31T14:22:04.500Z',
      events: Array.from({ length: 501 }, baseEvent),
    })

    assert.equal(result.success, false)
  })
})
