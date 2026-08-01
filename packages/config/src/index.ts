import { existsSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { config as loadDotenv } from 'dotenv'
import { z } from 'zod'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CONFIGURATION
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * No file in this repo reads `process.env` outside this module. That single
 * rule buys three things:
 *
 *   1. **Container readiness.** The same build runs anywhere; only the
 *      environment changes. There are no baked paths or hostnames to find.
 *   2. **Loud failure at boot.** A missing variable stops the process at
 *      startup with a message naming the variable — not at 3am with a
 *      `TypeError: Cannot read properties of undefined`.
 *   3. **Typed access.** `env.db.url` is a string. `process.env.DATABASE_URL`
 *      is `string | undefined` at every call site forever.
 *
 * ── Why slices instead of one big schema ────────────────────────────────────
 * The ingestion service has no business failing to boot because ANTHROPIC_API_KEY
 * is absent — it never calls a model. Each service validates only the slice it
 * actually uses. A monolithic "validate everything" schema couples every service
 * to every other service's configuration, which is precisely the coupling that
 * makes deployments brittle.
 */

let dotenvLoaded = false

/**
 * Find the nearest `.env` by walking up from the current directory.
 *
 * dotenv resolves `.env` relative to `process.cwd()`, which is wrong in a
 * monorepo: `npm run migrate --workspace @ollive/db` executes with cwd set to
 * `packages/db`, so the root `.env` is invisible and every variable reads as
 * missing. Walking up finds it from any workspace, and from `apps/web` under
 * `next dev` too.
 *
 * Stops at the filesystem root rather than looping forever, and returns null if
 * nothing is found — which is a legitimate state in production, where the
 * platform injects the environment directly.
 */
function findEnvFile(from: string): string | null {
  const { root } = parse(from)
  let dir = from

  for (;;) {
    const candidate = join(dir, '.env')
    if (existsSync(candidate)) return candidate
    if (dir === root) return null
    dir = dirname(dir)
  }
}

/**
 * Load `.env` into `process.env`, if one exists.
 *
 * Deliberately *not* gated on NODE_ENV. Two things make that safe, and the
 * combination is what matters:
 *
 *   1. dotenv never overwrites a variable that is already set. On Vercel, in a
 *      container, or under k8s, the platform's injected environment always
 *      wins — a stray `.env` cannot shadow real configuration.
 *   2. `.env` is gitignored and not copied into any image, so in a real
 *      deployment there is no file to find and this is a no-op.
 *
 * The earlier version skipped loading whenever NODE_ENV=production, which
 * sounds prudent and is actually a footgun: `next start` and `node dist/…` both
 * set NODE_ENV=production locally, so running your own build on your own
 * machine silently saw no configuration at all. Correct-looking gate, wrong
 * behaviour — the guarantee we want comes from precedence, not from refusing
 * to read the file.
 */
function ensureDotenv(): void {
  if (dotenvLoaded) return
  dotenvLoaded = true

  const path = findEnvFile(process.cwd())
  if (path) loadDotenv({ path, quiet: true, override: false })
}

/** Turn Zod issues into something a human can act on without reading the schema. */
function fail(slice: string, error: z.ZodError): never {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join('.')
    return `  ✗ ${key}: ${issue.message}`
  })

  throw new Error(
    [
      '',
      `Invalid configuration for "${slice}":`,
      ...lines,
      '',
      'Copy .env.example to .env and fill in the missing values.',
      '',
    ].join('\n'),
  )
}

const resetters: (() => void)[] = []

/**
 * Memoise a slice so validation runs once per process, not per access.
 *
 * Generic over the schema rather than over its output type: every slice ends in
 * `.transform()`, so its input (raw `process.env` strings) and output (typed
 * config object) differ, and `z.ZodType<T>` would wrongly require them to match.
 */
function slice<S extends z.ZodTypeAny>(name: string, schema: S): () => z.infer<S> {
  let cached: z.infer<S> | undefined
  let loaded = false

  resetters.push(() => {
    cached = undefined
    loaded = false
  })

  return () => {
    if (loaded) return cached as z.infer<S>
    ensureDotenv()
    const result = schema.safeParse(process.env)
    if (!result.success) fail(name, result.error)
    cached = result.data
    loaded = true
    return cached
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime
// ─────────────────────────────────────────────────────────────────────────────

export const runtimeConfig = slice(
  'runtime',
  z
    .object({
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    })
    .transform((e) => ({
      nodeEnv: e.NODE_ENV,
      logLevel: e.LOG_LEVEL,
      isProduction: e.NODE_ENV === 'production',
    })),
)

/**
 * Are we running somewhere that freezes the process the moment a response is sent?
 *
 * This is not cosmetic. On Vercel a 200ms batch timer will never fire — the
 * function is suspended as soon as the response returns — so every buffered
 * event would be lost. The transport uses this to switch to flush-on-response,
 * trading batching efficiency for actually delivering the data.
 */
export function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)
}

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────

