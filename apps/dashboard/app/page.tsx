import { Dashboard } from '@/components/dashboard'

/**
 * The dashboard lives at `/` here, not `/dashboard`.
 *
 * This app IS the dashboard — it has no other pages to disambiguate from, and
 * a host that serves one thing should serve it at the root.
 */
export default function Page() {
  const chatUrl = process.env.NEXT_PUBLIC_CHAT_URL

  return (
    <div className="min-h-full">
      <header className="flex items-center justify-between border-b border-[#262b34] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">Ollive</span>
          <span className="text-xs text-[#898781]">latency · throughput · errors · cost</span>
        </div>
        {chatUrl && (
          <a
            href={chatUrl}
            className="text-xs text-[#898781] underline-offset-2 hover:text-[#c3c2b7] hover:underline"
          >
            ← chat
          </a>
        )}
      </header>
      <Dashboard />
    </div>
  )
}
