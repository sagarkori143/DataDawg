import { query } from '../pool.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * METRICS — what the dashboards read
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything here reads `inference_rollup_1m`, never raw events.
 *
 * Drawing 24 hours of p95 from raw rows means scanning millions of them on
 * every page load. Reading pre-aggregated minutes means 1,440 rows. The shop
 * wrote the daily total in a book at closing rather than recounting every
 * receipt.
 *
 * The one exception is `latencyPercentilesRaw`, which exists so the dashboard
 * can show both paths side by side — the rollup is a *cache*, and being able to
 * check it against the source is what makes it trustworthy.
 */

export type Range = '15m' | '1h' | '6h' | '24h' | '7d'

/**
 * Bucket width per range.
 *
 * Fixed rather than computed so every chart in a given range shares an x-axis.
 * Roughly 60-100 points each: enough shape to read a trend, few enough that the
 * browser is not laying out thousands of SVG nodes.
 */
const RANGES: Record<Range, { interval: string; bucket: string }> = {
  '15m': { interval: '15 minutes', bucket: '1 minute' },
  '1h': { interval: '1 hour', bucket: '1 minute' },
  '6h': { interval: '6 hours', bucket: '5 minutes' },
  '24h': { interval: '24 hours', bucket: '15 minutes' },
  '7d': { interval: '7 days', bucket: '1 hour' },
}

export interface TimePoint {
  bucket: string
  calls: number
  errors: number
  cancelled: number
  p50: number | null
  p95: number | null
  p99: number | null
  ttftP50: number | null
  ttftP95: number | null
  tokensPerMin: number
  costUsd: string
}

/**
 * The main time series.
 *
 * Percentiles come from merged histograms, not from averaging per-minute
 * percentiles — averaging p95s is meaningless and a surprisingly common bug.
 * `histogram_sum` adds the bucket arrays element-wise, which yields the true
 * histogram of the union, and the percentile is read from that.
 */
export async function timeseries(range: Range, model?: string | null): Promise<TimePoint[]> {
  const { interval, bucket } = RANGES[range]

  const { rows } = await query<TimePoint>(
    `SELECT
       to_char(date_bin($2::interval, bucket, now() - $1::interval), 'YYYY-MM-DD"T"HH24:MI:SSZ') AS bucket,
       sum(calls)::bigint      AS calls,
       sum(errors)::bigint     AS errors,
       sum(cancelled)::bigint  AS cancelled,
       round(histogram_percentile(histogram_sum(hist_latency), 0.50)::numeric)::float AS p50,
       round(histogram_percentile(histogram_sum(hist_latency), 0.95)::numeric)::float AS p95,
       round(histogram_percentile(histogram_sum(hist_latency), 0.99)::numeric)::float AS p99,
       round(histogram_percentile(histogram_sum(hist_ttft), 0.50)::numeric)::float    AS "ttftP50",
       round(histogram_percentile(histogram_sum(hist_ttft), 0.95)::numeric)::float    AS "ttftP95",
       (sum(input_tokens + output_tokens)
         / greatest(extract(epoch from $2::interval) / 60, 1))::bigint AS "tokensPerMin",
       round(sum(cost_usd), 6)::text AS "costUsd"
     FROM inference_rollup_1m
    WHERE bucket >= now() - $1::interval
      AND ($3::text IS NULL OR model = $3)
    GROUP BY 1
    ORDER BY 1`,
    [interval, bucket, model ?? null],
  )

  return rows
}

export interface Totals {
  calls: number
  errors: number
  cancelled: number
  errorRate: number
  p50: number | null
  p95: number | null
  p99: number | null
  ttftP95: number | null
  inputTokens: number
  outputTokens: number
  costUsd: string
  callsPerMin: number
}

/** Headline numbers for the stat row. One scan, one row. */
export async function totals(range: Range, model?: string | null): Promise<Totals> {
  const { interval } = RANGES[range]

  const { rows } = await query<Totals>(
    `SELECT
       coalesce(sum(calls), 0)::bigint     AS calls,
       coalesce(sum(errors), 0)::bigint    AS errors,
       coalesce(sum(cancelled), 0)::bigint AS cancelled,
       -- Cancellations are excluded from the denominator: a user pressing Stop
       -- is not a request the system failed to serve, and counting it as one
       -- makes the error rate lie in exactly the situation you most need it.
       CASE WHEN coalesce(sum(calls), 0) - coalesce(sum(cancelled), 0) > 0
            THEN round(sum(errors)::numeric
                       / (sum(calls) - sum(cancelled)) * 100, 2)::float
            ELSE 0 END AS "errorRate",
       round(histogram_percentile(histogram_sum(hist_latency), 0.50)::numeric)::float AS p50,
       round(histogram_percentile(histogram_sum(hist_latency), 0.95)::numeric)::float AS p95,
       round(histogram_percentile(histogram_sum(hist_latency), 0.99)::numeric)::float AS p99,
       round(histogram_percentile(histogram_sum(hist_ttft), 0.95)::numeric)::float    AS "ttftP95",
       coalesce(sum(input_tokens), 0)::bigint  AS "inputTokens",
       coalesce(sum(output_tokens), 0)::bigint AS "outputTokens",
       coalesce(round(sum(cost_usd), 6), 0)::text AS "costUsd",
       round(coalesce(sum(calls), 0)::numeric
             / greatest(extract(epoch from $1::interval) / 60, 1), 2)::float AS "callsPerMin"
     FROM inference_rollup_1m
    WHERE bucket >= now() - $1::interval
      AND ($2::text IS NULL OR model = $2)`,
    [interval, model ?? null],
  )

  return rows[0]!
}

