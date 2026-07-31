import type { ErrorType } from '@ollive/contracts'
import { instrument } from '@ollive/sdk'
import OpenAI from 'openai'
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
 * OPENAI-COMPATIBLE ADAPTER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * One adapter, many vendors. DeepSeek, Groq, xAI, Together, Fireworks, Ollama
 * and OpenAI itself all speak `/chat/completions`, so they differ only by base
 * URL and model list — configuration, not code.
 *
 * That is the test of whether a provider abstraction is real. Adding DeepSeek
 * here is a row in a table below; if it required a new class, the abstraction
 * would be decorative.
 */

export interface CompatibleVendor {
  name: string
  baseURL: string | undefined
  models: readonly string[]
  defaultModel: string
  envKey: string
}

export const COMPATIBLE_VENDORS: Record<string, CompatibleVendor> = {
  openai: {
    name: 'openai',
    baseURL: undefined, // the SDK's own default
    models: ['gpt-4.1', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4.1',
    envKey: 'OPENAI_API_KEY',
  },
  groq: {
    name: 'groq',
    baseURL: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    defaultModel: 'llama-3.3-70b-versatile',
    envKey: 'GROQ_API_KEY',
  },
  deepseek: {
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly name: string
  readonly models: readonly string[]
  readonly defaultModel: string

  private readonly client: OpenAI

  constructor(vendor: CompatibleVendor, apiKey: string) {
    this.name = vendor.name
    this.models = vendor.models
    this.defaultModel = vendor.defaultModel

    // Same instrumentation call as the Anthropic adapter. The SDK identifies
    // this client by shape (`chat.completions.create`) and applies the OpenAI
    // shim — no per-vendor wiring, which is the point of shims.
    this.client = instrument(
      new OpenAI({
        apiKey,
        ...(vendor.baseURL ? { baseURL: vendor.baseURL } : {}),
        maxRetries: 0,
        timeout: 120_000,
      }),
      { provider: 'openai' },
    )
  }

  private buildParams(req: ChatRequest) {
    const messages = req.system
      ? [{ role: 'system' as const, content: req.system }, ...req.messages]
      : req.messages

    return {
      model: req.model,
      messages,
      max_completion_tokens: req.maxTokens ?? 4_096,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<StreamChunk, void, undefined> {
    const usage: Usage = { ...EMPTY_USAGE }
    let finishReason: string | null = null

    try {
      const stream = await this.client.chat.completions.create(
        {
          ...this.buildParams(req),
          stream: true,
          // Without this, a streamed OpenAI call returns NO usage at all — not
          // zero, absent. Every token and cost figure would silently be null.
          // Set here rather than left to the caller, because forgetting it is
          // invisible until someone asks why the cost panel is empty.
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      )

      for await (const chunk of stream) {
        // Usage arrives on a final chunk whose `choices` array is empty — so a
        // consumer that only reads choices never sees it.
        if (chunk.usage) {
          usage.inputTokens = chunk.usage.prompt_tokens
          usage.outputTokens = chunk.usage.completion_tokens
          usage.cacheReadTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? null
          yield { type: 'usage', usage: { ...usage } }
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        if (choice.delta?.content) yield { type: 'text', text: choice.delta.content }
        if (choice.finish_reason) finishReason = choice.finish_reason
      }

      yield { type: 'done', finishReason }
    } catch (err) {
      throw normaliseError(err, this.name)
    }
  }

  async complete(req: ChatRequest): Promise<ChatResult> {
    try {
      const res = await this.client.chat.completions.create(
        { ...this.buildParams(req), stream: false },
        { signal: req.signal },
      )

      const choice = res.choices[0]

      return {
        text: choice?.message?.content ?? '',
        usage: {
          inputTokens: res.usage?.prompt_tokens ?? null,
          outputTokens: res.usage?.completion_tokens ?? null,
          cacheReadTokens: res.usage?.prompt_tokens_details?.cached_tokens ?? null,
          cacheWriteTokens: null,
        },
        finishReason: choice?.finish_reason ?? null,
      }
    } catch (err) {
      throw normaliseError(err, this.name)
    }
  }
}

function normaliseError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err

  if (err instanceof OpenAI.APIUserAbortError) {
    return new ProviderError('Request cancelled by client', 'unknown', provider, {
      retryable: false,
      cause: err,
    })
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError('Request timed out', 'timeout', provider, { cause: err })
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(err.message, 'network', provider, { cause: err })
  }

  if (err instanceof OpenAI.APIError) {
    const status = err.status
    let type: ErrorType = errorTypeFromStatus(status)

    if (status === 400) {
      const m = err.message.toLowerCase()
      if (m.includes('context') || m.includes('maximum context')) type = 'context_length'
      else if (m.includes('content') || m.includes('policy')) type = 'content_filter'
    }

    return new ProviderError(err.message, type, provider, { status, cause: err })
  }

  return new ProviderError(err instanceof Error ? err.message : String(err), 'unknown', provider, {
    retryable: false,
    cause: err,
  })
}
