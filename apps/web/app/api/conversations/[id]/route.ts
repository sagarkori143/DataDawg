import { chat, query } from '@ollive/db'

/**
 * GET  /api/conversations/:id — resume. Messages replay in `seq` order, never
 *                                by timestamp: two messages can share a
 *                                millisecond, and a history handed to a model
 *                                out of order is a silently corrupted prompt.
 * PATCH /api/conversations/:id — archive, or redact for an erasure request.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  try {
    const conversation = await chat.getConversation(id)
    if (!conversation) return Response.json({ error: 'not found' }, { status: 404 })
    return Response.json({ conversation, messages: await chat.getMessages(id) })
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params
  const body = (await req.json().catch(() => ({}))) as { status?: string; redact?: boolean }

  try {
    if (body.redact) {
      // GDPR erasure: strips the content, keeps latency/tokens/cost. Erasure and
      // amnesia are different requirements — see 004_ingest.sql.
      const { rows } = await query('SELECT * FROM redact_conversation($1)', [id])
      return Response.json({ redacted: rows[0] })
    }

    if (body.status === 'archived' || body.status === 'active' || body.status === 'deleted') {
      await chat.setConversationStatus(id, body.status)
      return Response.json({ ok: true, status: body.status })
    }

    return Response.json({ error: 'nothing to do' }, { status: 400 })
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}
