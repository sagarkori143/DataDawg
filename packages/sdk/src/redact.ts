import { createHash } from 'node:crypto'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PII REDACTION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Where this runs ─────────────────────────────────────────────────────────
 * Both in the SDK, before an event leaves the process, and again at ingestion.
 * They protect against different failures:
 *
 *   SDK-side     — PII never crosses the network at all. Strongest guarantee,
 *                  but the policy is baked into whatever SDK version each app
 *                  happens to be running, so updating it means redeploying them.
 *   Ingest-side  — one central policy you can change in an afternoon, but the
 *                  data has already travelled to get there.
 *
 * Running both means a stale SDK is still caught centrally, and a
 * misconfiguration at ingest does not expose data that was already clean.
 *
 * ── Replace, don't delete ───────────────────────────────────────────────────
 * Matches become `[EMAIL:a1b2c3d4]` rather than `[REDACTED]`. The suffix is a
 * truncated salted digest, so the same address always yields the same token.
 * That preserves the two things analysts actually need from PII — "how many
 * distinct users hit this error" and "is this the same person as in that other
 * trace" — while storing nothing that can be read back.
 *
 * ── Why regex and not Presidio or an LLM classifier ─────────────────────────
 * Structured identifiers (cards, emails, keys) are exactly what patterns are
 * good at, and they are the ones with real consequences if leaked. Free-form
 * PII — names, addresses — needs an NER model, which means a heavyweight
 * dependency or a network call on the hot path of a logging library. That is
 * the wrong trade here, and the honest thing is to say so rather than claim
 * coverage this does not have.
 */

const SALT = process.env.OLLIVE_REDACTION_SALT ?? 'ollive-default-salt'

function token(kind: string, value: string): string {
  const digest = createHash('sha256').update(SALT).update(value).digest('hex').slice(0, 8)
  return `[${kind}:${digest}]`
}

interface Detector {
  kind: string
  pattern: RegExp
  /** Second-pass check. Patterns over-match by design; this is where false positives die. */
  validate?: (match: string) => boolean
}

/**
 * Luhn checksum.
 *
 * Without it, any 16-digit run — an order number, a request ID, a timestamp
 * concatenation — reads as a credit card. Luhn removes ~90% of those while
 * keeping every real card, because real card numbers are constructed to satisfy
 * it. This is the difference between a redactor people trust and one they
 * switch off because it mangles their logs.
 */
function luhn(digits: string): boolean {
  const s = digits.replace(/\D/g, '')
  if (s.length < 13 || s.length > 19) return false

  let sum = 0
  let double = false
  for (let i = s.length - 1; i >= 0; i--) {
    let d = s.charCodeAt(i) - 48
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/** Reject SSN groups the SSA never issues, which is most of what the shape matches. */
function validSsn(match: string): boolean {
  const [area, group, serial] = match.split(/[-\s]/) as [string, string, string]
  if (area === '000' || area === '666' || area.startsWith('9')) return false
  return group !== '00' && serial !== '0000'
}

const DETECTORS: Detector[] = [
  {
    kind: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    // Ordered before CARD: a JWT contains long digit runs that could otherwise
    // be partially eaten by the card pattern, leaving a mangled half-token.
    kind: 'JWT',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    kind: 'APIKEY',
    pattern:
      /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    kind: 'CARD',
    pattern: /\b(?:\d[ -]?){13,19}\b/g,
    validate: luhn,
  },
  {
    kind: 'SSN',
    pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g,
    validate: validSsn,
  },
  {
    kind: 'PHONE',
    // Requires punctuation or a country code. A bare 10-digit run is far more
    // often an ID than a phone number, and redacting those makes traces useless.
    pattern: /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g,
  },
  {
    kind: 'IP',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    // Version strings ("1.2.3.4") match the shape. Requiring at least one octet
    // above 255-range plausibility is unreliable, so drop only the obvious
    // loopback/unspecified cases which carry no personal information anyway.
    validate: (m) => m !== '127.0.0.1' && m !== '0.0.0.0',
  },
]

export interface RedactionResult {
  text: string
  hits: number
  /** Per-kind counts. Surfaced on the dashboard — a redactor you cannot observe is one you cannot trust. */
  byKind: Record<string, number>
}

/**
 * Redact a string.
 *
 * Detectors run in the order declared, each over the output of the last, so an
 * earlier, more specific pattern claims its text before a looser one can.
 */
export function redact(input: string | null | undefined): RedactionResult {
  if (!input) return { text: input ?? '', hits: 0, byKind: {} }

  let text = input
  let hits = 0
  const byKind: Record<string, number> = {}

  for (const det of DETECTORS) {
    // Fresh regex per pass: /g patterns carry mutable lastIndex, and reusing a
    // shared instance across calls silently skips matches on every other call.
    const re = new RegExp(det.pattern.source, det.pattern.flags)

    text = text.replace(re, (match) => {
      if (det.validate && !det.validate(match)) return match
      hits++
      byKind[det.kind] = (byKind[det.kind] ?? 0) + 1
      return token(det.kind, match.replace(/[\s-]/g, ''))
    })
  }

  return { text, hits, byKind }
}

/**
 * Truncate to a preview, redacting first.
 *
 * Order matters: truncating first can slice an identifier in half, and the
 * surviving fragment is both un-matchable by the detectors and still sensitive.
 */
export function preview(
  input: string | null | undefined,
  maxChars: number,
): { text: string | null; hits: number } {
  if (!input) return { text: null, hits: 0 }

  const { text, hits } = redact(input)
  return {
    text: text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`,
    hits,
  }
}
