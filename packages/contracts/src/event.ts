import { z } from 'zod'
import {
  CAPTURE_LAYERS,
  ERROR_TYPES,
  INFERENCE_STATUSES,
  OPERATIONS,
} from './enums.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CONTRACT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One schema, three jobs:
 *
 *   1. the SDK's payload type          (compile-time, via z.infer)
 *   2. the ingestion service validator (runtime, via .safeParse)
 *   3. the published JSON Schema       (docs, via zod-to-json-schema)
 *
 * Defining it once is not a stylistic preference. The failure mode this design
 * eliminates is the one where the producer and consumer of a wire format drift
 * apart silently and you find out weeks later that a field has been arriving as
 * a string. Here they cannot drift: they are the same object.
 *
 * ── Naming ──────────────────────────────────────────────────────────────────
 * camelCase on the wire (idiomatic JS), snake_case in Postgres (idiomatic SQL).
 * The repository layer owns that mapping and is the only place it appears.
 *
 * ── Versioning ──────────────────────────────────────────────────────────────
 * `schemaVersion` is required on every event. Once telemetry is flowing you can
 * never assume every producer has been redeployed, so the consumer must be able
 * to branch on the version it actually received rather than the one it expects.
 */

const MAX_PREVIEW_CHARS = 2_000

/** ISO-8601 with an explicit offset. Never a naive local timestamp — see the clock-skew note below. */
const isoTimestamp = z.string().datetime({ offset: true })

/** Free-form, provider-specific extras. The "misc drawer": promote a field to a real column once you find yourself querying it. */
const attributes = z.record(z.unknown()).default({})

export const InferenceEventSchema = z
  .object({
    // ── Identity ────────────────────────────────────────────────────────────
    /**
     * Client-generated, and the idempotency key for the whole pipeline.
     *
     * Delivery is at-least-once: if an ACK is lost the SDK resends, so the same
     * event legitimately arrives more than once. Rather than chase exactly-once
     * delivery (effectively impossible over a network) we make the *write*
     * idempotent — `ON CONFLICT DO NOTHING` on this column. The duplicate is
     * absorbed silently and the dashboard stays honest.
     */
    eventId: z.string().uuid(),
    schemaVersion: z.literal(1),

    // ── Correlation ─────────────────────────────────────────────────────────
    // Nullable throughout: the SDK must be able to instrument an LLM call that
    // has no conversation attached (a script, a background job, an eval run).
    // Telemetry that only works inside the happy path is not telemetry.
    conversationId: z.string().uuid().nullable().default(null),
    messageId: z.string().uuid().nullable().default(null),
    sessionId: z.string().max(128).nullable().default(null),
    userId: z.string().max(128).nullable().default(null),

    // ── What was called ─────────────────────────────────────────────────────
    provider: z.string().min(1).max(64),
    model: z.string().min(1).max(128),
    operation: z.enum(OPERATIONS).default('chat'),
    streamed: z.boolean().default(false),
    /** Which instrumentation layer captured this. Makes the zero-code demo provable from data. */
    capturedBy: z.enum(CAPTURE_LAYERS).default('proxy'),

    // ── How it ended ────────────────────────────────────────────────────────
    status: z.enum(INFERENCE_STATUSES),
    finishReason: z.string().max(64).nullable().default(null),
    errorType: z.enum(ERROR_TYPES).nullable().default(null),
    errorMessage: z.string().max(2_000).nullable().default(null),

    // ── Timing ──────────────────────────────────────────────────────────────
    /** When the SDK *observed* the call starting. Client clock — never trusted for ordering. */
    startedAt: isoTimestamp,
    endedAt: isoTimestamp,
    /** Wall-clock duration of the whole call. */
    latencyMs: z.number().int().nonnegative().max(3_600_000),
    /**
     * Time to first token — null for non-streamed calls.
     *
     * The most important latency number for a streaming UI and the one most
     * often not captured. Total latency describes the request; TTFT describes
     * what the user actually experienced.
     */
    ttftMs: z.number().int().nonnegative().max(3_600_000).nullable().default(null),

    // ── Usage ───────────────────────────────────────────────────────────────
    // Nullable because usage genuinely is sometimes unavailable: a stream that
    // errored before the usage frame, or OpenAI without
    // `stream_options.include_usage`. Recording null is honest; recording 0
    // would silently corrupt every token and cost aggregate downstream.
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
    /** Cache hits, when the provider reports them. Kept separate so cost maths stays correct. */
    cacheReadTokens: z.number().int().nonnegative().nullable().default(null),
    cacheWriteTokens: z.number().int().nonnegative().nullable().default(null),

    // ── Payload previews ────────────────────────────────────────────────────
    // Truncated on purpose. Full message text lives in `messages`; duplicating
    // it here would make the table the dashboards scan several times wider for
    // no analytical benefit. The hard cap also stops a buggy SDK build from
    // shipping megabytes per event.
    inputPreview: z.string().max(MAX_PREVIEW_CHARS).nullable().default(null),
    outputPreview: z.string().max(MAX_PREVIEW_CHARS).nullable().default(null),
    /** How many PII matches were replaced. Surfaced as a dashboard panel — a redactor you cannot observe is a redactor you cannot trust. */
    redactionHits: z.number().int().nonnegative().default(0),

    // ── Request shape ───────────────────────────────────────────────────────
    temperature: z.number().min(0).max(2).nullable().default(null),
    maxTokens: z.number().int().positive().nullable().default(null),
    /** Turns in the prompt. Lets you correlate latency with conversation depth without storing the prompt. */
    messageCount: z.number().int().nonnegative().nullable().default(null),

    attributes,
  })
  .strict()
  .superRefine((event, ctx) => {
    // Cross-field invariants. Catching these at the edge means the database
    // never has to store a row that contradicts itself, and the person debugging
    // gets told which field is wrong instead of discovering it in a chart.

    if (event.status === 'error' && event.errorType === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorType'],
        message: 'errorType is required when status is "error" — use "unknown" rather than omitting it',
      })
    }

    if (event.status === 'ok' && event.errorType !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['errorType'],
        message: 'errorType must be null when status is "ok"',
      })
    }

    if (event.ttftMs !== null && event.ttftMs > event.latencyMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ttftMs'],
        message: 'ttftMs cannot exceed latencyMs — the first token cannot arrive after the last one',
      })
    }

    if (Date.parse(event.endedAt) < Date.parse(event.startedAt)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endedAt'],
        message: 'endedAt precedes startedAt',
      })
    }
  })

