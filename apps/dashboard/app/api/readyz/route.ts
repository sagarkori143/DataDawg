import { ping } from '@ollive/db'

export const dynamic = 'force-dynamic'

/**
 * Readiness. Checks the database this host reads from — which may be a read
 * replica, and may be down independently of the primary the chat app uses.
 * That independence is the point of running this separately.
 */
export async function GET(): Promise<Response> {
  const dbOk = await ping()
  return Response.json(
    { status: dbOk ? 'ok' : 'degraded', database: dbOk },
    { status: dbOk ? 200 : 503 },
  )
}
