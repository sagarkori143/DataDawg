'use client'

import { useCallback, useEffect, useState } from 'react'

export interface ConversationRow {
  id: string
  title: string | null
  status: string
  messageCount: number
  lastMessageAt: string | null
  createdAt: string
}

/**
 * Conversation list — the "list" and "resume" halves of the frontend bonus.
 *
 * Reads only the `conversations` table. `messageCount` is maintained by a
 * trigger, so rendering N rows costs one index scan rather than N counts — the
 * denormalisation earning its keep.
 */
export function Sidebar({
  activeId,
  onSelect,
  onNew,
  refreshKey,
}: {
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  /** Bumped by the parent after a turn completes, so the list re-sorts. */
  refreshKey: number
}) {
  const [rows, setRows] = useState<ConversationRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations?limit=50')
      const json = await res.json()
      if (res.ok) setRows(json.conversations)
    } catch {
      // A sidebar that fails to load must not take the chat down with it.
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const archive = useCallback(
    async (id: string, e: React.MouseEvent) => {
      e.stopPropagation()
      setBusy(id)
      try {
        await fetch(`/api/conversations/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'archived' }),
        })
        await load()
      } finally {
        setBusy(null)
      }
    },
    [load],
  )

  const groups = groupByAge(rows)

  return (
    <aside className="flex h-full w-67 shrink-0 flex-col border-r border-line bg-surface">
      <div className="p-3">
        <button
          onClick={onNew}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium text-text transition-colors hover:bg-raised"
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden className="text-clay">
            <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          New chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {rows.length === 0 && (
          <p className="px-3 py-8 text-center text-xs leading-relaxed text-faint">
            No conversations yet.
          </p>
        )}

        {groups.map(([heading, items]) => (
          <div key={heading} className="mb-3">
            <div className="px-3 pb-1.5 pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-faint">
              {heading}
            </div>

            {items.map((c) => (
              <div
                key={c.id}
                className={`group relative flex items-center rounded-xl transition-colors ${
                  activeId === c.id ? 'bg-raised' : 'hover:bg-raised/60'
                }`}
              >
                <button
                  onClick={() => onSelect(c.id)}
                  className="min-w-0 flex-1 px-3 py-2 text-left"
                >
                  <span className="block truncate text-[13px] leading-snug text-text">
                    {c.title ?? 'Untitled'}
                  </span>
                  <span className="mt-0.5 block text-[11px] tabular-nums text-faint">
                    {c.messageCount} msg
                    {c.lastMessageAt &&
                      ` · ${new Date(c.lastMessageAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`}
                  </span>
                </button>

                {/* A real button, not a click handler on a span — archive must
                    be reachable by keyboard, and focus alone reveals it. */}
                <button
                  onClick={(e) => void archive(c.id, e)}
                  aria-label={`Archive ${c.title ?? 'conversation'}`}
                  className="mr-1.5 shrink-0 rounded-lg p-1.5 text-faint opacity-0 transition hover:bg-canvas hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                >
                  {busy === c.id ? (
                    <span className="block h-3 w-3 animate-pulse rounded-full bg-current" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                      <path
                        d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  )}
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  )
}

/**
 * Group by recency.
 *
 * A flat list of fifty identical rows is hard to scan; "Today / Yesterday /
 * Earlier" gives the eye somewhere to land. Rows arrive already sorted by
 * `last_message_at DESC`, so this only has to partition — no re-sorting, and
 * the index does the ordering work.
 */
function groupByAge(rows: ConversationRow[]): Array<[string, ConversationRow[]]> {
  const now = Date.now()
  const DAY = 86_400_000
  const buckets: Record<string, ConversationRow[]> = { Today: [], Yesterday: [], Earlier: [] }

  for (const r of rows) {
    const at = r.lastMessageAt ?? r.createdAt
    const age = now - new Date(at).getTime()
    const key = age < DAY ? 'Today' : age < 2 * DAY ? 'Yesterday' : 'Earlier'
    buckets[key]!.push(r)
  }

  return Object.entries(buckets).filter(([, v]) => v.length > 0)
}
