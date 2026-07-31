import type { Message } from '@ollive/db'
import type { ChatMessage } from '@ollive/providers'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONVERSATIONAL CONTEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The brief asks the chatbot to "maintain short conversational context". There
 * are three ways to do that, and the choice is a real tradeoff:
 *
 *   1. Send the whole history — perfect recall, cost grows without bound, and
 *      eventually it just stops working when the context window fills.
 *   2. Sliding window — cheap, bounded, predictable. Forgets the beginning.
 *   3. Rolling summary — preserves the gist of old turns, but costs an extra
 *      model call per turn and can silently drop the one detail that mattered.
 *
 * This is (2), budgeted by characters rather than turn count.
 *
 * Turn count is the wrong unit: twenty one-line exchanges and two pasted stack
 * traces are wildly different amounts of context but identical turn counts, so
 * a turn-based window either wastes budget or blows through it depending on
 * what the user happens to be doing.
 *
 * A floor of MIN_TURNS is kept regardless of budget — a window that can drop to
 * zero turns produces a bot that forgets the question it is answering, which is
 * worse than being slightly over budget.
 *
 * Upgrade path when it matters: summarise everything evicted here and prepend
 * it as a system message. The seam is the return value of this function, so
 * that change does not touch the route.
 */

/**
 * ~4 characters per token is the usual English rule of thumb. Deliberately an
 * estimate: a real tokeniser call per turn would add a network round trip to
 * the hot path to protect against a limit we are nowhere near.
 */
const CHARS_PER_TOKEN = 4

/** Leaves ample room for the reply and any thinking inside a 200k+ window. */
const DEFAULT_TOKEN_BUDGET = 8_000

/** Never send fewer than this many turns, however long they are. */
const MIN_TURNS = 4

export interface ContextResult {
  messages: ChatMessage[]
  /** Turns dropped to stay within budget. Recorded on the event so truncation is visible, not silent. */
  droppedTurns: number
  estimatedTokens: number
}

export function buildContextWindow(
  history: Message[],
  tokenBudget = DEFAULT_TOKEN_BUDGET,
): ContextResult {
  const charBudget = tokenBudget * CHARS_PER_TOKEN

  // Walk backwards from the most recent turn: recency is what matters, and the
  // newest message is the one that must never be evicted.
  const kept: Message[] = []
  let chars = 0

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!

    // Skip the empty placeholder row of an in-flight assistant message — it
    // exists so a cancelled stream still leaves a record, but sending an empty
    // assistant turn to the model would be malformed.
    if (msg.role === 'assistant' && msg.content.length === 0) continue

    const cost = msg.content.length
    if (chars + cost > charBudget && kept.length >= MIN_TURNS) break

    kept.push(msg)
    chars += cost
  }

  kept.reverse()

  return {
    messages: kept.map((m) => ({ role: m.role, content: m.content })),
    droppedTurns: history.length - kept.length,
    estimatedTokens: Math.ceil(chars / CHARS_PER_TOKEN),
  }
}

/** First user message, trimmed to a sensible sidebar title. */
export function deriveTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 57)}…`
}
