import type { ConversationStatus, MessageRole } from '@ollive/contracts'
import { query, transaction } from '../pool.js'
import type { Conversation, Message } from '../types.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CHAT REPOSITORY — the OLTP half
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Small, transactional, read one conversation at a time.
 *
 * Kept separate from EventRepository not for tidiness but because they have
 * genuinely different futures. When telemetry volume outgrows Postgres, only
 * the event side moves to ClickHouse — and because the seam is here, that is a
 * swap of one file rather than an archaeology expedition through every query in
 * the codebase.
 */

const CONVERSATION_COLUMNS = `
  id,
  user_id        AS "userId",
  title,
  status,
  message_count  AS "messageCount",
  last_message_at AS "lastMessageAt",
  created_at     AS "createdAt",
  updated_at     AS "updatedAt",
  metadata
`

const MESSAGE_COLUMNS = `
  id,
  conversation_id AS "conversationId",
  seq,
  role,
  content,
  token_count AS "tokenCount",
  is_complete AS "isComplete",
  created_at  AS "createdAt"
`

export async function createConversation(input: {
  userId?: string | null
  title?: string | null
}): Promise<Conversation> {
  const { rows } = await query<Conversation>(
    `INSERT INTO conversations (user_id, title)
     VALUES ($1, $2)
     RETURNING ${CONVERSATION_COLUMNS}`,
    [input.userId ?? null, input.title ?? null],
  )
  return rows[0]!
}

export async function getConversation(id: string): Promise<Conversation | null> {
  const { rows } = await query<Conversation>(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE id = $1`,
    [id],
  )
  return rows[0] ?? null
}

/**
 * The sidebar query.
 *
 * Served entirely by conversations_list_idx — no join to messages, because the
 * counters it would compute are already denormalised onto the row by trigger.
 * Rendering a list of N conversations costs one index scan, not N counts.
 */
export async function listConversations(opts: {
  userId?: string | null
  limit?: number
  before?: Date | null
} = {}): Promise<Conversation[]> {
  const limit = Math.min(opts.limit ?? 50, 200)

  const { rows } = await query<Conversation>(
    `SELECT ${CONVERSATION_COLUMNS}
       FROM conversations
      WHERE status <> 'deleted'
        AND ($1::text IS NULL OR user_id IS NOT DISTINCT FROM $1)
        AND ($2::timestamptz IS NULL OR last_message_at < $2)
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
      LIMIT $3`,
    [opts.userId ?? null, opts.before ?? null, limit],
  )
  return rows
}

/**
 * Replay a conversation in order — the resume path.
 *
 * Ordered by seq, never by created_at. Two messages can share a millisecond,
 * and a history handed to a model in the wrong order is a subtly corrupted
 * prompt that is very hard to notice and very easy to ship.
 */
export async function getMessages(conversationId: string, limit = 200): Promise<Message[]> {
  const { rows } = await query<Message>(
    `SELECT ${MESSAGE_COLUMNS}
       FROM messages
      WHERE conversation_id = $1
      ORDER BY seq ASC
      LIMIT $2`,
    [conversationId, limit],
  )
  return rows
}

/**
 * Append a message, assigning the next sequence number.
 *
 * The seq is computed inside the same transaction as the insert, so two
 * concurrent sends to one conversation cannot both claim the same number —
 * the UNIQUE (conversation_id, seq) constraint would reject the loser, and the
 * transaction keeps read and write from being separated by another writer.
 */
export async function appendMessage(input: {
  conversationId: string
  role: MessageRole
  content: string
  tokenCount?: number | null
  isComplete?: boolean
}): Promise<Message> {
  return transaction(async (client) => {
    const { rows } = await client.query<Message>(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, is_complete)
       VALUES (
         $1,
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = $1),
         $2, $3, $4, $5
       )
       RETURNING ${MESSAGE_COLUMNS}`,
      [
        input.conversationId,
        input.role,
        input.content,
        input.tokenCount ?? null,
        input.isComplete ?? true,
      ],
    )
    return rows[0]!
  })
}

/**
 * Finalise a streaming assistant message.
 *
 * The row is created empty when the stream opens so that a cancelled or crashed
 * stream still leaves a record of what the user saw. This fills in the text
 * once the stream ends — whether it ended by completing, erroring, or being
 * stopped. A partial answer is still an answer that was on screen.
 */
export async function completeMessage(input: {
  id: string
  content: string
  tokenCount?: number | null
  isComplete: boolean
}): Promise<void> {
  await query(
    `UPDATE messages
        SET content = $2, token_count = $3, is_complete = $4
      WHERE id = $1`,
    [input.id, input.content, input.tokenCount ?? null, input.isComplete],
  )
}

export async function setConversationStatus(
  id: string,
  status: ConversationStatus,
): Promise<void> {
  await query(`UPDATE conversations SET status = $2, updated_at = now() WHERE id = $1`, [
    id,
    status,
  ])
}

/** Auto-title a conversation from its first user message, if it has no title yet. */
export async function setTitleIfEmpty(id: string, title: string): Promise<void> {
  await query(
    `UPDATE conversations
        SET title = $2, updated_at = now()
      WHERE id = $1 AND (title IS NULL OR title = '')`,
    [id, title.slice(0, 120)],
  )
}
