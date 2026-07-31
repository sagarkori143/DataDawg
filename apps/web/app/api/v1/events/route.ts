import { telemetryConfig, ingestServerConfig } from '@ollive/config'
import { checkAuth, handleBatch } from '@ollive/ingest-core'

/**
 * POST /api/v1/events — the deployed ingestion endpoint.
 *
 * Ten lines, because every bit of the logic lives in @ollive/ingest-core and is
 * shared verbatim with the standalone Fastify service. Locally you can run the
 * real separate process on its own port, which proves the SDK genuinely crosses
 * a network boundary; in production this deploys as one project, because
 * serverless platforms have no long-lived processes to host a second service.
 *
 * Same code, two entry points. That is what makes containerising this later a
 * packaging step rather than a redesign.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const expected = ingestServerConfig().apiKey

  if (!checkAuth(req.headers.get('authorization') ?? undefined, expected)) {
    return Response.json({ error: 'invalid or missing credentials' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const telemetry = telemetryConfig()

  try {
    const result = await handleBatch(body, {
      redactionMode: telemetry.redaction,
      previewChars: telemetry.previewChars,
    })
    // 202: received and now our responsibility, not "the write is complete".
    return Response.json(result, { status: 202 })
  } catch {
    // Transient — tell the SDK to retry rather than dead-lettering a whole
    // batch over a five-second database blip.
    return Response.json({ error: 'temporarily unable to persist' }, { status: 503 })
  }
}
