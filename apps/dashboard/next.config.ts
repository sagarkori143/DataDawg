import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

/**
 * The dashboard is a separate deployable on purpose.
 *
 * It shares no runtime with the chat app — different process, different host,
 * different database connection pool. What it shares is `packages/db`, and only
 * the read side of it.
 *
 * The payoff is not tidiness. It is that this app has its **own**
 * `DATABASE_URL`, so pointing analytics at a read replica is one environment
 * variable rather than a refactor — and until then, a heavy dashboard query
 * exhausts *this* pool rather than the one the chat app needs to answer users.
 */
const config: NextConfig = {
  outputFileTracingRoot: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),

  // Node-native; must not be bundled.
  serverExternalPackages: ['pg'],

  transpilePackages: ['@ollive/config', '@ollive/db', '@ollive/contracts'],

  /**
   * Standalone output for containers.
   *
   * Next traces the files actually reachable at runtime and emits a
   * self-contained server — so the image carries neither the full
   * node_modules nor the source. In a monorepo that is roughly a 10x
   * reduction, and it depends on `outputFileTracingRoot` above being correct.
   */
  output: 'standalone',

  eslint: { ignoreDuringBuilds: true },
}

export default config
