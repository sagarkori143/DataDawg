'use client'

import type { ReactNode } from 'react'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHART PRIMITIVES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Palette slots are validated against this app's actual dark surface
 * (#16191f), not against a generic one — contrast and CVD results are only
 * meaningful against the surface the chart really renders on.
 *
 *   categorical (blue/orange/aqua)  all-pairs CVD ΔE 9.4, normal-vision 20.9
 *   latency ramp (one hue, ordinal) monotone L, light end 3.26:1
 *
 * Percentiles use a single-hue ordinal ramp rather than three categorical hues,
 * because p50/p95/p99 are the same measurement at increasing severity — not
 * three unrelated things. Brightest is assigned to p99 so the number that
 * matters most is the one that draws the eye on a dark surface.
 */

export const VIZ = {
  surface: '#16191f',
  grid: '#2c2c2a',
  axis: '#383835',
  muted: '#898781',
  textSecondary: '#c3c2b7',

  series: ['#3987e5', '#d95926', '#199e70'] as const,

  latency: { p50: '#256abf', p95: '#3987e5', p99: '#86b6ef' } as const,

  // Reserved. Never reused as "series 4", and never carries meaning alone —
  // every use below is paired with a visible label.
  status: { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' } as const,
} as const

export function Panel({
  title,
  hint,
  right,
  children,
}: {
  title: string
  hint?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-[#262b34] bg-[#16191f] p-4">
      <header className="mb-3 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <h2 className="text-[13px] font-medium tracking-tight text-[#e8eaed]">{title}</h2>
          {hint && <span className="text-[11px] text-[#898781]">{hint}</span>}
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
}: {
  label: string
  value: string | number
  unit?: string
  tone?: 'critical' | 'warning' | 'good'
  note?: string
}) {
  const color = tone ? VIZ.status[tone] : '#e8eaed'

  return (
    <div className="rounded-lg border border-[#262b34] bg-[#16191f] px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-[#898781]">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-2xl leading-none" style={{ color }}>
          {value}
        </span>
        {unit && <span className="text-[11px] text-[#898781]">{unit}</span>}
      </div>
      {note && <div className="mt-1 text-[11px] text-[#898781]">{note}</div>}
    </div>
  )
}

/**
 * Legend.
 *
 * Always present for two or more series, so identity is never carried by colour
 * alone — that is the difference between a chart a colourblind reader can use
 * and one they cannot.
 */
export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-[11px] text-[#c3c2b7]">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: i.color }}
          />
          {i.label}
        </span>
      ))}
    </div>
  )
}

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
