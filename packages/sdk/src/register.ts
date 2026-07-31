import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ZERO-CODE AUTO-INSTRUMENTATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *     node --import @ollive/sdk/register  app.js
 *
 * That flag is the entire integration. Not one line of the application changes
 * — no import, no wrapper, no init call — and every LLM call it makes is timed,
 * measured, and shipped.
 *
 * ── How ─────────────────────────────────────────────────────────────────────
 * Node runs this file before the application's own entry point. It installs a
 * module hook that watches for `@anthropic-ai/sdk` and `openai`. When the app
 * later imports one, the hook substitutes a tiny synthetic module that pulls in
 * the real package and re-exports its client class wrapped in a `construct`
 * trap. The app believes it received the real library.
 *
 * You replace the manager's door with a revolving door that counts people — at
 * 4am, before anyone arrives. Nobody in the building finds out.
 *
 * This is what Datadog, New Relic and OpenTelemetry do. `module.registerHooks`
 * (Node 22.15+) makes it dramatically less code than the
 * `require-in-the-middle` + `import-in-the-middle` pair it used to require: one
 * synchronous hook covering both module systems, no worker thread, no
 * message-port dance.
 *
 * ── The honest limitation ───────────────────────────────────────────────────
 * This works on module *specifiers*. A bundler that inlines the vendor SDK into
 * a chunk leaves no specifier to match, so under Next.js the provider packages
 * must be listed in `serverExternalPackages` (they are — see next.config.ts).
 * The unambiguous proof is therefore `examples/zero-code`, run with plain
 * `node`: same file, run twice, events only the second time.
 */

/**
 * Packages to intercept, and the shim each maps to.
 *
 * Anchored to the package's **top-level entry**, not to anything inside it.
 * A looser pattern also matches internal files like
 * `@anthropic-ai/sdk/resources/index.mjs`, which have no default export — the
 * substituted module then fails to instantiate and takes the whole process
 * down at import time. Match the front door, not every door in the building.
 */
const TARGETS: { match: RegExp; provider: string }[] = [
  {
    match: /node_modules[/\\]@anthropic-ai[/\\]sdk[/\\](?:dist[/\\])?index\.[mc]?js$/,
    provider: 'anthropic',
  },
  {
    match: /node_modules[/\\]openai[/\\](?:dist[/\\])?index\.[mc]?js$/,
    provider: 'openai',
  },
]

const HERE = fileURLToPath(import.meta.url)
const RUNTIME_URL = pathToFileURL(HERE.replace(/register\.(m?js|ts)$/, 'hook-runtime.js')).href

/** Marks a URL as already-unwrapped so the hook does not recurse into itself. */
const RAW = 'ollive-raw'

function targetFor(url: string): string | null {
  if (url.includes(RAW)) return null
  // Strip any query so `?ollive-raw=1` never defeats the anchored `$`.
  const path = url.split('?')[0] ?? url
  for (const t of TARGETS) {
    if (t.match.test(path)) return t.provider
  }
  return null
}

let installed = false

export function register(): void {
  if (installed) return
  installed = true

  registerHooks({
    load(url, context, nextLoad) {
      const provider = targetFor(url)
      if (!provider) return nextLoad(url, context)

      // Substitute a module that imports the real one under a different URL
      // (so this hook skips it) and re-exports the client class wrapped.
      //
      // `export *` forwards every named export untouched; only `default` — the
      // client class — is replaced. That keeps type-only and helper exports
      // working exactly as before.
      const raw = `${url}${url.includes('?') ? '&' : '?'}${RAW}=1`

      return {
        format: 'module',
        shortCircuit: true,
        source: [
          `import RealClient from ${JSON.stringify(raw)};`,
          `export * from ${JSON.stringify(raw)};`,
          `import { wrapConstructor } from ${JSON.stringify(RUNTIME_URL)};`,
          `export default wrapConstructor(RealClient, ${JSON.stringify(provider)});`,
        ].join('\n'),
      }
    },
  })

  console.warn(
    JSON.stringify({
      level: 'info',
      logger: '@ollive/sdk/register',
      msg: 'auto-instrumentation active',
      targets: TARGETS.map((t) => t.provider),
      ts: new Date().toISOString(),
    }),
  )
}

// Installing on import is the point: `--import` evaluates this module, and that
// evaluation is the whole integration.
register()
