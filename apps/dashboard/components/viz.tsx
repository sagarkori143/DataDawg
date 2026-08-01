'use client'

import type { ReactNode } from 'react'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHART PRIMITIVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Palette slots are validated against this app's actual dark surface, not a
 * generic one — contrast and CVD results are only meaningful against the
 * surface the chart really renders on.
 *
 *   categorical (blue/orange/aqua)  all-pairs CVD ΔE 9.4, normal-vision 20.9
 *   latency ramp (one hue, ordinal) monotone L, light end 3.26:1
 *
 * Percentiles use a single-hue ordinal ramp rather than three categorical hues,
 * because p50/p95/p99 are the same measurement at increasing severity — not
 * three unrelated things. Brightest is assigned to p99 so the number that
 * matters most draws the eye on a dark surface.
 *
 * These values survived the visual redesign untouched. The chrome around them
 * changed completely; the data colours did not, because the numbers above are
 * the reason they were chosen and restyling would invalidate them.
 */

export const VIZ = {
  surface: 'rgba(255,255,255,0.03)',
  grid: 'rgba(255,255,255,0.055)',
  axis: 'rgba(255,255,255,0.10)',
  muted: '#6b7280',
  textSecondary: '#9aa1b1',

  /** Brand accent. Chrome only — never used to encode a data series. */
  volt: '#ccff4d',

  series: ['#5b9cf8', '#f2803c', '#2bbd8a'] as const,

  latency: { p50: '#2f6fd0', p95: '#5b9cf8', p99: '#a8caff' } as const,

  // Reserved. Never reused as "series 4", and never carries meaning alone —
  // every use is paired with a visible label.
  status: { good: '#2bbd8a', warning: '#ffc53d', serious: '#f2803c', critical: '#ff6b6b' } as const,
} as const

/* ────────────────────────────────────────────────────────────────────────── */

export function Panel({
  title,
  hint,
  right,
  children,
  className = '',
  delay = 0,
}: {
  title: string
  hint?: string
  right?: ReactNode
  children: ReactNode
  className?: string
  /** Staggers the entrance so panels cascade rather than snapping in together. */
  delay?: number
}) {
  return (
    <section
      className={`glass glass-lit glass-hover rise rounded-2xl p-5 ${className}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      <header className="mb-4 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className="font-(family-name:--font-display) text-[13px] font-semibold tracking-tight text-text">
            {title}
          </h2>
          {hint && <span className="text-[11px] text-faint">{hint}</span>}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

/**
 * A stat tile — a number that needs no plot.
 *
 * Not every measure deserves a chart. "Total cost over the window" is one
 * number; drawing it as a one-bar chart adds axes and gridlines to communicate
 * strictly less than the digits do.
 */
export function Stat({
  label,
  value,
  unit,
  tone,
  note,
  delay = 0,
  compact = false,
}: {
  label: string
  value: string | number
  unit?: string
  tone?: 'critical' | 'warning' | 'good'
  note?: string
  delay?: number
  compact?: boolean
}) {
  const color = tone ? VIZ.status[tone] : '#edeef2'
  const pending = value === '—' || value === undefined

  return (
    <div
      className={`glass glass-hover rise rounded-2xl ${compact ? 'px-4 py-3' : 'px-5 py-4'}`}
      style={delay ? { animationDelay: `${delay}ms` } : undefined}
    >
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-faint">
        {label}
      </div>

      <div className="mt-2 flex items-baseline gap-1.5">
        {pending ? (
          <span className="skeleton mt-1 block h-7 w-20 rounded-md" aria-hidden />
        ) : (
          <span
            className={`font-(family-name:--font-display) font-semibold leading-none tracking-tight ${
              compact ? 'text-xl' : 'text-[27px]'
            }`}
            style={{ color }}
          >
            {value}
          </span>
        )}
        {unit && !pending && <span className="text-[11px] text-faint">{unit}</span>}
      </div>

      {note && <div className="mt-1.5 text-[11px] leading-snug text-faint">{note}</div>}
    </div>
  )
}

/**
 * Legend.
 *
 * Always present for two or more series, so identity is never carried by
 * colour alone — that is the difference between a chart a colourblind reader
 * can use and one they cannot.
 */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-[11px] text-dim">
          <span
            aria-hidden
            className="inline-block h-1.5 w-4 rounded-full"
            style={{ background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  )
}

/**
 * Tooltip.
 *
 * Hand-rolled rather than Recharts' default, which cannot be made to match a
 * glass surface — it renders an opaque box with its own border radius and
 * padding scale, and reads as a component borrowed from another product.
 */
export function ChartTip({
  active,
  payload,
  label,
  labelFormat,
  valueFormat,
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: number | string; color?: string; dataKey?: string }>
  label?: string | number
  labelFormat?: (l: string) => string
  valueFormat?: (v: number) => string
}) {
  if (!active || !payload?.length) return null

  return (
    <div className="glass rounded-xl px-3 py-2 text-[11px] shadow-2xl">
      {label !== undefined && (
        <div className="mb-1.5 font-(family-name:--font-display) text-[10px] uppercase tracking-wider text-faint">
          {labelFormat ? labelFormat(String(label)) : String(label)}
        </div>
      )}
      <div className="flex flex-col gap-1">
        {payload.map((p, i) => (
          <div key={`${p.dataKey ?? p.name ?? i}`} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-1.5 w-3 shrink-0 rounded-full"
              style={{ background: p.color }}
            />
            <span className="text-dim">{p.name ?? p.dataKey}</span>
            <span className="ml-auto font-(family-name:--font-display) font-medium text-text">
              {valueFormat && typeof p.value === 'number' ? valueFormat(p.value) : String(p.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Segmented control — the range picker and any other small exclusive choice. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
  label: string
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="glass flex rounded-xl p-1"
    >
      {options.map((o) => {
        const on = o === value
        return (
          <button
            key={o}
            onClick={() => onChange(o)}
            aria-pressed={on}
            className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
              on
                ? 'bg-volt text-void'
                : 'text-dim hover:bg-white/5 hover:text-text'
            }`}
          >
            {o}
          </button>
        )
      })}
    </div>
  )
}

/* ── Formatters ─────────────────────────────────────────────────────────── */

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`
}

export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—'
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return String(v)
}

export function fmtUsd(v: string | number | null | undefined): string {
  const n = typeof v === 'string' ? Number.parseFloat(v) : (v ?? 0)
  if (!Number.isFinite(n)) return '$0'
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(5)}`
  return `$${n.toFixed(4)}`
}

export function fmtClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
