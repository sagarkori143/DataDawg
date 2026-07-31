#!/usr/bin/env node
import { closePool } from '../pool.js'
import { migrate, reset } from '../migrate.js'

/**
 * `npm run db:migrate` / `npm run db:reset`
 *
 * A standalone command on purpose: this is exactly the shape a Docker Compose
 * one-shot service or a Kubernetes Job needs. Migrations must run once, to
 * completion, before the app starts — not lazily on first request, which races
 * across replicas.
 */

const wantsReset = process.argv.includes('--reset')

try {
  if (wantsReset) {
    console.log('\nResetting database…')
    await reset()
  }

  console.log('\nApplying migrations…')
  const { applied, skipped } = await migrate()

  if (applied.length === 0) {
    console.log(`  nothing to do (${skipped.length} already applied)`)
  } else {
    console.log(`\n${applied.length} applied, ${skipped.length} already present.`)
  }
  console.log('')
} catch (err) {
  console.error(`\n✗ ${(err as Error).message}\n`)
  process.exitCode = 1
} finally {
  await closePool()
}
