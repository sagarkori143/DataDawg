import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REQUEST CONTEXT — the hospital wristband
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The instrumentation sits deep inside a vendor SDK call. The conversation ID
 * lives at the top of the HTTP request. Threading it down means changing every
 * function signature between the two — which defeats the entire premise of
 * instrumentation you do not have to write.
 *
 * `AsyncLocalStorage` is the wristband: snap it on when the request arrives and
 * anyone, at any depth, in any async continuation, can read it without being
 * handed anything. The patient moves between rooms; every doctor can read the
 * band.
 *
 * This is genuinely async-aware, not a global. Two concurrent requests each see
 * their own context — a module-level variable would interleave them and
 * attribute one user's tokens to another, which is the kind of bug that looks
 * like "the numbers are a bit off" for months.
 */

export interface InferenceContext {
  conversationId?: string | null
  messageId?: string | null
  sessionId?: string | null
  userId?: string | null
  /** Free-form extras merged onto the event's `attributes`. */
  attributes?: Record<string, unknown>
}

const storage = new AsyncLocalStorage<InferenceContext>()

/**
 * Run `fn` with the given context attached.
 *
 * Everything the callback awaits inherits it, including code the caller has
 * never heard of.
 */
export function withContext<T>(ctx: InferenceContext, fn: () => T): T {
  return storage.run(ctx, fn)
}

/** Read the ambient context. Empty object when running outside one — never throws. */
export function getContext(): InferenceContext {
  return storage.getStore() ?? {}
}

/**
 * Merge fields into the current context in place.
 *
 * Needed because some identifiers only exist part-way through a request: the
 * assistant `messageId` is created after the context is established but must
 * still land on the event. Mutating the active store is the only way to attach
 * it without re-entering `withContext` and losing everything already set.
 */
export function updateContext(patch: Partial<InferenceContext>): void {
  const store = storage.getStore()
  if (store) Object.assign(store, patch)
}
