import { chat } from '@ollive/db'

/** GET /api/conversations — the sidebar. One index scan, no per-row counting. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request): Promise<Response> {
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 50)
  try {
    return Response.json({ conversations: await chat.listConversations({ limit }) })
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}

/** POST /api/conversations — start an empty conversation. */
export async function POST(): Promise<Response> {
  try {
    return Response.json({ conversation: await chat.createConversation({}) }, { status: 201 })
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 })
  }
}
