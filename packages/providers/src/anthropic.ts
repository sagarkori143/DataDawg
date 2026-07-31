import Anthropic from '@anthropic-ai/sdk'
import type { ErrorType } from '@ollive/contracts'
import { instrument } from '@ollive/sdk'
import {
  EMPTY_USAGE,
  ProviderError,
  errorTypeFromStatus,
  type ChatRequest,
  type ChatResult,
  type ProviderAdapter,
  type StreamChunk,
  type Usage,
} from './types.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANTHROPIC ADAPTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thin on purpose. Its whole job is to turn Anthropic's stream event vocabulary
 * into the three-case one in types.ts, and its error classes into the shared
 * taxonomy. The interesting code in this repo is the instrumentation that wraps
 * this — not this.
 */

const MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5',
] as const

/**
 * Models that reject `temperature` / `top_p` / `top_k` with a 400.
 *
 * This is not a style preference — sending a sampling parameter to Opus 5 is a
 * hard request failure. Since `ChatRequest` carries an optional temperature for
 * the providers that do accept one, the adapter has to strip it here rather
 * than trusting every call site to know which models are which.
 */
function rejectsSamplingParams(model: string): boolean {
  return /^claude-(opus-5|opus-4-8|opus-4-7|sonnet-5|fable-5|mythos-5)/.test(model)
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly name = 'anthropic'
  readonly models = MODELS
  readonly defaultModel = 'claude-opus-5'

  private readonly client: Anthropic

  constructor(apiKey: string) {
    // ── Where auto-instrumentation attaches ─────────────────────────────────
    //
    // One word, one place. Every call this adapter makes is now timed and
    // measured, and not one line below this constructor knows about telemetry.
    //
    // It wraps the RAW vendor client rather than this adapter on purpose: the
    // interesting claim is that a third-party SDK we do not own can be
    // instrumented without touching it. Wrapping our own facade would prove
    // nothing about the hard case.
    this.client = instrument(new Anthropic({
      apiKey,
      // Retries are disabled here and owned one layer up.
      //
      // The SDK's built-in retry would hide the retry from the telemetry layer:
      // three attempts would surface as one call with a mysteriously long
      // latency. Since measuring exactly that is the point of this project, the
      // adapter reports each attempt honestly and lets the caller decide.
      maxRetries: 0,
      timeout: 120_000,
    }))
  }

  private buildParams(req: ChatRequest) {
    const { system, messages } = splitSystem(req)

    return {
      model: req.model,
      // Streaming, so a large cap is safe — it bounds the response, it does not
      // reserve anything. On Opus 5 it bounds thinking + text together, which
      // is why it needs headroom rather than being sized to the visible answer.
      max_tokens: req.maxTokens ?? 8_192,
      ...(system ? { system } : {}),
      messages,
      // Adaptive thinking is on by default on Opus 5. `effort: low` keeps chat
      // latency sane without disabling thinking outright — disabling it is the
      // documented cause of two failure modes (tool calls emitted as plain
      // text, `<thinking>` tags leaking into output), and low effort gets most
      // of the same latency win without either.
      output_config: { effort: 'low' as const },
      ...(rejectsSamplingParams(req.model) || req.temperature === undefined
        ? {}
        : { temperature: req.temperature }),
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const usage: Usage = { ...EMPTY_USAGE }
    let finishReason: string | null = null

    try {
      const stream = this.client.messages.stream(this.buildParams(req), {
        // Wired through so a browser disconnect actually stops the upstream
        // call rather than leaving it billing away unobserved.
        signal: req.signal,
      })

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            // Input tokens land here, at the very start — before a single
            // output token exists. A consumer that only reads usage at the end
            // of the stream silently records zero input tokens for every call.
            const u = event.message.usage
            usage.inputTokens = u.input_tokens
            usage.cacheReadTokens = u.cache_read_input_tokens ?? null
            usage.cacheWriteTokens = u.cache_creation_input_tokens ?? null
            yield { type: 'usage', usage: { ...usage } }
            break
          }

          case 'content_block_delta': {
            if (event.delta.type === 'text_delta') {
              yield { type: 'text', text: event.delta.text }
            }
            // thinking_delta is intentionally not forwarded: `display` defaults
            // to omitted, so its text is empty, and the chat UI has nothing to
            // show. The tokens are still counted in the usage totals.
            break
          }

          case 'message_delta': {
            // Output tokens arrive only here, near the end.
            usage.outputTokens = event.usage.output_tokens
            finishReason = event.delta.stop_reason ?? null
            yield { type: 'usage', usage: { outputTokens: usage.outputTokens } }
            break
          }
        }
      }

      yield { type: 'done', finishReason }
    } catch (err) {
      throw normaliseError(err)
    }
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    try {
      const message = await this.client.messages.create(
        { ...this.buildParams(req), stream: false },
        { signal: req.signal },
      )

      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')

      return {
        text,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? null,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? null,
        },
        finishReason: message.stop_reason ?? null,
      }
    } catch (err) {
      throw normaliseError(err)
    }
  }
}

/**
 * Anthropic takes the system prompt as a top-level field, not as a message with
 * `role: "system"`. Every other provider we support does the opposite, so the
 * unified `ChatRequest` uses messages and the adapter splits them back out.
 */
function splitSystem(req: ChatRequest): {
  system: string | undefined
  messages: Anthropic.MessageParam[]
} {
  const systemParts: string[] = []
  if (req.system) systemParts.push(req.system)

  const messages: Anthropic.MessageParam[] = []

  for (const m of req.messages) {
    if (m.role === 'system') {
      systemParts.push(m.content)
      continue
    }
    messages.push({ role: m.role, content: m.content })
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages,
  }
}

/**
 * Collapse the SDK's error classes onto the shared taxonomy.
 *
 * Checked most-specific first. `APIUserAbortError` is deliberately mapped to
 * `cancelled` and marked non-retryable: a user pressing Stop is not a failure,
 * and retrying it would be actively wrong.
 */
function normaliseError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof Anthropic.APIUserAbortError) {
    return new ProviderError('Request cancelled by client', 'unknown', 'anthropic', {
      retryable: false,
      cause: err,
    })
  }

  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('Request timed out', 'timeout', 'anthropic', { cause: err })
  }

  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(err.message, 'network', 'anthropic', { cause: err })
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status
    let type: ErrorType = errorTypeFromStatus(status)

    // A 400 covers several genuinely different situations. The status alone
    // cannot tell a prompt that is too long from one that was malformed, so
    // fall back to the message for the cases worth distinguishing — the
    // dashboard grouping is only useful if these do not all read as
    // "invalid_request".
    if (status === 400) {
      const msg = err.message.toLowerCase()
      if (msg.includes('context') || msg.includes('too long') || msg.includes('max_tokens')) {
        type = 'context_length'
      }
    }
    if (status === 529) type = 'server_error' // Anthropic-specific "overloaded"

    return new ProviderError(err.message, type, 'anthropic', { status, cause: err })
  }

  return new ProviderError(
    err instanceof Error ? err.message : String(err),
    'unknown',
    'anthropic',
    { retryable: false, cause: err },
  )
}
