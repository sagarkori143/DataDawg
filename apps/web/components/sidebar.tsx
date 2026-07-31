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

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-[#262b34]">
      <div className="border-b border-[#262b34] p-3">
        <button
          onClick={onNew}
          className="w-full rounded-lg border border-[#262b34] px-3 py-2 text-xs text-[#c3c2b7] hover:border-[#7dd3a0]/40 hover:text-[#7dd3a0]"
        >
          + new conversation
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 && (
          <p className="px-3 py-6 text-center text-[11px] text-[#898781]">No conversations yet.</p>
        )}

        {rows.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelect(c.id)}
            className={`group flex w-full flex-col gap-0.5 border-b border-[#1b1f26] px-3 py-2.5 text-left hover:bg-[#16191f] ${
              activeId === c.id ? 'bg-[#16191f]' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="line-clamp-2 text-xs leading-snug text-[#e8eaed]">
                {c.title ?? 'Untitled'}
              </span>
              <span
                onClick={(e) => void archive(c.id, e)}
                role="button"
                tabIndex={0}
                aria-label="Archive conversation"
                className="shrink-0 text-[11px] text-[#898781] opacity-0 transition group-hover:opacity-100 hover:text-[#f0776c]"
              >
                {busy === c.id ? '…' : '×'}
              </span>
            </div>
            <span className="text-[10px] tabular-nums text-[#898781]">
              {c.messageCount} msg
              {c.lastMessageAt &&
                ` · ${new Date(c.lastMessageAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}
