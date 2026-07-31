import type { ErrorType } from '@ollive/contracts'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PROVIDER SHIMS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A shim teaches the instrumentation how to read one vendor's shapes: which
 * methods to wrap, how to pull the model out of the arguments, and how to read
 * usage out of a response or a stream chunk.
 *
 * Everything else in the SDK is vendor-agnostic. Supporting a new provider is a
 * shim, not a change to the timing, buffering, or transport code — which is
 * what keeps "multi-provider" from meaning "the same wrapper written twice".
 */

export interface RequestMeta {
  model: string
  streamed: boolean
  maxTokens: number | null
  temperature: number | null
  messageCount: number | null
  /** Raw prompt text. Redacted and truncated downstream — never stored whole. */
  inputText: string | null
}

export interface UsageDelta {
  inputTokens?: number | null
  outputTokens?: number | null
  cacheReadTokens?: number | null
  cacheWriteTokens?: number | null
}

export interface ChunkRead {
  text?: string
  usage?: UsageDelta
  finishReason?: string | null
}

export interface ProviderShim {
  provider: string
  /** Dotted paths, relative to the client, of the methods to wrap. */
  targets: string[]
  readRequest(args: readonly unknown[]): RequestMeta
  /** Non-streaming response. Null when the value is a stream rather than a message. */
  readResponse(value: unknown): { text: string; usage: UsageDelta; finishReason: string | null } | null
  readChunk(chunk: unknown): ChunkRead | null
  /**
   * Classify a thrown error.
   *
   * `cancelled` is deliberately part of this union even though it is not an
   * ErrorType: vendors surface a user abort as a thrown error, but it is a
   * deliberate action rather than a fault. Modelling it here keeps the
   * distinction explicit instead of leaving callers to cast it away.
   */
  classifyError(err: unknown): { errorType: ErrorType | 'cancelled'; message: string }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * Flatten a messages array into plain text for the preview.
 *
 * Content blocks vary per vendor (string, array of typed parts, tool results);
 * anything that is not textual is skipped rather than stringified, because
 * `[object Object]` in a preview is worse than a shorter preview.
 */
function flattenMessages(messages: unknown): { text: string; count: number } {
  if (!Array.isArray(messages)) return { text: '', count: 0 }

  const parts: string[] = []
  for (const m of messages) {
    if (!isRecord(m)) continue
    const c = m.content
    if (typeof c === 'string') {
      parts.push(c)
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text)
        }
      }
    }
  }

  return { text: parts.join('\n'), count: messages.length }
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic
// ─────────────────────────────────────────────────────────────────────────────

