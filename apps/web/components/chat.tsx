'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from './markdown'
import { ModelPicker } from './model-picker'
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
  const [sidebarOpen, setSidebarOpen] = useState(false)
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
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  /**
   * Grow the composer with its content, up to a ceiling.
   *
   * Layout effect, not effect: measuring after paint makes the box visibly
   * jump a frame behind the text. Height is reset to `auto` first because
   * scrollHeight never shrinks below the current height.
   */
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [input])

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
        json.messages.map(
          (m: { id: string; role: string; content: string; isComplete: boolean }) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            partial: !m.isComplete,
          }),
        ),
      )
      setSidebarOpen(false)
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
    setSidebarOpen(false)
  }, [])

  /**
   * Nothing has come back yet.
   *
   * Two states qualify, and missing the first one is what made the indicator
   * arrive late: between pressing Enter and the server's `meta` frame there is
   * no assistant row at all, only the user's message. That gap is a network
   * round trip — the most likely moment for the user to wonder whether the
   * send worked — so it is exactly when the indicator must already be visible.
   */
  const last = messages[messages.length - 1]
  const awaitingFirstToken =
    streaming &&
    (last?.role === 'user' ||
      (last?.role === 'assistant' && last.content.length === 0 && !last.error))

  return (
    <div className="flex h-full">
      {/* Off-canvas below lg, fixed rail above it. */}
      <div
        className={`fixed inset-y-0 left-0 z-40 transition-transform lg:static lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <Sidebar
          activeId={conversationId}
          onSelect={(id) => void resume(id)}
          onNew={newConversation}
          refreshKey={refreshKey}
        />
      </div>

      {sidebarOpen && (
        <button
          aria-label="Close conversation list"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Header ──────────────────────────────────────────────────── */}
        <header className="flex shrink-0 items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSidebarOpen(true)}
              aria-label="Open conversation list"
              className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-surface hover:text-text lg:hidden"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path
                  d="M2 4h12M2 8h12M2 12h12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>

            <span className="text-[15px] font-semibold tracking-tight">
              Data<span className="text-clay">Dawg</span>
            </span>

            {process.env.NEXT_PUBLIC_DASHBOARD_URL && (
              <a
                href={process.env.NEXT_PUBLIC_DASHBOARD_URL}
                className="hidden rounded-lg px-2 py-1 text-xs text-faint transition-colors hover:text-text sm:inline"
              >
                dashboard →
              </a>
            )}
          </div>

          {meta && meta.droppedTurns > 0 && (
            <span
              title="Older turns evicted to stay within the context budget"
              className="rounded-full border border-line px-2.5 py-1 text-[11px] text-faint"
            >
              {meta.droppedTurns} turn{meta.droppedTurns === 1 ? '' : 's'} dropped
            </span>
          )}
        </header>

        {/* ── Transcript ──────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 pb-10 sm:px-6">
            {messages.length === 0 ? (
              <Welcome />
            ) : (
              <div className="flex flex-col gap-7 pt-6">
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <div key={m.id} className="msg-in flex justify-end">
                      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px] leading-relaxed">
                        {m.content}
                      </div>
                    </div>
                  ) : (
                    /* No bubble on the assistant. The answer is the page, not a
                       message in a container — which is what makes long replies
                       readable instead of a wall inside a box. */
                    <div key={m.id} className="msg-in flex flex-col gap-2">
                      <div className="text-[15px] leading-[1.75] text-text">
                        <Markdown>{m.content}</Markdown>
                        {streaming && !m.error && m.content.length > 0 && (
                          <span className="caret -mt-1 inline-block" aria-hidden />
                        )}
                      </div>

                      {m.error && (
                        <div className="rounded-xl border border-danger/25 bg-danger/5 px-3.5 py-2.5 text-[13px] text-danger">
                          {m.error}
                        </div>
                      )}
                      {m.partial && !m.error && m.content.length > 0 && (
                        <span className="text-xs text-faint">stopped — partial response saved</span>
                      )}
                    </div>
                  ),
                )}

                {awaitingFirstToken && (
                  <div className="flex items-center gap-1.5 pl-0.5" aria-label="Waiting for response">
                    {[0, 1, 2].map((i) => (
                      <span key={i} className="dot h-1.5 w-1.5 rounded-full bg-clay" />
                    ))}
                  </div>
                )}
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* ── Composer ────────────────────────────────────────────────── */}
        <div className="shrink-0 px-4 pb-4 sm:px-6 sm:pb-6">
          <div className="mx-auto w-full max-w-3xl">
            <div className="rounded-2xl border border-line bg-surface shadow-[0_8px_28px_-16px_rgba(0,0,0,0.8)] transition-colors focus-within:border-clay/45">
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={1}
                placeholder="Ask anything…"
                className="max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-faint"
              />

              {/* Controls sit inside the box, below the text — so the model in
                  use is visible at the moment of sending rather than parked in
                  a header nobody looks at. */}
              <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
                <ModelPicker
                  options={providers.flatMap((p) =>
                    p.models.map((m) => ({ provider: p.name, model: m })),
                  )}
                  value={choice}
                  onChange={setChoice}
                  disabled={streaming}
                />

                <span className="ml-auto hidden text-[11px] text-faint sm:inline">
                  {streaming ? 'streaming…' : 'Enter to send · Shift+Enter for newline'}
                </span>

                {streaming ? (
                  <button
                    onClick={stop}
                    aria-label="Stop generating"
                    className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:border-danger/50 hover:text-danger"
                  >
                    <span className="block h-2.5 w-2.5 rounded-xs bg-current" />
                  </button>
                ) : (
                  <button
                    onClick={() => void send()}
                    disabled={!input.trim()}
                    aria-label="Send message"
                    className="flex h-8 w-8 items-center justify-center rounded-lg bg-clay text-canvas transition-opacity disabled:opacity-25"
                  >
                    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                      <path
                        d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5"
                        stroke="currentColor"
                        strokeWidth="1.7"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Empty state.
 *
 * A serif greeting rather than a grid of suggestion cards. The cards are a
 * product decision this project has not earned: they imply curated prompts,
 * and there are none.
 */
function Welcome() {
  return (
    <div className="flex min-h-[52vh] flex-col items-center justify-center text-center">
      <h1 className="font-serif text-4xl font-normal tracking-tight text-text sm:text-[42px]">
        What can I help with?
      </h1>
      <p className="mt-3.5 max-w-md text-sm leading-relaxed text-faint">
        Ask anything. Behind the scenes every call is instrumented — latency, time to first token,
        tokens, cost and errors land in the dashboard without slowing this down.
      </p>
    </div>
  )
}
