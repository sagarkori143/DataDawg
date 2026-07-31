import { dbConfig } from '@ollive/config'
import pg from 'pg'

const { Pool, types } = pg

/**
 * ── Type coercion ───────────────────────────────────────────────────────────
 *
 * node-postgres returns bigint (int8) and numeric as strings by default,
 * because both can exceed what a JS number represents exactly. That default is
 * right for money and wrong for counters, so we split the difference:
 *
 *   int8    → Number.  Our bigints are call counts and token sums. Reaching
 *             2^53 would require ~9 quadrillion calls, so the precision risk is
 *             theoretical while the "why is my count a string" bug is not.
 *   numeric → left as a string. This is cost_usd. Turning money into a float is
 *             how you end up with $0.30000000000000004 in a billing table.
 *             Callers parse it deliberately, at the point where they know
 *             whether they want display or arithmetic.
 */
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10))

/**
 * ── TLS ─────────────────────────────────────────────────────────────────────
 *
 * `sslmode` is removed from the URL and the TLS config supplied explicitly.
 *
 * Passing a connection string *and* an `ssl` object does not merge the way you
 * would expect: `pg-connection-string` parses `sslmode` into its own ssl
 * config, and that silently wins over the explicit option. Owning one source of
 * truth is the only way to make the behaviour deterministic across pg versions.
 *
 * The reason this matters at all: node-postgres v8 reinterpreted
 * `sslmode=require` to mean full certificate verification (previously it meant
 * "encrypt, don't verify" — libpq's semantics). Managed providers commonly
 * present chains that are absent from Node's bundled CA store, so connection
 * strings that worked for years now fail with SELF_SIGNED_CERT_IN_CHAIN.
 *
 * What relaxing this gives up is **authentication of the server**, not
 * encryption — traffic is TLS either way. That is a real reduction in
 * protection against an active MITM, so it is a documented default rather than
 * a silent one: set DATABASE_SSL_STRICT=true to restore verification.
 */
function resolveTls(
  raw: string,
  strict: boolean,
): { connectionString: string; ssl: pg.PoolConfig['ssl'] } {
  const url = new URL(raw)
  const sslmode = url.searchParams.get('sslmode')

  url.searchParams.delete('sslmode')
  url.searchParams.delete('uselibpqcompat')

  const connectionString = url.toString()

  // Explicitly opted out — local Postgres over a loopback socket, typically.
  if (sslmode === 'disable') return { connectionString, ssl: false }

  return { connectionString, ssl: { rejectUnauthorized: strict } }
}

let pool: pg.Pool | undefined

/**
 * The process-wide connection pool.
 *
 * Lazy, so importing this module does not open sockets — which matters because
 * the Next.js build imports route handlers to analyse them, and a pool opened
 * at import time would try to reach Neon during `next build`.
 */
export function getPool(): pg.Pool {
  if (pool) return pool

  const cfg = dbConfig()
  const { connectionString, ssl } = resolveTls(cfg.url, cfg.sslStrict)

  pool = new Pool({
    connectionString,
    ssl,
    max: cfg.poolMax,
    // Neon closes idle connections on its side; releasing ours first avoids the
    // "Connection terminated unexpectedly" class of error on the next borrow.
    idleTimeoutMillis: 30_000,
    // Fail fast rather than hanging a request for 30s when the database is
    // unreachable. The chat route surfaces this as an error the user can act on.
    connectionTimeoutMillis: 10_000,
  })

  // An idle client erroring is not an exception anyone can catch at a call
  // site — without this listener it becomes an unhandled 'error' event and
  // takes the process down. Logging and continuing is correct: the pool
  // discards the client and the next borrow gets a fresh one.
  pool.on('error', (err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'idle postgres client errored',
        error: err.message,
        ts: new Date().toISOString(),
      }),
    )
  })

  return pool
}

/** Run a query. Thin wrapper so call sites never import `pg` directly. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: readonly unknown[],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[])
}

/**
 * Run a function inside a transaction, rolling back if it throws.
 *
 * Used by the chat write path, where a message and its conversation counter
 * must move together. The telemetry path deliberately does not use this: its
 * whole batch is already one statement.
 */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // The rollback itself can fail if the connection died mid-transaction.
      // Swallow it so the original error — the useful one — is what propagates.
    })
    throw err
  } finally {
    client.release()
  }
}

/**
 * Readiness probe: can we actually reach the database?
 *
 * Distinct from liveness on purpose. Liveness asks "is this process alive"
 * (restart me if not); readiness asks "can this process serve traffic" (stop
 * sending me requests until it can). Wiring both to the same check is the most
 * common way to turn a brief database blip into a restart loop.
 */
export async function ping(): Promise<boolean> {
  try {
    await query('SELECT 1')
    return true
  } catch {
    return false
  }
}

/** Close the pool. Called from the SIGTERM handler so shutdown does not strand connections. */
export async function closePool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = undefined
  await p.end()
}