export interface ModelBreakdown {
  provider: string
  model: string
  calls: number
  errors: number
  p95: number | null
  inputTokens: number
  outputTokens: number
  costUsd: string
}

/** Per-model table. Lights up on its own the moment a second provider is used. */
export async function byModel(range: Range): Promise<ModelBreakdown[]> {
  const { interval } = RANGES[range]

  const { rows } = await query<ModelBreakdown>(
    `SELECT provider, model,
            sum(calls)::bigint  AS calls,
            sum(errors)::bigint AS errors,
            round(histogram_percentile(histogram_sum(hist_latency), 0.95)::numeric)::float AS p95,
            sum(input_tokens)::bigint  AS "inputTokens",
            sum(output_tokens)::bigint AS "outputTokens",
            round(sum(cost_usd), 6)::text AS "costUsd"
       FROM inference_rollup_1m
      WHERE bucket >= now() - $1::interval
      GROUP BY provider, model
      ORDER BY sum(calls) DESC`,
    [interval],
  )

  return rows
}

export interface ErrorBreakdown {
  errorType: string
  count: number
  lastSeen: string
  sample: string | null
}

/**
 * Errors grouped by cause.
 *
 * This one hits raw events, because the rollup only counts errors — it does not
 * carry the taxonomy. Cheap regardless: the partial index on
 * `(created_at, error_type) WHERE status <> 'ok'` covers only failures, which
 * are a small fraction of rows.
 */
export async function byErrorType(range: Range): Promise<ErrorBreakdown[]> {
  const { interval } = RANGES[range]

  const { rows } = await query<ErrorBreakdown>(
    `SELECT coalesce(error_type::text, 'unknown') AS "errorType",
            count(*)::bigint AS count,
            to_char(max(created_at), 'YYYY-MM-DD HH24:MI:SS') AS "lastSeen",
            (array_agg(left(error_message, 160) ORDER BY created_at DESC))[1] AS sample
       FROM inference_events
      WHERE created_at >= now() - $1::interval
        AND status = 'error'
      GROUP BY 1
      ORDER BY count(*) DESC`,
    [interval],
  )

  return rows
}

/**
 * Percentiles computed from raw rows with `percentile_cont`.
 *
 * Exists purely so the dashboard can show rollup and raw side by side. The
 * rollup is a derived cache; being able to check it against the source is the
 * difference between "these numbers are probably right" and "these numbers are
 * verifiable". Bucket-interpolated percentiles will differ slightly from exact
 * ones — that difference is the accuracy cost of mergeability, and showing it
 * honestly beats hiding it.
 */
export async function latencyPercentilesRaw(
  range: Range,
): Promise<{ p50: number | null; p95: number | null; p99: number | null; samples: number }> {
  const { interval } = RANGES[range]

  const { rows } = await query<{ p50: number; p95: number; p99: number; samples: number }>(
    `SELECT percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms)::float AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float AS p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms)::float AS p99,
            count(*)::bigint AS samples
       FROM inference_events
      WHERE created_at >= now() - $1::interval AND status <> 'cancelled'`,
    [interval],
  )

  return rows[0] ?? { p50: null, p95: null, p99: null, samples: 0 }
}

export interface PipelineHealth {
  dlqPending: number
  redactionHits: number
  /** Median gap between the SDK observing a call and the server storing it. */
  medianLagMs: number | null
  maxLagMs: number | null
  eventsByLayer: Record<string, number>
}

/**
 * Health of the telemetry pipeline itself.
 *
 * Pipeline lag — `ingested_at - client_ts` — is the metric that says the system
 * is falling behind before users notice, and it only exists because the schema
 * stores both timestamps rather than one.
 */
export async function pipelineHealth(range: Range): Promise<PipelineHealth> {
  const { interval } = RANGES[range]

  const [{ rows: lag }, { rows: dlq }, { rows: layers }] = await Promise.all([
    query<{ medianLagMs: number; maxLagMs: number; redactionHits: number }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (
                ORDER BY extract(epoch from (ingested_at - client_ts)) * 1000)::int AS "medianLagMs",
              (max(extract(epoch from (ingested_at - client_ts))) * 1000)::int      AS "maxLagMs",
              coalesce(sum(redaction_hits), 0)::bigint AS "redactionHits"
         FROM inference_events
        WHERE created_at >= now() - $1::interval`,
      [interval],
    ),
    query<{ n: number }>('SELECT count(*)::int AS n FROM dlq WHERE replayed_at IS NULL'),
    query<{ layer: string; n: number }>(
      `SELECT captured_by::text AS layer, count(*)::int AS n
         FROM inference_events
        WHERE created_at >= now() - $1::interval
        GROUP BY 1`,
      [interval],
    ),
  ])

  return {
    dlqPending: dlq[0]?.n ?? 0,
    redactionHits: lag[0]?.redactionHits ?? 0,
    medianLagMs: lag[0]?.medianLagMs ?? null,
    maxLagMs: lag[0]?.maxLagMs ?? null,
    eventsByLayer: Object.fromEntries(layers.map((l) => [l.layer, l.n])),
  }
}

/** Every model seen in the window, for the filter dropdown. */
export async function knownModels(range: Range): Promise<string[]> {
  const { interval } = RANGES[range]
  const { rows } = await query<{ model: string }>(
    `SELECT DISTINCT model FROM inference_rollup_1m
      WHERE bucket >= now() - $1::interval ORDER BY 1`,
    [interval],
  )
  return rows.map((r) => r.model)
}

export const RANGE_KEYS = Object.keys(RANGES) as Range[]
