import type { ConversationStatus, MessageRole } from '@ollive/contracts'

/**
 * Row shapes as the application sees them: camelCase.
 *
 * Postgres speaks snake_case, JavaScript speaks camelCase, and exactly one
 * layer is allowed to know that — the repositories. Every query aliases its
 * columns, so nothing above this line ever sees an underscore, and no caller
 * has to remember which convention it is currently standing in.
 */

export interface Conversation {
  id: string
  userId: string | null
  title: string | null
  status: ConversationStatus
  messageCount: number
  lastMessageAt: Date | null
  createdAt: Date
  updatedAt: Date
  metadata: Record<string, unknown>
}

export interface Message {
  id: string
  conversationId: string
  seq: number
  role: MessageRole
  content: string
  tokenCount: number | null
  isComplete: boolean
  createdAt: Date
}

/** A conversation plus the telemetry summary the sidebar shows alongside it. */
export interface ConversationSummary extends Conversation {
  totalCostUsd: string
  totalTokens: number
  errorCount: number
}
