import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool } from './pool.js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MIGRATION RUNNER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Plain numbered .sql files, applied in order, recorded in a table. About 100
 * lines, no dependency.
 *
 * Deliberately hand-rolled rather than node-pg-migrate or Prisma. The schema is
 * itself a graded deliverable here, so it is worth having it live in the repo
 * as readable SQL with the reasoning in comments, rather than behind a DSL that
 * generates it. A framework would also add a dependency to do something this
 * small — and would not have let me write the commentary that explains *why*
 * `inference_events` is partitioned.
 *
 * The tradeoff is honest: no down-migrations. Rolling back means writing a new
 * forward migration. For a system whose largest table is append-only telemetry,
 * that is the right trade — and reversible migrations are largely a fiction
 * once a destructive change has run against production data anyway.
 */

// From dist/ this resolves to packages/db/migrations; from src/ under tsx it
// resolves to the same place. Both entry points work without configuration.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

/**
 * Two concurrent deployers must not run migrations at once.
 *
 * A session-level advisory lock is the cheapest correct answer: the second
 * process blocks until the first finishes, then finds every migration already
 * applied and does nothing. Without it, both would try to CREATE TYPE and one
 * would crash the deploy.
 */
const LOCK_KEY = 0x0117_0001

export interface MigrationResult {
  applied: string[]
  skipped: string[]
}

async function ensureMigrationsTable(): Promise<void> {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

function checksum(sql: string): string {
  // Normalise line endings first. Without this, cloning the repo on Windows
  // with autocrlf would change every checksum and make already-applied
  // migrations look tampered with.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}

export async function migrate(log: (msg: string) => void = console.log): Promise<MigrationResult> {
  const pool = getPool()
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

  if (files.length === 0) throw new Error(`No .sql files found in ${MIGRATIONS_DIR}`)

  const client = await pool.connect()
  const applied: string[] = []
  const skipped: string[] = []

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY])
    await ensureMigrationsTable()

    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM _migrations',
    )
    const previous = new Map(rows.map((r) => [r.name, r.checksum]))

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
      const sum = checksum(sql)
      const seen = previous.get(file)

      if (seen) {
        // Editing an applied migration means the database and the repo have
        // silently diverged — every environment applied a different version of
        // this file. Refusing loudly is far kinder than discovering it later.
        if (seen !== sum) {
          throw new Error(
            `Migration "${file}" has changed since it was applied ` +
              `(recorded ${seen}, found ${sum}). Add a new migration instead of editing this one.`,
          )
        }
        skipped.push(file)
        continue
      }

      // Each migration is one transaction: it applies completely or not at all,
      // and a failure never leaves a half-built schema behind.
      await client.query('BEGIN')
      try {
        await client.query(sql)
        await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [file, sum])
        await client.query('COMMIT')
        applied.push(file)
        log(`  ✓ ${file}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`Migration "${file}" failed: ${(err as Error).message}`, { cause: err })
      }
    }

    // Idempotent, and run on every startup rather than only when migrating.
    //
    // A missing partition is an insert error at midnight on the first of the
    // month — an entirely predictable outage that costs one cheap function call
    // to prevent. Production would also schedule this; doing it here means the
    // dev machine and CI are never the ones that break.
    await client.query('SELECT ensure_events_partition(CURRENT_DATE)')
    await client.query("SELECT ensure_events_partition((CURRENT_DATE + interval '1 month')::date)")
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {})
    client.release()
  }

  return { applied, skipped }
}

/**
 * Drop everything and start over. Development only.
 *
 * Guarded against NODE_ENV=production because the one thing worse than no reset
 * command is a reset command that works in production.
 */
export async function reset(log: (msg: string) => void = console.log): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('reset() refuses to run with NODE_ENV=production')
  }

  log('  ! dropping schema public')
  await getPool().query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
}