export const dbConfig = slice(
  'database',
  z
    .object({
      DATABASE_URL: z
        .string()
        .min(1, 'required — get a connection string from https://neon.tech')
        .refine((v) => v.startsWith('postgres://') || v.startsWith('postgresql://'), {
          message: 'must be a postgres:// or postgresql:// URL',
        }),
      // Small by default: Neon pools on their side, and serverless functions each
      // hold their own pool. A large per-instance pool is how you exhaust the
      // server's connection limit with a traffic spike.
      DATABASE_POOL_MAX: z.coerce.number().int().positive().max(50).default(5),
      /**
       * Verify the server's TLS certificate chain.
       *
       * Off by default because managed Postgres providers present chains that
       * are not in Node's bundled CA store, and `pg` v8 now treats
       * `sslmode=require` as full verification. The connection stays encrypted
       * either way; this controls whether we authenticate the server.
       */
      DATABASE_SSL_STRICT: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    })
    .transform((e) => ({
      url: e.DATABASE_URL,
      poolMax: e.DATABASE_POOL_MAX,
      sslStrict: e.DATABASE_SSL_STRICT,
    })),
)

// ─────────────────────────────────────────────────────────────────────────────
// Model providers
// ─────────────────────────────────────────────────────────────────────────────

export const providerConfig = slice(
  'providers',
  z
    .object({
      ANTHROPIC_API_KEY: z.string().min(1).optional(),
      OPENAI_API_KEY: z.string().min(1).optional(),
      // OpenAI-compatible vendors are configuration, not code — one adapter,
      // many base URLs. Keys are optional so the app degrades to whatever is
      // actually available rather than refusing to start.
      GROQ_API_KEY: z.string().min(1).optional(),
      DEEPSEEK_API_KEY: z.string().min(1).optional(),
    })
    .transform((e) => {
      const keys = {
        anthropic: e.ANTHROPIC_API_KEY,
        openai: e.OPENAI_API_KEY,
        groq: e.GROQ_API_KEY,
        deepseek: e.DEEPSEEK_API_KEY,
      } as const

      const available = (Object.keys(keys) as (keyof typeof keys)[]).filter((k) => keys[k])

      return {
        keys,
        /** Which providers this deployment can actually serve. The UI offers exactly these. */
        available,
        has(provider: keyof typeof keys): boolean {
          return Boolean(keys[provider])
        },
      }
    })
    .refine((c) => c.available.length > 0, {
      message: 'at least one provider key is required (ANTHROPIC_API_KEY or OPENAI_API_KEY)',
    }),
)

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry — read by the SDK
// ─────────────────────────────────────────────────────────────────────────────

export const telemetryConfig = slice(
  'telemetry',
  z
    .object({
      /**
       * Unset is a supported, deliberate state — not an error.
       *
       * The SDK becomes a no-op with one startup warning. It must never throw and
       * never retry into the void: the absence of telemetry cannot be allowed to
       * break the application being instrumented. This is the first thing a
       * reviewer hits if they clone the repo without reading the README.
       */
      INGEST_ENDPOINT: z.string().url().optional(),
      INGEST_API_KEY: z.string().min(1).optional(),

      OLLIVE_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
      OLLIVE_FLUSH_MS: z.coerce.number().int().positive().max(60_000).default(200),
      OLLIVE_MAX_QUEUE: z.coerce.number().int().positive().max(100_000).default(1_000),
      OLLIVE_PREVIEW_CHARS: z.coerce.number().int().nonnegative().max(2_000).default(300),
      OLLIVE_REDACTION: z.enum(['sdk', 'ingest', 'both', 'off']).default('both'),
      /** Hard ceiling on a single ingestion request. Logging must never become the slow path. */
      OLLIVE_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(5_000),
    })
    .transform((e) => ({
      endpoint: e.INGEST_ENDPOINT ?? null,
      apiKey: e.INGEST_API_KEY ?? null,
      enabled: Boolean(e.INGEST_ENDPOINT),
      batchSize: e.OLLIVE_BATCH_SIZE,
      flushMs: e.OLLIVE_FLUSH_MS,
      maxQueue: e.OLLIVE_MAX_QUEUE,
      previewChars: e.OLLIVE_PREVIEW_CHARS,
      redaction: e.OLLIVE_REDACTION,
      httpTimeoutMs: e.OLLIVE_HTTP_TIMEOUT_MS,
    })),
)

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion server
// ─────────────────────────────────────────────────────────────────────────────

