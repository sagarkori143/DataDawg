import type { Metadata } from 'next'
import { Inter, Space_Grotesk } from 'next/font/google'
import './globals.css'

/**
 * Two families, each with a job.
 *
 *   Space Grotesk — headings and every metric. Wide, flat-sided, slightly
 *                   mechanical numerals: right for telemetry, and instantly
 *                   not-Inter.
 *   Inter         — body copy and dense UI, where Space Grotesk's character
 *                   would fight the reading.
 *
 * `display: 'swap'` so a slow font fetch never blanks the numbers — the
 * fallback paints first and swaps when the file lands.
 */
const display = Space_Grotesk({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-display',
  display: 'swap',
})

const body = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'DataDawg — observability',
  description: 'Latency, throughput, errors and cost for every model call.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="h-full font-(family-name:--font-body)">
        {/* Fixed, behind everything, non-interactive. */}
        <div className="ambient" aria-hidden />
        <div className="grain" aria-hidden />
        <div className="relative z-10 min-h-full">{children}</div>
      </body>
    </html>
  )
}
