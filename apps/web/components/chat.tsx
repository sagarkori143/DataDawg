'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Sidebar } from './sidebar'

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** Stream ended early — cancelled or errored. Rendered so a partial answer is never mistaken for a whole one. */
  partial?: boolean
  error?: string
}

interface Meta {
  conversationId: string
  messageId: string
  provider: string
  model: string
  droppedTurns: number
}

export function Chat() {
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [providers, setProviders] = useState<
    { name: string; models: string[]; defaultModel: string }[]
  >([])
  const [choice, setChoice] = useState<{ provider: string; model: string } | null>(null)

  // Offer exactly what this deployment is keyed for, rather than a hardcoded
  // list that lies when a key is missing.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch('/api/providers')
        const json = await res.json()
        setProviders(json.providers)
        const first = json.providers[0]
        if (first) setChoice({ provider: first.name, model: first.defaultModel })
      } catch {
        /* the chat still works on the server default */
      }
    })()
  }, [])

  /**
   * Held in a ref, not state.
   *
   * The Stop button must abort the request that is running *right now*. A
   * state value captured in a closure can be one render stale, which would
   * abort nothing while the stream carried on — the exact bug that makes a
   * cancel button look broken.
   */
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
  }, [])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    setInput('')
    setStreaming(true)

    // Render the user's message immediately rather than waiting for the server
    // to confirm it. The id is provisional and replaced by the server's.
    const localUserId = `local-${Date.now()}`
    setMessages((m) => [...m, { id: localUserId, role: 'user', content: text }])

    const controller = new AbortController()
    abortRef.current = controller

    let assistantId: string | null = null

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: text, ...(choice ?? {}) }),
        signal: controller.signal,
      })

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: res.statusText }))
        throw new Error(err.error ?? 'Request failed')
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE frames are separated by a blank line. A chunk can split a frame
        // mid-way, so anything after the last separator stays buffered until
        // the rest of it arrives — otherwise long tokens arrive as broken JSON.
        const frames = buffer.split('\n\n')
        buffer = frames.pop() ?? ''

        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue

          const event = JSON.parse(line.slice(6))

          if (event.type === 'meta') {
            assistantId = event.messageId
            setConversationId(event.conversationId)
            setMeta(event)
            setMessages((m) => [
              ...m.map((x) => (x.id === localUserId ? { ...x, id: event.userMessageId } : x)),
              { id: event.messageId, role: 'assistant' as const, content: '' },
            ])
          } else if (event.type === 'text') {
            setMessages((m) =>
              m.map((x) => (x.id === assistantId ? { ...x, content: x.content + event.text } : x)),
            )
          } else if (event.type === 'error') {
            setMessages((m) =>
              m.map((x) =>
                x.id === assistantId ? { ...x, error: event.message, partial: true } : x,
              ),
            )
          }
        }
      }
    } catch (err) {
      const aborted = err instanceof DOMException && err.name === 'AbortError'

      setMessages((m) =>
        m.map((x) =>
          x.id === assistantId
            ? { ...x, partial: true, error: aborted ? undefined : (err as Error).message }
            : x,
        ),
      )

      // A non-abort failure before the stream opened leaves no assistant row to
      // attach the error to, so add one rather than failing silently.
      if (!aborted && !assistantId) {
        setMessages((m) => [
          ...m,
          {
            id: `err-${Date.now()}`,
            role: 'assistant',
            content: '',
            error: (err as Error).message,
            partial: true,
          },
        ])
      }
    } finally {
      abortRef.current = null
      setStreaming(false)
      // Re-sort the sidebar: this conversation is now the most recent, and its
      // message count changed.
      setRefreshKey((k) => k + 1)
    }
  }, [input, streaming, conversationId, choice])

  /**
   * Resume a conversation.
   *
   * Aborts anything in flight first — switching conversations mid-stream would
   * otherwise keep appending the old answer into the newly loaded thread.
   */
  const resume = useCallback(async (id: string) => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)

    try {
      const res = await fetch(`/api/conversations/${id}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error)

      setConversationId(id)
      setMessages(
        json.messages.map((m: { id: string; role: string; content: string; isComplete: boolean }) => ({
          id: m.id,
          role: m.role as 'user' | 'assistant',
          content: m.content,
          partial: !m.isComplete,
        })),
      )
    } catch {
      /* leave the current view alone rather than blanking it on a failed load */
    }
  }, [])

  const newConversation = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setConversationId(null)
    setMessages([])
    setMeta(null)
  }, [])

  return (
    <div className="flex h-full">
      <Sidebar
        activeId={conversationId}
        onSelect={(id) => void resume(id)}
        onNew={newConversation}
        refreshKey={refreshKey}
      />
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-[--color-edge] px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-tight">Ollive</span>
          {process.env.NEXT_PUBLIC_DASHBOARD_URL && (
            <a
              href={process.env.NEXT_PUBLIC_DASHBOARD_URL}
              className="text-xs text-[--color-muted] underline-offset-2 hover:underline"
            >
              dashboards →
            </a>
          )}
        </div>
        <div className="flex items-center gap-3">
          {providers.length > 0 && (
            <select
              value={choice ? `${choice.provider}:${choice.model}` : ''}
              onChange={(e) => {
                const [provider, model] = e.target.value.split(':')
                if (provider && model) setChoice({ provider, model })
              }}
              disabled={streaming}
              className="rounded-md border border-[--color-edge] bg-[--color-panel] px-2 py-1 font-mono text-[11px] text-[--color-muted] outline-none disabled:opacity-40"
            >
              {providers.flatMap((p) =>
                p.models.map((m) => (
                  <option key={`${p.name}:${m}`} value={`${p.name}:${m}`}>
                    {p.name} / {m}
                  </option>
                )),
              )}
            </select>
          )}
        {meta && (
          <div className="flex items-center gap-3 font-mono text-[11px] text-[--color-muted]">
            {meta.droppedTurns > 0 && (
              <span title="Older turns evicted to stay within the context budget">
                · {meta.droppedTurns} turn{meta.droppedTurns === 1 ? '' : 's'} dropped
              </span>
            )}
          </div>
        )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
          {messages.length === 0 && (
            <div className="mt-24 text-center text-sm text-[--color-muted]">
              Send a message. Every call is timed, measured, and shipped to the
              ingestion pipeline out of band.
            </div>
          )}

          {messages.map((m) => (
            <div key={m.id} className="flex flex-col gap-1.5">
              <span className="font-mono text-[11px] uppercase tracking-wider text-[--color-muted]">
                {m.role}
              </span>
              <div
                className={
                  m.role === 'user'
                    ? 'whitespace-pre-wrap rounded-lg bg-[--color-panel] px-4 py-3 text-sm leading-relaxed'
                    : 'whitespace-pre-wrap px-1 text-sm leading-relaxed'
                }
              >
                {m.content}
                {streaming && m.role === 'assistant' && !m.error && (
                  <span className="caret" aria-hidden />
                )}
              </div>

              {m.error && (
                <div className="rounded border border-[--color-danger]/30 bg-[--color-danger]/5 px-3 py-2 text-xs text-[--color-danger]">
                  {m.error}
                </div>
              )}
              {m.partial && !m.error && m.content.length > 0 && (
                <span className="text-[11px] text-[--color-muted]">
                  stopped — partial response saved
                </span>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="border-t border-[--color-edge] px-6 py-4">
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder="Ask something…  (Enter to send, Shift+Enter for newline)"
            className="flex-1 resize-none rounded-lg border border-[--color-edge] bg-[--color-panel] px-4 py-3 text-sm outline-none placeholder:text-[--color-muted] focus:border-[--color-accent]/50"
          />
          {streaming ? (
            <button
              onClick={stop}
              className="rounded-lg border border-[--color-danger]/40 px-5 text-sm text-[--color-danger] hover:bg-[--color-danger]/10"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!input.trim()}
              className="rounded-lg bg-[--color-accent] px-5 text-sm font-medium text-[--color-ink] disabled:opacity-30"
            >
              Send
            </button>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