export const anthropicShim: ProviderShim = {
  provider: 'anthropic',
  // `create` covers both modes (stream:true returns a stream); `stream` is the
  // helper that always does. Both are wrapped so the app's choice of API style
  // does not change whether it is observed.
  targets: ['messages.create', 'messages.stream'],

  readRequest(args) {
    const params = isRecord(args[0]) ? args[0] : {}
    const { text, count } = flattenMessages(params.messages)
    const system = typeof params.system === 'string' ? params.system : ''

    return {
      model: typeof params.model === 'string' ? params.model : 'unknown',
      streamed: params.stream === true,
      maxTokens: typeof params.max_tokens === 'number' ? params.max_tokens : null,
      temperature: typeof params.temperature === 'number' ? params.temperature : null,
      messageCount: count,
      inputText: system ? `${system}\n\n${text}` : text,
    }
  },

  readResponse(value) {
    if (!isRecord(value) || value.type !== 'message') return null

    const blocks = Array.isArray(value.content) ? value.content : []
    const text = blocks
      .filter((b): b is { type: 'text'; text: string } => isRecord(b) && b.type === 'text')
      .map((b) => b.text)
      .join('')

    const u = isRecord(value.usage) ? value.usage : {}

    return {
      text,
      usage: {
        inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
        outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
        cacheReadTokens:
          typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : null,
        cacheWriteTokens:
          typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : null,
      },
      finishReason: typeof value.stop_reason === 'string' ? value.stop_reason : null,
    }
  },

  readChunk(chunk) {
    if (!isRecord(chunk)) return null

    switch (chunk.type) {
      case 'message_start': {
        // Input tokens arrive HERE — at the very start, before a single output
        // token exists. Code that reads usage only at stream end records zero
        // input tokens on every call and nobody notices until the cost report.
        const msg = isRecord(chunk.message) ? chunk.message : {}
        const u = isRecord(msg.usage) ? msg.usage : {}
        return {
          usage: {
            inputTokens: typeof u.input_tokens === 'number' ? u.input_tokens : null,
            cacheReadTokens:
              typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : null,
            cacheWriteTokens:
              typeof u.cache_creation_input_tokens === 'number'
                ? u.cache_creation_input_tokens
                : null,
          },
        }
      }

      case 'content_block_delta': {
        const d = isRecord(chunk.delta) ? chunk.delta : {}
        if (d.type === 'text_delta' && typeof d.text === 'string') return { text: d.text }
        return null
      }

      case 'message_delta': {
        const u = isRecord(chunk.usage) ? chunk.usage : {}
        const d = isRecord(chunk.delta) ? chunk.delta : {}
        return {
          usage: {
            outputTokens: typeof u.output_tokens === 'number' ? u.output_tokens : null,
          },
          finishReason: typeof d.stop_reason === 'string' ? d.stop_reason : null,
        }
      }

      default:
        return null
    }
  },

  classifyError(err) {
    const e = err as { status?: number; name?: string; message?: string }
    const message = e?.message ?? String(err)
    const status = e?.status

    if (e?.name === 'APIUserAbortError') return { errorType: 'cancelled', message }
    if (e?.name === 'APIConnectionTimeoutError') return { errorType: 'timeout', message }
    if (e?.name === 'APIConnectionError') return { errorType: 'network', message }

    if (status === 401 || status === 403) return { errorType: 'auth', message }
    if (status === 408) return { errorType: 'timeout', message }
    if (status === 429) return { errorType: 'rate_limit', message }
    if (status && status >= 500) return { errorType: 'server_error', message }
    if (status === 400) {
      const m = message.toLowerCase()
      if (m.includes('context') || m.includes('too long')) {
        return { errorType: 'context_length', message }
      }
      return { errorType: 'invalid_request', message }
    }

    return { errorType: 'unknown', message }
  },
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenAI (and every OpenAI-compatible vendor — DeepSeek, Groq, xAI, Together)
// ─────────────────────────────────────────────────────────────────────────────

export const openaiShim: ProviderShim = {
  provider: 'openai',
  targets: ['chat.completions.create'],

  readRequest(args) {
    const params = isRecord(args[0]) ? args[0] : {}
    const { text, count } = flattenMessages(params.messages)

    return {
      model: typeof params.model === 'string' ? params.model : 'unknown',
      streamed: params.stream === true,
      maxTokens:
        typeof params.max_completion_tokens === 'number'
          ? params.max_completion_tokens
          : typeof params.max_tokens === 'number'
            ? params.max_tokens
            : null,
      temperature: typeof params.temperature === 'number' ? params.temperature : null,
      messageCount: count,
      inputText: text,
    }
  },

  readResponse(value) {
    if (!isRecord(value) || !Array.isArray(value.choices)) return null

    const choice = isRecord(value.choices[0]) ? value.choices[0] : {}
    const msg = isRecord(choice.message) ? choice.message : {}
    const u = isRecord(value.usage) ? value.usage : {}
    const details = isRecord(u.prompt_tokens_details) ? u.prompt_tokens_details : {}

    return {
      text: typeof msg.content === 'string' ? msg.content : '',
      usage: {
        inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
        outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
        cacheReadTokens: typeof details.cached_tokens === 'number' ? details.cached_tokens : null,
      },
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    }
  },

  readChunk(chunk) {
    if (!isRecord(chunk)) return null

    const out: ChunkRead = {}

    // Only present when the caller passed stream_options.include_usage — and it
    // arrives on a final chunk whose `choices` array is empty. Without that
    // option OpenAI returns no usage at all for a streamed call, which is why
    // the adapter sets it rather than leaving it to the app.
    if (isRecord(chunk.usage)) {
      const u = chunk.usage
      out.usage = {
        inputTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null,
        outputTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : null,
      }
    }

    if (Array.isArray(chunk.choices) && chunk.choices.length > 0) {
      const choice = isRecord(chunk.choices[0]) ? chunk.choices[0] : {}
      const delta = isRecord(choice.delta) ? choice.delta : {}
      if (typeof delta.content === 'string' && delta.content) out.text = delta.content
      if (typeof choice.finish_reason === 'string') out.finishReason = choice.finish_reason
    }

    return Object.keys(out).length > 0 ? out : null
  },

  classifyError(err) {
    const e = err as { status?: number; name?: string; message?: string; code?: string }
    const message = e?.message ?? String(err)
    const status = e?.status

    if (e?.name === 'APIUserAbortError') return { errorType: 'cancelled', message }
    if (e?.code === 'ETIMEDOUT' || e?.name === 'APIConnectionTimeoutError') {
      return { errorType: 'timeout', message }
    }
    if (e?.name === 'APIConnectionError') return { errorType: 'network', message }

    if (status === 401 || status === 403) return { errorType: 'auth', message }
    if (status === 429) return { errorType: 'rate_limit', message }
    if (status && status >= 500) return { errorType: 'server_error', message }
    if (status === 400) {
      const m = message.toLowerCase()
      if (m.includes('context') || m.includes('maximum context')) {
        return { errorType: 'context_length', message }
      }
      if (m.includes('content')) return { errorType: 'content_filter', message }
      return { errorType: 'invalid_request', message }
    }

    return { errorType: 'unknown', message }
  },
}

export const SHIMS: Record<string, ProviderShim> = {
  anthropic: anthropicShim,
  openai: openaiShim,
}
