export const dynamic = 'force-dynamic'

/** Liveness. Dependency-free on purpose — see apps/ingest/src/server.ts. */
export async function GET(): Promise<Response> {
  return Response.json({ status: 'ok', uptime: process.uptime() })
}
