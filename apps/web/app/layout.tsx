import type { Metadata } from 'next'
import { Inter, Newsreader } from 'next/font/google'
import './globals.css'

/**
 * Inter for everything you interact with, a serif for the one thing you only
 * read — the empty-state greeting.
 *
 * The serif is doing real work rather than decoration: it marks the greeting
 * as prose instead of UI, which is why the blank screen reads as an invitation
 * rather than an empty container.
 */
const body = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

const serif = Newsreader({
  subsets: ['latin'],
  weight: ['400'],
  style: ['normal', 'italic'],
  variable: '--font-serif',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'DataDawg — chat',
  description: 'A chatbot and the observability pipeline watching it.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${serif.variable}`}>
      <body className="h-full font-(family-name:--font-body)">{children}</body>
    </html>
  )
}