export const ingestServerConfig = slice(
  'ingest-server',
  z
    .object({
      /**
       * `PORT` is what every PaaS injects — Railway, Render, Heroku, App Runner
       * all assign a port and route to it. Binding a hardcoded 3001 while the
       * platform knocks on its own port produces a health check that fails with
       * "service unavailable" against a process that started perfectly, which
       * is a genuinely confusing hour.
       *
       * Precedence is explicit-over-injected: INGEST_PORT wins when set, so
       * compose and local dev keep their fixed port, and a PaaS needs no
       * configuration at all.
       */
      INGEST_PORT: z.coerce
        .number()
        .int()
        .positive()
        .max(65_535)
        .default(Number(process.env.PORT) || 3001),
      // Not `localhost`. A container binding to the loopback interface is
      // unreachable from outside it, which looks identical to a crash.
      INGEST_HOST: z.string().default('0.0.0.0'),
      INGEST_API_KEY: z.string().min(1, 'required — the SDK authenticates with this'),
      /** Rejected at the edge with 413. A 500-event batch of 2KB previews is ~1MB; 4MB is generous headroom. */
      INGEST_MAX_BODY_BYTES: z.coerce.number().int().positive().default(4 * 1024 * 1024),
      /**
       * How long SIGTERM waits for in-flight work before exiting.
       *
       * This is the same number as k8s `terminationGracePeriodSeconds` and it is
       * why graceful shutdown is worth building now rather than when containers
       * arrive: without it, every deploy silently drops whatever was buffered.
       */
      SHUTDOWN_GRACE_MS: z.coerce.number().int().positive().max(60_000).default(10_000),
      /**
       * Where accepted events go.
       *
       *   direct  await the insert. Ingest latency IS database latency.
       *   pgmq    enqueue and return; a worker persists. A database blip
       *           queues work instead of returning 503.
       *   kafka   not implemented — see packages/ingest-core/src/sink.ts for
       *           the thresholds at which it would be.
       */
      INGEST_SINK: z.enum(['direct', 'pgmq', 'kafka']).default('direct'),
      /** Run the queue worker in this process. Set false to scale it separately. */
      INGEST_WORKER: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
      /**
       * Consumer lag, in seconds, past which an instance running the worker
       * reports itself unready.
       *
       * Depth is not the signal — a deep queue draining fast is healthy. The
       * age of the oldest unread message is what says the worker has stopped
       * keeping up. 60s sits well above a normal batch (sub-second) and well
       * below the point anyone would notice missing data.
       */
      INGEST_MAX_QUEUE_LAG_SEC: z.coerce.number().int().positive().max(3600).default(60),
    })
    .transform((e) => ({
      port: e.INGEST_PORT,
      host: e.INGEST_HOST,
      apiKey: e.INGEST_API_KEY,
      maxBodyBytes: e.INGEST_MAX_BODY_BYTES,
      shutdownGraceMs: e.SHUTDOWN_GRACE_MS,
      sink: e.INGEST_SINK,
      runWorker: e.INGEST_WORKER,
      maxQueueLagSec: e.INGEST_MAX_QUEUE_LAG_SEC,
    })),
)

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

export const dashboardConfig = slice(
  'dashboard',
  z
    .object({
      DASHBOARD_PORT: z.coerce.number().int().positive().max(65_535).default(3002),
      /**
       * Shared bearer token for the metrics API.
       *
       * Unset means open. That is fine locally and deliberate — but the
       * dashboard exposes spend per model and raw provider error messages, so
       * once it runs on its own host this should be set, or the host put
       * behind a VPN or identity provider.
       */
      DASHBOARD_TOKEN: z.string().min(8).optional(),
    })
    .transform((e) => ({
      port: e.DASHBOARD_PORT,
      token: e.DASHBOARD_TOKEN ?? null,
    })),
)

/** Test-only: drop every memoised slice so a test can vary the environment. */
export function __resetConfigForTests(): void {
  dotenvLoaded = true // tests set process.env directly; never let dotenv overwrite them
  for (const reset of resetters) reset()
}
