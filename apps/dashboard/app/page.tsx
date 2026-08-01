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
      {/* Sticky, so identity and the escape hatch survive a long scroll. Blur
          without a solid fill: content passing underneath stays faintly
          visible, which reads as glass rather than as a lid. */}
      <header className="sticky top-0 z-30 border-b border-white/6 bg-void/60 backdrop-blur-xl">
        <div className="mx-auto flex max-w-370 items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
          <div className="flex items-baseline gap-3">
            <span className="font-(family-name:--font-display) text-[15px] font-bold tracking-tight text-text">
              Data<span className="text-volt">Dawg</span>
            </span>
            <span className="hidden text-[11px] text-faint sm:inline">
              latency · throughput · errors · cost
            </span>
          </div>

          {chatUrl && (
            <a
              href={chatUrl}
              className="rounded-lg px-2 py-1 text-[11px] font-medium text-faint transition-colors hover:text-text"
            >
              ← chat
            </a>
          )}
        </div>
      </header>

      <Dashboard />
    </div>
  )
}
