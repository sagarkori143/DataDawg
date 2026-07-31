import type { CaptureLayer } from '@ollive/contracts'
import type { AnyTransport } from '../transport/queue.js'
import { SHIMS, type ProviderShim } from './shims.js'
import { Span } from './span.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PROXY INSTRUMENTATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     const claude = instrument(new Anthropic())
 *
 * One word, one place. Every `claude.messages.create(...)` in the process is
 * now timed and measured, and not a single call site changes.
 *
 * A `Proxy` is an object that looks and behaves exactly like the real one but
 * lets us intervene on property access. The receptionist in front of the
 * manager's door: you still ask for the manager, she notes when you went in and
 * when you came out, and you never notice she is there.
 *
 * ── The hard part ───────────────────────────────────────────────────────────
 * Streaming. The obvious implementation reads the stream to count tokens — and
 * then the application gets nothing, because a stream can only be consumed
 * once. The wrapper has to be a *turnstile*: every chunk passes straight
 * through to the caller, counted on the way past. That is what `wrapStream`
 * below does, and it is the reason this file exists rather than a ten-line
 * timing decorator.
 */

export interface InstrumentOptions {
  /** Defaults to sniffing the client's shape. Pass explicitly for an unusual client. */
  provider?: string
  transport: AnyTransport
  capturedBy?: CaptureLayer
  previewChars?: number
  sdkVersion?: string
}

/** Marks a proxy so double-wrapping is a no-op instead of double-counting. */
const INSTRUMENTED = Symbol.for('ollive.instrumented')

/**
 * Identify the vendor from the client's shape.
 *
 * Constructor names are unreliable once a bundler has minified them, so this
 * looks at the API surface instead — `messages.create` for Anthropic,
 * `chat.completions` for OpenAI and everything that mimics it.
 */
function detectProvider(client: unknown): string | null {
  const c = client as Record<string, unknown> | null
  if (!c || typeof c !== 'object') return null

  const messages = c.messages as Record<string, unknown> | undefined
  if (messages && typeof messages.create === 'function') return 'anthropic'

  const chat = c.chat as Record<string, unknown> | undefined
  const completions = chat?.completions as Record<string, unknown> | undefined
  if (completions && typeof completions.create === 'function') return 'openai'

  return null
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof v === 'object' && v !== null && Symbol.asyncIterator in v
}

/**
 * Wrap a stream so it is counted but not consumed.
 *
 * Returns a Proxy over the vendor's stream object. `Symbol.asyncIterator` is
 * replaced with a generator that pulls from the real iterator, records what it
 * sees, and immediately yields the chunk onward. Every other property —
 * `.finalMessage()`, `.controller`, `.abort()` — passes through untouched, so
 * the object remains a drop-in for the real one.
 *
 * `return()` is forwarded deliberately: when a consumer breaks out of a
 * `for await` loop early, the runtime calls it, and that is the only signal we
 * get that the caller walked away. Without forwarding, the vendor's socket
 * would leak; without observing it, an abandoned stream would never emit an
 * event at all.
 */
