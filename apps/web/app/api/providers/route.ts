import { getRegistry } from '@ollive/providers'

/** GET /api/providers — what this deployment can actually serve. */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(): Promise<Response> {
  const providers = [...getRegistry().entries()].map(([name, a]) => ({
    name,
    models: a.models,
    defaultModel: a.defaultModel,
  }))
  return Response.json({ providers })
}
