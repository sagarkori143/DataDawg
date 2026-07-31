import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NextConfig } from 'next'

const config: NextConfig = {
  /**
   * Pin the workspace root.
   *
   * Next infers it by searching upward for a lockfile, and a stray
   * package-lock.json anywhere above the repo wins — producing a build that
   * traces files from the wrong tree. Pinning it makes the build independent of
   * whatever happens to exist in parent directories on a given machine.
   */
  outputFileTracingRoot: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),

  /**
   * Keep the provider SDKs out of the bundler.
   *
   * Two reasons, and the second is the important one:
   *
   *  1. `pg` and the vendor SDKs are Node-native and do not survive bundling.
   *  2. The instrumentation loader (Phase 9) intercepts module *specifiers* at
   *     require/import time. Once a bundler inlines `@anthropic-ai/sdk` into a
   *     chunk there is no specifier left to intercept, and auto-instrumentation
   *     silently captures nothing. Externalising them keeps the seam intact.
   */
  serverExternalPackages: ['pg', '@anthropic-ai/sdk', 'openai'],

  /**
   * Workspace packages ship TypeScript source; Next compiles them in-place so
   * there is no build step between editing a package and seeing it in the app.
   */
  transpilePackages: [
    '@ollive/contracts',
    '@ollive/config',
    '@ollive/db',
    '@ollive/providers',
    '@ollive/sdk',
    '@ollive/ingest-core',
  ],

  eslint: { ignoreDuringBuilds: true },
}

export default config
