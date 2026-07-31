import { providerConfig } from '@ollive/config'
import { AnthropicAdapter } from './anthropic.js'
import type { ProviderAdapter } from './types.js'

export * from './types.js'
export * from './pricing.js'
export { AnthropicAdapter } from './anthropic.js'

/**
 * Build the adapters this deployment can actually serve.
 *
 * Keyed off `providerConfig().available`, so the UI offers exactly the
 * providers that have credentials. Missing a key degrades the app to fewer
 * options rather than failing to start — a demo that refuses to boot because
 * one optional vendor key is absent is a worse demo.
 */
export function buildRegistry(): Map<string, ProviderAdapter> {
  const cfg = providerConfig()
  const registry = new Map<string, ProviderAdapter>()

  if (cfg.keys.anthropic) {
    registry.set('anthropic', new AnthropicAdapter(cfg.keys.anthropic))
  }

  return registry
}

let cached: Map<string, ProviderAdapter> | undefined

export function getRegistry(): Map<string, ProviderAdapter> {
  cached ??= buildRegistry()
  return cached
}

export function getAdapter(provider: string): ProviderAdapter {
  const adapter = getRegistry().get(provider)
  if (!adapter) {
    throw new Error(
      `Provider "${provider}" is not configured. Available: ${[...getRegistry().keys()].join(', ') || 'none'}`,
    )
  }
  return adapter
}

/** Which provider serves a given model. Lets the chat route take a model and find its adapter. */
export function resolveProviderForModel(model: string): string | null {
  for (const [name, adapter] of getRegistry()) {
    if (adapter.models.includes(model)) return name
  }
  return null
}
