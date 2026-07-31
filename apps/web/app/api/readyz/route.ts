import { ping } from '@ollive/db'

export const dynamic = 'force-dynamic'

/** Readiness. Checks the database, so a node that cannot serve is taken out of rotation. */
export async function GET(): Promise<Response> {
  const dbOk = await ping()
  return Response.json(
    { status: dbOk ? 'ok' : 'degraded', database: dbOk },
    { status: dbOk ? 200 : 503 },
  )
}
