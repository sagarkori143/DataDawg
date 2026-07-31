/**
 * Closed vocabularies shared by the SDK, the ingestion pipeline and the database.
 *
 * These are declared as `as const` arrays rather than TypeScript `enum`s so that a
 * single declaration yields all three things we need: the Zod validator, the static
 * type, and the literal list used to generate the Postgres `CREATE TYPE` statement.
 */

/**
 * How an inference call ended.
 *
 * Deliberately three values, not four. A timeout is a *kind of error*, not a peer of
 * one — modelling it as a status would mean every consumer has to remember to check
 * for two failure states instead of one. It lives in `errorType` instead.
 *
 * `cancelled` is its own status because it is not a failure: the user chose to stop.
 * Folding it into `error` would inflate the error-rate panel with deliberate user
 * actions, which is exactly the sort of thing that makes a dashboard untrustworthy.
 */
export const INFERENCE_STATUSES = ['ok', 'error', 'cancelled'] as const
export type InferenceStatus = (typeof INFERENCE_STATUSES)[number]

/**
 * Normalised failure taxonomy across every provider.
 *
 * Each vendor SDK throws its own error shapes with its own status codes and message
 * strings. Mapping them onto one closed set is most of the value of the adapter
 * layer: it is what lets the dashboard group errors by cause instead of by vendor,
 * and what lets retry policy be written once rather than per-provider.
 */
export const ERROR_TYPES = [
  'rate_limit', // 429 — retryable with backoff
  'timeout', // request exceeded our deadline — retryable
  'auth', // bad or missing key — NOT retryable, alert loudly
  'content_filter', // provider refused on safety grounds — not retryable
  'context_length', // prompt too long — not retryable without changing the request
  'invalid_request', // malformed params — a bug in our code
  'server_error', // provider 5xx — retryable
  'network', // DNS/TLS/socket — retryable
  'unknown', // never leave an error unclassified; this bucket should stay near-empty
] as const
export type ErrorType = (typeof ERROR_TYPES)[number]

/** The kind of model call. Only `chat` is exercised today; the others are here so the schema does not need a breaking change to add them. */
export const OPERATIONS = ['chat', 'completion', 'embedding'] as const
export type Operation = (typeof OPERATIONS)[number]

/** Lifecycle of a conversation. `deleted` is a soft delete — see the retention notes in ARCHITECTURE-EXPLAINED.md. */
export const CONVERSATION_STATUSES = ['active', 'archived', 'deleted'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

/** Who authored a message. */
export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const
export type MessageRole = (typeof MESSAGE_ROLES)[number]

/**
 * Which instrumentation layer captured the event.
 *
 * Recorded on every event so that the zero-code demo is *verifiable from the data*
 * rather than merely asserted: rows produced by `node --import @ollive/sdk/register`
 * carry `loader`, rows from an explicitly wrapped client carry `proxy`.
 */
export const CAPTURE_LAYERS = ['manual', 'proxy', 'loader'] as const
export type CaptureLayer = (typeof CAPTURE_LAYERS)[number]
