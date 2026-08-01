import { dashboardConfig } from '@ollive/config'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DASHBOARD ACCESS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Moving the dashboard to its own host means it is reachable from somewhere
 * other than the app that produced the data. It shows spend per model and raw
 * provider error messages — commercially sensitive, and occasionally revealing
 * about prompts. A metrics endpoint that is open because nobody thought about
 * it is how that leaks.
 *
 * ── What this is, and is not ────────────────────────────────────────────────
 * A shared bearer token. It is deliberately minimal:
 *
 *   IS      a guard against the endpoint being trivially readable by anyone
 *           who finds the URL
 *   IS NOT  authentication. There are no users, no sessions, no revocation,
 *           and one leaked token means rotating it everywhere
 *
 * For anything real, put this behind your identity provider or a VPN. That is
 * stated here rather than implied, because a token check can look like more
 * security than it is.
 *
 * Unset means open, and the app says so loudly at startup. That keeps the
 * local demo frictionless while making the exposure a decision rather than an
 * accident.
 */
export function checkDashboardAuth(header: string | null): boolean {
  const expected = dashboardConfig().token
  if (!expected) return true // no token configured — open by design

  if (!header) return false
  const token = header.startsWith('Bearer ') ? header.slice(7) : header
  if (token.length !== expected.length) return false

  // Constant-time compare: `===` leaks length and prefix through timing.
  let diff = 0
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

export function isProtected(): boolean {
  return Boolean(dashboardConfig().token)
}
