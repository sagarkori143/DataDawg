import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ollive — inference logging',
  description: 'A chatbot and the observability pipeline watching it.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  )
}
