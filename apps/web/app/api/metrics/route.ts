import { RANGE_KEYS, metrics, type Range } from '@ollive/db'

/**
 * GET /api/metrics?range=1h&model=…
 *
 * Every panel on the dashboard in one round trip. Six small queries in parallel
 * beats six sequential requests from the browser, and they all read the rollup
 * table rather than raw events — the difference between scanning 1,440 rows and
 * several million.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const raw = url.searchParams.get('range') ?? '1h'
  const range: Range = (RANGE_KEYS as string[]).includes(raw) ? (raw as Range) : '1h'
  const model = url.searchParams.get('model') || null

  try {
    const [series, totals, byModel, byErrorType, health, models, rawPct] = await Promise.all([
      metrics.timeseries(range, model),
      metrics.totals(range, model),
      metrics.byModel(range),
      metrics.byErrorType(range),
      metrics.pipelineHealth(range),
      metrics.knownModels(range),
      // The honesty check: exact percentiles from raw rows, shown beside the
      // bucketed ones so the cache is verifiable rather than merely trusted.
      metrics.latencyPercentilesRaw(range),
    ])

    return Response.json(
      { range, model, series, totals, byModel, byErrorType, health, models, rawPct },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}
