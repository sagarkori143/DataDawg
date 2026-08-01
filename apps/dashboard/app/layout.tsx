import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ollive — dashboards',
  description: 'Latency, throughput, errors and cost for every model call.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  )
}
