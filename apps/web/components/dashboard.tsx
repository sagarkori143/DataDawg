'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Legend, Panel, Stat, VIZ, fmtClock, fmtMs, fmtNum, fmtUsd } from './viz'

const RANGES = ['15m', '1h', '6h', '24h', '7d'] as const

interface Payload {
  series: Array<{
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
  }>
  totals: {
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
  byModel: Array<{
    provider: string
    model: string
    calls: number
    errors: number
    p95: number | null
    inputTokens: number
    outputTokens: number
    costUsd: string
  }>
  byErrorType: Array<{ errorType: string; count: number; lastSeen: string; sample: string | null }>
  health: {
    dlqPending: number
    redactionHits: number
    medianLagMs: number | null
    maxLagMs: number | null
    eventsByLayer: Record<string, number>
  }
  models: string[]
  rawPct: { p50: number | null; p95: number | null; p99: number | null; samples: number }
}

/** Recessive chrome, shared by every chart so they read as one system. */
const axis = {
  stroke: VIZ.axis,
  tick: { fill: VIZ.muted, fontSize: 10, fontVariantNumeric: 'tabular-nums' as const },
  tickLine: false,
  axisLine: { stroke: VIZ.axis },
}

const tooltipStyle = {
  contentStyle: {
    background: '#0f1115',
    border: '1px solid #262b34',
    borderRadius: 8,
    fontSize: 11,
  },
  labelStyle: { color: VIZ.textSecondary, marginBottom: 4 },
  cursor: { stroke: VIZ.muted, strokeWidth: 1, strokeDasharray: '3 3' },
}

export function Dashboard() {
  const [range, setRange] = useState<(typeof RANGES)[number]>('1h')
  const [model, setModel] = useState<string>('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showTable, setShowTable] = useState(false)

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ range, ...(model ? { model } : {}) })
      const res = await fetch(`/api/metrics?${qs}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'failed to load metrics')
      setData(json)
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }, [range, model])

  useEffect(() => {
    void load()
    // Live-ish without hammering the database. The rollup is at most a minute
    // behind anyway, so polling faster would show the same numbers.
    const id = setInterval(() => void load(), 10_000)
    return () => clearInterval(id)
  }, [load])

  const t = data?.totals
  const series = data?.series ?? []
  const hasErrors = (t?.errors ?? 0) > 0

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-6">
      {/* ── Filters: one row, above the charts ─────────────────────────── */}
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-[#262b34] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs ${
                range === r ? 'bg-[#262b34] text-[#e8eaed]' : 'text-[#898781] hover:text-[#c3c2b7]'
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="rounded-lg border border-[#262b34] bg-[#16191f] px-3 py-1.5 text-xs text-[#c3c2b7] outline-none"
        >
          <option value="">all models</option>
          {data?.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>

        <button
          onClick={() => setShowTable((v) => !v)}
          className="rounded-lg border border-[#262b34] px-3 py-1.5 text-xs text-[#898781] hover:text-[#c3c2b7]"
        >
          {showTable ? 'charts' : 'table view'}
        </button>

        <a
          href="/"
          className="ml-auto rounded-lg border border-[#262b34] px-3 py-1.5 text-xs text-[#898781] hover:text-[#c3c2b7]"
        >
          ← chat
        </a>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-[#d03b3b]/30 bg-[#d03b3b]/5 px-4 py-3 text-xs text-[#d03b3b]">
          {error}
        </div>
      )}

      {/* ── Headline numbers ───────────────────────────────────────────── */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Stat label="calls" value={fmtNum(t?.calls)} note={`${t?.callsPerMin ?? 0}/min`} />
        <Stat label="p95 latency" value={fmtMs(t?.p95)} note={`p50 ${fmtMs(t?.p50)}`} />
        <Stat label="p95 TTFT" value={fmtMs(t?.ttftP95)} note="time to first token" />
        <Stat
          label="error rate"
          value={`${t?.errorRate ?? 0}%`}
          tone={hasErrors ? 'critical' : undefined}
          note={`${t?.errors ?? 0} failed · ${t?.cancelled ?? 0} cancelled`}
        />
        <Stat
          label="tokens"
          value={fmtNum((t?.inputTokens ?? 0) + (t?.outputTokens ?? 0))}
          note={`${fmtNum(t?.inputTokens)} in · ${fmtNum(t?.outputTokens)} out`}
        />
        <Stat label="cost" value={fmtUsd(t?.costUsd)} note="frozen at ingestion" />
      </div>

      {showTable ? (
        <TableView data={data} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* ── Latency percentiles ─────────────────────────────────────── */}
          <Panel
            title="Latency"
            hint="p50 / p95 / p99"
            right={
              <Legend
                items={[
                  { label: 'p50', color: VIZ.latency.p50 },
                  { label: 'p95', color: VIZ.latency.p95 },
                  { label: 'p99', color: VIZ.latency.p99 },
                ]}
              />
            }
          >
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <CartesianGrid stroke={VIZ.grid} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={fmtClock} {...axis} minTickGap={40} />
                <YAxis tickFormatter={(v) => fmtMs(v)} {...axis} width={52} />
                <Tooltip
                  {...tooltipStyle}
                  labelFormatter={(l) => fmtClock(String(l))}
                  formatter={(v, n) => [fmtMs(Number(v)), String(n)]}
                />
                {/* 2px lines, 8px markers only on hover — a dot on every point
                    is noise once there are more than a handful. */}
                <Line
                  type="monotone"
                  dataKey="p50"
                  stroke={VIZ.latency.p50}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="p95"
                  stroke={VIZ.latency.p95}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
                <Line
                  type="monotone"
                  dataKey="p99"
                  stroke={VIZ.latency.p99}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>

            {data && data.rawPct.samples > 0 && (
              <p className="mt-2 text-[11px] leading-relaxed text-[#898781]">
                Rollup p95 <span className="text-[#c3c2b7]">{fmtMs(t?.p95)}</span> · exact
                percentile_cont over {fmtNum(data.rawPct.samples)} raw rows{' '}
                <span className="text-[#c3c2b7]">{fmtMs(data.rawPct.p95)}</span>. The gap is the
                accuracy cost of histogram buckets, which is what makes the rollup mergeable.
              </p>
            )}
          </Panel>

          {/* ── Throughput ──────────────────────────────────────────────── */}
          <Panel title="Throughput" hint="calls and tokens per bucket">
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
                <defs>
                  <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={VIZ.series[0]} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={VIZ.series[0]} stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={VIZ.grid} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={fmtClock} {...axis} minTickGap={40} />
                <YAxis {...axis} width={40} allowDecimals={false} />
                <Tooltip {...tooltipStyle} labelFormatter={(l) => fmtClock(String(l))} />
                <Area
                  type="monotone"
                  dataKey="calls"
                  name="calls"
                  stroke={VIZ.series[0]}
                  strokeWidth={2}
                  fill="url(#callsFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* ── Errors ──────────────────────────────────────────────────── */}
          <Panel title="Errors" hint="by cause">
            {data && data.byErrorType.length === 0 ? (
              <p className="py-12 text-center text-xs text-[#898781]">
                No errors in this window.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {data?.byErrorType.map((e) => (
                  <div
                    key={e.errorType}
                    className="flex items-start gap-3 rounded border border-[#262b34] px-3 py-2"
                  >
                    {/* Status colour never carries meaning alone — the label
                        beside it names the cause. */}
                    <span
                      aria-hidden
                      className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: VIZ.status.critical }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[11px] text-[#e8eaed]">{e.errorType}</span>
                        <span className="text-[11px] tabular-nums text-[#898781]">
                          {e.count} · {e.lastSeen}
                        </span>
                      </div>
                      {e.sample && (
                        <p className="mt-0.5 truncate text-[11px] text-[#898781]">{e.sample}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* ── Cost by model ───────────────────────────────────────────── */}
          <Panel title="Cost by model" hint="frozen at ingestion with a pricing version">
            {data && data.byModel.length > 0 ? (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart
                  data={data.byModel.map((m) => ({ ...m, cost: Number(m.costUsd) }))}
                  margin={{ top: 4, right: 8, bottom: 0, left: -12 }}
                  layout="vertical"
                >
                  <CartesianGrid stroke={VIZ.grid} horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => fmtUsd(v)} {...axis} />
                  <YAxis type="category" dataKey="model" {...axis} width={130} />
                  <Tooltip
                    {...tooltipStyle}
                    cursor={{ fill: '#ffffff08' }}
                    formatter={(v) => [fmtUsd(Number(v)), 'cost']}
                  />
                  {/* 4px rounded data-end, anchored to the baseline. */}
                  <Bar dataKey="cost" fill={VIZ.series[0]} radius={[0, 4, 4, 0]} barSize={18} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-12 text-center text-xs text-[#898781]">No traffic yet.</p>
            )}
          </Panel>

          {/* ── Pipeline health ─────────────────────────────────────────── */}
          <Panel
            title="Pipeline health"
            hint="the telemetry system observing itself"
            right={
              <Legend
                items={Object.entries(data?.health.eventsByLayer ?? {}).map(([k], i) => ({
                  label: `captured by ${k}`,
                  color: VIZ.series[i % VIZ.series.length]!,
                }))}
              />
            }
          >
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat
                label="ingest lag"
                value={fmtMs(data?.health.medianLagMs)}
                note={`max ${fmtMs(data?.health.maxLagMs)}`}
              />
              <Stat
                label="DLQ"
                value={data?.health.dlqPending ?? 0}
                tone={(data?.health.dlqPending ?? 0) > 0 ? 'warning' : undefined}
                note="parked, replayable"
              />
              <Stat
                label="PII redacted"
                value={fmtNum(data?.health.redactionHits)}
                note="never reached the DB"
              />
              <Stat
                label="capture layer"
                value={Object.keys(data?.health.eventsByLayer ?? {}).join(' + ') || '—'}
                note="proxy / loader"
              />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-[#898781]">
              Ingest lag is <span className="text-[#c3c2b7]">ingested_at − client_ts</span> — the
              gap between the SDK observing a call and the server storing it. It only exists
              because the schema keeps both timestamps, and it is the number that says the pipeline
              is falling behind before anyone else notices.
            </p>
          </Panel>
        </div>
      )}
    </div>
  )
}

/**
 * Table view.
 *
 * Not a fallback — an equal path to the same data. Charts encode with position
 * and colour; a screen reader gets neither.
 */
function TableView({ data }: { data: Payload | null }) {
  if (!data) return null

  return (
    <div className="overflow-x-auto rounded-lg border border-[#262b34]">
      <table className="w-full text-left text-xs tabular-nums">
        <thead className="bg-[#16191f] text-[#898781]">
          <tr>
            {['time', 'calls', 'errors', 'cancelled', 'p50', 'p95', 'p99', 'ttft p95', 'cost'].map(
              (h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody className="text-[#c3c2b7]">
          {data.series.map((s) => (
            <tr key={s.bucket} className="border-t border-[#262b34]">
              <td className="px-3 py-1.5">{fmtClock(s.bucket)}</td>
              <td className="px-3 py-1.5">{s.calls}</td>
              <td className="px-3 py-1.5">{s.errors}</td>
              <td className="px-3 py-1.5">{s.cancelled}</td>
              <td className="px-3 py-1.5">{fmtMs(s.p50)}</td>
              <td className="px-3 py-1.5">{fmtMs(s.p95)}</td>
              <td className="px-3 py-1.5">{fmtMs(s.p99)}</td>
              <td className="px-3 py-1.5">{fmtMs(s.ttftP95)}</td>
              <td className="px-3 py-1.5">{fmtUsd(s.costUsd)}</td>
            </tr>
          ))}
          {data.series.length === 0 && (
            <tr>
              <td colSpan={9} className="px-3 py-8 text-center text-[#898781]">
                No data in this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
