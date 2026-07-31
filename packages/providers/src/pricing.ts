import type { Usage } from './types.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PRICING
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cost is computed once, at ingestion, and frozen onto the event alongside the
 * version of this table that produced it.
 *
 * The alternative — computing cost at query time from a live price list — is
 * subtly wrong in a way that is hard to notice: when a vendor changes its
 * prices, every historical chart silently rewrites itself. Last quarter's spend
 * becomes a different number than the one you reported. Receipts do not change
 * when the shop changes its prices.
 *
 * `PRICING_VERSION` is stored on every row. Re-pricing history is then a
 * deliberate migration you can audit, rather than something that happens to you.
 */

/** Bump on every edit below. Written to `inference_events.pricing_version`. */
export const PRICING_VERSION = '2026-07-31'

interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
  /**
   * Cache multipliers, relative to the input rate.
   *
   * Anthropic: a 5-minute cache write costs 1.25x input, a read 0.1x. Reads
   * being ~10x cheaper is the entire economic argument for prompt caching, so
   * a cost model that ignored them would overstate spend badly on any workload
   * with a large stable prefix.
   */
  cacheWriteMultiplier: number
  cacheReadMultiplier: number
}

/**
 * Prices in USD per 1M tokens, current as of PRICING_VERSION.
 *
 * Anthropic figures are from the published price list. OpenAI figures are
 * marked below — verify them against platform.openai.com/pricing before
 * relying on the cost panel for anything that matters. Being wrong here is
 * invisible until someone reconciles against a real invoice, so the honest
 * move is to say which numbers are authoritative and which are not.
 */
const PRICES: Record<string, ModelPrice> = {
  // ── Anthropic ─────────────────────────────────────────────────────────────
  'claude-opus-5': { input: 5.0, output: 25.0, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  'claude-opus-4-8': { input: 5.0, output: 25.0, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  // Sonnet 5 list price is $3/$15; introductory pricing of $2/$10 runs through
  // 2026-08-31. Encoded at the introductory rate because that is what is
  // actually being billed at PRICING_VERSION — which is precisely the kind of
  // time-bounded fact that makes a frozen cost column necessary.
  'claude-sonnet-5': { input: 2.0, output: 10.0, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // UNVERIFIED — these are best-known figures, not confirmed against the live
  // price list. Treat the OpenAI cost panel as indicative until checked.
  'gpt-4.1': { input: 2.0, output: 8.0, cacheWriteMultiplier: 1.0, cacheReadMultiplier: 0.25 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheWriteMultiplier: 1.0, cacheReadMultiplier: 0.25 },
}

export interface PricedCost {
  /**
   * Serialised as a decimal string, not a number.
   *
   * Money in a float is how you get 0.30000000000000004 in a billing column.
   * The string goes straight into a Postgres `numeric`, which does exact
   * decimal arithmetic, and no float ever touches the value.
   */
  costUsd: string | null
  pricingVersion: string
}

/**
 * Price one call.
 *
 * Returns `null` for an unknown model rather than guessing or defaulting to
 * zero. A zero would quietly understate spend and look like a free model; a
 * null shows up as a gap and gets investigated. Unknown models are expected —
 * vendors ship them faster than price tables get updated — so this path is
 * normal, not exceptional.
 */
export function priceCall(model: string, usage: Usage): PricedCost {
  const price = PRICES[model] ?? PRICES[normaliseModel(model)]

  if (!price) return { costUsd: null, pricingVersion: PRICING_VERSION }

  const perToken = (rate: number) => rate / 1_000_000

  const cost =
    (usage.inputTokens ?? 0) * perToken(price.input) +
    (usage.outputTokens ?? 0) * perToken(price.output) +
    (usage.cacheWriteTokens ?? 0) * perToken(price.input * price.cacheWriteMultiplier) +
    (usage.cacheReadTokens ?? 0) * perToken(price.input * price.cacheReadMultiplier)

  // 8 decimal places: a single cheap call can cost well under a cent, and
  // rounding to 4 would floor thousands of small calls to exactly zero.
  return { costUsd: cost.toFixed(8), pricingVersion: PRICING_VERSION }
}

/**
 * Strip provider prefixes and date suffixes so a model resolves to its base price.
 *
 * `anthropic.claude-opus-5` (Bedrock) and `claude-haiku-4-5-20251001` (dated
 * snapshot) are the same product as their base IDs and cost the same.
 */
function normaliseModel(model: string): string {
  return model
    .replace(/^(anthropic|openai|us|eu)\./, '')
    .replace(/-\d{8}$/, '')
}

/** Whether a model has a known price. Used to surface coverage gaps on the dashboard. */
export function isPriced(model: string): boolean {
  return Boolean(PRICES[model] ?? PRICES[normaliseModel(model)])
}