function wrapStream<T extends object>(stream: T, span: Span, shim: ProviderShim): T {
  let settled = false

  const finish = (fn: () => void) => {
    if (settled) return
    settled = true
    fn()
  }

  return new Proxy(stream, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true

      if (prop === Symbol.asyncIterator) {
        return function instrumentedIterator() {
          const inner = (target as AsyncIterable<unknown>)[Symbol.asyncIterator]()

          const iterator: AsyncIterator<unknown> = {
            async next() {
              try {
                const result = await inner.next()

                if (result.done) {
                  finish(() => span.end())
                  return result
                }

                try {
                  const read = shim.readChunk(result.value)
                  if (read) {
                    if (read.text) {
                      span.markFirstToken()
                      span.appendText(read.text)
                    }
                    if (read.usage) span.mergeUsage(read.usage)
                    if (read.finishReason !== undefined) span.setFinishReason(read.finishReason)
                  }
                } catch {
                  // A shim that cannot read this chunk must not break the
                  // stream. The event will be slightly less complete; the
                  // application still gets its tokens.
                }

                // Passed through untouched. This line is the entire point.
                return result
              } catch (err) {
                const { errorType, message } = shim.classifyError(err)
                finish(() => span.fail(errorType, message))
                throw err
              }
            },

            async return(value?: unknown) {
              // The consumer broke out early — abandoned, or the client
              // disconnected. Partial tokens and a real TTFT were still
              // observed, so they are kept rather than discarded.
              finish(() => span.cancel())
              return inner.return ? inner.return(value) : { done: true, value }
            },

            async throw(err?: unknown) {
              const { errorType, message } = shim.classifyError(err)
              finish(() => span.fail(errorType, message))
              if (inner.throw) return inner.throw(err)
              throw err
            },
          }

          return iterator
        }
      }

      const value = Reflect.get(target, prop, receiver)

      // `finalMessage()` consumes the stream internally, bypassing our
      // iterator entirely. Wrapping it is what keeps that code path observed.
      if (prop === 'finalMessage' && typeof value === 'function') {
        return async function instrumentedFinalMessage(this: unknown, ...args: unknown[]) {
          try {
            const message = await (value as (...a: unknown[]) => Promise<unknown>).apply(
              target,
              args,
            )
            try {
              const read = shim.readResponse(message)
              if (read) {
                span.mergeUsage(read.usage)
                span.appendText(read.text)
                span.setFinishReason(read.finishReason)
              }
            } catch {
              /* best effort */
            }
            finish(() => span.end())
            return message
          } catch (err) {
            const { errorType, message } = shim.classifyError(err)
            finish(() => span.fail(errorType, message))
            throw err
          }
        }
      }

      // Methods must keep their original `this`. Binding to the proxy would
      // send the SDK's internal calls back through here and recurse.
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Wrap one method so calling it opens a span. */
function wrapMethod(
  original: (...args: unknown[]) => unknown,
  owner: object,
  shim: ProviderShim,
  opts: InstrumentOptions,
): (...args: unknown[]) => unknown {
  return function instrumented(this: unknown, ...args: unknown[]) {
    let span: Span
    try {
      span = new Span(shim.readRequest(args), {
        provider: shim.provider,
        capturedBy: opts.capturedBy ?? 'proxy',
        transport: opts.transport,
        previewChars: opts.previewChars,
        sdkVersion: opts.sdkVersion,
      })
    } catch {
      // Could not even read the request. Call through unobserved rather than
      // failing — an un-instrumented call beats a broken one.
      return original.apply(owner, args)
    }

    let result: unknown
    try {
      result = original.apply(owner, args)
    } catch (err) {
      const { errorType, message } = shim.classifyError(err)
      span.fail(errorType, message)
      throw err
    }

    // `messages.stream()` returns the stream object synchronously.
    if (isAsyncIterable(result)) return wrapStream(result as object, span, shim)

    if (result instanceof Promise) {
      return result.then(
        (value) => {
          // `messages.create({stream: true})` returns a *promise of* a stream.
          if (isAsyncIterable(value)) return wrapStream(value as object, span, shim)

          try {
            const read = shim.readResponse(value)
            if (read) {
              span.mergeUsage(read.usage)
              span.appendText(read.text)
              span.setFinishReason(read.finishReason)
            }
          } catch {
            /* best effort */
          }
          span.end()
          return value
        },
        (err) => {
          const { errorType, message } = shim.classifyError(err)
          span.fail(errorType, message)
          throw err
        },
      )
    }

    span.end()
    return result
  }
}

/**
 * Build the nested proxies for one dotted target path.
 *
 * `messages.create` means proxying `client` so that reading `.messages` yields
 * a proxy whose `.create` is wrapped. The intermediate objects have to be
 * proxied too — you cannot intercept a method without intercepting the object
 * that owns it.
 */
function proxyPath(
  root: object,
  segments: string[],
  shim: ProviderShim,
  opts: InstrumentOptions,
): object {
  const [head, ...rest] = segments
  if (!head) return root

  return new Proxy(root, {
    get(target, prop, receiver) {
      if (prop === INSTRUMENTED) return true

      const value = Reflect.get(target, prop, receiver)

      if (prop !== head) {
        return typeof value === 'function' ? value.bind(target) : value
      }

      if (rest.length === 0) {
        if (typeof value !== 'function') return value
        return wrapMethod(value as (...a: unknown[]) => unknown, target, shim, opts)
      }

      if (typeof value !== 'object' || value === null) return value
      return proxyPath(value, rest, shim, opts)
    },
  })
}

/**
 * Instrument a provider client.
 *
 * Returns a proxy that is behaviourally identical to the input. Safe to call on
 * an already-instrumented client (returns it unchanged) and safe to call on
 * something unrecognised (returns it unchanged, with the reason on `onSkip`) —
 * because a telemetry helper that throws during application startup is the
 * worst possible failure mode for a telemetry helper.
 */
export function instrument<T extends object>(
  client: T,
  opts: InstrumentOptions & { onSkip?: (reason: string) => void },
): T {
  try {
    if ((client as Record<symbol, unknown>)[INSTRUMENTED]) return client

    const providerName = opts.provider ?? detectProvider(client)
    if (!providerName) {
      opts.onSkip?.('could not identify provider from client shape')
      return client
    }

    const shim = SHIMS[providerName]
    if (!shim) {
      opts.onSkip?.(`no shim registered for provider "${providerName}"`)
      return client
    }

    let proxied: object = client
    for (const target of shim.targets) {
      proxied = proxyPath(proxied, target.split('.'), shim, opts)
    }

    return proxied as T
  } catch (err) {
    opts.onSkip?.(`instrumentation failed: ${(err as Error).message}`)
    return client
  }
}
