import { chat } from '@ollive/db'
import { ProviderError, getAdapter, getRegistry } from '@ollive/providers'
import { buildContextWindow, deriveTitle } from '@/lib/context-window'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * POST /api/chat — streaming chat
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why SSE rather than WebSocket ───────────────────────────────────────────
 * Token streaming is strictly one-way: the server pushes, the client listens.
 * A WebSocket would add a second protocol, its own upgrade handshake, and its
 * own reconnect logic to buy a return channel nothing uses. SSE is plain HTTP,
 * so it passes through every proxy and CDN unchanged, and cancellation is just
 * closing the connection — which is exactly the signal we want.
 *
 * ── Why the assistant row is created before the stream starts ───────────────
 * So a cancelled or crashed stream still leaves a record of what the user saw.
 * An answer the user read half of is not the same as no answer at all, and the
 * telemetry row needs something to point at.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface ChatBody {
  conversationId?: string
  message: string
  model?: string
  provider?: string
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

export async function POST(req: Request): Promise<Response> {
  let body: ChatBody
  try {
    body = (await req.json()) as ChatBody
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.message?.trim()) {
    return Response.json({ error: 'message is required' }, { status: 400 })
  }

  const registry = getRegistry()
  if (registry.size === 0) {
    return Response.json(
      { error: 'No model provider configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.' },
      { status: 503 },
    )
  }

  const providerName = body.provider ?? [...registry.keys()][0]!
  let adapter
  try {
    adapter = getAdapter(providerName)
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 400 })
  }

  const model = body.model ?? adapter.defaultModel

  // ── Persist the turn before calling the model ────────────────────────────
  // Ordering matters: if the provider call fails, the user's message is still
  // saved and the conversation is resumable. Writing it after a successful
  // response would lose the message on every error.
  const conversation = body.conversationId
    ? await chat.getConversation(body.conversationId)
    : await chat.createConversation({})

  if (!conversation) {
    return Response.json({ error: 'Conversation not found' }, { status: 404 })
  }

  const history = await chat.getMessages(conversation.id)
  const userMessage = await chat.appendMessage({
    conversationId: conversation.id,
    role: 'user',
    content: body.message,
  })

  if (history.length === 0) {
    await chat.setTitleIfEmpty(conversation.id, deriveTitle(body.message))
  }

  const context = buildContextWindow([...history, userMessage])

  // Empty placeholder — filled in when the stream ends, however it ends.
  const assistantMessage = await chat.appendMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    isComplete: false,
  })

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let text = ''
      let closed = false

      const send = (data: unknown) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(sse(data)))
        } catch {
          // The client vanished between our check and the write. Nothing to do
          // and nothing worth logging — the abort path below handles cleanup.
          closed = true
        }
      }

      send({
        type: 'meta',
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        userMessageId: userMessage.id,
        provider: providerName,
        model,
        droppedTurns: context.droppedTurns,
      })

      try {
        for await (const chunk of adapter.stream({
          model,
          messages: context.messages,
          // Propagates the browser disconnect all the way to the vendor SDK, so
          // pressing Stop actually stops the upstream call rather than leaving
          // it running and billing with nobody listening.
          signal: req.signal,
        })) {
          if (chunk.type === 'text') {
            text += chunk.text
            send({ type: 'text', text: chunk.text })
          } else if (chunk.type === 'done') {
            send({ type: 'done', finishReason: chunk.finishReason })
          }
        }

        await chat.completeMessage({
          id: assistantMessage.id,
          content: text,
          isComplete: true,
        })
      } catch (err) {
        const aborted = req.signal.aborted

        // A cancellation is not a failure. The partial text the user already
        // read is saved and flagged incomplete, rather than being discarded or
        // recorded as an error — both of which would misrepresent what happened.
        await chat.completeMessage({
          id: assistantMessage.id,
          content: text,
          isComplete: false,
        })

        if (!aborted) {
          const pe = err instanceof ProviderError ? err : null
          send({
            type: 'error',
            errorType: pe?.type ?? 'unknown',
            message: pe?.message ?? (err as Error).message,
            retryable: pe?.retryable ?? false,
          })
        }
      } finally {
        closed = true
        try {
          controller.close()
        } catch {
          // Already closed by the client disconnecting. Expected.
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and several CDNs buffer proxied responses by default, which turns
      // a token stream into one delivery at the end. This disables that.
      'X-Accel-Buffering': 'no',
    },
  })
}
