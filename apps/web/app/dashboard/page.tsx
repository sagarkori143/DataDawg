import { Dashboard } from '@/components/dashboard'

export const metadata = { title: 'Ollive — dashboards' }

export default function Page() {
  return (
    <div className="min-h-full">
      <header className="border-b border-[#262b34] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">Ollive</span>
          <span className="text-xs text-[#898781]">latency · throughput · errors · cost</span>
        </div>
      </header>
      <Dashboard />
    </div>
  )
}
