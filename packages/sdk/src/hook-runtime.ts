import { instrument } from './index.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HOOK RUNTIME
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Called from the synthetic module that `register.ts` substitutes for each
 * provider SDK. Kept in its own file because that synthetic source has to
 * `import` it by absolute URL, and pointing at the barrel would drag the whole
 * package into a module graph that is being rewritten mid-load.
 */

/**
 * Wrap a vendor SDK's default export — its client class.
 *
 * The application still writes `new Anthropic({ apiKey })`. The `construct`
 * trap runs the real constructor and hands back an instrumented instance, so
 * every method call on it is observed. The application cannot tell, and no line
 * of its source changed.
 *
 * `capturedBy: 'loader'` is written onto every event this produces, which is
 * what makes the zero-code claim checkable from the data rather than merely
 * asserted: rows captured this way say so.
 */
export function wrapConstructor<T extends new (...args: never[]) => object>(
  Original: T,
  provider: string,
): T {
  if (typeof Original !== 'function') return Original

  return new Proxy(Original, {
    construct(target, args, newTarget) {
      const instance = Reflect.construct(target, args, newTarget) as object

      try {
        return instrument(instance, { provider, capturedBy: 'loader' })
      } catch {
        // Instrumentation must never break construction. An un-instrumented
        // client is a missing metric; a throwing constructor is an outage.
        return instance
      }
    },
  }) as T
}
