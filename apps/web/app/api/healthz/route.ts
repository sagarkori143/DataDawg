export const dynamic = 'force-dynamic'

/** Liveness. Deliberately dependency-free — see the note in apps/ingest/src/server.ts. */
export async function GET(): Promise<Response> {
  return Response.json({ status: 'ok', uptime: process.uptime() })
}
