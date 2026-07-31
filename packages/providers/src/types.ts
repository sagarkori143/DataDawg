import type { ErrorType } from '@ollive/contracts'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROVIDER INTERFACE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every vendor SDK has its own message format, its own streaming event shapes,
 * its own names for token counts, and its own error classes. Normalising them
 * onto one interface is most of the value of this package: it is what lets the
 * dashboard group by cause instead of by vendor, and lets retry policy be
 * written once.
 *
 * ── Why hand-rolled adapters rather than the Vercel AI SDK ──────────────────
 * The AI SDK would have saved several hours and has a built-in telemetry hook.
 * It was rejected because this project's headline feature is auto-instrumenting
 * *someone else's* SDK. Wrapping a wrapper would mean instrumenting a facade we
 * control, which proves nothing about the hard case — patching a third-party
 * client we do not own. The adapters stay thin (~100 lines each) precisely so
 * that the interesting code is the instrumentation, not this.
 */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface ChatRequest {
  model: string
  messages: ChatMessage[]
  system?: string
  maxTokens?: number
  temperature?: number
  /** Wired through to the underlying SDK so a client disconnect actually stops the upstream call. */
  signal?: AbortSignal
}

/**
 * Normalised token usage.
 *
 * Every field is nullable because usage genuinely is sometimes unavailable — a
 * stream that died before its usage frame, or OpenAI without
 * `stream_options.include_usage`. Defaulting to 0 would be a lie that silently
 * deflates every cost aggregate downstream, and a wrong number is worse than a
 * missing one because nobody investigates it.
 */
export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
}

export const EMPTY_USAGE: Usage = {
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
}

/**
 * The normalised stream.
 *
 * A deliberately small vocabulary. Providers emit a dozen event kinds each
 * (ping, content_block_start, message_delta…); collapsing them to "text",
 * "usage" and "done" means the instrumentation layer above has exactly three
 * cases to handle instead of a dozen per vendor.
 */
export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Partial<Usage> }
  | { type: 'done'; finishReason: string | null }

export interface ChatResult {
  text: string
  usage: Usage
  finishReason: string | null
}

export interface ProviderAdapter {
  /** Stable identifier written to every telemetry row. */
  readonly name: string
  /** Models this adapter can serve, for the UI picker. */
  readonly models: readonly string[]
  readonly defaultModel: string

  /**
   * Stream a chat completion.
   *
   * Async generator rather than a callback because it composes: the
   * instrumentation layer can wrap it as a passthrough iterator that counts
   * chunks without consuming them, which is what makes streaming telemetry
   * possible without the SDK owning the loop.
   */
  stream(request: ChatRequest): AsyncGenerator<StreamChunk, void, undefined>

  /** Non-streaming call. Kept because evals and background jobs do not need streaming. */
  complete(request: ChatRequest): Promise<ChatResult>
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NORMALISED ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `retryable` is derived at the boundary, once, by the adapter that actually
 * understands the vendor's status codes — rather than re-inferred by every
 * caller from a message string. Retry policy then reads this flag and nothing
 * else, which is why it can be written once for all providers.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly type: ErrorType,
    readonly provider: string,
    readonly options: {
      status?: number | undefined
      retryable?: boolean | undefined
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'ProviderError'
  }

  get retryable(): boolean {
    return this.options.retryable ?? RETRYABLE_ERROR_TYPES.has(this.type)
  }

  get status(): number | undefined {
    return this.options.status
  }
}

/**
 * Which failures are worth trying again.
 *
 * `auth` is excluded on purpose: a bad key will still be bad in 8 seconds, and
 * retrying it turns a clear configuration error into a slow mysterious one.
 * `content_filter`, `context_length` and `invalid_request` are excluded for the
 * same reason — the request itself must change for the outcome to change.
 */
export const RETRYABLE_ERROR_TYPES: ReadonlySet<ErrorType> = new Set<ErrorType>([
  'rate_limit',
  'timeout',
  'server_error',
  'network',
])

/**
 * Map an HTTP status onto the taxonomy.
 *
 * Adapters call this as a fallback after they have tried the vendor's own,
 * more specific signals — status alone cannot distinguish a context-length
 * overflow from a malformed parameter, since both arrive as 400.
 */
export function errorTypeFromStatus(status: number | undefined): ErrorType {
  if (status === undefined) return 'unknown'
  if (status === 401 || status === 403) return 'auth'
  if (status === 408) return 'timeout'
  if (status === 429) return 'rate_limit'
  if (status >= 500) return 'server_error'
  if (status >= 400) return 'invalid_request'
  return 'unknown'
}
