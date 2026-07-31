export { closePool, getPool, ping, query, transaction } from './pool.js'
export { migrate, reset } from './migrate.js'
export type { MigrationResult } from './migrate.js'
export type { Conversation, ConversationSummary, Message } from './types.js'
export { RANGE_KEYS, type Range } from './repositories/metrics.js'

/**
 * The two repositories are exported as namespaces rather than flattened.
 *
 * `chat.appendMessage(...)` and `events.ingestBatch(...)` keep the OLTP/OLAP
 * split visible at every call site — which is the point of having drawn it.
 */
export * as chat from './repositories/chat.js'
export * as events from './repositories/events.js'
export * as metrics from './repositories/metrics.js'