/** The validated event, with every default applied. What the ingestion pipeline works with. */
export type InferenceEvent = z.infer<typeof InferenceEventSchema>
/** What a caller may pass in — defaulted fields are optional here. What the SDK constructs. */
export type InferenceEventInput = z.input<typeof InferenceEventSchema>

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BATCH ENVELOPE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Events travel in batches, never one per request. At 1,000 calls/second a
 * request-per-event would mean 1,000 extra HTTP round trips per second spent
 * purely on logging; batching at 50 turns that into roughly 20.
 *
 * The envelope carries SDK identity so that when a specific client version
 * starts emitting malformed events you can tell *which* one from the DLQ,
 * without guessing.
 */
export const EventBatchSchema = z
  .object({
    sdk: z.object({
      name: z.string().max(64),
      version: z.string().max(32),
      runtime: z.string().max(64).default('node'),
    }),
    /**
     * When the SDK dispatched this batch — its own clock.
     *
     * The server stamps its own `ingestedAt` on arrival and stores both. The
     * gap between them is pipeline lag, which is the metric that tells you the
     * system is falling behind before your users do. It also exposes client
     * clock skew: if `sentAt` is in the future, the client's clock is wrong and
     * the server's timestamp is the one to trust for ordering.
     */
    sentAt: isoTimestamp,
    events: z.array(InferenceEventSchema).min(1).max(500),
    /**
     * Events the SDK dropped since the last batch because its buffer was full.
     *
     * Reported rather than hidden. A telemetry pipeline that loses data silently
     * is worse than one that loses data loudly — silent loss looks exactly like
     * "traffic went down", which is the single most expensive misreading a
     * dashboard can produce.
     */
    droppedSinceLastBatch: z.number().int().nonnegative().default(0),
  })
  .strict()

export type EventBatch = z.infer<typeof EventBatchSchema>
export type EventBatchInput = z.input<typeof EventBatchSchema>

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INGESTION RESPONSE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Returned with HTTP **202 Accepted**, not 200 OK. 200 would claim the write is
 * complete; 202 says "received, and I am responsible for it now", which is the
 * truth once an event bus sits behind the endpoint.
 *
 * `duplicates` is surfaced deliberately: a healthy pipeline shows a small
 * non-zero number (retries working as designed), and a sudden spike means the
 * SDK is not receiving ACKs.
 */
export const IngestAckSchema = z.object({
  accepted: z.number().int().nonnegative(),
  duplicates: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  /** Per-event failures, so a single bad event never fails an otherwise good batch. */
  errors: z
    .array(
      z.object({
        eventId: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .default([]),
})

export type IngestAck = z.infer<typeof IngestAckSchema>
