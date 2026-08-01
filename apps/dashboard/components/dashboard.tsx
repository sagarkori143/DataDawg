'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ChartTip,
  Legend,
  Panel,
  Segmented,
  Stat,
  VIZ,
  fmtClock,
  fmtMs,
  fmtNum,
  fmtUsd,
} from './viz'

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

const cursor = { stroke: 'rgba(255,255,255,0.18)', strokeWidth: 1, strokeDasharray: '3 3' }

export function Dashboard() {
  const [range, setRange] = useState<(typeof RANGES)[number]>('1h')
  const [model, setModel] = useState<string>('')
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showTable, setShowTable] = useState(false)
  /** Flashes the live dot on each successful poll, so "live" is observable. */
  const [tick, setTick] = useState(0)

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ range, ...(model ? { model } : {}) })
      // When DASHBOARD_TOKEN is set the API requires a bearer token. Kept in
      // localStorage rather than a cookie because there is no session here —
      // it is a shared secret for a read-only view, not an identity.
      const token = typeof window !== 'undefined' ? localStorage.getItem('datadawg.token') : null
      const res = await fetch(`/api/metrics?${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      if (res.status === 401) {
        const entered = typeof window !== 'undefined' ? window.prompt('Dashboard token:') : null
        if (entered) {
          localStorage.setItem('datadawg.token', entered)
          return load()
        }
        throw new Error('unauthorized — set DASHBOARD_TOKEN or clear it to run open')
      }
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'failed to load metrics')
      setData(json)
      setError(null)
      setTick((t) => t + 1)
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
    <div className="mx-auto max-w-370 px-5 pb-16 pt-5 sm:px-8">
      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-2.5">
        <Segmented options={RANGES} value={range} onChange={setRange} label="Time range" />

        <div className="glass relative rounded-xl">
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Filter by model"
            className="cursor-pointer appearance-none rounded-xl bg-transparent py-2 pl-3.5 pr-9 text-[11px] font-medium text-dim outline-none hover:text-text"
          >
            <option value="" className="bg-ink">
              all models
            </option>
            {data?.models.map((m) => (
              <option key={m} value={m} className="bg-ink">
                {m}
              </option>
            ))}
          </select>
          <span
            aria-hidden
            className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[9px] text-faint"
          >
            ▼
          </span>
        </div>

        <button
          onClick={() => setShowTable((v) => !v)}
          className="glass glass-hover rounded-xl px-3.5 py-2 text-[11px] font-medium text-dim hover:text-text"
        >
          {showTable ? '◫ charts' : '▤ table'}
        </button>

        {/* Live indicator. The key on the dot restarts its transition each
            poll, so a stalled fetch is visible as a dot that stops flashing. */}
        <div className="glass ml-auto flex items-center gap-2 rounded-xl px-3.5 py-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="pulse-ring absolute inset-0" aria-hidden />
            <span key={tick} className="relative h-1.5 w-1.5 rounded-full bg-volt" />
          </span>
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
            live · 10s
          </span>
        </div>
      </div>

      {error && (
        <div className="glass mb-5 rounded-2xl border-danger/25 px-4 py-3 text-xs text-danger">
          {error}
        </div>
      )}

      {/* ── Headline numbers ───────────────────────────────────────────── */}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="calls"
          value={fmtNum(t?.calls)}
          note={`${t?.callsPerMin ?? 0}/min`}
          delay={0}
        />
        <Stat label="p95 latency" value={fmtMs(t?.p95)} note={`p50 ${fmtMs(t?.p50)}`} delay={40} />
        <Stat label="p95 ttft" value={fmtMs(t?.ttftP95)} note="time to first token" delay={80} />
        <Stat
          label="error rate"
          value={`${t?.errorRate ?? 0}%`}
          tone={hasErrors ? 'critical' : undefined}
          note={`${t?.errors ?? 0} failed · ${t?.cancelled ?? 0} cancelled`}
          delay={120}
        />
        <Stat
          label="tokens"
          value={fmtNum((t?.inputTokens ?? 0) + (t?.outputTokens ?? 0))}
          note={`${fmtNum(t?.inputTokens)} in · ${fmtNum(t?.outputTokens)} out`}
          delay={160}
        />
        <Stat
          label="cost"
          value={fmtUsd(t?.costUsd)}
          note="frozen at ingestion"
          delay={200}
        />
      </div>

      {showTable ? (
        <TableView data={data} />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {/* ── Latency percentiles ───────────────────────────────────── */}
          <Panel
            title="Latency"
            hint="p50 / p95 / p99"
            delay={240}
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
            <ResponsiveContainer width="100%" height={208}>
              <LineChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -14 }}>
                <CartesianGrid stroke={VIZ.grid} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={fmtClock} {...axis} minTickGap={44} />
                <YAxis tickFormatter={(v) => fmtMs(v)} {...axis} width={54} />
                <Tooltip
                  cursor={cursor}
                  content={<ChartTip labelFormat={fmtClock} valueFormat={fmtMs} />}
                />
                {/* 2px lines, markers only on hover — a dot on every point is
                    noise once there are more than a handful. */}
                {(['p50', 'p95', 'p99'] as const).map((k) => (
                  <Line
                    key={k}
                    type="monotone"
                    dataKey={k}
                    name={k}
                    stroke={VIZ.latency[k]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3.5, strokeWidth: 0 }}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>

            {data && data.rawPct.samples > 0 && (
              <p className="mt-3 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-faint">
                Rollup p95 <span className="text-dim">{fmtMs(t?.p95)}</span> · exact
                percentile_cont over {fmtNum(data.rawPct.samples)} raw rows{' '}
                <span className="text-dim">{fmtMs(data.rawPct.p95)}</span>. The gap is the accuracy
                cost of histogram buckets, which is what makes the rollup mergeable.
              </p>
            )}
          </Panel>

          {/* ── Throughput ────────────────────────────────────────────── */}
          <Panel title="Throughput" hint="calls per bucket" delay={280}>
            <ResponsiveContainer width="100%" height={208}>
              <AreaChart data={series} margin={{ top: 4, right: 8, bottom: 0, left: -14 }}>
                <defs>
                  <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={VIZ.series[0]} stopOpacity={0.42} />
                    <stop offset="100%" stopColor={VIZ.series[0]} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={VIZ.grid} vertical={false} />
                <XAxis dataKey="bucket" tickFormatter={fmtClock} {...axis} minTickGap={44} />
                <YAxis {...axis} width={42} allowDecimals={false} />
                <Tooltip cursor={cursor} content={<ChartTip labelFormat={fmtClock} />} />
                <Area
                  type="monotone"
                  dataKey="calls"
                  name="calls"
                  stroke={VIZ.series[0]}
                  strokeWidth={2}
                  fill="url(#callsFill)"
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </Panel>

          {/* ── Errors ────────────────────────────────────────────────── */}
          <Panel title="Errors" hint="by cause" delay={320}>
            {data && data.byErrorType.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-14 text-center">
                <span className="mb-2 inline-block h-1.5 w-8 rounded-full bg-[#2bbd8a]/50" />
                <p className="text-xs text-faint">No errors in this window.</p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {data?.byErrorType.map((e) => (
                  <div
                    key={e.errorType}
                    className="flex items-start gap-3 rounded-xl border border-white/6 bg-white/2 px-3.5 py-2.5 transition-colors hover:bg-white/4"
                  >
                    {/* Status colour never carries meaning alone — the label
                        beside it names the cause. */}
                    <span
                      aria-hidden
                      className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        background: VIZ.status.critical,
                        boxShadow: `0 0 10px ${VIZ.status.critical}80`,
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[11px] text-text">{e.errorType}</span>
                        <span className="shrink-0 text-[11px] text-faint">
                          <span className="text-dim">{e.count}</span> · {e.lastSeen}
                        </span>
                      </div>
                      {e.sample && (
                        <p className="mt-0.5 truncate text-[11px] text-faint">{e.sample}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* ── Cost by model ─────────────────────────────────────────── */}
          <Panel title="Cost by model" hint="frozen at ingestion with a pricing version" delay={360}>
            {data && data.byModel.length > 0 ? (
              <ResponsiveContainer width="100%" height={208}>
                <BarChart
                  data={data.byModel.map((m) => ({ ...m, cost: Number(m.costUsd) }))}
                  margin={{ top: 4, right: 12, bottom: 0, left: -12 }}
                  layout="vertical"
                >
                  <defs>
                    <linearGradient id="costFill" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor={VIZ.series[0]} stopOpacity={0.55} />
                      <stop offset="100%" stopColor={VIZ.series[0]} stopOpacity={1} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={VIZ.grid} horizontal={false} />
                  <XAxis type="number" tickFormatter={(v) => fmtUsd(v)} {...axis} />
                  <YAxis type="category" dataKey="model" {...axis} width={136} />
                  <Tooltip
                    cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                    content={<ChartTip valueFormat={(v) => fmtUsd(v)} />}
                  />
                  <Bar dataKey="cost" name="cost" radius={[0, 5, 5, 0]} barSize={16}>
                    {data.byModel.map((m) => (
                      <Cell key={m.model} fill="url(#costFill)" />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <p className="py-14 text-center text-xs text-faint">No traffic yet.</p>
            )}
          </Panel>

          {/* ── Pipeline health ───────────────────────────────────────── */}
          <Panel
            title="Pipeline health"
            hint="the telemetry system observing itself"
            className="lg:col-span-2"
            delay={400}
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
                compact
                label="ingest lag"
                value={fmtMs(data?.health.medianLagMs)}
                note={`max ${fmtMs(data?.health.maxLagMs)}`}
              />
              <Stat
                compact
                label="dlq"
                value={data?.health.dlqPending ?? 0}
                tone={(data?.health.dlqPending ?? 0) > 0 ? 'warning' : undefined}
                note="parked, replayable"
              />
              <Stat
                compact
                label="pii redacted"
                value={fmtNum(data?.health.redactionHits)}
                note="never reached the DB"
              />
              <Stat
                compact
                label="capture layer"
                value={Object.keys(data?.health.eventsByLayer ?? {}).join(' + ') || '—'}
                note="proxy / loader"
              />
            </div>
            <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-faint">
              Ingest lag is <span className="text-dim">ingested_at − client_ts</span> — the gap
              between the SDK observing a call and the server storing it. It exists only because
              the schema keeps both timestamps, and it is the number that says the pipeline is
              falling behind before anyone else notices.
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

  const cols = ['time', 'calls', 'errors', 'cancelled', 'p50', 'p95', 'p99', 'ttft p95', 'cost']

  return (
    <div className="glass rise overflow-x-auto rounded-2xl">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-white/8">
            {cols.map((h) => (
              <th
                key={h}
                className="px-4 py-3 text-[10px] font-medium uppercase tracking-[0.12em] text-faint"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-dim">
          {data.series.map((s) => (
            <tr key={s.bucket} className="border-b border-white/4 transition-colors hover:bg-white/3">
              <td className="px-4 py-2 text-text">{fmtClock(s.bucket)}</td>
              <td className="px-4 py-2">{s.calls}</td>
              <td className="px-4 py-2" style={s.errors > 0 ? { color: VIZ.status.critical } : undefined}>
                {s.errors}
              </td>
              <td className="px-4 py-2">{s.cancelled}</td>
              <td className="px-4 py-2">{fmtMs(s.p50)}</td>
              <td className="px-4 py-2">{fmtMs(s.p95)}</td>
              <td className="px-4 py-2">{fmtMs(s.p99)}</td>
              <td className="px-4 py-2">{fmtMs(s.ttftP95)}</td>
              <td className="px-4 py-2">{fmtUsd(s.costUsd)}</td>
            </tr>
          ))}
          {data.series.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-4 py-12 text-center text-faint">
                No data in this window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
